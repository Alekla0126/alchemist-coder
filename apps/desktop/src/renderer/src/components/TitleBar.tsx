import { keys } from '../keys';
import type { Mode } from '@shared/api';
import { useShallow } from 'zustand/react/shallow';
import { useStore, useT, waitingRuns } from '../store';
import { needsYou } from './Bots';
import { LogoMark } from './Logo';
import { Icon, type IconName } from './Icon';
import { toggleSidebar, toggleSplitSide, useLayout, useViewport } from '../layout';
import { openMenu } from '../ui';

const MODES: Mode[] = ['agents', 'arena', 'code', 'split', 'terminal', 'history', 'bots', 'marketing', 'board'];
/** Modes with a sidebar the title bar button can fold. */
export const WITH_SIDEBAR = new Set<Mode>(['agents', 'arena', 'code', 'split', 'terminal', 'bots']);
export const MODE_ICON: Record<Mode, IconName> = { agents: 'agents', arena: 'arena', code: 'code', split: 'split', terminal: 'terminal', history: 'history', bots: 'bots', marketing: 'marketing', board: 'board' };
const shortcut = (m: Mode) => keys(`⌘${MODES.indexOf(m) + 1}`);

export function TitleBar() {
  const t = useT();
  const mode = useStore((s) => s.settings.mode);
  const setMode = useStore((s) => s.setMode);
  const info = useStore((s) => s.info);
  const project = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId));
  const selection = useStore((s) => s.selection);
  const waitingList = useStore(useShallow((s) => waitingRuns(s).map((w) => `${w.sessionId ?? ''}|${w.projectId ?? ''}`)));
  // Plans to review count even when the coordinator stopped: answering resumes it (the same rule as the list).
  const plans = useStore(useShallow((s) => s.botTeams.filter((x) => x.plan?.status === 'pending' && needsYou(x)).map((x) => x.id)));
  // An automation's questions count too.
  const asks = useStore(useShallow((s) => s.automations.flatMap((x) => (x.runs[0]?.asks ?? []).map((a) => `${x.automation.id}:${a.id}`))));
  const waiting = [...waitingList, ...plans, ...asks];
  /** The next conversation (or new one) whose agent waits for you. */
  const goToWaiting = async () => {
    const s = useStore.getState();
    const next = waitingRuns(s)[0];
    const plan = s.botTeams.find((x) => x.plan?.status === 'pending');
    const asking = s.automations.find((x) => x.runs[0]?.asks.length);
    if (!next && !plan && asking) {
      s.setMode('bots');
      useStore.setState({ activeAutomationId: asking.automation.id, activeTeamId: null, activeMemberId: null, activeBotId: null });
      return;
    }
    if (!next && plan) {
      s.setMode('bots');
      useStore.setState({ activeTeamId: plan.id, activeBotId: plan.bots[0]?.id ?? null, activeMemberId: null });
      return;
    }
    if (!next) return;
    // A bot waiting for you: open its team in the Bots view.
    const team = s.botTeams.find((x) => x.bots.some((b) => b.runId === next.runId));
    if (team) {
      s.setMode('bots');
      useStore.setState({ activeTeamId: team.id, activeBotId: team.bots.find((b) => b.runId === next.runId)!.id, activeMemberId: null });
      return;
    }
    if (s.settings.mode !== 'agents' && s.settings.mode !== 'split') s.setMode('agents');
    if (next.sessionId) await s.select(next.sessionId, 'main');
    else if (next.projectId != null) {
      if (s.settings.activeProjectId !== next.projectId) await s.setActiveProject(next.projectId);
      s.setCompose(next.projectId);
    }
  };
  const title = useStore((s) => {
    const id = s.selection?.sessionId;
    if (!id) return undefined;
    const pid = s.settings.activeProjectId;
    return (pid != null ? s.sessions[pid]?.find((x) => x.id === id)?.title : undefined) ?? s.trees[id]?.description;
  });
  const allScope = useStore((s) => s.agentsScope === 'all');
  const narrow = useViewport((v) => v.narrow);
  const drawer = useViewport((v) => v.drawer);
  const sideHidden = useLayout((l) => l.sideHidden);
  const splitSideHidden = useLayout((l) => l.splitSideHidden);
  const agentLabel = t(splitSideHidden ? 'layout.showAgent' : 'layout.hideAgent');
  // What the button would do: open when the sidebar is out of sight, close when it shows.
  const sideShown = narrow ? drawer : !sideHidden;
  const sideLabel = t(sideShown ? 'layout.hideSidebar' : 'layout.showSidebar');
  const pickMode = async () => {
    const id = await openMenu(MODES.map((m) => ({ id: m, label: t(`mode.${m}`), checked: m === mode, accelerator: `CmdOrCtrl+${MODES.indexOf(m) + 1}` })));
    if (id) setMode(id as Mode);
  };
  return (
    <header className="titlebar">
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
      <nav className="modes" aria-label="Modes">
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
        {mode === 'split' && (
          <button className="icon-btn side-toggle" onClick={toggleSplitSide} title={`${agentLabel} (${keys('⌘⌥B')})`} aria-label={agentLabel} aria-expanded={!splitSideHidden}>
            <Icon name={splitSideHidden ? 'panelRightOpen' : 'panelRightClose'} size={17} />
          </button>
        )}
        {waiting.length > 0 && (
          <button className="needs-you-btn" onClick={() => void goToWaiting()} title={t('attention.goTo')}>
            ● {t('attention.needYou', { n: waiting.length })}
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
