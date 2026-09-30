import type { ProjectSummary, SessionSummary } from '@alchemist-coder/core';
import type { BoardData, BoardPhase, BoardPlacement, BoardTask } from '@shared/api';

export const PHASES: BoardPhase[] = ['backlog', 'planning', 'implementing', 'validating', 'done'];
/** Conversations with activity this recent show up on their own; older ones only if you put them there. */
export const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
/** Activity this long after you moved a card means the agent worked on it again (a stopped agent still writes for a moment). */
const GRACE_MS = 30_000;

/** What an agent is doing right now in a conversation. */
export type Live = 'running' | 'planning' | 'waiting';

export interface BoardCard {
  /** 't:<task id>' or 's:<session id>'. */
  key: string;
  phase: BoardPhase;
  title: string;
  cwd: string | null;
  projectId: number | null;
  session: SessionSummary | null;
  task: BoardTask | null;
  live: Live | null;
  /** For ordering: the latest activity or edit. */
  when: number;
}

/**
 * Where a card goes: a working agent puts it in Planning or Implementing; otherwise the column you
 * chose, unless the agent worked on it after that (then it waits for your review in Validating).
 */
export function phaseOf(session: SessionSummary | null, live: Live | null, placement: BoardPlacement | null): BoardPhase {
  if (live) return live === 'planning' ? 'planning' : 'implementing';
  if (placement && (!session || (session.lastTs ?? 0) <= placement.at + GRACE_MS)) return placement.phase;
  return session ? 'validating' : 'backlog';
}

export function buildCards(input: {
  data: BoardData;
  sessions: SessionSummary[];
  projects: ProjectSummary[];
  live: Record<string, Live>;
  now: number;
}): BoardCard[] {
  const { data, projects, live, now } = input;
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const byCwd = new Map(projects.map((p) => [p.cwd, p]));
  const byProject = new Map(projects.map((p) => [p.id, p]));
  const cards: BoardCard[] = [];
  const linked = new Set<string>();
  for (const task of data.tasks) {
    const session = task.sessionId ? (byId.get(task.sessionId) ?? null) : null;
    if (task.sessionId) linked.add(task.sessionId);
    const l = task.sessionId ? (live[task.sessionId] ?? null) : null;
    cards.push({
      key: `t:${task.id}`,
      phase: phaseOf(session, l, { phase: task.phase, at: task.updatedAt }),
      title: task.title || session?.title || '',
      cwd: task.cwd,
      projectId: byCwd.get(task.cwd)?.id ?? session?.projectId ?? null,
      session,
      task,
      live: l,
      when: Math.max(task.updatedAt, session?.lastTs ?? 0),
    });
  }
  for (const session of input.sessions) {
    if (linked.has(session.id)) continue;
    const placement = data.placed[session.id] ?? null;
    const l = live[session.id] ?? null;
    if (!placement && !l && now - (session.lastTs ?? 0) > RECENT_MS) continue;
    cards.push({
      key: `s:${session.id}`,
      phase: phaseOf(session, l, placement),
      title: session.title,
      cwd: byProject.get(session.projectId)?.cwd ?? null,
      projectId: session.projectId,
      session,
      task: null,
      live: l,
      when: session.lastTs ?? 0,
    });
  }
  return cards;
}

const LIVE_RANK: Record<Live, number> = { waiting: 0, running: 1, planning: 1 };
/** Who needs you first, then who's working, then the latest. */
export const byUrgency = (a: BoardCard, b: BoardCard) => (a.live ? LIVE_RANK[a.live] : 2) - (b.live ? LIVE_RANK[b.live] : 2) || b.when - a.when;

/** The board after moving a card: a task keeps its own column, a conversation gets a placement. */
export function moveCard(data: BoardData, card: Pick<BoardCard, 'key' | 'task' | 'session'>, phase: BoardPhase, now: number): BoardData {
  if (card.task) return { ...data, tasks: data.tasks.map((t) => (t.id === card.task!.id ? { ...t, phase, updatedAt: now } : t)) };
  if (card.session) return { ...data, placed: { ...data.placed, [card.session.id]: { phase, at: now } } };
  return data;
}

export const newTaskId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
