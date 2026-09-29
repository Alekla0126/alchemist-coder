import type { Mode } from '@shared/api';
import { useShallow } from 'zustand/react/shallow';
import { useStore, useT, waitingRuns } from '../store';
import { needsYou } from './Bots';
import { LogoMark } from './Logo';

const MODES: Mode[] = ['agents', 'arena', 'code', 'split', 'terminal', 'history', 'bots'];

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
  const waiting = [...waitingList, ...plans];
  /** The next conversation (or new one) whose agent waits for you. */
  const goToWaiting = async () => {
    const s = useStore.getState();
    const next = waitingRuns(s)[0];
    const plan = s.botTeams.find((x) => x.plan?.status === 'pending');
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
  return (
    <header className="titlebar">
      <div className="brand">
        <span className="logo">
          <LogoMark size={20} />
        </span>
        <span>Alchemist Coder</span>
      </div>
      <div className="crumb">
        {project && <b>{project.name}</b>}
        {selection && title && <span> / {title}</span>}
      </div>
      <nav className="modes" aria-label="Modes">
        {MODES.map((m) => (
          <button key={m} className={m === mode ? 'on' : ''} onClick={() => setMode(m)}>
            {t(`mode.${m}`)}
          </button>
        ))}
      </nav>
      <div className="title-right">
        {waiting.length > 0 && (
          <button className="needs-you-btn" onClick={() => void goToWaiting()} title={t('attention.goTo')}>
            ● {t('attention.needYou', { n: waiting.length })}
          </button>
        )}
        <button className="title-search" onClick={() => useStore.setState({ paletteOpen: true })} title={t('palette.placeholder')}>
          <span>⌕</span> {t('title.search')} <kbd>⌘K</kbd>
        </button>
        <button className="icon-btn title-gear" onClick={() => useStore.setState({ settingsOpen: true })} title={`${t('settings.title')} (⌘,)`} aria-label={t('settings.title')}>
          ⚙
        </button>
        <button className={`chip edition ${info?.edition === 'pro' ? 'pro' : ''}`} title={t('usage.title')} onClick={() => useStore.setState({ settingsOpen: true, settingsSection: 'usage' })}>
          {info?.edition === 'pro' ? 'Pro' : t('status.edition')}
        </button>
      </div>
    </header>
  );
}
