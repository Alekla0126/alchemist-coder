import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ProviderAdapter, RunnerEvent } from '@alchemist-coder/core';
import { codexAgent, readCodexRuntime } from '@alchemist-coder/harness';

// One opt-in synthetic turn using an existing ChatGPT session and ordinary quota only.
it.skipIf(process.env.RUN_CODEX_ORG_E2E !== '1')('applies a catalog model, explicit effort and read-only permissions to real Codex', async () => {
  const env = { OPENAI_API_KEY: '', CODEX_API_KEY: '', CODEX_CONFIG: JSON.stringify({ mcp_servers: {} }) };
  const runtime = await readCodexRuntime({ env });
  expect(runtime.connected).toBe(true);
  expect(runtime.account?.type).toBe('chatgpt');
  expect(runtime.limits?.length).toBeGreaterThan(0);
  expect(runtime.limits?.every((w) => w.usedPercent < 100)).toBe(true);
  const model = runtime.models[0]!;
  const effort = model.reasoningEfforts?.find((e) => e.id === 'low')?.id ?? model.defaultReasoningEffort!;
  expect(effort).toBeTruthy();
  const cwd = mkdtempSync(join(tmpdir(), 'codex-org-smoke-'));
  const provider: ProviderAdapter = { id: 'openai', label: 'ChatGPT', edition: 'pro', harnesses: ['codex'], capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false }, models: async () => runtime.models, env: async () => env };
  const run = codexAgent().run({ cwd, provider, model: model.id, effort, permissionMode: 'plan', prompt: 'Synthetic integration test. Do not use tools, read files, or change anything. Reply only with AC_CODEX_ORG_OK.' });
  try {
    const events = await new Promise<RunnerEvent[]>((resolve, reject) => {
      const events: RunnerEvent[] = [];
      const timer = setTimeout(() => { off(); reject(new Error('Codex did not complete the synthetic turn.')); }, 45_000);
      const off = run.onEvent((e) => {
        events.push(e);
        if (e.type === 'permission') run.respond?.(e.requestId, null);
        if (e.type === 'result' || (e.type === 'status' && e.status === 'error')) { clearTimeout(timer); off(); resolve(events); }
      });
    });
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events.find((e) => e.type === 'started')).toMatchObject({ model: model.id });
    expect(events.find((e) => e.type === 'config')).toMatchObject({ mode: 'read-only', options: expect.arrayContaining([expect.objectContaining({ category: 'thought_level', value: effort })]) });
    expect(events.find((e) => e.type === 'result')).toMatchObject({ ok: true });
    expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('').trim()).toBe('AC_CODEX_ORG_OK');
  } finally { run.stop(); rmSync(cwd, { recursive: true, force: true }); }
}, 60_000);
