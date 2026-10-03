import type { BotConfig, BotMember, BotStatus, BotTeam } from '@shared/api';
import { isInside } from './paths';

export const ACTIVE: BotStatus[] = ['starting', 'working', 'waiting'];

/** A bot's status as you see it: a coordinator whose plan waits for you is waiting for you (even stopped: answering resumes it). */
export function botState(team: BotTeam, bot: BotMember): BotStatus {
  if (bot.depth === 0 && team.plan?.status === 'pending' && bot.status !== 'error') return 'waiting';
  return bot.status;
}

export const teamActive = (team: BotTeam) => team.bots.some((b) => ACTIVE.includes(b.status));
export const teamCost = (team: BotTeam) => team.bots.reduce((a, b) => a + (b.costUsd ?? 0), 0);

/** One word for how a team is doing. */
export type TeamState = 'waiting' | 'working' | 'stopped' | 'failed' | 'finished' | 'yourTurn';
/** Whether an assignment waits for you: a plan to review (even after a stop or restart: answering resumes it) or an agent asking. */
export const needsYou = (team: BotTeam) => team.plan?.status === 'pending' || team.bots.some((b) => b.status === 'waiting');

export function teamState(team: BotTeam): TeamState {
  if (needsYou(team)) return 'waiting';
  if (team.bots.some((b) => b.status === 'working' || b.status === 'starting')) return 'working';
  if (team.stoppedReason || team.bots[0]?.status === 'stopped') return 'stopped';
  if (team.bots[0]?.status === 'error') return 'failed';
  // Finished only when the coordinator said so (finish_team); otherwise it ended its turn for you. An
  // automation's step is done when its agent is: the automation reviews it, not you.
  return team.finished || team.origin ? 'finished' : 'yourTurn';
}

/** Whether an agent works in the project at `cwd` (no projects = all of them). */
export const inProject = (c: BotConfig, cwd: string) => !c.projects?.length || c.projects.some((p) => isInside(cwd, p) || isInside(p, cwd));
export const inFolder = (team: BotTeam, cwd: string) => isInside(team.cwd, cwd);

/** Something an agent needs from you: a plan to review or a question/permission, and in which assignment. */
export interface Need {
  team: BotTeam;
  kind: 'plan' | 'ask';
  detail: string;
}

/** What an organization agent is doing across its assignments: what it needs from you, what it's working on. */
export function activityOf(member: BotConfig, teams: BotTeam[]) {
  let working = 0;
  let cost = 0;
  let doing: string | null = null;
  const needs: Need[] = [];
  const involved: BotTeam[] = [];
  for (const team of teams) {
    const mine = team.bots.filter((b) => b.configId === member.id);
    if (!mine.length) continue;
    involved.push(team);
    for (const b of mine) {
      cost += b.costUsd ?? 0;
      const state = botState(team, b);
      if (state === 'waiting') {
        const plan = b.depth === 0 && team.plan?.status === 'pending';
        const asked = [...(team.activity ?? [])].reverse().find((e) => e.kind === 'waiting' && e.botId === b.id);
        needs.push({ team, kind: plan ? 'plan' : 'ask', detail: plan ? '' : (asked?.detail ?? '') });
      } else if (ACTIVE.includes(state)) {
        working++;
        doing ??= b.doing ?? null;
      }
    }
  }
  const status: 'waiting' | 'working' | 'idle' = needs.length ? 'waiting' : working ? 'working' : 'idle';
  return { status, working, waiting: needs.length, needs, cost, doing, involved };
}

/** How an agent relates to the open assignment: in it (its own bots there), planned for it, or not. */
export type Focus = { kind: 'in'; team: BotTeam; bots: BotMember[] } | { kind: 'planned'; team: BotTeam } | { kind: 'out' } | null;

/** What an agent did in one assignment, most telling first: needs you, working, failed, done, stopped. */
export function resultIn(team: BotTeam, bots: BotMember[]): 'waiting' | 'working' | 'error' | 'done' | 'stopped' {
  const states = bots.map((b) => botState(team, b));
  if (states.includes('waiting')) return 'waiting';
  if (states.some((s) => ACTIVE.includes(s))) return 'working';
  if (states.includes('error')) return 'error';
  if (states.some((s) => s === 'done' || s === 'idle')) return 'done';
  return 'stopped';
}

/** A top-level agent and the agents on its team. */
export interface ChartLead {
  member: BotConfig;
  team: BotConfig[];
}

/** The organization as a chart: the coordinator, the agents that report to it (each with its team), and the proposed ones. */
export function chartOf(configs: BotConfig[], cwd = ''): { coordinator: BotConfig | null; leads: ChartLead[]; proposed: BotConfig[] } {
  const members = configs.filter((c) => c.kind !== 'coordinator' && (!cwd || inProject(c, cwd)));
  const kept = members.filter((c) => !c.proposed);
  return {
    coordinator: configs.find((c) => c.kind === 'coordinator') ?? null,
    // An agent whose lead isn't showing (another project) stands on its own.
    leads: kept.filter((m) => !m.leadId || !kept.some((k) => k.id === m.leadId)).map((member) => ({ member, team: kept.filter((x) => x.leadId === member.id) })),
    proposed: members.filter((c) => c.proposed),
  };
}

/** Whether `member` can go on `lead`'s team; `null` (or the coordinator) takes it back under the coordinator. */
export function canMove(member: BotConfig, lead: BotConfig | null, configs: BotConfig[]): boolean {
  if (member.kind === 'coordinator' || member.proposed) return false;
  if (!lead || lead.kind === 'coordinator') return !!member.leadId;
  if (lead.id === member.id || lead.proposed || lead.leadId || member.leadId === lead.id) return false;
  // An agent that leads a team can't join another one.
  return !configs.some((c) => c.leadId === member.id);
}

/** An agent's part in one assignment: what it was (or will be) asked to do and how that is going. */
export interface CardWork {
  state: 'planned' | 'waiting' | 'working' | 'error' | 'done' | 'stopped';
  task: string;
  /** What it's doing right now, while it works. */
  doing: string | null;
  /** Its bot in the assignment (none while it's only planned). */
  botId: string | null;
  /** Other tasks the same agent has there. */
  more: number;
  costUsd: number | null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const planOf = (team: BotTeam) => (team.plan && team.plan.status !== 'changes' ? team.plan.bots : []);

function workOfBots(team: BotTeam, bots: BotMember[]): CardWork {
  const state = resultIn(team, bots);
  // The one that tells the most: waiting for you, then working, then the latest.
  const shown = bots.find((b) => botState(team, b) === 'waiting') ?? bots.find((b) => ACTIVE.includes(botState(team, b))) ?? bots.at(-1)!;
  const cost = bots.reduce((a, b) => a + (b.costUsd ?? 0), 0);
  return { state, task: shown.task, doing: state === 'working' ? (shown.doing ?? null) : null, botId: shown.id, more: bots.length - 1, costUsd: cost > 0 ? cost : null };
}

/** What `member` has to do with `team`: its bots there, or what the plan has for it; null when it isn't part of it. */
export function workIn(team: BotTeam, member: BotConfig): CardWork | null {
  const bots = team.bots.filter((b) => b.configId === member.id);
  if (bots.length) return workOfBots(team, bots);
  const planned = planOf(team).filter((p) => (p.config ? p.config === member.id || same(p.config, member.name) : same(p.name, member.name)));
  if (!planned.length) return null;
  return { state: 'planned', task: planned[0]!.task, doing: null, botId: null, more: planned.length - 1, costUsd: null };
}

/** Agents of an assignment that aren't in the organization: defined on the spot, in the plan or already working. */
export function extrasIn(team: BotTeam, configs: BotConfig[]): Array<{ key: string; name: string; role: string; work: CardWork }> {
  const known = (id: string | null) => !!id && configs.some((c) => c.id === id);
  const created = team.bots.filter((b) => b.depth > 0 && !known(b.configId));
  const extras = created.map((b) => ({ key: `bot:${b.id}`, name: b.name, role: b.role, work: workOfBots(team, [b]) }));
  planOf(team).forEach((p, i) => {
    if (p.config ? configs.some((c) => c.id === p.config || same(c.name, p.config)) : configs.some((c) => same(c.name, p.name))) return;
    if (created.some((b) => same(b.name, p.name))) return;
    extras.push({ key: `plan:${i}`, name: p.name, role: p.role, work: { state: 'planned', task: p.task, doing: null, botId: null, more: 0, costUsd: null } });
  });
  return extras;
}
