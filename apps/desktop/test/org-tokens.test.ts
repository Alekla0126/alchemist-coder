import { describe, expect, it } from 'vitest';
import type { BotConfig, BotMember, BotTeam, TeamEvent } from '../src/shared/api';
import { exchangesOf } from '../src/renderer/src/org-model';
import { flowsOf, gainsOf, handsOf, ledgerOf, shareOf, totalOf, totalsOf, type SessionSpend } from '../src/renderer/src/org-tokens';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const lead = (extra: Partial<BotMember> = {}) => bot('b1', { name: 'Coordinator', parentId: null, depth: 0, createdAt: 0, ...extra });
const team = (extra: Partial<BotTeam> = {}): BotTeam => ({ id: 'team-1', title: 'Export to CSV', goal: 'Add a CSV export', cwd: '/p/castbook', createdAt: 0, updatedAt: 0, bots: [], ...extra });
const ev = (at: number, botId: string, kind: TeamEvent['kind'], detail = '', chars?: number): TeamEvent => ({ at, botId, kind, detail, ...(chars ? { chars } : {}) });
const config = (id: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name: id, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const configs = [config('coord', { kind: 'coordinator' }), config('coder'), config('tester')];
const spend = (input: number, output: number, cacheRead = 0, cacheWrite = 0, context = 0, contextWindow: number | null = null): SessionSpend => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  contextTokens: context,
  contextWindow,
});

describe("an assignment's spending", () => {
  const t = team({
    bots: [
      lead({ configId: 'coord', sessionId: 's1', costUsd: 1.5 }),
      bot('b2', { configId: 'coder', sessionId: 's2', costUsd: 2, createdAt: 10 }),
      // Asked twice: both add up on the coder's desk, and the context is the latest one's.
      bot('b3', { configId: 'coder', sessionId: 's3', costUsd: 0.5, createdAt: 20 }),
      // Not in the history yet: on its desk, counting nothing.
      bot('b4', { configId: 'tester', sessionId: 's4', createdAt: 30 }),
      // Defined on the spot, without a conversation at all.
      bot('b5', { createdAt: 40 }),
    ],
  });
  const sessions = { s1: spend(100, 1_000, 50_000, 2_000, 40_000, 200_000), s2: spend(10, 5_000, 300_000, 9_000, 90_000, 200_000), s3: spend(5, 2_000, 100_000, 1_000, 30_000, null) };
  const ledger = ledgerOf(t, sessions, configs);

  it('adds up what each desk read, re-read from the cache and wrote, and the cost its agents reported', () => {
    expect(ledger.desks.get('coord')).toMatchObject({ read: 52_100, cached: 50_000, written: 1_000, costUsd: 1.5, context: 40_000, contextWindow: 200_000, bots: 1, counted: 1 });
    expect(ledger.desks.get('coder')).toMatchObject({ read: 410_015, cached: 400_000, written: 7_000, costUsd: 2.5, context: 30_000, contextWindow: null, bots: 2, counted: 2 });
    expect(ledger.desks.get('tester')).toMatchObject({ read: 0, written: 0, costUsd: null, bots: 1, counted: 0 });
    expect(ledger.desks.get('bot:b5')).toMatchObject({ read: 0, bots: 1, counted: 0 });
  });

  it('totals the assignment, and names the desk that spent the most', () => {
    expect(ledger.total).toMatchObject({ read: 462_115, cached: 450_000, written: 8_000, costUsd: 4, bots: 5, counted: 3 });
    expect(totalOf(ledger.total)).toBe(470_115);
    expect(ledger.top).toBe('coder');
    expect(shareOf(ledger, 'coder')).toBeCloseTo(417_015 / 470_115);
    expect(shareOf(ledger, 'tester')).toBe(0);
    expect(shareOf(ledger, 'nobody')).toBe(0);
  });

  it('has no top desk and no shares before anything is in the history', () => {
    const none = ledgerOf(t, {}, configs);
    expect(none.top).toBeNull();
    expect(totalOf(none.total)).toBe(0);
    expect(shareOf(none, 'coord')).toBe(0);
    // Every desk is there anyway, so the first tokens that come in count as spent.
    expect([...totalsOf(none).keys()].sort()).toEqual(['bot:b5', 'coder', 'coord', 'tester']);
  });
});

describe('what each desk just spent', () => {
  const t = team({ bots: [lead({ configId: 'coord', sessionId: 's1' }), bot('b2', { configId: 'coder', sessionId: 's2' })] });
  const before = ledgerOf(t, { s1: spend(10, 100), s2: spend(10, 100) }, configs);

  it('is nothing the first time an assignment opens', () => {
    expect(gainsOf(null, before).size).toBe(0);
  });

  it("is how much more each desk spent since the last look, and only the ones that spent more", () => {
    const after = ledgerOf(t, { s1: spend(10, 100), s2: spend(10, 1_300, 5_000) }, configs);
    expect([...gainsOf(totalsOf(before), after)]).toEqual([['coder', 6_200]]);
    // Reindexed lower (a conversation rewritten): never a negative gain.
    expect(gainsOf(totalsOf(after), before).size).toBe(0);
  });

  it('counts a desk that had nothing yet, but not one that just joined', () => {
    const first = ledgerOf(t, { s1: spend(10, 100) }, configs);
    const next = ledgerOf(t, { s1: spend(10, 100), s2: spend(0, 400) }, configs);
    expect([...gainsOf(totalsOf(first), next)]).toEqual([['coder', 400]]);
    const joined = ledgerOf({ ...t, bots: [...t.bots, bot('b3', { configId: 'tester', sessionId: 's3' })] }, { s1: spend(10, 100), s3: spend(0, 900) }, configs);
    expect(gainsOf(totalsOf(first), joined).has('tester')).toBe(false);
  });
});

describe('who handed whom how much', () => {
  const t = team({
    bots: [lead({ configId: 'coord' }), bot('b2', { configId: 'coder', task: 'x'.repeat(4_000) }), bot('b3', { configId: 'tester', parentId: 'b2', depth: 2, createdAt: 20, task: 'test it' })],
    activity: [
      ev(1, 'b1', 'created', `b2|${'x'.repeat(300)}`),
      ev(2, 'b2', 'created', 'b3|test it'),
      ev(3, 'b3', 'finished', '', 400),
      ev(4, 'b2', 'finished', '', 2_000),
      ev(5, 'you', 'message', 'b1|Also the totals'),
      ev(6, 'b1', 'waiting', 'Overwrite the file?'),
      ev(7, 'autopilot', 'nudged', 'Coordinator'),
      ev(8, 'b1', 'learned', 'Keep commas'),
    ],
  });
  const flows = flowsOf(t, exchangesOf(t), configs);

  it('goes desk to desk, each way on its own, the heaviest first, with you at your desk', () => {
    expect(flows).toEqual([
      { from: 'coord', to: 'coder', n: 1, tokens: 1_000 },
      { from: 'coder', to: 'coord', n: 1, tokens: 500 },
      { from: 'tester', to: 'coder', n: 1, tokens: 100 },
      { from: 'you', to: 'coord', n: 2, tokens: 4 },
      { from: 'coord', to: 'you', n: 1, tokens: 5 },
      { from: 'coder', to: 'tester', n: 1, tokens: 2 },
    ].sort((a, b) => b.tokens - a.tokens || b.n - a.n));
    // A lesson is for everyone: no desk gets it.
    expect(flows.some((f) => f.from === 'coord' && f.to === 'coord')).toBe(false);
  });

  it("gives each desk its side: whom it handed how much, and from whom it got how much", () => {
    expect(handsOf(flows, 'coder')).toEqual({
      sent: [
        { id: 'coord', n: 1, tokens: 500 },
        { id: 'tester', n: 1, tokens: 2 },
      ],
      got: [
        { id: 'coord', n: 1, tokens: 1_000 },
        { id: 'tester', n: 1, tokens: 100 },
      ],
      sentTokens: 502,
      gotTokens: 1_100,
    });
    expect(handsOf(flows, 'you')).toMatchObject({ sentTokens: 4, gotTokens: 5 });
    expect(handsOf(flows, 'nobody')).toEqual({ sent: [], got: [], sentTokens: 0, gotTokens: 0 });
  });
});
