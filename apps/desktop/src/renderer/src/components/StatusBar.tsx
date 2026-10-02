import { useEffect } from 'react';
import { useStore, useT } from '../store';
import { UsageMeter } from './UsageMeter';
import { ActivityBar } from './ActivityBar';
import { useGit } from '../git-store';
import { gitSummary } from './GitPanel';
import { Icon } from './Icon';
import { useLayout, useViewport } from '../layout';

export function StatusBar() {
  const t = useT();
  const progress = useStore((s) => s.progress);
  const projects = useStore((s) => s.projects);
  const info = useStore((s) => s.info);
  const sessions = projects.reduce((n, p) => n + p.sessionCount, 0);
  const cwd = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId)?.cwd);
  const git = gitSummary(useGit((g) => (cwd ? g.byCwd[cwd] : undefined)));
  const load = useGit((g) => g.load);
  // The status bar keeps the branch in sight even when the Git tab isn't open.
  useEffect(() => {
    if (!cwd) return;
    void load(cwd);
    const id = setInterval(() => document.visibilityState === 'visible' && void load(cwd), 30_000);
    return () => clearInterval(id);
  }, [cwd, load]);
  const openGit = () => {
    const s = useStore.getState();
    if (!['agents', 'code', 'split', 'terminal'].includes(s.settings.mode)) s.setMode('agents');
    s.setSidebarTab('git');
    if (useViewport.getState().narrow) useViewport.setState({ drawer: true });
    else if (useLayout.getState().sideHidden) useLayout.setState({ sideHidden: false });
  };
  return (
    <footer className="status">
      <span className="l status-index">
        {progress.phase === 'ready' ? (
          t('index.ready', { sessions, projects: projects.length })
        ) : progress.phase === 'scanning' ? (
          <>
            <span className="spin" /> {t('index.scanning')}
          </>
        ) : (
          <>
            <span className="spin" /> {t('index.indexing', { done: progress.done, total: progress.total })}
          </>
        )}
      </span>
      <ActivityBar />
      {git && (
        <button className="l status-git" onClick={openGit} title={t('git.statusTip')}>
          <Icon name="branch" size={12} /> {git.branch}
          {git.changes > 0 && <span className="sg-changes">{t('git.statusChanges', { n: git.changes })}</span>}
          {git.ahead > 0 && <span className="sg-ahead">{git.ahead}↑</span>}
          {git.behind > 0 && <span className="sg-behind">{git.behind}↓</span>}
        </button>
      )}
      <span className="sp" />
      <UsageMeter />
      {info && <span className="l">v{info.version}</span>}
    </footer>
  );
}
