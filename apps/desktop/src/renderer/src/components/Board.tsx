import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@alchemist-coder/core';
import type { BoardPhase, BoardTask } from '@shared/api';
import { PHASES, buildCards, byUrgency, moveCard, newTaskId, type BoardCard, type Live } from '../board-model';
import { startTask, useBoard } from '../board-store';
import { initials, projectGradient, relativeTime } from '../format';
import { sourceOf } from '../sources';
import { useStore, useT } from '../store';
import { confirmAction, openMenu, toast } from '../ui';
import { AgentPanel } from './AgentPanel';
import { Icon } from './Icon';
import { Resizer } from './Resizer';
import { keys } from '../keys';

type T = ReturnType<typeof useT>;
const COLLAPSED_KEY = 'alchemist.boardCollapsed';
/** Each column shows this many cards until you ask for all of them. */
const CAP = 8;
const phaseName = (t: T, p: BoardPhase) => t(`board.phase.${p}` as never);
const taskPrompt = (task: BoardTask) => (task.notes.trim() ? `${task.title.trim()}\n\n${task.notes.trim()}` : task.title.trim());

/** Keeps a set of ids in localStorage (which columns are folded). */
function useCollapsed(): [Set<BoardPhase>, (p: BoardPhase) => void] {
  const [set, setSet] = useState<Set<BoardPhase>>(() => {
    try {
      // Done starts folded: it only grows.
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '["done"]') as BoardPhase[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (p: BoardPhase) =>
    setSet((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  return [set, toggle];
}

/** The element's width, to switch to a list when the board is narrow (half a screen). */
function useWidth<E extends HTMLElement>(): [React.RefObject<E | null>, number] {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * The project-management view: every piece of work as a card, in Nimbalyst's phases. Conversations
 * from the last few days show up on their own and move as their agents work; tasks are written down
 * first and handed to an agent when you're ready. Open, close and reopen are one click on each card.
 */
export function BoardView() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const data = useBoard((b) => b.data);
  const update = useBoard((b) => b.update);
  const scope = useStore((s) => s.agentsScope);
  const setScope = useStore((s) => s.setAgentsScope);
  const projects = useStore((s) => s.projects);
  const openIds = useStore((s) => s.settings.openProjectIds);
  const activeId = useStore((s) => s.settings.activeProjectId);
  const recent = useStore((s) => s.recent);
  const activeSessions = useStore((s) => (s.settings.activeProjectId != null ? s.sessions[s.settings.activeProjectId] : undefined));
  const runs = useStore((s) => s.runs);
  const [extra, setExtra] = useState<Record<string, SessionSummary>>({});
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ task: BoardTask | null; phase: BoardPhase } | null>(null);
  const [collapsed, toggleCollapsed] = useCollapsed();
  const [dragOver, setDragOver] = useState<BoardPhase | null>(null);
  const [showAll, setShowAll] = useState<Set<BoardPhase>>(new Set());
  const toggleShowAll = (p: BoardPhase) => setShowAll((cur) => (cur.has(p) ? new Set([...cur].filter((x) => x !== p)) : new Set([...cur, p])));
  const [ref, width] = useWidth<HTMLDivElement>();
  const asList = width < 760;

  useEffect(() => {
    void useBoard.getState().load();
    void useStore.getState().loadRecent();
  }, []);
  // Screenshots wait for the cards.
  const capture = useStore((s) => !!s.info?.capture);
  const loaded = !!data && Object.keys(recent).length > 0;
  useEffect(() => {
    if (useStore.getState().info?.capture?.boardNew) setEditing({ task: null, phase: 'backlog' });
  }, []);
  useEffect(() => {
    if (!capture || !loaded) return;
    const id = setTimeout(() => useStore.getState().markCaptureReady(), 900);
    return () => clearTimeout(id);
  }, [capture, loaded]);

  // Conversations the board points at but the recent lists don't have (older ones you placed).
  const known = useMemo(() => {
    const m = new Map<string, SessionSummary>();
    for (const list of Object.values(recent)) for (const s of list) m.set(s.id, s);
    for (const s of activeSessions ?? []) m.set(s.id, s);
    for (const s of Object.values(extra)) if (!m.has(s.id)) m.set(s.id, s);
    return m;
  }, [recent, activeSessions, extra]);
  useEffect(() => {
    if (!data) return;
    const month = Date.now() - 30 * 24 * 3600 * 1000;
    const want = [...data.tasks.map((x) => x.sessionId), ...Object.entries(data.placed).filter(([, p]) => p.at > month).map(([id]) => id)].filter((id): id is string => !!id && !known.has(id) && !(id in extra));
    if (!want.length) return;
    let alive = true;
    void Promise.all(want.slice(0, 80).map((id) => window.alchemist.session(id).catch(() => null))).then((found) => {
      if (!alive) return;
      setExtra((cur) => {
        const next = { ...cur };
        found.forEach((s, i) => {
          next[want[i]!] = s ?? ({ id: want[i]! } as SessionSummary);
        });
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [data, known]);

  const live = useMemo(() => {
    const out: Record<string, Live> = {};
    // The app's own runs know best; the index only guesses from recent writes.
    const mine = new Set(Object.values(runs).map((r) => r.sessionId).filter(Boolean));
    for (const s of known.values()) if (s.title && !mine.has(s.id) && (s.runningAgents > 0 || s.status === 'running')) out[s.id] = 'running';
    for (const r of Object.values(runs)) {
      if (!r.sessionId) continue;
      if (r.status === 'waiting') out[r.sessionId] = 'waiting';
      else if (r.status === 'running' || r.status === 'starting') out[r.sessionId] = r.config?.mode === 'plan' ? 'planning' : 'running';
    }
    return out;
  }, [known, runs]);

  const inScope = scope === 'all' ? new Set(openIds) : new Set(activeId != null ? [activeId] : []);
  const cards = useMemo(() => {
    if (!data) return [];
    const sessions = [...known.values()].filter((s) => s.title !== undefined);
    const q = query.trim().toLowerCase();
    return buildCards({ data, sessions, projects, live, now: Date.now() })
      .filter((c) => c.projectId != null && inScope.has(c.projectId))
      .filter((c) => !q || c.title.toLowerCase().includes(q) || (c.task?.notes ?? '').toLowerCase().includes(q) || (projects.find((p) => p.id === c.projectId)?.name ?? '').toLowerCase().includes(q));
  }, [data, known, projects, live, query, scope, openIds.join(), activeId]);
  const columns = useMemo(() => Object.fromEntries(PHASES.map((p) => [p, cards.filter((c) => c.phase === p).sort(byUrgency)])) as Record<BoardPhase, BoardCard[]>, [cards]);
  const waiting = cards.filter((c) => c.live === 'waiting').length;
  const working = cards.filter((c) => c.live && c.live !== 'waiting').length;
  const toReview = columns.validating.length;

  const stopRun = useStore((s) => s.stopRun);
  const selection = useStore((s) => s.selection);
  /** The app's own run on a conversation, while it works (the one "Stop and finish" can stop). */
  const runOf = (sessionId: string) => Object.values(runs).find((r) => r.sessionId === sessionId && (r.status === 'running' || r.status === 'starting' || r.status === 'waiting'));
  const move = (cards: BoardCard[], phase: BoardPhase) => update((d) => cards.reduce((acc, c) => moveCard(acc, c, phase, Date.now()), d));
  /** A card whose agent is working stays where the agent is: say so instead of silently not moving. */
  const tryMove = (group: BoardCard[], phase: BoardPhase) => {
    if (group.some((c) => c.live) && phase !== group[0]!.phase) return toast(t('board.stillWorking'));
    move(group, phase);
  };
  /** Done: stops the app's own runs first (an agent still working would pull the card back). */
  const finish = async (group: BoardCard[]) => {
    for (const c of group) {
      const run = c.session && c.live ? runOf(c.session.id) : undefined;
      if (run) await stopRun(run.runId).catch(() => {});
    }
    move(group, 'done');
  };
  // The conversation opens next to the board, so you can work on it and keep the board in view.
  const [peek, setPeek] = useState<string | null>(null);
  const peekOpen = !!peek && selection?.sessionId === peek;
  const open = async (card: BoardCard) => {
    if (card.session) {
      setPeek(card.session.id);
      await useStore.getState().select(card.session.id, 'main');
      return;
    }
    if (card.task) setEditing({ task: card.task, phase: card.task.phase });
  };
  const openInAgents = async (sessionId: string) => {
    const s = useStore.getState();
    s.setMode('agents');
    await s.select(sessionId, 'main');
  };
  useEffect(() => {
    const id = useStore.getState().info?.capture?.boardOpen;
    if (!id) return;
    setPeek(id);
    void useStore.getState().select(id, 'main');
  }, []);
  useEffect(() => {
    if (!peekOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key === 'Escape' && !(el && /^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName))) setPeek(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [peekOpen]);
  const start = async (task: BoardTask) => {
    if (!(await startTask(task, taskPrompt(task)))) toast(t('board.noProject'));
  };
  const remove = async (task: BoardTask) => {
    const ok = await confirmAction({ title: t('board.deleteTitle'), message: task.title, confirmLabel: t('board.delete'), cancelLabel: t('dialog.cancel'), danger: true });
    if (ok) update((d) => ({ ...d, tasks: d.tasks.filter((x) => x.id !== task.id) }));
  };
  const more = async (group: BoardCard[]) => {
    const card = group[0]!;
    const id = await openMenu([
      { id: 'move', label: t('board.moveTo'), enabled: !card.live, submenu: PHASES.map((p) => ({ id: `m:${p}`, label: phaseName(t, p), checked: p === card.phase, enabled: p !== card.phase })) },
      ...(card.session ? [{ id: 'agents', label: t('board.openInAgents') }] : []),
      ...(card.task ? [{ id: 'edit', label: t('board.edit') }] : []),
      ...(card.task && !card.session ? [{ id: 'start', label: t('board.start') }] : []),
      ...(card.task ? [{ type: 'separator' as const }, { id: 'delete', label: t('board.delete') }] : []),
    ]);
    if (id?.startsWith('m:')) tryMove(group, id.slice(2) as BoardPhase);
    if (id === 'agents' && card.session) void openInAgents(card.session.id);
    if (id === 'edit' && card.task) setEditing({ task: card.task, phase: card.task.phase });
    if (id === 'start' && card.task) void start(card.task);
    if (id === 'delete' && card.task) void remove(card.task);
  };

  /** Repeated runs of the same thing (same project and title) show as one card with a count. */
  const groupsOf = (list: BoardCard[]) => {
    const out: BoardCard[][] = [];
    const byKey = new Map<string, BoardCard[]>();
    for (const c of list) {
      if (!c.session || c.task || c.live) {
        out.push([c]);
        continue;
      }
      const k = `${c.projectId}|${c.title.trim().toLowerCase()}`;
      const g = byKey.get(k);
      if (g) g.push(c);
      else {
        const fresh = [c];
        byKey.set(k, fresh);
        out.push(fresh);
      }
    }
    return out;
  };

  const projectOf = (card: BoardCard) => projects.find((p) => p.id === card.projectId);
  const renderCard = (group: BoardCard[]) => {
    const card = group[0]!;
    const p = projectOf(card);
    const done = card.phase === 'done';
    const started = !!card.session;
    const external = !!card.live && !!card.session && !runOf(card.session.id);
    const status = card.live === 'waiting' ? (
      <span className="needs-you-pill">{t('attention.waiting')}</span>
    ) : card.live ? (
      <span className="bcard-live">● {card.live === 'planning' ? t('board.planning') : t('board.working')}</span>
    ) : (
      <span className="bcard-when">{started ? relativeTime(card.session!.lastTs, locale) : t('board.notStarted')}</span>
    );
    const src = card.session ? sourceOf(card.session.source) : null;
    return (
      <article
        key={card.key}
        className={`bcard ${card.live ? `is-${card.live}` : ''} ${started ? '' : 'is-task'} ${done ? 'is-done' : ''} ${peekOpen && card.session?.id === peek ? 'is-open' : ''}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/x-board-card', JSON.stringify(group.map((c) => c.key)));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          void more(group);
        }}
      >
        {(scope === 'all' || !started) && (
          <div className="bcard-top">
            {scope === 'all' && p && (
              <span className="bcard-proj" title={p.cwd}>
                <span className="avatar xs" style={{ background: projectGradient(p.name) }}>{initials(p.name)}</span>
                {p.name}
              </span>
            )}
            {!started && <span className="bcard-kind">{t('board.task')}</span>}
          </div>
        )}
        <button className="bcard-title" onClick={() => void open(card)} title={started ? t('board.openConversation') : t('board.edit')}>
          {card.title || t('board.untitled')}
          {group.length > 1 && (
            <span className="bcard-count" title={t('board.repeats', { n: group.length })}>
              ×{group.length}
            </span>
          )}
        </button>
        {card.task?.notes.trim() && !started && <p className="bcard-notes">{card.task.notes}</p>}
        <div className="bcard-foot">
          <span className="bcard-state">
            {src && (
              <span className="bcard-src" title={src.label}>
                {src.glyph}
              </span>
            )}
            {status}
          </span>
          <span className="bcard-actions">
            {started ? (
              <button className="bcard-btn" onClick={() => void open(card)} title={t('board.openConversation')} aria-label={t('board.openConversation')}>
                <Icon name="goto" size={13} />
                <span>{t('board.open')}</span>
              </button>
            ) : (
              <button className="bcard-btn primary" onClick={() => card.task && void start(card.task)} title={t('board.startTip')}>
                <Icon name="play" size={12} />
                <span>{t('board.start')}</span>
              </button>
            )}
            {done ? (
              <button className="bcard-btn" onClick={() => move(group, started ? 'validating' : 'backlog')} title={t('board.reopenTip')} aria-label={t('board.reopen')}>
                <Icon name="reopen" size={13} />
                <span>{t('board.reopen')}</span>
              </button>
            ) : (
              <button
                className="bcard-btn"
                disabled={external}
                onClick={() => void finish(group)}
                title={external ? t('board.stopFirst') : card.live ? t('board.stopFinishTip') : group.length > 1 ? t('board.finishAll', { n: group.length }) : t('board.finishTip')}
                aria-label={card.live ? t('board.stopFinish') : t('board.finish')}
              >
                <Icon name="done" size={13} />
                <span>{card.live ? t('board.stopFinish') : t('board.finish')}</span>
              </button>
            )}
            <button className="bcard-btn icon" onClick={() => void more(group)} title={t('menu.more')} aria-label={t('menu.more')}>
              <Icon name="more" size={14} />
            </button>
          </span>
        </div>
      </article>
    );
  };

  const dropProps = (phase: BoardPhase) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('text/x-board-card')) return;
      e.preventDefault();
      if (dragOver !== phase) setDragOver(phase);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      let keys: string[] = [];
      try {
        keys = JSON.parse(e.dataTransfer.getData('text/x-board-card')) as string[];
      } catch {
        return;
      }
      const group = cards.filter((c) => keys.includes(c.key));
      if (group.length && group[0]!.phase !== phase) tryMove(group, phase);
    },
  });

  const column = (phase: BoardPhase) => {
    const list = columns[phase];
    const groups = groupsOf(list);
    const expanded = showAll.has(phase);
    const shown = expanded ? groups : groups.slice(0, CAP);
    const folded = collapsed.has(phase);
    const finishable = phase === 'validating' ? list.filter((c) => !c.live) : [];
    const foldIcon = folded ? 'chevronRight' : asList ? 'chevronDown' : 'chevronLeft';
    return (
      <section key={phase} className={`bcol ${folded ? 'folded' : ''} ${dragOver === phase ? 'drop' : ''}`} {...dropProps(phase)} aria-label={phaseName(t, phase)}>
        <header className="bcol-head">
          <button className="bcol-fold" onClick={() => toggleCollapsed(phase)} aria-expanded={!folded} title={folded ? t('board.expand') : t('board.collapse')}>
            <Icon name={foldIcon} size={14} />
            <span className={`bcol-dot ${phase}`} />
            <b>{phaseName(t, phase)}</b>
            <span className="bcol-count">{list.length}</span>
          </button>
          {finishable.length > 1 && (
            <button
              className="bcol-add"
              onClick={() =>
                void openMenu([{ id: 'all', label: t('board.finishAll', { n: finishable.length }) }]).then((id) => id === 'all' && move(finishable, 'done'))
              }
              title={t('menu.more')}
              aria-label={t('menu.more')}
            >
              <Icon name="more" size={14} />
            </button>
          )}
          <button className="bcol-add" onClick={() => setEditing({ task: null, phase })} title={t('board.addTo', { phase: phaseName(t, phase) })} aria-label={t('board.addTo', { phase: phaseName(t, phase) })}>
            <Icon name="plus" size={14} />
          </button>
        </header>
        {!folded && (
          <div className="bcol-cards">
            {shown.map(renderCard)}
            {!list.length && <p className="bcol-empty">{t(`board.empty.${phase}` as never)}</p>}
            {groups.length > CAP && (
              <button className="link small bcol-more" onClick={() => toggleShowAll(phase)}>
                {expanded ? t('board.showLess') : t('board.showAll', { n: groups.length })}
              </button>
            )}
          </div>
        )}
      </section>
    );
  };

  const projectName = projects.find((p) => p.id === activeId)?.name;
  return (
    <div className={`board ${peekOpen ? 'peeking' : ''}`}>
      <div className={`board-main ${asList ? 'as-list' : ''}`} ref={ref}>
        <header className="board-head">
          <div className="board-title">
            <h2>
              <Icon name="board" size={18} /> {t('mode.board')}
              {scope === 'project' && projectName && <span>· {projectName}</span>}
            </h2>
            <p>
              {[waiting && t('board.sumWaiting', { n: waiting }), working && t('board.sumWorking', { n: working }), toReview && t('board.sumReview', { n: toReview })].filter(Boolean).join(' · ') || t('board.sumNone')}
            </p>
          </div>
          <div className="board-tools">
            <div className="scope board-scope" role="tablist" aria-label={t('scope.label')}>
              <button role="tab" aria-selected={scope === 'project'} className={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')}>
                {t('scope.project')}
              </button>
              <button role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
                {t('scope.all')}
              </button>
            </div>
            <label className="board-search">
              <Icon name="search" size={13} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('board.filter')} aria-label={t('board.filter')} />
            </label>
            <button className="btn-send" onClick={() => setEditing({ task: null, phase: 'backlog' })}>
              <Icon name="plus" size={13} /> {t('board.newTask')}
            </button>
          </div>
        </header>
        {!data ? (
          <div className="panel-empty">
            <span className="spin" />
          </div>
        ) : (
          <div className="board-cols">{PHASES.map(column)}</div>
        )}
        {data && !cards.length && !query && <p className="board-hint">{t('board.hint')}</p>}
      </div>
      {peekOpen && !asList && <Resizer panel="peek" edge="right" />}
      {peekOpen && (
        <aside className="board-peek" aria-label={t('board.openConversation')}>
          <div className="peek-bar">
            <button className="icon-btn ic-btn" onClick={() => void openInAgents(peek!)} title={t('board.openInAgents')} aria-label={t('board.openInAgents')}>
              <Icon name="agents" size={15} />
            </button>
            <button className="icon-btn ic-btn" onClick={() => setPeek(null)} title={`${t('board.closePanel')} (Esc)`} aria-label={t('board.closePanel')}>
              <Icon name="close" size={15} />
            </button>
          </div>
          <AgentPanel />
        </aside>
      )}
      {editing && <TaskDialog task={editing.task} phase={editing.phase} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Write a task down (or edit it): what, where, and optionally hand it to an agent right away. */
function TaskDialog({ task, phase, onClose }: { task: BoardTask | null; phase: BoardPhase; onClose: () => void }) {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const openIds = useStore((s) => s.settings.openProjectIds);
  const activeId = useStore((s) => s.settings.activeProjectId);
  const update = useBoard((b) => b.update);
  const open = openIds.map((id) => projects.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [cwd, setCwd] = useState(task?.cwd ?? projects.find((p) => p.id === activeId)?.cwd ?? open[0]?.cwd ?? '');
  const [col, setCol] = useState<BoardPhase>(task?.phase ?? phase);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const choices = open.some((p) => p.cwd === cwd) || !cwd ? open : [...open, ...projects.filter((p) => p.cwd === cwd)];

  const save = (andStart: boolean) => {
    if (!title.trim() || !cwd) return;
    const now = Date.now();
    const next: BoardTask = task ? { ...task, title: title.trim(), notes, cwd, phase: col, updatedAt: now } : { id: newTaskId(), cwd, title: title.trim(), notes, phase: col, sessionId: null, createdAt: now, updatedAt: now };
    update((d) => ({ ...d, tasks: task ? d.tasks.map((x) => (x.id === task.id ? next : x)) : [next, ...d.tasks] }));
    onClose();
    if (andStart) void startTask(next, taskPrompt(next)).then((ok) => ok || toast(t('board.noProject')));
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog task-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={task ? t('board.edit') : t('board.newTask')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          // ⌘↵: add it and hand it to an agent right away.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !task?.sessionId) {
            e.preventDefault();
            save(true);
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
      >
        <h3>{task ? t('board.edit') : t('board.newTask')}</h3>
        <label className="np-field">
          <span>{t('board.fTitle')}</span>
          <input ref={input} value={title} maxLength={300} placeholder={t('board.fTitlePh')} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="np-field">
          <span>{t('board.fNotes')}</span>
          <textarea value={notes} rows={5} maxLength={20000} placeholder={t('board.fNotesPh')} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="task-dialog-row">
          <label className="np-field">
            <span>{t('board.fProject')}</span>
            <select value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={!!task?.sessionId}>
              {choices.map((p) => (
                <option key={p.cwd} value={p.cwd}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="np-field">
            <span>{t('board.fPhase')}</span>
            <select value={col} onChange={(e) => setCol(e.target.value as BoardPhase)}>
              {PHASES.map((p) => (
                <option key={p} value={p}>
                  {phaseName(t, p)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          {!task?.sessionId && (
            <button type="button" className="btn-ghost" disabled={!title.trim() || !cwd} onClick={() => save(true)} title={t('board.startTip')}>
              <Icon name="play" size={12} /> {t('board.saveStart')} <kbd>{keys('⌘↵')}</kbd>
            </button>
          )}
          <button type="submit" className="btn-send" disabled={!title.trim() || !cwd}>
            {task ? t('board.save') : t('board.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
