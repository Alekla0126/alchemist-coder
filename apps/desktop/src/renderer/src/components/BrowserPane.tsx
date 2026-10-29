import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BROWSER_MAX_TABS, type BrowserState } from '@shared/api';
import { sessionTitle, useStore, useT } from '../store';
import { Icon } from './Icon';

const api = () => window.alchemist;

/** example.com, for a tab with no title yet. */
function hostOf(url: string): string {
  try {
    return url && url !== 'about:blank' ? new URL(url).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

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

  const tabs = state?.tabs ?? [];
  const tabName = (tab: { title: string; url: string }) => tab.title || hostOf(tab.url) || t('browser.newTab');

  return (
    <section className="browser-pane" aria-label={t('browser.title')}>
      {/* This project's tabs: its own browser, apart from other projects' tabs and sign-ins. */}
      <div className="browser-tabs" role="tablist" aria-label={t('browser.tabs')}>
        {tabs.map((tab) => (
          <div key={tab.id} className={`browser-tab ${tab.active ? 'on' : ''}`} role="presentation">
            <button role="tab" aria-selected={tab.active} className="bt-name" title={tab.url || tabName(tab)} onClick={() => void api().browserSwitchTab(tab.id)}>
              {tab.loading && <span className="spin" aria-hidden />}
              <span className="bt-label">{tabName(tab)}</span>
            </button>
            <button className="bt-close" onClick={() => void api().browserCloseTab(tab.id)} title={t('browser.closeTab')} aria-label={`${t('browser.closeTab')}: ${tabName(tab)}`}>
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
        <button className="icon-btn bt-new" disabled={tabs.length >= BROWSER_MAX_TABS} onClick={() => void api().browserNewTab()} title={tabs.length >= BROWSER_MAX_TABS ? t('browser.tabsFull', { n: BROWSER_MAX_TABS }) : t('browser.newTab')} aria-label={t('browser.newTab')}>
          <Icon name="plus" size={14} />
        </button>
      </div>
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
      {/* Sign-ins from other projects' browsers (or the one before 1.3.1): this project's agents get them only if you say so. */}
      {state?.signInsFrom && state.signInsFrom.length > 0 && <SignInsOffer sites={state.signInsFrom} earlier={state.signInsEarlier} />}
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

/**
 * The offer to bring sign-ins this project's browser doesn't have: from other projects, one site at a
 * time (a click on its name) or all, so only the accounts you pick reach this project's agents; from
 * the browser before 1.3.1, all of them at once, as before.
 */
export function SignInsOffer({ sites, earlier }: { sites: string[]; earlier: boolean }) {
  const t = useT();
  const listed = sites.length > 4 ? `${sites.slice(0, 4).join(', ')} +${sites.length - 4}` : sites.join(', ');
  return (
    <div className="browser-signins" role="note">
      <span className="bsi-text">{earlier ? t('browser.signIns', { sites: listed }) : t('browser.signInsOther')}</span>
      {!earlier && (
        <span className="bsi-sites">
          {sites.slice(0, 8).map((site) => (
            <button key={site} className="bsi-site" title={t('browser.signInsOne', { site })} onClick={() => void api().browserSignIns(true, site)}>
              {site}
            </button>
          ))}
          {sites.length > 8 && <span className="bsi-more">+{sites.length - 8}</span>}
        </span>
      )}
      <span className="bsi-actions">
        <button onClick={() => void api().browserSignIns(true)}>{earlier ? t('browser.signInsBring') : t('browser.signInsAll')}</button>
        <button className="quiet" onClick={() => void api().browserSignIns(false)}>
          {t('browser.signInsSkip')}
        </button>
      </span>
    </div>
  );
}
