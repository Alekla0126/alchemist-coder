import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { keys } from '../keys';
import { fitModes, modesRoom, type ModeFit } from '../mode-fit';
import type { Mode } from '@shared/api';
import { nextPlace, waitingPlaces, type Place } from '../needs-you';
import { sessionTitle, useStore, useT } from '../store';
import { LogoMark } from './Logo';
import { Icon, type IconName } from './Icon';
import { openBrowser, toggleBrowser, toggleSidebar, toggleSplitSide, useLayout, useViewport } from '../layout';
import { openMenu } from '../ui';

const MODES: Mode[] = ['agents', 'arena', 'code', 'split', 'terminal', 'history', 'bots', 'marketing', 'board'];
/** Modes with a sidebar the title bar button can fold. */
export const WITH_SIDEBAR = new Set<Mode>(['agents', 'arena', 'code', 'split', 'terminal', 'bots']);
export const MODE_ICON: Record<Mode, IconName> = { agents: 'agents', arena: 'arena', code: 'code', split: 'split', terminal: 'terminal', history: 'history', bots: 'bots', marketing: 'marketing', board: 'board' };
const shortcut = (m: Mode) => keys(`⌘${MODES.indexOf(m) + 1}`);
const FITS = ['full', 'active', 'icons'] as const;
/** The project name keeps at least this much next to the modes. */
const CRUMB_MIN = 120;

/** Which way of showing the modes fits the title bar now: measured, so it holds in every language. */
function useModeFit(header: React.RefObject<HTMLElement | null>, measure: React.RefObject<HTMLDivElement | null>): ModeFit {
  const [fit, setFit] = useState<ModeFit>('full');
  useLayoutEffect(() => {
    const h = header.current;
    const m = measure.current;
    if (!h || !m) return;
    const pick = () => {
      const cs = getComputedStyle(h);
      const gap = parseFloat(cs.columnGap) || 0;
      const width = (el: Element | null) => (el ? el.getBoundingClientRect().width : 0);
      const right = h.querySelector('.title-right');
      const rightGap = right ? parseFloat(getComputedStyle(right).columnGap) || 0 : 0;
      const rightContent = right ? [...right.children].reduce((sum, c) => sum + width(c), 0) + rightGap * Math.max(0, right.children.length - 1) : 0;
      const room = modesRoom({
        inner: h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        gap,
        fixedLeft: width(h.querySelector('.side-toggle')) + width(h.querySelector('.brand')),
        right: rightContent,
        // The project name hides on narrower windows (CSS): then it needs no room.
        crumbMin: getComputedStyle(h.querySelector('.crumb') ?? h).display === 'none' ? 0 : CRUMB_MIN,
      });
      const [full, active, icons] = [...m.children].map((c) => (c as HTMLElement).offsetWidth);
      setFit(fitModes(room, { full: full!, active: active!, icons: icons! }));
    };
    pick();
    // The window, the right side (a "needs you" pill comes and goes) and the labels (another language).
    const ro = new ResizeObserver(pick);
    for (const el of [h, h.querySelector('.title-right'), m]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [header, measure]);
  return fit;
}


/** Autopilot on or off: off it's an icon; on it says so, in the accent color, so it's never forgotten. */
function AutopilotButton() {
  const t = useT();
  const on = useStore((s) => s.settings.autopilot);
  const setAutopilot = useStore((s) => s.setAutopilot);
  // The coordinator's own switch: said here too while it's on, and a click goes to it.
  const orgOn = useStore((s) => s.orgSettings?.autopilot === true);
  const openCoordinator = () => {
    const s = useStore.getState();
    s.setMode('bots');
    useStore.setState({ activeMemberId: s.botConfigs.find((c) => c.kind === 'coordinator')?.id ?? null, activeTeamId: null, activeBotId: null });
  };
  return (
    <>
      {orgOn && !on && (
        <button className="autopilot-btn on" onClick={openCoordinator} title={t('org.autopilotPillTip')} aria-label={t('org.autopilotPill')}>
          <Icon name="plane" size={13} />
          <span className="ap-label">{t('org.autopilotPill')}</span>
        </button>
      )}
      <button className={`autopilot-btn ${on ? 'on' : 'icon-btn'}`} onClick={() => setAutopilot(!on)} title={t(on ? 'autopilot.onTip' : 'autopilot.offTip')} aria-label={t('autopilot.name')} aria-pressed={on}>
        <Icon name="plane" size={on ? 13 : 16} />
        {on && <span className="ap-label">{t('autopilot.name')}</span>}
      </button>
    </>
  );
}

/** What a waiting place is called: the conversation's title, the project, the bot, the task… */
function placeName(place: Place, s: ReturnType<typeof useStore.getState>, t: ReturnType<typeof useT>): string {
  switch (place.kind) {
    case 'session':
      return sessionTitle(s, place.sessionId) ?? t('attention.aConversation');
    case 'compose':
      return s.projects.find((p) => p.id === place.projectId)?.name ?? t('attention.aConversation');
    case 'bot':
      return s.botTeams.find((x) => x.id === place.teamId)?.bots.find((b) => b.id === place.botId)?.name ?? t('mode.bots');
    case 'plan': {
      const team = s.botTeams.find((x) => x.id === place.teamId);
      return team?.title || team?.goal.split('\n')[0] || t('mode.bots');
    }
    case 'arena':
      return s.tasks[place.taskId]?.title ?? t('mode.arena');
    case 'marketing':
      return t('mode.marketing');
    case 'automation':
      return s.automations.find((a) => a.automation.id === place.automationId)?.automation.name ?? t('mode.bots');
  }
}
export function TitleBar() {
  const t = useT();
  const mode = useStore((s) => s.settings.mode);
  const setMode = useStore((s) => s.setMode);
  const info = useStore((s) => s.info);
  const header = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const fit = useModeFit(header, measure);
  const project = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId));
  const selection = useStore((s) => s.selection);
  // What the button counts is what it can take you to: waiting runs, plans to review, automations' questions.
  const waiting = useStore((s) => waitingPlaces(s).length);
  // Its tooltip names where the next press goes: «Go to "Fix the login" (2 of 3)».
  const goToLabel = useStore((s) => {
    const places = waitingPlaces(s);
    const next = nextPlace(s);
    if (!next) return '';
    return t('attention.goToNamed', { name: placeName(next, s, t), i: places.findIndex((p) => p.key === next.key) + 1, n: places.length });
  });
  /**
   * Right to what waits for you, in the tab where you answer it (needs-you.ts): its conversation on
   * the main agent's tab, the Arena task, the bot, Marketing… With several, the next one you aren't on.
   */
  const goToWaiting = async () => {
    const s = useStore.getState();
    const place = nextPlace(s);
    if (!place) return;
    const show = (mode: Mode) => s.settings.mode !== mode && s.setMode(mode);
    switch (place.kind) {
      case 'session':
        if (s.settings.mode !== 'agents' && s.settings.mode !== 'split') s.setMode('agents');
        await s.select(place.sessionId, 'main');
        return;
      case 'compose':
        if (s.settings.mode !== 'agents' && s.settings.mode !== 'split') s.setMode('agents');
        if (s.settings.activeProjectId !== place.projectId) await s.setActiveProject(place.projectId);
        s.setCompose(place.projectId);
        return;
      case 'bot':
        show('bots');
        useStore.setState({ activeTeamId: place.teamId, activeBotId: place.botId, activeMemberId: null, activeAutomationId: null });
        return;
      case 'plan':
        show('bots');
        useStore.setState({ activeTeamId: place.teamId, activeBotId: place.botId, activeMemberId: null, activeAutomationId: null });
        return;
      case 'automation':
        show('bots');
        useStore.setState({ activeAutomationId: place.automationId, activeTeamId: null, activeMemberId: null, activeBotId: null });
        return;
      case 'arena':
        show('arena');
        s.setActiveTask(place.taskId);
        return;
      case 'marketing':
        show('marketing');
        return;
    }
  };
  const title = useStore((s) => {
    const id = s.selection?.sessionId;
    if (!id) return undefined;
    const pid = s.settings.activeProjectId;
    return (pid != null ? s.sessions[pid]?.find((x) => x.id === id)?.title : undefined) ?? s.trees[id]?.description;
  });
  const allScope = useStore((s) => s.agentsScope !== 'project');
  const narrow = useViewport((v) => v.narrow);
  const drawer = useViewport((v) => v.drawer);
  const sideHidden = useLayout((l) => l.sideHidden);
  const splitSideHidden = useLayout((l) => l.splitSideHidden);
  const agentLabel = t(splitSideHidden ? 'layout.showAgent' : 'layout.hideAgent');
  const browserOpen = useLayout((l) => l.browserOpen);
  // The globe is in every mode: agents in Marketing or Split use the browser too, and a dot says one is at it.
  const [driver, setDriver] = useState<string | null>(null);
  useEffect(() => {
    void window.alchemist.browserState().then((b) => setDriver(b.driver));
    return window.alchemist.onBrowserState((b) => setDriver(b.driver));
  }, []);
  const browserShown = mode === 'agents' && browserOpen;
  const browserLabel = driver !== null ? t('browser.driving', { agent: driver || t('browser.anAgent') }) : t(browserShown ? 'browser.hide' : 'browser.show');
  // The browser's panel lives next to the conversation (Agents): from elsewhere the globe takes you there.
  const onGlobe = () => {
    if (mode === 'agents') return toggleBrowser();
    setMode('agents');
    openBrowser();
  };
  // What the button would do: open when the sidebar is out of sight, close when it shows.
  const sideShown = narrow ? drawer : !sideHidden;
  const sideLabel = t(sideShown ? 'layout.hideSidebar' : 'layout.showSidebar');
  const pickMode = async () => {
    const id = await openMenu(MODES.map((m) => ({ id: m, label: t(`mode.${m}`), checked: m === mode, accelerator: `CmdOrCtrl+${MODES.indexOf(m) + 1}` })));
    if (id) setMode(id as Mode);
  };
  return (
    <header className={`titlebar modes-${fit}`} ref={header}>
      {/* Always in the same place (kept invisible in modes without a sidebar, so nothing shifts). */}
      <button
        className={`icon-btn side-toggle ${WITH_SIDEBAR.has(mode) ? '' : 'off'}`}
        onClick={toggleSidebar}
        title={`${sideLabel} (${keys('⌘B')})`}
        aria-label={sideLabel}
        aria-expanded={sideShown}
        aria-hidden={!WITH_SIDEBAR.has(mode)}
        tabIndex={WITH_SIDEBAR.has(mode) ? 0 : -1}
      >
        <Icon name={sideShown ? 'sidebarClose' : 'sidebarOpen'} size={17} />
      </button>
      <div className="brand">
        <span className="logo">
          <LogoMark size={20} />
        </span>
        <span>Alchemist Coder</span>
      </div>
      <div className="crumb">
        {/* The board over all projects isn't about one project. */}
        {project && !(mode === 'board' && allScope) && <b>{project.name}</b>}
        {selection && title && <span> / {title}</span>}
      </div>
      {/* The modes each way they can show, unseen, to measure which one fits. */}
      <div className="modes-measure" ref={measure} aria-hidden inert>
        {FITS.map((f) => (
          <nav key={f} className={`modes fit-${f}`}>
            {MODES.map((m) => (
              <button key={m} className={m === mode ? 'on' : ''} tabIndex={-1}>
                <Icon name={MODE_ICON[m]} size={15} className="m-ic" />
                <span className="m-label">{t(`mode.${m}`)}</span>
              </button>
            ))}
          </nav>
        ))}
      </div>
      <nav className={`modes fit-${fit === 'menu' ? 'icons' : fit}`} aria-label="Modes">
        {MODES.map((m) => (
          <button key={m} className={m === mode ? 'on' : ''} onClick={() => setMode(m)} title={`${t(`mode.${m}`)} (${shortcut(m)})`} aria-current={m === mode ? 'page' : undefined}>
            <Icon name={MODE_ICON[m]} size={15} className="m-ic" />
            <span className="m-label">{t(`mode.${m}`)}</span>
          </button>
        ))}
      </nav>
      {/* Half a screen has no room for every mode: one button lists them. */}
      <button className="mode-menu" onClick={() => void pickMode()} aria-haspopup="menu" title={t('title.modes')}>
        <Icon name={MODE_ICON[mode]} size={15} />
        <span>{t(`mode.${mode}`)}</span>
        <Icon name="chevronDown" size={13} />
      </button>
      <div className="title-right">
        <button className={`icon-btn browser-toggle ${browserShown ? 'on' : ''}`} onClick={onGlobe} title={browserLabel} aria-label={browserLabel} aria-expanded={browserShown}>
          <Icon name="globe" size={16} />
          {driver !== null && <span className="globe-live" aria-hidden />}
        </button>
        {mode === 'split' && (
          <button className="icon-btn side-toggle" onClick={toggleSplitSide} title={`${agentLabel} (${keys('⌘⌥B')})`} aria-label={agentLabel} aria-expanded={!splitSideHidden}>
            <Icon name={splitSideHidden ? 'panelRightOpen' : 'panelRightClose'} size={17} />
          </button>
        )}
        <AutopilotButton />
        {waiting > 0 && (
          <button className="needs-you-btn" onClick={() => void goToWaiting()} title={goToLabel || t('attention.goTo')}>
            ● {t('attention.needYou', { n: waiting })}
          </button>
        )}
        <button className="title-search" onClick={() => useStore.setState({ paletteOpen: true })} title={t('palette.placeholder')}>
          <Icon name="search" size={14} /> <span className="ts-label">{t('title.search')}</span> <kbd>{keys('⌘K')}</kbd>
        </button>
        <button className="icon-btn title-gear" onClick={() => useStore.setState({ settingsOpen: true })} title={`${t('settings.title')} (${keys('⌘,')})`} aria-label={t('settings.title')}>
          ⚙
        </button>
        <button className={`chip edition ${info?.edition === 'pro' ? 'pro' : ''}`} title={t('usage.title')} onClick={() => useStore.setState({ settingsOpen: true, settingsSection: 'usage' })}>
          {info?.edition === 'pro' ? 'Pro' : t('status.edition')}
        </button>
      </div>
    </header>
  );
}
