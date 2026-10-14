import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserState } from '@shared/api';
import { sessionTitle, useStore, useT } from '../store';
import { Icon } from './Icon';

const api = () => window.alchemist;

/** Anything modal on screen: a dialog, a sheet, the palette. */
const MODAL = '[aria-modal="true"], .dialog-backdrop, .settings-backdrop, .palette-backdrop';

/**
 * Whether a modal is open anywhere in the window. The page draws above the whole app, so any
 * dialog (to rename, confirm, add an agent, review a commit…) would open under it otherwise.
 */
function useModalOpen(): boolean {
  const [open, setOpen] = useState(() => !!document.querySelector(MODAL));
  useEffect(() => {
    let frame = 0;
    // Checked at most once a frame, however much the conversation changes meanwhile.
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setOpen(!!document.querySelector(MODAL));
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return open;
}

/**
 * The browser pane. The page itself is a native view the main process lays exactly over this
 * pane's body: it doesn't move or open windows when an agent drives it, and it goes away when the
 * pane closes (or something has to show over it: `covered`). You see everything an agent does,
 * and can take the browser over (its tools then wait) and hand it back.
 */
export function BrowserPane({ covered: coveredBy = false, onClose }: { covered?: boolean; onClose: () => void }) {
  const t = useT();
  const [state, setState] = useState<BrowserState | null>(null);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const covered = useModalOpen() || coveredBy;

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
  const driving = state?.driver != null;
  const agent = state?.driver || t('browser.anAgent');
  // The conversation whose agent is at it, to name it and go there.
  const conversationId = useStore((s) => {
    const run = state?.driverRunId ? s.runs[state.driverRunId] : undefined;
    return run?.sessionId ?? (run?.target.startsWith('s:') ? run.target.slice(2) : null);
  });
  const conversationTitle = useStore((s) => (conversationId ? (sessionTitle(s, conversationId) ?? t('attention.aConversation')) : ''));

  return (
    <section className="browser-pane" aria-label={t('browser.title')}>
      <form className="browser-bar" onSubmit={go}>
        <button type="button" className="icon-btn" disabled={!state?.canGoBack} onClick={() => void api().browserBack()} title={t('browser.back')} aria-label={t('browser.back')}>
          <Icon name="chevronLeft" size={15} />
        </button>
        <button type="button" className="icon-btn" disabled={!state?.canGoForward} onClick={() => void api().browserForward()} title={t('browser.forward')} aria-label={t('browser.forward')}>
          <Icon name="chevronRight" size={15} />
        </button>
        {state?.loading ? (
          <button type="button" className="icon-btn" onClick={() => void api().browserStop()} title={t('browser.stop')} aria-label={t('browser.stop')}>
            <Icon name="stop" size={12} />
          </button>
        ) : (
          <button type="button" className="icon-btn" disabled={empty} onClick={() => void api().browserReload()} title={t('browser.reload')} aria-label={t('browser.reload')}>
            <Icon name="refresh" size={14} />
          </button>
        )}
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
      {/* Always there, so the page never moves: the page's title, or who has the browser. */}
      {(!empty || driving || state?.userControl) && (
        <div className={`browser-status ${state?.userControl ? 'yours' : driving ? 'driving' : ''}`} role="status" title={state?.userControl ? t('browser.yours') : driving ? t('browser.driving', { agent }) : state?.title}>
          {state?.userControl ? (
            <span className="bs-text">{t('browser.yours')}</span>
          ) : driving ? (
            <span className="bs-text">
              <span className="live-dot" aria-hidden /> <b>{agent}</b>
              {conversationId && (
                <>
                  {' · '}
                  <button className="bs-link" onClick={() => void useStore.getState().select(conversationId, 'main')} title={t('browser.goToConversation', { name: conversationTitle })}>
                    {conversationTitle}
                  </button>
                </>
              )}
            </span>
          ) : (
            <span className="bs-text bs-title">{state?.title}</span>
          )}
          {(driving || state?.userControl) && (
            <button className="bs-btn" onClick={() => void api().browserUserControl(!state?.userControl)}>
              {state?.userControl ? t('browser.handBack') : t('browser.takeOver')}
            </button>
          )}
        </div>
      )}
      <div className="browser-body" ref={body}>
        {empty && (
          <div className="browser-empty">
            <Icon name="globe" size={28} />
            <p>{t('browser.empty')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
