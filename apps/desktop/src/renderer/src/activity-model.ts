import type { ProjectSummary, SessionSummary } from '@alchemist-coder/core';
import type { AgentChoice, ArenaTask, BotTeam } from '@shared/api';
import type { LiveTurn } from './live-turns';
import { ACTIVE, botState } from './org-model';
import { isInside } from './paths';

/** What the activity model needs to know of a live run. */
export interface ActivityRun {
  runId: string;
  target: string;
  status: string;
  sessionId: string | null;
  cwd?: string;
  turns: LiveTurn[];
  usage: { costUsd: number | null } | null;
  permissions: Array<{ title: string }>;
  questions?: Array<{ message: string }>;
}

/** What an agent is doing: its own words, or a moment the view names ("Thinking…", "Using Bash…"). */
export type Doing =
  | { kind: 'text'; text: string }
  | { kind: 'thinking' | 'writing' | 'starting' | 'running' | 'waiting' | 'plan' | 'elsewhere' }
  | { kind: 'tool'; tool: string }
  | { kind: 'agents'; n: number };

export type ActivityTarget =
  | { kind: 'bot'; teamId: string; botId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'compose'; projectId: number }
  | { kind: 'project'; projectId: number }
  | { kind: 'arena'; taskId: string };

/** One line of the activity bar: an agent (or a conversation's agents) working or waiting for you. */
export interface ActivityItem {
  key: string;
  state: 'waiting' | 'working';
  /** Who; empty for an Arena agent, named after `agent`. */
  name: string;
  agent?: AgentChoice;
  /** The assignment, task or project it works in. */
  where: string;
  doing: Doing;
  /** When this stretch of work started, when known. */
  since: number | null;
  costUsd: number | null;
  /** How many agents the line stands for (a conversation with subagents: several). */
  agents: number;
  target: ActivityTarget;
}

export interface ActivityInput {
  runs: Record<string, ActivityRun>;
  runByTarget: Record<string, string>;
  botTeams: BotTeam[];
  tasks: Record<string, ArenaTask>;
  projects: ProjectSummary[];
  /** The conversations of the lists that are loaded (the working ones get a line). */
  sessions: SessionSummary[];
}

const LIVE = ['starting', 'running', 'waiting'];
const isLive = (s: SessionSummary) => s.runningAgents > 0 || s.status === 'running';
const openTurn = (run: ActivityRun | undefined) => {
  const turn = run?.turns.at(-1);
  return turn && turn.endedAt === null ? turn : null;
};

/** What a run is doing right now, from the last thing in its open turn. */
export function doingOf(run: ActivityRun): Doing {
  if (run.status === 'waiting') {
    const asked = run.permissions[0]?.title ?? run.questions?.[0]?.message;
    return asked ? { kind: 'text', text: asked.replace(/\s+/g, ' ').slice(0, 140) } : { kind: 'waiting' };
  }
  if (run.status === 'starting') return { kind: 'starting' };
  const last = openTurn(run)?.blocks.at(-1);
  if (last?.kind === 'thinking') return { kind: 'thinking' };
  if (last?.kind === 'tool' && last.tool.state !== 'done' && last.tool.state !== 'failed') return { kind: 'tool', tool: last.tool.name };
  if (last?.kind === 'text') return { kind: 'writing' };
  return { kind: 'running' };
}

/**
 * Everyone working or waiting for you, across the app: the organization's agents, Arena agents, the
 * app's own conversations, and conversations going on outside the app (a terminal, another app).
 * Those waiting for you come first.
 */
export function buildActivity(input: ActivityInput): ActivityItem[] {
  const items: ActivityItem[] = [];
  const takenRuns = new Set<string>();
  const takenSessions = new Set<string>();
  /** Agents already on a line, by project: the rest of a project's count gets one line of its own. */
  const accounted = new Map<number, number>();
  const projectOf = (cwd: string | undefined) => (cwd ? (input.projects.find((p) => p.cwd === cwd) ?? input.projects.find((p) => isInside(cwd, p.cwd))) : undefined);
  const add = (item: ActivityItem, projectId: number | undefined) => {
    items.push(item);
    // One waiting for you still counts as running in the index.
    if (projectId != null) accounted.set(projectId, (accounted.get(projectId) ?? 0) + item.agents);
  };
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));

  for (const team of input.botTeams) {
    for (const bot of team.bots) {
      if (bot.runId) takenRuns.add(bot.runId);
      if (bot.sessionId) takenSessions.add(bot.sessionId);
      const state = botState(team, bot);
      if (!ACTIVE.includes(state)) continue;
      const run = bot.runId ? input.runs[bot.runId] : undefined;
      const plan = bot.depth === 0 && team.plan?.status === 'pending';
      const asked = state === 'waiting' && !plan ? [...(team.activity ?? [])].reverse().find((e) => e.kind === 'waiting' && e.botId === bot.id)?.detail : undefined;
      const waitingFor: Doing = plan ? { kind: 'plan' } : asked ? { kind: 'text', text: asked } : run ? doingOf({ ...run, status: 'waiting' }) : { kind: 'waiting' };
      add(
        {
          key: `bot:${team.id}:${bot.id}`,
          state: state === 'waiting' ? 'waiting' : 'working',
          name: bot.name,
          where: team.title || team.goal,
          doing: state === 'waiting' ? waitingFor : bot.doing ? { kind: 'text', text: bot.doing } : { kind: state === 'starting' ? 'starting' : 'running' },
          // The coordinator works in turns: only its open one says since when.
          since: state === 'waiting' ? null : (openTurn(run)?.startedAt ?? (bot.depth > 0 ? bot.createdAt : null)),
          costUsd: bot.costUsd,
          agents: 1,
          target: { kind: 'bot', teamId: team.id, botId: bot.id },
        },
        projectOf(team.cwd)?.id,
      );
    }
  }

  for (const task of Object.values(input.tasks)) {
    // Its planner shows in the task itself.
    if (task.planner?.runId) takenRuns.add(task.planner.runId);
    for (const c of task.contestants) {
      if (c.runId) takenRuns.add(c.runId);
      if (c.sessionId) takenSessions.add(c.sessionId);
      if (!LIVE.includes(c.state)) continue;
      const run = c.runId ? input.runs[c.runId] : undefined;
      const waiting = c.state === 'waiting';
      add(
        {
          key: `arena:${task.id}:${c.id}`,
          state: waiting ? 'waiting' : 'working',
          name: '',
          agent: { harnessId: c.harnessId, providerId: c.providerId, model: c.model },
          where: task.title,
          doing: run ? doingOf(waiting ? { ...run, status: 'waiting' } : run) : { kind: c.state === 'starting' ? 'starting' : waiting ? 'waiting' : 'running' },
          since: waiting ? null : c.startedAt,
          costUsd: c.costUsd,
          agents: 1,
          target: { kind: 'arena', taskId: task.id },
        },
        projectOf(task.projectCwd)?.id,
      );
    }
  }

  /** Conversations the app itself ran: when the index still has them working, it isn't "outside the app". */
  const appSessions = new Set<string>();
  for (const run of Object.values(input.runs)) {
    const sessionId = run.sessionId ?? (run.target.startsWith('s:') ? run.target.slice(2) : null);
    if (sessionId) appSessions.add(sessionId);
    if (takenRuns.has(run.runId) || !LIVE.includes(run.status)) continue;
    // Conversations only: other background runs (a planner, a piece being written) show where they belong.
    if (!run.target.startsWith('s:') && !run.target.startsWith('p:')) continue;
    if (input.runByTarget[run.target] !== run.runId) continue;
    const session = sessionId ? sessionById.get(sessionId) : undefined;
    const project = session ? input.projects.find((p) => p.id === session.projectId) : run.target.startsWith('p:') ? input.projects.find((p) => p.id === Number(run.target.slice(2))) : projectOf(run.cwd);
    if (sessionId) takenSessions.add(sessionId);
    const prompt = run.turns.findLast((t) => t.prompt.trim())?.prompt.replace(/\s+/g, ' ').slice(0, 80) ?? '';
    add(
      {
        key: `run:${run.runId}`,
        state: run.status === 'waiting' ? 'waiting' : 'working',
        name: session?.title || prompt || project?.name || '',
        where: project?.name ?? '',
        doing: doingOf(run),
        since: run.status === 'waiting' ? null : (openTurn(run)?.startedAt ?? null),
        costUsd: run.usage?.costUsd ?? null,
        agents: Math.max(1, session?.runningAgents ?? 1),
        target: sessionId ? { kind: 'session', sessionId } : { kind: 'compose', projectId: project?.id ?? Number(run.target.slice(2)) },
      },
      project?.id,
    );
  }

  // Working without a run of the app: the index only knows that they are, and how many agents.
  for (const s of input.sessions) {
    if (!isLive(s) || takenSessions.has(s.id)) continue;
    takenSessions.add(s.id);
    const agents = Math.max(1, s.runningAgents);
    add(
      {
        key: `session:${s.id}`,
        state: 'working',
        name: s.title,
        where: input.projects.find((p) => p.id === s.projectId)?.name ?? '',
        doing: agents > 1 ? { kind: 'agents', n: agents } : { kind: appSessions.has(s.id) ? 'running' : 'elsewhere' },
        since: null,
        costUsd: null,
        agents,
        target: { kind: 'session', sessionId: s.id },
      },
      s.projectId,
    );
  }
  // Agents the lines above don't cover (their conversations aren't loaded): one line per project, so nobody working goes unseen.
  for (const p of input.projects) {
    const rest = p.runningAgents - (accounted.get(p.id) ?? 0);
    if (rest <= 0) continue;
    items.push({ key: `project:${p.id}`, state: 'working', name: p.name, where: '', doing: { kind: 'agents', n: rest }, since: null, costUsd: null, agents: rest, target: { kind: 'project', projectId: p.id } });
  }

  return [...items.filter((x) => x.state === 'waiting'), ...items.filter((x) => x.state === 'working')];
}

/** The bar's totals: who waits for you, how many agents work, and what the work in sight has cost. */
export function activityTotals(items: ActivityItem[]) {
  const cost = items.reduce((a, x) => a + (x.costUsd ?? 0), 0);
  return {
    waiting: items.filter((x) => x.state === 'waiting').length,
    working: items.filter((x) => x.state === 'working').reduce((a, x) => a + x.agents, 0),
    costUsd: cost > 0 ? cost : null,
  };
}
