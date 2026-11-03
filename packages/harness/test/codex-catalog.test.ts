import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { codexProviderArgs, readCodexRuntime } from '../src/codex-runtime';

const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const read = (env: Record<string, string> = {}, extra = {}) => readCodexRuntime({ bin: process.execPath, env, spawn: (_bin, _args, opts) => spawn(process.execPath, [fake], opts), ...extra });

it('reads paginated runtime model ids and efforts, account metadata and arbitrary quota windows', async () => {
  const r = await read();
  expect(r.connected).toBe(true);
  expect(r.models).toEqual([
    { id: 'future-large', label: 'Future Large', reasoningEfforts: [{ id: 'ultra', label: 'Deep' }], defaultReasoningEffort: 'ultra' },
    { id: 'future-small', label: 'Future Small', reasoningEfforts: [{ id: 'low', label: 'Quick' }], defaultReasoningEffort: 'low' },
  ]);
  expect(r.account).toEqual({ type: 'chatgpt', email: 'test@example.invalid', plan: 'pro' });
  expect(JSON.stringify(r)).not.toContain('never-forward-this');
  expect(r.limits).toEqual([{ label: 'Custom', usedPercent: 0, windowMinutes: 17, resetsAt: 2000000000000 }]);
});

it('keeps absent and unsupported quota unknown, without inventing zero usage', async () => {
  const absent = await read({ FAKE_NO_QUOTA: '1' });
  expect(absent.connected).toBe(true);
  expect(absent.limits).toBeNull();
  const unsupported = await read({ FAKE_QUOTA_ERROR: '1' });
  expect(unsupported.connected).toBe(true);
  expect(unsupported.limits).toBeNull();
  expect(unsupported.limitsError).toBe('Not supported');
});

it('reports connection failure, timeout, cancellation and a missing binary without a stale catalog', async () => {
  expect(await read({ FAKE_DISCONNECT: '1' })).toMatchObject({ connected: false, models: [], error: expect.stringMatching(/disconnected/) });
  expect(await read({ FAKE_HANG: '1' }, { timeoutMs: 150 })).toMatchObject({ connected: false, models: [], error: expect.stringMatching(/in time/) });
  const c = new AbortController();
  const p = read({ FAKE_HANG: '1' }, { signal: c.signal });
  c.abort();
  expect(await p).toMatchObject({ connected: false, models: [], error: expect.stringMatching(/cancelled/) });
  expect(await readCodexRuntime({ bin: '/missing/codex' })).toMatchObject({ connected: false, models: [], error: expect.any(String) });
});


it('a quota timeout keeps the catalog connected and leaves quota unknown', async () => {
  // Leave room for the fake process to initialize on a busy machine; only quota should time out.
  const r = await read({ FAKE_QUOTA_HANG: '1' }, { timeoutMs: 1500 });
  expect(r).toMatchObject({ connected: true, limits: null, limitsError: expect.stringMatching(/in time/) });
  expect(r.models).toHaveLength(2);
});

it('uses the provider routing overrides and never labels API-key execution with the ambient ChatGPT plan', async () => {
  expect(codexProviderArgs(JSON.stringify({ mcp_servers: {}, model_provider: 'custom', model_providers: { custom: { base_url: 'https://example.invalid/v1', env_key: 'CUSTOM_KEY', wire_api: 'responses' } } }))).toEqual(['-c', 'model_provider="custom"', '-c', 'model_providers."custom".base_url="https://example.invalid/v1"', '-c', 'model_providers."custom".env_key="CUSTOM_KEY"', '-c', 'model_providers."custom".wire_api="responses"']);
  expect(() => codexProviderArgs('{"model_providers":{"x":{"bearer_token":"secret"}}}')).toThrow(/safely/);
  const r = await read({ OPENAI_API_KEY: 'synthetic-not-a-real-key' });
  expect(r.account).toBeNull();
  expect(r.usesApiKey).toBe(true);
  expect(r.limits).toBeNull();
});


it('does not expose malformed provider configuration in errors', async () => {
  for (const config of ['null', '[]', '"value"']) expect(() => codexProviderArgs(config)).toThrow('Invalid Codex provider configuration.');
  const r = await read({ CODEX_CONFIG: 'SYNTHETIC_SECRET' });
  expect(r.error).toBe('Invalid Codex provider configuration.');
  expect(JSON.stringify(r)).not.toContain('SYNTHETIC_SECRET');
});
