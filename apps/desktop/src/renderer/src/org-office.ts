import type { BotConfig, BotMember, BotStatus, BotTeam } from '@shared/api';
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

/** A department: a top-level agent and its team, the lead first. */
export interface Department {
  lead: BotConfig;
  members: OfficeMember[];
  working: number;
  waiting: number;
}

/**
 * The organization by department (the chart's leads, each with its team), the coordinator apart and
 * the proposed agents last. `cwd` keeps the agents that work in that project.
 */
export function departmentsOf(configs: BotConfig[], teams: BotTeam[], cwd = ''): { coordinator: OfficeMember | null; departments: Department[]; proposed: BotConfig[] } {
  const { coordinator, leads, proposed } = chartOf(configs, cwd);
  const of = (member: BotConfig): OfficeMember => ({ member, status: activityOf(member, teams).status });
  const departments = leads.map(({ member, team }) => {
    const members = [of(member), ...team.map(of)];
    return { lead: member, members, working: members.filter((m) => m.status === 'working').length, waiting: members.filter((m) => m.status === 'waiting').length };
  });
  // Departments with a team first (as on the chart's map), each group in the chart's order.
  return { coordinator: coordinator ? of(coordinator) : null, departments: [...departments.filter((d) => d.members.length > 1), ...departments.filter((d) => d.members.length === 1)], proposed };
}

/** Whether a bot can still hear from you: a live run, or a conversation to continue. */
export const reachable = (b: BotMember) => (!!b.runId && (ACTIVE.includes(b.status) || b.status === 'idle')) || !!b.sessionId;

/**
 * Where a message to an agent goes, without a new channel: its bot in the latest assignment it can
 * still hear in (a running one first). None: the message becomes an assignment for the coordinator.
 */
export function channelOf(member: BotConfig, teams: BotTeam[]): { team: BotTeam; bot: BotMember } | null {
  let best: { team: BotTeam; bot: BotMember; live: boolean } | null = null;
  for (const team of teams) {
    if (team.plan?.status === 'pending') continue;
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
