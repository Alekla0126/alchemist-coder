import { useEffect, useState } from 'react';
import type { SessionSummary } from '@alchemist-coder/core';
import { showSessionMenu } from '../actions/session';
import { relativeTime } from '../format';
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

function SessionRow({ session }: { session: SessionSummary }) {
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
          {unread && !waiting && <span className="unread-dot" title={t('attention.unread')} />}
          {session.favorite && <span className="pin-mark" title={t('favorite.remove')}>📌</span>}
          {/* Waiting for you outranks "running": one clear pill instead of a dot and a count. */}
          {waiting ? (
            <span className="needs-you-pill" title={t('attention.waiting')}>
              {t('attention.needsYouPill')}
            </span>
          ) : session.runningAgents > 0 ? (
            <span className="badge-run">● {session.runningAgents}</span>
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
  const setCompose = useStore((s) => s.setCompose);
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const [query, setQuery] = useState('');
  useEffect(() => setQuery(''), [activeId]);
  const shown = (sessions ?? []).filter((s) => (filter === 'running' ? s.runningAgents > 0 || s.status === 'running' : filter === 'favorites' ? s.favorite : true) && matchesQuery(s, query));
  const groups = groupSessions(shown);
  const running = (sessions ?? []).filter((s) => s.runningAgents > 0 || s.status === 'running').length;
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
      <div className="filters">
        {FILTERS.map((f) => (
          <button key={f} className={`f ${f === filter ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {t(`filter.${f}`)}
            {f === 'running' && running > 0 ? ` · ${running}` : ''}
          </button>
        ))}
      </div>
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
    </aside>
  );
}
