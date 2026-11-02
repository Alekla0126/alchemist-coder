import { describe, expect, it } from 'vitest';
import type { BotConfig, BotMember, BotTeam, TeamEvent } from '../src/shared/api';
import { columnsOf, companyOf, EXTRA, linkWidth, mapShare, since } from '../src/renderer/src/org-map';
import { YOU } from '../src/renderer/src/org-model';
import type { SessionSpend } from '../src/renderer/src/org-tokens';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'done', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const lead = (extra: Partial<BotMember> = {}) => bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, createdAt: 0, ...extra });
const ev = (at: number, botId: string, kind: TeamEvent['kind'], detail = ''): TeamEvent => ({ at, botId, kind, detail });
const config = (id: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name: id, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const spend = (input: number, output: number, cacheRead = 0): SessionSpend => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, contextTokens: 0, contextWindow: null });

const configs = [config('coord', { kind: 'coordinator' }), config('planner'), config('coder', { leadId: 'planner' }), config('tester', { leadId: 'planner' }), config('finance')];
const team = (id: string, updatedAt: number, bots: BotMember[], activity: TeamEvent[]): BotTeam => ({ id, title: id, goal: `goal ${id}`, cwd: '/p', createdAt: 0, updatedAt, bots, activity });

describe('the company map', () => {
  // Two assignments: the coordinator hands the coder work in both, the coder answers in one.
  const a = team('a', 100, [lead({ sessionId: 's1', costUsd: 1 }), bot('b2', { configId: 'coder', sessionId: 's2', costUsd: 2 })], [ev(1, 'b1', 'created', `b2|${'x'.repeat(400)}`), ev(2, 'b2', 'finished')]);
  const b = team('b', 200, [lead({ sessionId: 's3' }), bot('b2', { configId: 'coder', sessionId: 's4' }), bot('b3', { name: 'tester', sessionId: 's5' })], [ev(1, 'b1', 'created', `b2|${'y'.repeat(200)}`), ev(2, 'b1', 'created', 'b3|test it'), ev(3, 'you', 'message', 'b1|faster please')]);
  a.bots[1]!.lastReply = 'z'.repeat(80);
  const sessions = { s1: spend(100, 1000, 9000), s2: spend(50, 4000), s3: spend(10, 500), s4: spend(20, 2000), s5: spend(5, 100) };
  const map = companyOf([a, b], sessions, configs);

  it('adds up what each agent spent in all its assignments, and in how many', () => {
    expect(map.spend.get('coord')).toMatchObject({ read: 9110, cached: 9000, written: 1500, costUsd: 1, assignments: 2 });
    expect(map.spend.get('coder')).toMatchObject({ read: 70, written: 6000, costUsd: 2, assignments: 2 });
    expect(map.assignments).toBe(2);
    expect(map.total.written).toBe(7600);
  });

  it('puts an agent made on the spot on the agent with its name (a copy that was removed), else among the agents of the moment', () => {
    // b3 has no configuration but is named like one.
    expect(map.spend.get('tester')).toMatchObject({ written: 100, assignments: 1 });
    expect(map.spend.has(EXTRA)).toBe(false);
    const other = companyOf([team('c', 1, [lead(), bot('b9', { name: 'Ghost', sessionId: 's9' })], [])], { s9: spend(1, 1) }, configs);
    expect(other.spend.get(EXTRA)).toMatchObject({ read: 1, written: 1 });
  });

  it('links two agents once, with the tokens each way and the heaviest first', () => {
    const coordCoder = map.links.find((l) => l.a === 'coder' && l.b === 'coord')!;
    // 400 + 200 characters of tasks one way (about 4 per token), an 80-character reply the other.
    expect(coordCoder).toMatchObject({ ba: 150, ab: 20, n: 3 });
    expect(map.links[0]).toBe(coordCoder);
    expect(map.links.find((l) => l.a === 'coord' && l.b === YOU)).toMatchObject({ ba: 3, n: 1 });
  });

  it('says each agent’s share, how wide a link is and which assignments are recent', () => {
    // coder 70 + 6000 of 9110 + 1500 (coordinator) + 6070 + 105 (tester).
    expect(mapShare(map, 'coder')).toBeCloseTo(6070 / 16_785, 5);
    expect(linkWidth(0, 100)).toBe(1);
    expect(linkWidth(100, 100)).toBe(7);
    expect(linkWidth(25, 100)).toBe(4);
    expect(since([a, b], 1, 86_400_000 + 150).map((x) => x.id)).toEqual(['b']);
    expect(since([a, b], 0)).toHaveLength(2);
  });

  it('draws a column per lead with its team, the ones with a team first', () => {
    expect(columnsOf(configs).map((c) => [c.lead.id, c.team.map((m) => m.id)])).toEqual([
      ['planner', ['coder', 'tester']],
      ['finance', []],
    ]);
  });
});
