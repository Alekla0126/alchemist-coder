import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';
import { codexAgent } from '../src/agents';
import { binaryPath } from '../src/detect';
import type { ProviderAdapter, RunnerEvent } from '@alchemist-coder/core';

const dir = mkdtempSync(join(tmpdir(), 'codex-runtime-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

it('resolves the installed executable before npx can shadow it with the bundled Codex', () => {
  const local = join(dir, 'local bin'), bundled = join(dir, 'bundled');
  for (const path of [local, bundled]) {
    mkdirSync(path); writeFileSync(join(path, 'codex'), 'test'); chmodSync(join(path, 'codex'), 0o755);
  }
  expect(binaryPath('codex', `${local}${delimiter}${bundled}`)).toBe(join(local, 'codex'));
  expect(binaryPath(join(local, 'codex'), bundled)).toBe(join(local, 'codex'));
  expect(binaryPath('missing-codex', local)).toBeNull();
});

it('passes the installed Codex as an absolute CODEX_PATH to the adapter', async () => {
  const path = join(dir, 'installed-codex');
  let seen: NodeJS.ProcessEnv | undefined;
  let closed: Promise<void> | undefined;
  const harness = codexAgent({
    detectBinary: async (bin) => ({ installed: true, version: '1', path: bin === 'codex' ? path : 'npx' }),
    resolveCli: async ({ env } = {}) => {
      expect(env?.CODEX_PATH).toBe('provider-relative-path');
      return { path, version: '1', skippedPaths: [], error: null };
    },
    readRuntime: async ({ bin } = {}) => {
      expect(bin).toBe(path);
      return { connected: true, error: null, models: [{ id: 'opus[1m]', label: 'Synthetic', reasoningEfforts: [{ id: 'low', label: 'Low' }] }], account: null, accountError: null, limits: null, limitsError: null, checkedAt: 1 };
    },
    spawn: (_cmd, _args, options) => {
      seen = options.env;
      const child = spawn(process.execPath, [fake], options);
      closed = new Promise((resolve) => child.once('close', () => resolve()));
      return child;
    },
  });
  vi.stubEnv('CODEX_PATH', '');
  const run = harness.run({ cwd: dir, model: 'default', prompt: 'hello', permissionMode: 'plan', provider: { id: 'openai', label: 'ChatGPT', edition: 'pro', harnesses: ['codex'], capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false }, models: async () => [], env: async () => ({ CODEX_PATH: 'provider-relative-path' }) } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('adapter did not start')), 3000);
      const off = run.onEvent((e) => { if (e.type === 'started' || e.type === 'error') { clearTimeout(timer); off(); resolve(); } });
    });
    expect(seen?.CODEX_PATH).toBe(path);
  } finally { run.stop(); await closed; vi.unstubAllEnvs(); }
});

it('never launches ACP or its bundled runtime if the selected Codex cannot run', async () => {
  const spawn = vi.fn();
  const provider: ProviderAdapter = { id: 'openai', label: 'ChatGPT', edition: 'pro', harnesses: ['codex'], capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false }, models: async () => [], env: async () => ({ CODEX_PATH: '/explicit/broken-codex' }) };
  const run = codexAgent({ spawn, resolveCli: async () => ({ path: null, version: null, skippedPaths: ['/explicit/broken-codex'], error: 'Configured Codex cannot run; no fallback' }) }).run({ cwd: dir, model: 'legacy-model', prompt: 'MUST_NOT_SEND', provider, resumeSessionId: 'saved-session' });
  try {
    const error = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('missing configuration error')), 1000);
      run.onEvent((e) => { if (e.type === 'error') { clearTimeout(timer); resolve(e.message); } });
    });
    expect(error).toContain('no fallback');
    expect(spawn).not.toHaveBeenCalled();
  } finally { run.stop(); }
});

it('checks native model/list even when ACP adds a legacy saved model to its picker', async () => {
  for (const mode of ['explicit-invalid', 'inherited-invalid', 'catalog-absent', 'supported']) {
    let closed: Promise<void> | undefined;
    const readRuntime = vi.fn(async () => ({ connected: mode !== 'catalog-absent', error: mode === 'catalog-absent' ? 'offline' : null, models: [{ id: 'sonnet', label: 'Synthetic supported model', reasoningEfforts: [{ id: 'low', label: 'Low' }] }], account: null, accountError: null, limits: null, limitsError: null, checkedAt: 1 }));
    const harness = codexAgent({
      detectBinary: async () => ({ installed: true, path: 'npx', version: '1' }),
      resolveCli: async () => ({ path: '/synthetic/selected-codex', version: '1', skippedPaths: [], error: null }), readRuntime,
      spawn: (_cmd, _args, options) => { const child = spawn(process.execPath, [fake], options); closed = new Promise((r) => child.once('close', () => r())); return child; },
    });
    const run = harness.run({ cwd: dir, prompt: 'MUST_NOT_RUN_WITH_OLD_MODEL', resumeSessionId: 'same-saved-session', model: mode === 'inherited-invalid' ? 'default' : mode === 'explicit-invalid' ? 'old-model' : 'sonnet', permissionMode: 'plan', provider: { id: 'openai', label: 'ChatGPT', edition: 'pro', harnesses: ['codex'], capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false }, models: async () => [], env: async () => ({ FAKE_START_MODEL: 'old-model', FAKE_APPEND_SAVED_MODEL: '1', FAKE_MODES: 'read-only,agent', FAKE_BLOCKS: '1' }) } });
    try {
      const events = await new Promise<RunnerEvent[]>((resolve, reject) => {
        const events: RunnerEvent[] = []; const timer = setTimeout(() => reject(new Error('native catalog guard timed out')), 3000);
        run.onEvent((e) => { events.push(e); if (e.type === 'result') { clearTimeout(timer); resolve(events); } });
      });
      expect(readRuntime).toHaveBeenCalledWith(expect.objectContaining({ bin: '/synthetic/selected-codex', env: expect.objectContaining({ CODEX_PATH: '/synthetic/selected-codex' }) }));
      expect(events.find((e) => e.type === 'started')).toMatchObject({ sessionId: 'same-saved-session' });
      expect(events.find((e) => e.type === 'result')).toMatchObject({ ok: mode === 'supported', sessionId: 'same-saved-session' });
      if (mode !== 'supported') expect(events.some((e) => e.type === 'text' || e.type === 'tool')).toBe(false);
    } finally { run.stop(); await closed; }
  }
});

it('cancels metadata preflight and revalidates configuration changed while that read was pending', async () => {
  for (const mode of ['interrupt', 'change-supported', 'change-unavailable', 'change-from-invalid', 'change-rejected']) {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => { enter = r; });
    const held = new Promise<void>((r) => { release = r; });
    let reads = 0, signal: AbortSignal | undefined, closed: Promise<void> | undefined;
    const readRuntime = vi.fn(async (options: { signal?: AbortSignal } = {}) => {
      signal = options.signal;
      if (++reads === 1) { enter(); await held; }
      const id = reads > 1 && ['change-supported', 'change-from-invalid'].includes(mode) ? 'opus[1m]' : mode === 'change-from-invalid' ? 'not-selected' : 'sonnet';
      return { connected: true, error: null, models: [{ id, label: id, reasoningEfforts: [{ id: 'low', label: 'Low' }] }], account: null, accountError: null, limits: null, limitsError: null, checkedAt: 1 };
    });
    const run = codexAgent({
      detectBinary: async () => ({ installed: true, path: 'npx', version: '1' }),
      resolveCli: async () => ({ path: '/synthetic/selected-codex', version: '1', skippedPaths: [], error: null }), readRuntime,
      spawn: (_cmd, _args, options) => { const child = spawn(process.execPath, [fake], options); closed = new Promise((r) => child.once('close', () => r())); return child; },
    }).run({ cwd: dir, prompt: 'MUST_NOT_RUN_AFTER_INTERRUPT', model: 'sonnet', permissionMode: 'plan', resumeSessionId: 'same-saved-session', provider: { id: 'openai', label: 'ChatGPT', edition: 'pro', harnesses: ['codex'], capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false }, models: async () => [], env: async () => ({ FAKE_MODES: 'read-only,agent', FAKE_BLOCKS: '1' }) } });
    const result = new Promise<RunnerEvent[]>((resolve, reject) => {
      const events: RunnerEvent[] = []; const timer = setTimeout(() => reject(new Error('preflight race timed out')), 4000);
      run.onEvent((e) => { events.push(e); if (e.type === 'result') { clearTimeout(timer); resolve(events); } });
    });
    try {
      await entered;
      if (mode === 'interrupt') { run.interrupt!(); expect(signal?.aborted).toBe(true); }
      else if (mode === 'change-rejected') await expect(run.configure!({ option: { id: 'model', value: 'not-in-picker' } })).rejects.toThrow(/unknown value/);
      else await run.configure!({ option: { id: 'model', value: 'opus[1m]' } });
      release();
      const events = await result;
      const succeeds = ['change-supported', 'change-from-invalid'].includes(mode);
      expect(events.find((e) => e.type === 'result')).toMatchObject({ ok: succeeds, sessionId: 'same-saved-session' });
      if (mode === 'interrupt' || mode === 'change-rejected') expect(readRuntime).toHaveBeenCalledTimes(1);
      else expect(readRuntime).toHaveBeenCalledTimes(2);
      if (!succeeds) expect(events.some((e) => e.type === 'text' || e.type === 'tool')).toBe(false);
    } finally { release(); run.stop(); await closed; }
  }
});
