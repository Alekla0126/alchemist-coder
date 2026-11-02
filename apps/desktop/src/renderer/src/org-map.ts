import type { BotConfig, BotTeam } from '@shared/api';
import { cardOf, exchangesOf, YOU } from './org-model';
import { flowsOf, ledgerOf, totalOf, type SessionSpend, type Spend } from './org-tokens';

/**
 * The whole company on one map: every agent of the organization with what it spent in all its
 * assignments, and the links between them weighted by the tokens they handed each other. The
 * office (org-tokens.ts) counts one assignment; this adds them all up, desk by desk.
 */

/** Agents an assignment made on the spot (no configuration of their own) share one place on the map. */
export const EXTRA = 'extra';

/** What one place on the map spent, in how many assignments. */
export interface MapSpend extends Spend {
  assignments: number;
}

/** Two places that handed each other work: tokens each way and how many messages. */
export interface MapLink {
  a: string;
  b: string;
  /** Tokens a handed b, and b handed a. */
  ab: number;
  ba: number;
  n: number;
}

export interface CompanyMap {
  spend: Map<string, MapSpend>;
  /** Heaviest first. */
  links: MapLink[];
  total: Spend;
  assignments: number;
}

const empty = (): MapSpend => ({ read: 0, cached: 0, written: 0, costUsd: null, context: 0, contextWindow: null, bots: 0, counted: 0, assignments: 0 });

/** Where a desk of one assignment goes on the map: its agent, else one with its name (a copy that was removed), else EXTRA. */
function placeOf(team: BotTeam, card: string, configs: BotConfig[]): string {
  if (!card.startsWith('bot:')) return card;
  const bot = team.bots.find((b) => b.id === card.slice(4));
  const named = bot && configs.find((c) => c.name.trim().toLowerCase() === bot.name.trim().toLowerCase());
  return named?.id ?? EXTRA;
}

export function companyOf(teams: BotTeam[], sessions: Record<string, SessionSpend | null | undefined>, configs: BotConfig[]): CompanyMap {
  const spend = new Map<string, MapSpend>();
  const links = new Map<string, MapLink>();
  const total: Spend = empty();
  for (const team of teams) {
    const ledger = ledgerOf(team, sessions, configs);
    const here = new Set<string>();
    for (const [card, s] of ledger.desks) {
      const id = placeOf(team, card, configs);
      const into = spend.get(id) ?? empty();
      spend.set(id, into);
      into.read += s.read;
      into.cached += s.cached;
      into.written += s.written;
      into.bots += s.bots;
      into.counted += s.counted;
      if (s.costUsd != null) into.costUsd = (into.costUsd ?? 0) + s.costUsd;
      if (!here.has(id)) into.assignments++;
      here.add(id);
    }
    total.read += ledger.total.read;
    total.cached += ledger.total.cached;
    total.written += ledger.total.written;
    total.bots += ledger.total.bots;
    total.counted += ledger.total.counted;
    if (ledger.total.costUsd != null) total.costUsd = (total.costUsd ?? 0) + ledger.total.costUsd;
    for (const f of flowsOf(team, exchangesOf(team), configs)) {
      const from = f.from === YOU ? YOU : placeOf(team, f.from, configs);
      const to = f.to === YOU ? YOU : placeOf(team, f.to, configs);
      if (from === to) continue;
      const [a, b] = from < to ? [from, to] : [to, from];
      const key = `${a}|${b}`;
      const link = links.get(key) ?? { a, b, ab: 0, ba: 0, n: 0 };
      links.set(key, link);
      if (from === a) link.ab += f.tokens;
      else link.ba += f.tokens;
      link.n += f.n;
    }
  }
  return { spend, links: [...links.values()].sort((x, y) => y.ab + y.ba - (x.ab + x.ba) || y.n - x.n), total, assignments: teams.length };
}

/** A place's share of everything the company spent, from 0 to 1. */
export function mapShare(map: CompanyMap, id: string): number {
  const all = totalOf(map.total);
  const own = map.spend.get(id);
  return all > 0 && own ? totalOf(own) / all : 0;
}

/** How wide a link is drawn: thin for a few tokens, up to `max` px for the heaviest (by area, so a 4× link isn't 4× as wide). */
export function linkWidth(tokens: number, heaviest: number, max = 7): number {
  if (heaviest <= 0 || tokens <= 0) return 1;
  return Math.round((1 + (max - 1) * Math.sqrt(tokens / heaviest)) * 10) / 10;
}

/** Assignments from the last `days` days (0: all of them). */
export function since(teams: BotTeam[], days: number, now = Date.now()): BotTeam[] {
  return days > 0 ? teams.filter((x) => x.updatedAt >= now - days * 86_400_000) : teams;
}

export interface MapColumn {
  /** The lead (a top-level agent) and its team, in the chart's order. */
  lead: BotConfig;
  team: BotConfig[];
}

/** The map's columns: one per top-level agent (with its team under it), the ones with a team first. */
export function columnsOf(configs: BotConfig[]): MapColumn[] {
  const members = configs.filter((c) => c.kind !== 'coordinator' && !c.proposed);
  const ids = new Set(members.map((c) => c.id));
  const leads = members.filter((c) => !c.leadId || !ids.has(c.leadId));
  const cols = leads.map((lead) => ({ lead, team: members.filter((c) => c.leadId === lead.id) }));
  return [...cols.filter((c) => c.team.length), ...cols.filter((c) => !c.team.length)];
}
