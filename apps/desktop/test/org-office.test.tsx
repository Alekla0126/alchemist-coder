import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BotConfig, BotMember, BotTeam, TeamEvent } from '../src/shared/api';
import { translate } from '../src/renderer/src/i18n';
import { exchangesOf } from '../src/renderer/src/org-model';
import { flowsOf, handsOf, ledgerOf } from '../src/renderer/src/org-tokens';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const config = (id: string, name: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name, role: `${name} does its part.`, agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', projects: ['/p/castbook'], ...extra });
const configs = [config('coord', 'Coordinator', { kind: 'coordinator', role: 'Plans the work and hands it out.' }), config('coder', 'Coder', { about: 'Writes the code.' }), config('tester', 'Tester')];
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const ev = (at: number, botId: string, kind: TeamEvent['kind'], detail = '', chars?: number): TeamEvent => ({ at, botId, kind, detail, ...(chars ? { chars } : {}) });
const team: BotTeam = {
  id: 'team-1',
  title: 'Export to CSV',
  goal: 'Add a CSV export',
  cwd: '/p/castbook',
  createdAt: 0,
  updatedAt: 0,
  bots: [
    bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, canSpawn: true, sessionId: 's1', costUsd: 1.25, createdAt: 0 }),
    bot('b2', { name: 'Coder', configId: 'coder', sessionId: 's2', status: 'waiting', task: 'Write the exporter', costUsd: 3 }),
  ],
  activity: [ev(1, 'b1', 'created', 'b2|Write the exporter'), ev(2, 'b2', 'waiting', 'Overwrite out.csv?'), ev(3, 'you', 'message', 'b2|Yes, overwrite it')],
};

const state = {
  botConfigs: configs,
  changedSessions: [] as string[],
  locale: 'en',
  info: null,
  messageBot: async () => {},
};
// The store talks to the app's preload bridge; the office only reads these.
vi.mock('../src/renderer/src/store', () => {
  const useStore = Object.assign((pick: (s: unknown) => unknown) => pick(state), { getState: () => state, setState: () => {} });
  return { useStore, useT: () => (key: never, vars?: Record<string, string | number>) => translate('en', key, vars) };
});

const { CardWrite, OrgLive, TokenTable } = await import('../src/renderer/src/components/OrgLive');

describe('the office', () => {
  const html = renderToStaticMarkup(<OrgLive team={team} cwd="/p/castbook" />);

  it('seats you beside the coordinator, saying in words that someone needs you', () => {
    expect(html).toContain('data-live="you"');
    expect(html).toMatch(/class="of-desk st-waiting[^"]*of-you/);
    expect(html).toContain('Needs you');
    expect(html.indexOf('data-live="you"')).toBeLessThan(html.indexOf('data-live="coord"'));
  });

  it("puts a token meter on every desk in the assignment, in words before the history is read", () => {
    // Coordinator and Coder are in it; the Tester isn't, so it has no meter.
    expect(html.match(/class="tk-desk"/g)).toHaveLength(2);
    expect(html).toContain('no tokens yet');
    expect(html).toMatch(/data-live="tester"[^>]*class="of-desk st-out/);
  });

  it('says over the office what the assignment spent and how much they handed each other', () => {
    expect(html).toContain('Spent in this assignment');
    // Three messages: the task, the question to you and your answer.
    expect(html).toMatch(/≈ \d+ tokens handed over in 3 messages/);
  });

  it('weighs each message in the conversation below', () => {
    expect(html).toMatch(/asks you · ≈ \d+ tokens/);
  });

  it('lists the token exchange with you in it', () => {
    expect(html).toContain('Token exchange');
    expect(html).toMatch(/<button class="tk-who"[^>]*>You<\/button>/);
  });
});

describe('the token exchange', () => {
  const sessions = { s1: { inputTokens: 10, outputTokens: 2_000, cacheReadTokens: 90_000, cacheWriteTokens: 8_000, contextTokens: 50_000, contextWindow: 200_000 }, s2: { inputTokens: 5, outputTokens: 9_000, cacheReadTokens: 400_000, cacheWriteTokens: 1_000, contextTokens: 0, contextWindow: null } };
  const ledger = ledgerOf(team, sessions, configs);
  const flows = flowsOf(team, exchangesOf(team), configs);
  const rows = [
    { id: 'you', name: 'You', spend: null, hands: handsOf(flows, 'you') },
    { id: 'coord', name: 'Coordinator', spend: ledger.desks.get('coord')!, hands: handsOf(flows, 'coord') },
    { id: 'coder', name: 'Coder', spend: ledger.desks.get('coder')!, hands: handsOf(flows, 'coder') },
  ];
  const html = renderToStaticMarkup(<TokenTable rows={rows} ledger={ledger} open="coder" onOpen={() => {}} onHover={() => {}} />);

  it('puts the biggest spender first, with its share, what it read and wrote, and its cost', () => {
    const order = [...html.matchAll(/<button class="tk-who"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(order).toEqual(['Coder', 'Coordinator', 'You']);
    expect(html).toContain('410k · 80%');
    expect(html).toContain('$3.00');
    expect(html).toContain('$1.25');
  });

  it('marks the row whose card is open, and says it with the button too', () => {
    expect(html).toMatch(/<tr class="on"[^>]*><th scope="row"><button class="tk-who" aria-expanded="true"[^>]*>Coder/);
  });

  it('shows what you handed over and got, but no spending of your own', () => {
    const you = html.slice(html.lastIndexOf('<tr'));
    expect(you).toContain('>You<');
    expect(you).toMatch(/≈ \d+/);
    expect(you.match(/<td>—<\/td>/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('draws nothing without desks', () => {
    expect(renderToStaticMarkup(<TokenTable rows={[]} ledger={ledger} open={null} onOpen={() => {}} onHover={() => {}} />)).toBe('');
  });
});

describe("writing to an agent from its card", () => {
  const [lead, coder] = team.bots as [BotMember, BotMember];
  const box = (t: BotTeam, b: BotMember) => renderToStaticMarkup(<CardWrite team={t} bot={b} />);

  it('sends to a working agent right away', () => {
    const html = box(team, { ...coder, runId: 'run-2', status: 'working' });
    expect(html).toContain('placeholder="Message Coder…"');
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
    // Nothing typed yet: only the send button waits.
    expect(html).toMatch(/<button class="btn-send small" disabled="">Send ↵<\/button>/);
    expect(html).not.toContain('starts it again');
  });

  it("continues a finished one, and says first that it's a new turn that costs", () => {
    const html = box(team, { ...coder, runId: null, status: 'done' });
    expect(html).toContain('to continue its conversation');
    expect(html).toContain('your message starts it again');
    expect(html).toContain('Continue ↵');
  });

  it("can't reach one without a conversation to continue", () => {
    const html = box(team, { ...coder, runId: null, status: 'done', sessionId: null });
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).not.toContain('starts it again');
  });

  it('waits for your answer to the plan before writing to the coordinator', () => {
    const pending: BotTeam = { ...team, plan: { summary: 'Two agents', bots: [], estimateUsd: null, status: 'pending', feedback: '', revision: 1 } };
    const html = box(pending, { ...lead, runId: 'run-1', status: 'waiting' });
    expect(html).toContain('Answer the plan above first');
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    // Any other agent can still be written to.
    expect(box(pending, { ...coder, runId: 'run-2', status: 'working' })).not.toMatch(/<textarea[^>]*disabled=""/);
  });
});
