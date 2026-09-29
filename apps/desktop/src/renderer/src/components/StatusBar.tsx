import { useStore, useT } from '../store';
import { UsageMeter } from './UsageMeter';

export function StatusBar() {
  const t = useT();
  const progress = useStore((s) => s.progress);
  const projects = useStore((s) => s.projects);
  const info = useStore((s) => s.info);
  const sessions = projects.reduce((n, p) => n + p.sessionCount, 0);
  const running = projects.reduce((n, p) => n + p.runningAgents, 0);
  return (
    <footer className="status">
      <span className="l">
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
      {running > 0 && <span className="l run">● {t('status.runningAgents', { n: running })}</span>}
      <span className="sp" />
      <UsageMeter />
      {info && <span className="l">v{info.version}</span>}
    </footer>
  );
}
