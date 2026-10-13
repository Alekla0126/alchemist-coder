import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserState } from '@shared/api';
import { useT } from '../store';
import { Icon } from './Icon';

const api = () => window.alchemist;

/**
 * The browser pane. The page itself is a native view the main process lays exactly over this
 * pane's body: it doesn't move or open windows when an agent drives it, and it goes away when the
 * pane closes (or something has to show over it: `covered`). You see everything an agent does,
 * and can take the browser over (its tools then wait) and hand it back.
 */
export function BrowserPane({ covered = false, onClose }: { covered?: boolean; onClose: () => void }) {
  const t = useT();
  const [state, setState] = useState<BrowserState | null>(null);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api().browserState().then(setState);
    return api().onBrowserState(setState);
  }, []);
  useEffect(() => {
    if (!editing) setAddress(state?.url && state.url !== 'about:blank' ? state.url : '');
  }, [state?.url, editing]);

  // Where the page view goes: this pane's body, wherever layout puts it.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    if (covered) {
      api().browserBounds(null);
      return;
    }
    let frame = 0;
    const send = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        api().browserBounds({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
      });
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(el);
    window.addEventListener('resize', send);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', send);
      api().browserBounds(null);
    };
  }, [covered]);

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    setEditing(false);
    if (address.trim()) void api().browserOpen(address);
  };
  const empty = !state?.url || state.url === 'about:blank';

  return (
    <section className="browser-pane" aria-label={t('browser.title')}>
      <form className="browser-bar" onSubmit={go}>
        <button type="button" className="icon-btn" disabled={!state?.canGoBack} onClick={() => void api().browserBack()} title={t('browser.back')} aria-label={t('browser.back')}>
          ‹
        </button>
        <button type="button" className="icon-btn" disabled={!state?.canGoForward} onClick={() => void api().browserForward()} title={t('browser.forward')} aria-label={t('browser.forward')}>
          ›
        </button>
        <button type="button" className="icon-btn" disabled={empty} onClick={() => void api().browserReload()} title={t('browser.reload')} aria-label={t('browser.reload')}>
          {state?.loading ? '×' : '↻'}
        </button>
        <input
          className="browser-address"
          value={address}
          placeholder={t('browser.placeholder')}
          aria-label={t('browser.address')}
          spellCheck={false}
          onFocus={(e) => {
            setEditing(true);
            e.target.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && (e.currentTarget.blur(), setAddress(state?.url ?? ''))}
        />
        <button type="button" className="icon-btn" onClick={onClose} title={t('browser.close')} aria-label={t('browser.close')}>
          <Icon name="close" size={14} />
        </button>
      </form>
      {(state?.driver || state?.userControl) && (
        <div className={`browser-driver ${state.userControl ? 'yours' : ''}`} role="status">
          <span>{state.userControl ? t('browser.yours') : t('browser.driving', { agent: state.driver ?? '' })}</span>
          <button className="link small" onClick={() => void api().browserUserControl(!state.userControl)}>
            {state.userControl ? t('browser.handBack') : t('browser.takeOver')}
          </button>
        </div>
      )}
      <div className="browser-body" ref={body}>
        {empty && (
          <div className="browser-empty">
            <p>{t('browser.empty')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
