import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ProviderAdapter, RunHandle, RunnerEvent } from '@alchemist-coder/core';
import { codexAgent } from '../../../packages/harness/src/agents';
import { handoffContext, handoffPrompt } from '../src/renderer/src/conversation-handoff';

// Explicit opt-in: uses the user's existing Codex sign-in, never an API key.
it.skipIf(process.env.RUN_CODEX_E2E !== '1')('continues copied Claude context, replies again and resumes through the real Codex adapter', async () => {
  const provider: ProviderAdapter = {
    id: 'openai', label: 'ChatGPT', edition: 'pro', harnesses: ['codex'],
    capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false },
    models: async () => [],
    env: async () => ({ CODEX_CONFIG: JSON.stringify({ mcp_servers: {} }) }),
  };
  const cwd = mkdtempSync(join(tmpdir(), 'alchemist-codex-smoke-'));
  const copied = handoffContext([
    { key: 'u1', role: 'user', ts: 0, model: null, blocks: [{ kind: 'text', text: 'The project is named Solar Cedar. Remember the exact name.' }] },
    { key: 'a1', role: 'assistant', ts: 1, model: 'claude', blocks: [{ kind: 'text', text: 'Agreed. We will use SQLite for the garden tracker.' }] },
  ]);
  const options = {
    cwd, provider,
    model: process.env.CODEX_SMOKE_MODEL ?? 'default', permissionMode: 'plan',
  } as const;
  const run = codexAgent().run({ ...options, prompt: handoffPrompt({ sessionId: 'synthetic-claude-context', projectId: 1, title: 'Smoke test', ...copied, agent: { harnessId: 'codex', providerId: 'openai', model: options.model } }, 'This is a smoke test. Do not use tools or read files. Reply only with the project name and database, from the prior conversation.') });
  let sessionId: string | null = null;
  try {
    const events = await turn(run);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    expect(text).toContain('Solar Cedar');
    expect(text).toContain('SQLite');
    expect(events.find((e) => e.type === 'result')).toMatchObject({ ok: true });
    const started = events.find((e) => e.type === 'started');
    sessionId = started?.type === 'started' ? started.sessionId : null;
    expect(sessionId).toBeTruthy();
    expect(sessionId).not.toBe('synthetic-claude-context');
    const next = turn(run);
    run.send('Without tools or reading files, repeat only the project name and append _CONTINUED.');
    const followup = await next;
    expect(followup.filter((e) => e.type === 'text').map((e) => e.text).join('')).toContain('Solar Cedar_CONTINUED');
    expect(followup.find((e) => e.type === 'result')).toMatchObject({ ok: true });
  } finally {
    run.stop();
  }
  const resumed = codexAgent().run({ ...options, resumeSessionId: sessionId!, prompt: 'Without tools or reading files, reply only with the database chosen earlier.' });
  try {
    const events = await turn(resumed);
    expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toContain('SQLite');
    expect(events.find((e) => e.type === 'result')).toMatchObject({ ok: true });
  } finally { resumed.stop(); }
}, 90_000);

function turn(run: RunHandle): Promise<RunnerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: RunnerEvent[] = [];
    const timer = setTimeout(() => { off(); reject(new Error('Codex smoke timed out')); }, 75_000);
    const off = run.onEvent((event) => {
      events.push(event);
      if (event.type === 'permission') run.respond?.(event.requestId, null);
      if (event.type === 'result' || (event.type === 'status' && event.status === 'error')) {
        clearTimeout(timer);
        off();
        resolve(events);
      }
    });
  });
}
