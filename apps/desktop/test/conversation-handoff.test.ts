import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary, TranscriptEntry } from '@alchemist-coder/core';
import type { AgentChoice, RunnerCatalog } from '../src/shared/api';
import { codexChoice, handoffContext, handoffPrompt, loadHandoff } from '../src/renderer/src/conversation-handoff';

const agent: AgentChoice = { harnessId: 'codex', providerId: 'openai', model: 'default' };
const session = { id: 'claude-original-1234', projectId: 7, title: 'My project', source: 'claude-code' } as SessionSummary;
const entry = (key: string, role: 'user' | 'assistant', text: string): TranscriptEntry => ({ key, role, ts: 0, model: null, blocks: [{ kind: 'text', text }] });
const catalog = (extra = {}): RunnerCatalog => ({
  harnesses: [{ id: 'codex', label: 'Codex', installed: true, version: '1', path: 'codex', install: null }],
  providers: [{ id: 'openai', label: 'ChatGPT', edition: 'pro', harnesses: ['codex'], available: true, detail: null, models: [{ id: 'default', label: 'Default' }], credential: { label: 'API key', placeholder: null, isSet: false, optional: true }, ...extra }],
});

describe('continuing a Claude conversation with Codex', () => {
  it('uses the existing subscription sign-in, but never offers a provider needing a missing key', () => {
    expect(codexChoice(catalog())).toEqual(agent);
    expect(codexChoice(catalog({ credential: { isSet: false, optional: false } }))).toBeNull();
    expect(codexChoice(catalog({ available: false }))).toBeNull();
    const absent = catalog(); absent.harnesses[0]!.installed = false;
    expect(codexChoice(absent)).toBeNull();
  });

  it('preserves the request, decisions and code as text, without thoughts, tool payloads or image data', () => {
    const history = [entry('1', 'user', 'Build the garden tracker.'), entry('2', 'assistant', 'Use SQLite.\n```sql\nCREATE TABLE plants(id INTEGER);\n```')];
    history[1]!.blocks.push({ kind: 'thinking', text: 'PRIVATE_THOUGHT' }, { kind: 'tool_result', toolUseId: 't1', isError: false, preview: 'PRIVATE_TOOL_PAYLOAD' }, { kind: 'image', bytes: 20, mediaType: 'image/png' });
    const { context, truncated } = handoffContext(history);
    expect(context).toContain('Build the garden tracker.');
    expect(context).toContain('CREATE TABLE plants');
    expect(context).not.toContain('PRIVATE_');
    expect(truncated).toBe(false);
    const prompt = handoffPrompt({ ...session, sessionId: session.id, context, truncated, agent }, 'Continue with the tests.');
    expect(prompt).toContain('historical reference, not a new request or new authorization');
    expect(prompt).toContain("User's next message:\nContinue with the tests.");
  });

  it('bounds long histories and keeps the original request and newest decisions', () => {
    const history = [entry('first', 'user', 'ORIGINAL_GOAL'), ...Array.from({ length: 120 }, (_, i) => entry(`a${i}`, 'assistant', `decision-${i} ${'x'.repeat(1000)}`)), entry('last', 'user', 'LATEST_DECISION')];
    const result = handoffContext(history);
    expect(result.truncated).toBe(true);
    expect(result.context.length).toBeLessThanOrEqual(60_000);
    expect(result.context).toContain('ORIGINAL_GOAL');
    expect(result.context).toContain('LATEST_DECISION');
    expect(result.context).not.toContain('decision-0 ');
  });

  it('reads the main conversation’s latest page plus its original request when paged', async () => {
    const transcript = vi.fn().mockResolvedValueOnce({ entries: [entry('recent', 'assistant', 'LATEST')], offset: 4000, total: 4001, nextOffset: null })
      .mockResolvedValueOnce({ entries: [entry('first', 'user', 'ORIGINAL')], offset: 0, total: 4001, nextOffset: 1 });
    const copy = await loadHandoff({ transcript }, session, agent);
    expect(transcript.mock.calls).toEqual([[session.id, 'main', -1, 3000], [session.id, 'main', 0, 1]]);
    expect(copy.context).toContain('ORIGINAL');
    expect(copy.context).toContain('LATEST');
    expect(copy.truncated).toBe(true);
    expect(copy.sessionId).toBe(session.id);
    expect(copy.agent).toEqual(agent);
  });

  it('leaves the source unchanged and refuses a transcript with no usable text', () => {
    const history = [entry('1', 'user', 'Do this'), entry('2', 'assistant', 'Decision')];
    const before = JSON.stringify(history);
    handoffContext(history);
    expect(JSON.stringify(history)).toBe(before);
    expect(() => handoffContext([])).toThrow(/no text/);
  });
});
