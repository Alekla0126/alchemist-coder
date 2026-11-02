import type { AgentChoice, BotConfig, BotMember, BotStatus, BotTeam, RunnerCatalog, StarterAgent } from '@shared/api';
import { ACTIVE, activityOf, botState, chartOf, teamState } from './org-model';
import { baseName, isInside } from './paths';

/**
 * The office on one screen: the work going on now, project by project (who is on it and how it
 * goes), and the organization's agents department by department. Nothing here reads the store.
 */

/** How an agent's part goes, in a word: on it, waiting for you, done (ready for you), or failed. */
export type OfficeState = 'working' | 'waiting' | 'done' | 'failed';

/** Finished work stays on the floor this long, so you see what's ready when you come back. */
export const RECENT_MS = 24 * 60 * 60 * 1000;

/** One agent on the floor: its part in one assignment. */
export interface OfficeAgent {
  /** Stable across renders: the assignment and the agent (or its bot when it has no configuration). */
  key: string;
  team: BotTeam;
  /** Its bot that tells the most (waiting, then working, then the latest). */
  botId: string;
  /** Its organization agent; null for one the coordinator defined on the spot. */
  configId: string | null;
  name: string;
  avatar: string | null;
  state: OfficeState;
  /** What it was asked to do, on one line. */
  task: string;
  /** What it's doing right now, while it works. */
  doing: string | null;
  coordinator: boolean;
}

/** A project with the work in it: its agents on the floor and its assignments. */
export interface OfficeProject {
  cwd: string;
  name: string;
  agents: OfficeAgent[];
  /** Its assignments on the floor, the latest first. */
  teams: BotTeam[];
  counts: Record<OfficeState, number>;
  updatedAt: number;
}

const RANK: Record<OfficeState, number> = { waiting: 0, working: 1, failed: 2, done: 3 };
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A bot's state on the floor; null when it isn't there (stopped, or not started). */
export function officeStateOf(team: BotTeam, bot: BotMember): OfficeState | null {
  const s: BotStatus = botState(team, bot);
  if (s === 'waiting') return 'waiting';
  if (ACTIVE.includes(s)) return 'working';
  if (s === 'error') return 'failed';
  if (s === 'done' || s === 'idle') return 'done';
  return null;
}

/** Whether an assignment is on the floor: in progress, or done within `recent`. A stopped one isn't. */
export function onFloor(team: BotTeam, now: number, recent = RECENT_MS): boolean {
  const state = teamState(team);
  if (state === 'waiting' || state === 'working') return true;
  if (state === 'stopped') return false;
  return team.updatedAt >= now - recent;
}

/** The open project an assignment's folder is in (the deepest one), else its own folder. */
export function projectOf(cwd: string, projects: Array<{ cwd: string; name: string }>): { cwd: string; name: string } {
  const home = projects.filter((p) => isInside(cwd, p.cwd)).sort((a, b) => b.cwd.length - a.cwd.length)[0];
  return home ? { cwd: home.cwd, name: home.name } : { cwd, name: baseName(cwd) };
}

/** An assignment's agents on the floor: one per organization agent (or per bot defined on the spot). */
export function agentsIn(team: BotTeam, configs: BotConfig[]): OfficeAgent[] {
  const groups = new Map<string, BotMember[]>();
  for (const b of team.bots) {
    if (!officeStateOf(team, b)) continue;
    const id = b.configId && configs.some((c) => c.id === b.configId) ? b.configId : `bot:${b.id}`;
    groups.set(id, [...(groups.get(id) ?? []), b]);
  }
  const out: OfficeAgent[] = [];
  for (const [id, bots] of groups) {
    const shown = [...bots].sort((a, b) => RANK[officeStateOf(team, a)!] - RANK[officeStateOf(team, b)!] || b.createdAt - a.createdAt)[0]!;
    const config = id.startsWith('bot:') ? undefined : configs.find((c) => c.id === id);
    const state = officeStateOf(team, shown)!;
    out.push({
      key: `${team.id}:${id}`,
      team,
      botId: shown.id,
      configId: config?.id ?? null,
      name: config?.name ?? shown.name,
      avatar: config?.avatar ?? null,
      state,
      task: oneLine(shown.task),
      doing: state === 'working' ? (shown.doing ?? null) : null,
      coordinator: shown.depth === 0,
    });
  }
  // Who needs you first, then who works; the coordinator ahead of its agents in the same state.
  return out.sort((a, b) => RANK[a.state] - RANK[b.state] || Number(b.coordinator) - Number(a.coordinator));
}

/**
 * The work on the floor, project by project: the ones that need you first, then the busiest, then
 * the latest. `cwd` (the organization's project filter) keeps only that project's assignments.
 */
export function projectsOf(teams: BotTeam[], configs: BotConfig[], projects: Array<{ cwd: string; name: string }>, now: number, cwd = '', recent = RECENT_MS): OfficeProject[] {
  const byCwd = new Map<string, OfficeProject>();
  for (const team of teams) {
    if (cwd && !isInside(team.cwd, cwd)) continue;
    if (!onFloor(team, now, recent)) continue;
    const agents = agentsIn(team, configs);
    if (!agents.length) continue;
    const where = projectOf(team.cwd, projects);
    const p = byCwd.get(where.cwd) ?? { ...where, agents: [], teams: [], counts: { working: 0, waiting: 0, done: 0, failed: 0 }, updatedAt: 0 };
    byCwd.set(where.cwd, p);
    p.teams.push(team);
    p.agents.push(...agents);
    for (const a of agents) p.counts[a.state]++;
    p.updatedAt = Math.max(p.updatedAt, team.updatedAt);
  }
  for (const p of byCwd.values()) {
    p.teams.sort((a, b) => b.updatedAt - a.updatedAt);
    p.agents.sort((a, b) => RANK[a.state] - RANK[b.state] || b.team.updatedAt - a.team.updatedAt || Number(b.coordinator) - Number(a.coordinator));
  }
  return [...byCwd.values()].sort((a, b) => b.counts.waiting - a.counts.waiting || b.counts.working - a.counts.working || b.updatedAt - a.updatedAt);
}

/** How many agents are in each state across the floor. */
export function countsOf(projects: OfficeProject[]): Record<OfficeState, number> {
  const out: Record<OfficeState, number> = { working: 0, waiting: 0, done: 0, failed: 0 };
  for (const p of projects) for (const k of Object.keys(out) as OfficeState[]) out[k] += p.counts[k];
  return out;
}

/** An organization agent in its department, with how it is doing across its assignments. */
export interface OfficeMember {
  member: BotConfig;
  status: 'working' | 'waiting' | 'idle';
}

/** The department of the agents without a lead (and leading no team): one for all of them. */
export const NO_DEPARTMENT = 'none';

/** A department: a top-level agent and its team, the lead first; or (lead null) the agents with no department. */
export interface Department {
  id: string;
  lead: BotConfig | null;
  members: OfficeMember[];
  working: number;
  waiting: number;
}

/**
 * The organization by department (the chart's leads with a team), the agents with no department
 * together after them, the coordinator apart and the proposed agents last. `cwd` keeps the agents
 * that work in that project.
 */
export function departmentsOf(configs: BotConfig[], teams: BotTeam[], cwd = ''): { coordinator: OfficeMember | null; departments: Department[]; proposed: BotConfig[] } {
  const { coordinator, leads, proposed } = chartOf(configs, cwd);
  const of = (member: BotConfig): OfficeMember => ({ member, status: activityOf(member, teams).status });
  const department = (id: string, lead: BotConfig | null, members: OfficeMember[]): Department => ({ id, lead, members, working: members.filter((m) => m.status === 'working').length, waiting: members.filter((m) => m.status === 'waiting').length });
  // Departments with a team (as on the chart's map), each in the chart's order; then everyone on their own.
  const departments = leads.filter((l) => l.team.length).map(({ member, team }) => department(member.id, member, [of(member), ...team.map(of)]));
  const alone = leads.filter((l) => !l.team.length).map((l) => of(l.member));
  if (alone.length) departments.push(department(NO_DEPARTMENT, null, alone));
  return { coordinator: coordinator ? of(coordinator) : null, departments, proposed };
}

/** The department an agent is in: its lead's, its own when it leads a team, else none. */
export function departmentOf(configId: string | null, configs: BotConfig[]): string {
  const config = configId ? configs.find((c) => c.id === configId) : undefined;
  if (!config) return NO_DEPARTMENT;
  const lead = config.leadId ? configs.find((c) => c.id === config.leadId && c.kind !== 'coordinator' && !c.proposed) : undefined;
  if (lead) return lead.id;
  return configs.some((c) => c.leadId === config.id) ? config.id : NO_DEPARTMENT;
}

/** One assignment's agents by department: the coordinator apart, then each department as its agents come (who needs you first), the ones with none last. */
export function departmentsIn(team: BotTeam, configs: BotConfig[]): { coordinator: OfficeAgent[]; groups: Array<{ id: string; lead: BotConfig | null; agents: OfficeAgent[] }> } {
  const agents = agentsIn(team, configs);
  const groups = new Map<string, OfficeAgent[]>();
  for (const a of agents.filter((x) => !x.coordinator)) {
    const id = departmentOf(a.configId, configs);
    groups.set(id, [...(groups.get(id) ?? []), a]);
  }
  const ids = [...groups.keys()].sort((a, b) => Number(a === NO_DEPARTMENT) - Number(b === NO_DEPARTMENT));
  return { coordinator: agents.filter((a) => a.coordinator), groups: ids.map((id) => ({ id, lead: id === NO_DEPARTMENT ? null : (configs.find((c) => c.id === id) ?? null), agents: groups.get(id)! })) };
}

const atWork = (s: OfficeState | null) => s === 'working' || s === 'waiting';

/** An assignment in progress in another project than the one in focus: where, and how many of its agents are at work. */
export interface ElsewhereTeam {
  team: BotTeam;
  project: string;
  active: number;
}

/** The assignments in progress (working or waiting for you) in projects other than `focus`'s: the ones that need you first, then the latest. */
export function runningElsewhere(teams: BotTeam[], focus: BotTeam, projects: Array<{ cwd: string; name: string }>): ElsewhereTeam[] {
  const here = projectOf(focus.cwd, projects).cwd;
  return teams
    .filter((x) => x.id !== focus.id && (teamState(x) === 'working' || teamState(x) === 'waiting'))
    .map((team) => ({ team, where: projectOf(team.cwd, projects) }))
    .filter((x) => x.where.cwd !== here)
    .map(({ team, where }) => ({ team, project: where.name, active: team.bots.filter((b) => atWork(officeStateOf(team, b))).length }))
    .sort((a, b) => Number(teamState(b.team) === 'waiting') - Number(teamState(a.team) === 'waiting') || b.team.updatedAt - a.team.updatedAt);
}

/** Whether a bot can still hear from you: a live run, or a conversation to continue. */
export const reachable = (b: BotMember) => (!!b.runId && (ACTIVE.includes(b.status) || b.status === 'idle')) || !!b.sessionId;

/** The example office's agents and assignments (screenshots): shown, never saved nor sent to. */
export const isDemo = (id: string | null | undefined) => !!id?.startsWith('demo-');

/** The bot that waits for you in an assignment: the coordinator when its plan does, else the first one asking. */
export const waitingBot = (team: BotTeam) => (team.plan?.status === 'pending' ? team.bots[0] : team.bots.find((b) => b.status === 'waiting'));

/**
 * Where a message to an agent goes, without a new channel: its bot in the latest assignment it can
 * still hear in (a running one first). None: the message becomes an assignment for the coordinator.
 */
export function channelOf(member: BotConfig, teams: BotTeam[]): { team: BotTeam; bot: BotMember } | null {
  let best: { team: BotTeam; bot: BotMember; live: boolean } | null = null;
  for (const team of teams) {
    // Not a stopped assignment (it would start again for a word), nor an automation's step (the automation runs it).
    if (team.plan?.status === 'pending' || team.origin || teamState(team) === 'stopped') continue;
    for (const bot of team.bots) {
      if (bot.configId !== member.id || !reachable(bot)) continue;
      const live = ACTIVE.includes(bot.status);
      if (!best || (live && !best.live) || (live === best.live && team.updatedAt > best.team.updatedAt)) best = { team, bot, live };
    }
  }
  return best && { team: best.team, bot: best.bot };
}

/** The assignment that moved last: the coordinator's conversation on the office's box. */
export const latestTeam = (teams: BotTeam[]) => teams.reduce<BotTeam | undefined>((a, x) => (!a || x.updatedAt > a.updatedAt ? x : a), undefined);

/** The words of the example office (screenshots with --office-demo), in the app's language. */
export interface DemoText {
  goalA: string;
  goalB: string;
  taskA: string;
  taskB: string;
  taskC: string;
}

/**
 * An example office for screenshots, made from the organization's own agents and kept in the window
 * only (never saved): one project at work with an agent waiting for you, another one finished.
 */
export function demoTeams(configs: BotConfig[], projects: Array<{ cwd: string }>, now: number, text: DemoText): BotTeam[] {
  const coordinator = configs.find((c) => c.kind === 'coordinator');
  const { leads } = chartOf(configs);
  if (!coordinator || !leads.length) return [];
  const [a, b] = [...leads].sort((x, y) => y.team.length - x.team.length);
  const at = (i: number) => now - i * 60_000;
  // Each with a run and a conversation, so the box writes to it as it would to a real one.
  const member = (team: string, c: BotConfig, i: number, extra: Partial<BotMember>): BotMember => ({ id: `${team}-${i}`, name: c.name, configId: c.id, role: '', agent: c.agent, permissionMode: c.permissionMode, canSpawn: false, parentId: `${team}-0`, depth: 1, runId: `${team}-run-${i}`, sessionId: `${team}-session-${i}`, status: 'working', task: text.taskA, lastReply: '', costUsd: null, createdAt: at(10 - i), ...extra });
  const lead = (team: string, extra: Partial<BotMember>): BotMember => ({ ...member(team, coordinator, 0, extra), parentId: null, depth: 0, canSpawn: true });
  const crewA = [a!.member, ...a!.team].slice(0, 4);
  const teamA: BotTeam = {
    id: 'demo-a',
    title: text.goalA,
    goal: text.goalA,
    cwd: projects[0]?.cwd ?? '/demo/komodo-android',
    createdAt: at(30),
    updatedAt: at(1),
    bots: [
      lead('demo-a', { task: text.goalA, doing: 'Bash: pnpm test' }),
      ...crewA.map((c, i) => member('demo-a', c, i + 1, i === crewA.length - 1 ? { status: 'waiting', task: text.taskC } : i === 0 ? { status: 'done', task: text.taskB } : { doing: i === 1 ? 'Edit: OrgOffice.tsx' : null })),
    ],
  };
  const crewB = [(b ?? a)!.member, ...(b ?? a)!.team].slice(0, 2);
  const teamB: BotTeam = {
    id: 'demo-b',
    title: text.goalB,
    goal: text.goalB,
    cwd: projects[1]?.cwd ?? '/demo/pdf-master',
    createdAt: at(120),
    updatedAt: at(20),
    bots: [lead('demo-b', { status: 'idle', task: text.goalB }), ...crewB.map((c, i) => member('demo-b', c, i + 1, { status: 'done', task: text.taskB }))],
  };
  return [teamA, teamB];
}

/** The example office's agents when the organization isn't set up (a screenshot profile with no agent CLI): the house staff, in the window only. */
export function demoConfigs(staff: Record<string, StarterAgent>, agent: AgentChoice): BotConfig[] {
  return Object.entries(staff).map(([key, s]) => ({
    id: `demo-${key}`,
    name: s.name,
    role: s.role,
    agent: { ...agent, model: s.model ?? agent.model },
    permissionMode: s.permissionMode ?? 'acceptEdits',
    canSpawn: s.canSpawn === true,
    kind: key === 'coordinator' ? 'coordinator' : 'member',
    leadId: s.lead ? `demo-${s.lead}` : null,
    ...(s.proposed ? { proposed: true } : {}),
  }));
}

/**
 * Why no agent can run, from what the catalog says: no agent CLI installed, a provider missing its key,
 * or what an unavailable provider said; null when it says nothing.
 */
export function noAgentCause(catalog: RunnerCatalog | null): { kind: 'noCli' } | { kind: 'credential'; provider: string; label: string } | { kind: 'detail'; text: string } | null {
  if (!catalog) return null;
  const installed = catalog.harnesses.filter((h) => h.installed).map((h) => h.id);
  if (!installed.length) return { kind: 'noCli' };
  const usable = catalog.providers.filter((p) => p.harnesses.some((h) => installed.includes(h)));
  const keyless = usable.find((p) => p.available && p.credential && !p.credential.isSet && !p.credential.optional);
  if (keyless) return { kind: 'credential', provider: keyless.label, label: keyless.credential!.label };
  const said = usable.find((p) => !p.available && p.detail?.trim());
  return said ? { kind: 'detail', text: said.detail!.trim() } : null;
}
