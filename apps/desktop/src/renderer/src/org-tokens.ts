import type { SessionSummary } from '@alchemist-coder/core';
import type { BotConfig, BotTeam } from '@shared/api';
import { cardOf, type Exchange } from './org-model';

/** What the history keeps of a conversation's tokens: all the office needs of it. */
export type SessionSpend = Pick<SessionSummary, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'contextTokens' | 'contextWindow'>;

/** What a desk's agents spent in an assignment, from their conversations in the history. */
export interface Spend {
  /** Tokens read: its prompts and tool results, plus the context read again from the cache or written to it. */
  read: number;
  /** Of those, read again from the cache: most of them, and the cheap ones. */
  cached: number;
  /** Tokens written: its answers, its thinking and its tool calls. */
  written: number;
  /** What its agents reported in US$ (the same count as the assignment's cost); null when none did. */
  costUsd: number | null;
  /** How full its latest conversation's context is, and of how much; 0 and null when unknown. */
  context: number;
  contextWindow: number | null;
  /** Its agents in the assignment, and how many of them have a conversation in the history yet. */
  bots: number;
  counted: number;
}

/** Everything a spend read and wrote. */
export const totalOf = (s: Pick<Spend, 'read' | 'written'>) => s.read + s.written;

const empty = (): Spend => ({ read: 0, cached: 0, written: 0, costUsd: null, context: 0, contextWindow: null, bots: 0, counted: 0 });

/** An assignment's spending, desk by desk and in all, and the desk that spent the most. */
export interface Ledger {
  desks: Map<string, Spend>;
  total: Spend;
  top: string | null;
}

/**
 * What each desk spent in an assignment: its agents' conversations as the history counts them
 * (`sessions`, by conversation id; a bot without one yet counts nothing), on the desk cardOf puts
 * them. An agent asked twice in one assignment adds up on its desk.
 */
export function ledgerOf(team: BotTeam, sessions: Record<string, SessionSpend | null | undefined>, configs: BotConfig[]): Ledger {
  const desks = new Map<string, Spend>();
  const total = empty();
  // Oldest first, so a desk's context is its latest agent's.
  for (const bot of [...team.bots].sort((a, b) => a.createdAt - b.createdAt)) {
    const card = cardOf(team, bot.id, configs);
    if (!card) continue;
    const desk = desks.get(card) ?? empty();
    desks.set(card, desk);
    const s = bot.sessionId ? sessions[bot.sessionId] : null;
    for (const x of [desk, total]) {
      x.bots++;
      if (bot.costUsd != null) x.costUsd = (x.costUsd ?? 0) + bot.costUsd;
      if (!s) continue;
      x.counted++;
      x.read += s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
      x.cached += s.cacheReadTokens;
      x.written += s.outputTokens;
    }
    if (s && s.contextTokens > 0) {
      desk.context = s.contextTokens;
      desk.contextWindow = s.contextWindow;
    }
  }
  let top: string | null = null;
  for (const [card, s] of desks) if (totalOf(s) > 0 && (!top || totalOf(s) > totalOf(desks.get(top)!))) top = card;
  return { desks, total, top };
}

/** What a desk's share of the assignment's tokens is, from 0 to 1. */
export function shareOf(ledger: Ledger, card: string): number {
  const all = totalOf(ledger.total);
  const own = ledger.desks.get(card);
  return all > 0 && own ? totalOf(own) / all : 0;
}

/** What one desk handed another in an assignment: how many messages, weighing about how many tokens. */
export interface Flow {
  from: string;
  to: string;
  n: number;
  tokens: number;
}

/** Desk to desk, each way on its own, the heaviest first: who handed whom how much. */
export function flowsOf(team: BotTeam, exchanges: Exchange[], configs: BotConfig[]): Flow[] {
  const flows = new Map<string, Flow>();
  for (const x of exchanges) {
    const from = cardOf(team, x.from, configs);
    const to = x.to ? cardOf(team, x.to, configs) : null;
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}`;
    const flow = flows.get(key) ?? { from, to, n: 0, tokens: 0 };
    flow.n++;
    flow.tokens += x.tokens;
    flows.set(key, flow);
  }
  return [...flows.values()].sort((a, b) => b.tokens - a.tokens || b.n - a.n);
}

/** One desk's side of the flows: whom it handed how much, and from whom it got how much. */
export interface Hands {
  sent: Array<{ id: string; n: number; tokens: number }>;
  got: Array<{ id: string; n: number; tokens: number }>;
  sentTokens: number;
  gotTokens: number;
}

export function handsOf(flows: Flow[], card: string): Hands {
  const sent = flows.filter((f) => f.from === card).map((f) => ({ id: f.to, n: f.n, tokens: f.tokens }));
  const got = flows.filter((f) => f.to === card).map((f) => ({ id: f.from, n: f.n, tokens: f.tokens }));
  const sum = (xs: Array<{ tokens: number }>) => xs.reduce((a, x) => a + x.tokens, 0);
  return { sent, got, sentTokens: sum(sent), gotTokens: sum(got) };
}

/**
 * How many tokens each desk spent since the last look: only desks that spent more (a conversation
 * that's reindexed never makes a desk spend less). None the first time (an assignment just opened).
 */
export function gainsOf(prev: ReadonlyMap<string, number> | null, ledger: Ledger): Map<string, number> {
  const out = new Map<string, number>();
  if (!prev) return out;
  for (const [card, s] of ledger.desks) {
    const was = prev.get(card);
    const grew = totalOf(s) - (was ?? 0);
    if (was !== undefined && grew > 0) out.set(card, grew);
  }
  return out;
}

/** Each desk's tokens, to compare with on the next look (gainsOf). */
export const totalsOf = (ledger: Ledger) => new Map([...ledger.desks].map(([card, s]) => [card, totalOf(s)]));
