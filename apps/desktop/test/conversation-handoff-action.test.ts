import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@alchemist-coder/core';

const transcript = vi.fn();
const startRun = vi.fn();
const state = {
  locale: 'es',
  catalog: {
    harnesses: [{ id: 'codex', installed: true }],
    providers: [{ id: 'openai', available: true, harnesses: ['codex'], models: [{ id: 'default' }], credential: { optional: true } }],
  },
  settings: { activeProjectId: 7, openProjectIds: [7], mode: 'agents' },
  runByTarget: {} as Record<string, string>,
  runs: {} as Record<string, { sessionId: string | null; status: string }>,
  conversationHandoff: null as unknown,
  newConversation: vi.fn(), openProject: vi.fn(), setActiveProject: vi.fn(), setMode: vi.fn(),
};
vi.mock('../src/renderer/src/store', () => ({ useStore: { getState: () => state, setState: (patch: object) => Object.assign(state, patch) } }));
vi.stubGlobal('window', { alchemist: { transcript, startRun } });
const { continueWithCodex } = await import('../src/renderer/src/actions/session');
const session = { id: 'original-claude-session', projectId: 7, title: 'Garden tracker', source: 'claude-code' } as SessionSummary;

beforeEach(() => {
  vi.clearAllMocks(); state.conversationHandoff = null; state.runByTarget = {}; state.runs = {};
  transcript.mockResolvedValue({ entries: [{ key: '1', role: 'user', blocks: [{ kind: 'text', text: 'Remember Solar Cedar.' }] }], offset: 0, total: 1, nextOffset: null });
});

it('prepares a new Codex draft without sending anything or changing the Claude session', async () => {
  const before = JSON.stringify(session);
  await continueWithCodex(session);
  expect(state.newConversation).toHaveBeenCalledWith(7);
  expect(state.setMode).toHaveBeenCalledWith('agents');
  expect(state.conversationHandoff).toMatchObject({ sessionId: session.id, context: expect.stringContaining('Solar Cedar'), agent: { harnessId: 'codex' } });
  expect(startRun).not.toHaveBeenCalled();
  expect(JSON.stringify(session)).toBe(before);
});

it('preserves the current screen and draft if reading the original fails', async () => {
  state.conversationHandoff = { context: 'existing draft' };
  transcript.mockRejectedValue(new Error('transcript unavailable'));
  await expect(continueWithCodex(session)).rejects.toThrow('transcript unavailable');
  expect(state.newConversation).not.toHaveBeenCalled();
  expect(state.conversationHandoff).toEqual({ context: 'existing draft' });
});

it('does not take over a new conversation that is still starting', async () => {
  state.runByTarget = { 'p:7': 'pending' };
  state.runs = { pending: { sessionId: null, status: 'starting' } };
  await expect(continueWithCodex(session)).rejects.toThrow(/Espera/);
  expect(state.newConversation).not.toHaveBeenCalled();
  expect(startRun).not.toHaveBeenCalled();
});
