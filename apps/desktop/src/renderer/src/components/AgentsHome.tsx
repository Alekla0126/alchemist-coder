import type { SessionSummary } from '@alchemist-coder/core';
import { initials, projectGradient, relativeTime } from '../format';
import { sourceOf } from '../sources';
import { useStore, useT } from '../store';
import { openMenu } from '../ui';
import { LogoMark } from './Logo';

const isLive = (s: SessionSummary) => s.runningAgents > 0 || s.status === 'running';

/**
 * The all-projects home: what every agent in every open project is doing, in one screen. Who needs
 * you first, then who's working, then the latest conversations; a click opens one where it is.
 */
export function AgentsHome() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const openIds = useStore((s) => s.settings.openProjectIds);
  const projects = useStore((s) => s.projects);
  const recent = useStore((s) => s.recent);
  const runs = useStore((s) => s.runs);
  const runByTarget = useStore((s) => s.runByTarget);
  const select = useStore((s) => s.select);
  const openProject = useStore((s) => s.openProject);
  const setCompose = useStore((s) => s.setCompose);
  const setScope = useStore((s) => s.setAgentsScope);
  const open = openIds.map((id) => projects.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
  const byId = new Map(open.map((p) => [p.id, p]));
  const all = open.flatMap((p) => recent[p.id] ?? []);
  const waiting = (s: SessionSummary) => runs[runByTarget[`s:${s.id}`] ?? '']?.status === 'waiting';
  const needs = all.filter(waiting);
  const working = all.filter((s) => isLive(s) && !waiting(s));
  const latest = all
    .filter((s) => !isLive(s) && !waiting(s))
    .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
    .slice(0, 8);

  const newIn = async () => {
    if (open.length === 1) return void openProject(open[0]!.id).then(() => setCompose(open[0]!.id));
    const id = await openMenu(open.map((p) => ({ id: String(p.id), label: p.name })));
    if (id) {
      await openProject(Number(id));
      setCompose(Number(id));
    }
  };

  const row = (s: SessionSummary, kind: 'needs' | 'live' | 'done') => {
    const p = byId.get(s.projectId);
    return (
      <button key={s.id} className={`home-row is-${kind}`} onClick={() => void select(s.id, 'main')} title={s.title}>
        {p && (
          <span className="home-proj">
            <span className="avatar xs" style={{ background: projectGradient(p.name) }}>{initials(p.name)}</span>
            {p.name}
          </span>
        )}
        <span className="src" title={sourceOf(s.source).label}>
          {sourceOf(s.source).glyph}
        </span>
        <span className="home-title">{s.title}</span>
        {kind === 'needs' ? (
          <span className="needs-you-pill">{t('attention.waiting')}</span>
        ) : kind === 'live' ? (
          <span className="start-live" title={t('status.running')}>
            ● {relativeTime(s.lastTs, locale)}
          </span>
        ) : (
          <span className="start-when">{relativeTime(s.lastTs, locale)}</span>
        )}
      </button>
    );
  };

  return (
    <div className="start agents-home">
      <div className="start-logo">
        <LogoMark size={56} />
      </div>
      <h2>{t('home.title')}</h2>
      <p className="start-path">
        {t('home.sub', { n: open.length })}
        {working.length + needs.length > 0 && ` · ${t('home.working', { n: working.length + needs.length })}`}
      </p>
      {open.length > 0 && (
        <button className="btn-send start-new" onClick={() => void newIn()}>
          + {t('home.new')}
        </button>
      )}
      {needs.length > 0 && (
        <section className="start-sec">
          <h3>{t('home.needs')}</h3>
          {needs.map((s) => row(s, 'needs'))}
        </section>
      )}
      <section className="start-sec">
        <h3>{t('home.running')}</h3>
        {working.length ? working.map((s) => row(s, 'live')) : <p className="empty sm">{t('home.nothing')}</p>}
      </section>
      {latest.length > 0 && (
        <section className="start-sec">
          <h3>{t('home.recent')}</h3>
          {latest.map((s) => row(s, 'done'))}
        </section>
      )}
      {open.length > 1 && (
        <section className="start-sec">
          <h3>{t('home.projects')}</h3>
          <div className="home-projects">
            {open.map((p) => {
              const live = (recent[p.id] ?? []).filter(isLive).length;
              return (
                <button key={p.id} className="home-project" title={p.cwd} onClick={() => void openProject(p.id).then(() => setScope('project'))}>
                  <span className="avatar sm" style={{ background: projectGradient(p.name) }}>{initials(p.name)}</span>
                  <span className="home-project-text">
                    <b>{p.name}</b>
                    <small className={live > 0 ? 'live' : ''}>{live > 0 ? `● ${t('home.working', { n: live })}` : relativeTime(p.lastTs, locale)}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
