import { useEffect, useState } from 'react';
import type { SessionSummary } from '@alchemist-coder/core';
import { showSessionMenu } from '../actions/session';
import { initials, projectGradient, relativeTime } from '../format';
import { useStore, useT, type SessionFilter } from '../store';
import { isUnread, useViewed } from '../attention';
import { contextMenu, toast } from '../ui';
import { collapseRepeats, groupSessions, matchesQuery } from '../session-groups';
import { sourceOf } from '../sources';
import { AgentTree } from './AgentTree';
import { ExtensionsHub } from './ExtensionsHub';
import { FileTree } from './FileTree';

/** Several conversations with the same title, as one row that opens. */
function RepeatedRow({ title, items }: { title: string; items: SessionSummary[] }) {
  const t = useT();
  const key = `r:${items[0]!.projectId}:${title}`;
  const open = useStore((s) => s.expanded[key] ?? false);
  const toggle = useStore((s) => s.toggle);
  const selected = useStore((s) => items.some((x) => x.id === s.selection?.sessionId));
  const hideAll = async () => {
    for (const s of items) await window.alchemist.hideSession(s.id, true);
    await useStore.getState().sessionsChanged(items[0]!.projectId);
    toast(t('side.hiddenMany', { n: items.length }), {
      label: t('menu.undo'),
      run: () => void Promise.all(items.map((s) => window.alchemist.hideSession(s.id, false))).then(() => useStore.getState().sessionsChanged(items[0]!.projectId)),
    });
  };
  return (
    <div className="session repeated">
      <div
        className={`row session-row ${selected && !open ? 'sel' : ''}`}
        title={title}
        onClick={() => toggle(key)}
        onContextMenu={contextMenu(() => [{ id: 'hide-all', label: t('side.hideAll', { n: items.length }) }], (id) => id === 'hide-all' && void hideAll())}
      >
        <span className="car">{open ? '▾' : '▸'}</span>
        <span className="src">{sourceOf(items[0]!.source).glyph}</span>
        <span className="tt">{title}</span>
        <span className="r">
          <span className="repeat-count">×{items.length}</span>
        </span>
      </div>
      {open && (
        <div className="repeated-items">
          {items.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SessionRow({ session }: { session: SessionSummary }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const key = `s:${session.id}`;
  const open = useStore((s) => s.expanded[key] ?? false);
  const tree = useStore((s) => s.trees[session.id]);
  const selected = useStore((s) => s.selection?.sessionId === session.id);
  const unread = useViewed((v) => !selected && isUnread(session, v));
  const waiting = useStore((s) => s.runs[s.runByTarget[`s:${session.id}`] ?? '']?.status === 'waiting');
  const toggle = useStore((s) => s.toggle);
  const loadTree = useStore((s) => s.loadTree);
  const select = useStore((s) => s.select);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  useEffect(() => {
    if (open && tree === undefined) void loadTree(session.id);
  }, [open, tree, session.id, loadTree]);
  return (
    <div className="session">
      <div
        className={`row session-row ${selected && !open ? 'sel' : ''}`}
        title={session.title}
        onClick={() => {
          if (!open) toggle(key);
          void select(session.id, 'main');
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          void showSessionMenu(session);
        }}
      >
        <span
          className="car"
          onClick={(e) => {
            e.stopPropagation();
            toggle(key);
          }}
        >
          {open ? '▾' : '▸'}
        </span>
        <span className="src" title={sourceOf(session.source).label}>
          {sourceOf(session.source).glyph}
        </span>
        <span className={`tt ${unread ? 'unread' : ''}`}>{session.title}</span>
        <span className="r">
          {/* One indicator at a time: a working conversation shows its count; unread is the bold title. */}
          {unread && !waiting && !session.runningAgents && <span className="unread-dot" title={t('attention.unread')} />}
          {session.favorite && <span className="pin-mark" title={t('favorite.remove')}>📌</span>}
          {/* Waiting for you outranks "running": one clear pill instead of a dot and a count. */}
          {waiting ? (
            <span className="needs-you-pill" title={t('attention.waiting')}>
              {t('attention.needsYouPill')}
            </span>
          ) : session.runningAgents > 0 ? (
            <span className="badge-run" title={t('status.runningAgents', { n: session.runningAgents })}>● {session.runningAgents}</span>
          ) : (
            relativeTime(session.lastTs, locale)
          )}
        </span>
        <span className="row-actions">
        <button
          className={`star ${session.favorite ? 'on' : ''}`}
          title={session.favorite ? t('favorite.remove') : t('favorite.add')}
          onClick={(e) => {
            e.stopPropagation();
            void toggleFavorite(session);
          }}
        >
          ★
        </button>
        <button
          className="row-more"
          title={t('menu.more')}
          onClick={(e) => {
            e.stopPropagation();
            void showSessionMenu(session);
          }}
        >
          ⋯
        </button>
        </span>
      </div>
      {open && tree && <AgentTree sessionId={session.id} root={tree} />}
    </div>
  );
}

const FILTERS: SessionFilter[] = ['all', 'running', 'favorites'];
const isLive = (s: SessionSummary) => s.runningAgents > 0 || s.status === 'running';
const passes = (s: SessionSummary, filter: SessionFilter, query: string) =>
  (filter === 'running' ? isLive(s) : filter === 'favorites' ? s.favorite : true) && matchesQuery(s, query);

const collapsedKey = 'alchemist.allCollapsed';
const readCollapsed = (): number[] => {
  try {
    return JSON.parse(localStorage.getItem(collapsedKey) ?? '[]') as number[];
  } catch {
    return [];
  }
};

/**
 * Every open project at once, centered on the agents: each project's latest conversations (the ones
 * working first), without switching projects. Only a few per project are loaded.
 */
function AllProjects({ filter, query }: { filter: SessionFilter; query: string }) {
  const t = useT();
  const openIds = useStore((s) => s.settings.openProjectIds);
  const projects = useStore((s) => s.projects);
  const recent = useStore((s) => s.recent);
  const openProject = useStore((s) => s.openProject);
  const setCompose = useStore((s) => s.setCompose);
  const setScope = useStore((s) => s.setAgentsScope);
  const [collapsed, setCollapsed] = useState<number[]>(readCollapsed);
  const toggle = (id: number) => {
    const next = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id];
    setCollapsed(next);
    localStorage.setItem(collapsedKey, JSON.stringify(next));
  };
  const open = openIds.map((id) => projects.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
  if (!open.length) return <p className="empty">{t('all.empty')}</p>;
  return (
    <div className="tree all-projects">
      {open.map((p) => {
        const list = (recent[p.id] ?? []).filter((s) => passes(s, filter, query)).sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (b.lastTs ?? 0) - (a.lastTs ?? 0));
        const live = (recent[p.id] ?? []).filter(isLive).length;
        const shut = collapsed.includes(p.id);
        // A filter or search leaves out projects with nothing to show.
        if ((filter !== 'all' || query) && !list.length) return null;
        return (
          <div key={p.id} className="all-group" role="group" aria-label={p.name}>
            <div className="all-head">
              <button className="all-toggle" aria-expanded={!shut} onClick={() => toggle(p.id)} title={p.cwd}>
                <span className="car">{shut ? '▸' : '▾'}</span>
                <span className="avatar sm" style={{ background: projectGradient(p.name) }}>{initials(p.name)}</span>
                <b>{p.name}</b>
                {live > 0 && <span className="all-live" title={t('filter.running')}>● {live}</span>}
              </button>
              <button
                className="all-new"
                title={t('plus.conversation', { name: p.name })}
                aria-label={t('plus.conversation', { name: p.name })}
                onClick={() => void openProject(p.id).then(() => setCompose(p.id))}
              >
                ＋
              </button>
            </div>
            {!shut && (
              <>
                {collapseRepeats(list).map((c) => (c.kind === 'one' ? <SessionRow key={c.item.id} session={c.item} /> : <RepeatedRow key={`r:${c.items[0]!.id}`} title={c.title} items={c.items} />))}
                {recent[p.id] === undefined && <p className="empty sm">…</p>}
                {recent[p.id] !== undefined && !list.length && <p className="empty sm">{t('side.noSessions')}</p>}
                {filter === 'all' && !query && p.sessionCount > list.length && (
                  <button className="all-more" onClick={() => void openProject(p.id).then(() => setScope('project'))}>
                    {t('all.seeAll', { n: p.sessionCount })}
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Conversations hidden in this project, to bring back. */
function HiddenSessions({ projectId }: { projectId: number }) {
  const t = useT();
  const revision = useStore((s) => s.revision);
  const sessionsChanged = useStore((s) => s.sessionsChanged);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<SessionSummary[]>([]);
  useEffect(() => {
    void window.alchemist.hiddenSessions().then((list) => setHidden(list.filter((s) => s.projectId === projectId)));
  }, [projectId, revision]);
  if (!hidden.length) return null;
  return (
    <div className="hidden-sessions">
      <button className="load-more" onClick={() => setOpen(!open)}>
        {open ? t('side.hideHidden') : t('side.showHidden', { n: hidden.length })}
      </button>
      {open &&
        hidden.map((s) => (
          <div key={s.id} className="row hidden-row" title={s.title}>
            <span className="tt">{s.title}</span>
            <button className="btn-ghost small" onClick={() => void window.alchemist.hideSession(s.id, false).then(() => sessionsChanged(projectId))}>
              {t('side.unhide')}
            </button>
          </div>
        ))}
    </div>
  );
}

export function Sidebar() {
  const t = useT();
  const activeId = useStore((s) => s.settings.activeProjectId);
  const project = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId));
  const sessions = useStore((s) => (activeId != null ? s.sessions[activeId] : undefined));
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const scope = useStore((s) => s.agentsScope);
  const setScope = useStore((s) => s.setAgentsScope);
  const recent = useStore((s) => s.recent);
  const setCompose = useStore((s) => s.setCompose);
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const [query, setQuery] = useState('');
  useEffect(() => setQuery(''), [activeId]);
  const shown = (sessions ?? []).filter((s) => passes(s, filter, query));
  const groups = groupSessions(shown);
  const running = scope === 'all' ? Object.values(recent).flat().filter(isLive).length : (sessions ?? []).filter(isLive).length;
  return (
    <aside className="side">
      <div className="stabs">
        <button className={tab === 'agents' ? 'on' : ''} onClick={() => setTab('agents')}>
          ⚗ {t('side.agents')}
        </button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
          ▤ {t('side.files')}
        </button>
        <button className={tab === 'extensions' ? 'on' : ''} onClick={() => setTab('extensions')}>
          ◈ {t('side.extensions')}
        </button>
      </div>
      {tab === 'files' ? (
        <FileTree />
      ) : tab === 'extensions' ? (
        <ExtensionsHub />
      ) : (
        <>
      <div className="scope" role="tablist" aria-label={t('scope.label')}>
        {(['project', 'all'] as const).map((sc) => (
          <button key={sc} role="tab" aria-selected={scope === sc} className={scope === sc ? 'on' : ''} onClick={() => setScope(sc)}>
            {t(`scope.${sc}`)}
          </button>
        ))}
      </div>
      <div className="filters">
        {FILTERS.map((f) => (
          <button key={f} className={`f ${f === filter ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {t(`filter.${f}`)}
            {f === 'running' && running > 0 ? ` · ${running}` : ''}
          </button>
        ))}
      </div>
      {scope === 'all' ? (
        <>
          <div className="side-filter">
            <input
              type="search"
              value={query}
              placeholder={t('side.filter')}
              aria-label={t('side.filter')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            />
          </div>
          <AllProjects filter={filter} query={query} />
        </>
      ) : (
        <>
      <div className="sec sec-row">
        <span>
          {project?.name ?? ''} · {t('side.conversations')}
        </span>
        {activeId != null && (
          <button className="new-btn" title={t('run.new')} onClick={() => setCompose(activeId)}>
            ＋ {t('run.newShort')}
          </button>
        )}
      </div>
      {(sessions?.length ?? 0) > 6 && (
        <div className="side-filter">
          <input
            type="search"
            value={query}
            placeholder={t('side.filter')}
            aria-label={t('side.filter')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
        </div>
      )}
      <div className="tree">
        {groups.map(({ group, items }) => (
          <div key={group} className="side-group" role="group" aria-label={t(`group.${group}`)}>
            {/* One group only (e.g. everything from today) needs no heading. */}
            {groups.length > 1 && <div className="side-group-title">{t(`group.${group}`)}</div>}
            {collapseRepeats(items).map((c) => (c.kind === 'one' ? <SessionRow key={c.item.id} session={c.item} /> : <RepeatedRow key={`r:${c.items[0]!.id}`} title={c.title} items={c.items} />))}
          </div>
        ))}
        {sessions && shown.length === 0 && <p className="empty">{query ? t('side.noMatches') : t('side.noSessions')}</p>}
        {activeId != null && <HiddenSessions projectId={activeId} />}
      </div>
        </>
      )}
        </>
      )}
    </aside>
  );
}
