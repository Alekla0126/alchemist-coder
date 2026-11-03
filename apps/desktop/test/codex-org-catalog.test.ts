import { beforeEach, expect, it, vi } from 'vitest';
import { ExtensionRegistry, MemorySecretStore, type CodexRuntimeSnapshot, type ProviderAdapter } from '@alchemist-coder/core';
import { readCodexRuntime } from '@alchemist-coder/harness';
import { RunnerManager } from '../src/main/runner';

vi.mock('@alchemist-coder/harness', () => ({ readCodexRuntime: vi.fn(), detectBinary: vi.fn(async () => ({ installed: true })), stageData: vi.fn(), stageFile: vi.fn() }));
vi.mock('../src/main/cli-status', () => ({ cliStatus: async () => ({ cliVersion: 'test', signedIn: true, account: null, cliPath: 'codex' }) }));
vi.mock('../src/main/shell-path', () => ({ cliSearchPath: async () => {} }));
vi.mock('../src/main/store-tools', () => ({ storeMcpServers: () => [] }));

const runtime: CodexRuntimeSnapshot = { connected: true, error: null, models: [{ id: 'future', label: 'Future', reasoningEfforts: [{ id: 'low', label: 'Quick' }] }], account: { type: 'chatgpt', email: null, plan: 'pro' }, accountError: null, limits: null, limitsError: null, checkedAt: 1 };
const models = vi.fn(async () => [{ id: 'stale-hardcoded', label: 'Old' }]);
const provider: ProviderAdapter = { id: 'openai', label: 'ChatGPT', edition: 'pro', harnesses: ['codex'], capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false }, models, env: async () => ({ CODEX_CONFIG: '{"mcp_servers":{}}' }) };
const manager = (p = provider, edition: 'community' | 'pro' = 'pro') => {
  const registry = new ExtensionRegistry(edition, new MemorySecretStore());
  // registerProvider preserves its edition gate; a personal extension can register its own exemption.
  registry.registerProvider(p);
  return new RunnerManager(registry, () => {});
};
beforeEach(() => { vi.clearAllMocks(); vi.mocked(readCodexRuntime).mockResolvedValue(structuredClone(runtime)); });

it('replaces the account provider static catalog with runtime efforts, preserving unknown quota', async () => {
  const p = (await manager().catalog()).providers[0]!;
  expect(p.models).toEqual(runtime.models);
  expect(p.codexRuntime?.limits).toBeNull();
  expect(p.available).toBe(true);
  expect(models).not.toHaveBeenCalled();
});

it('shows a disconnected provider as unavailable without falling back to its static models', async () => {
  vi.mocked(readCodexRuntime).mockResolvedValue({ ...runtime, connected: false, models: [], error: 'Connection lost' });
  expect((await manager().catalog()).providers[0]).toMatchObject({ available: false, detail: 'Connection lost', models: [] });
  expect(models).not.toHaveBeenCalled();
});

it('keeps provider credential errors local to that provider and does not invent an account', async () => {
  const bad = { ...provider, env: async () => { throw new Error('credential unavailable'); } };
  expect((await manager(bad).catalog()).providers[0]).toMatchObject({ available: false, models: [], codexRuntime: { account: null, limits: null } });
  vi.mocked(readCodexRuntime).mockResolvedValue({ ...runtime, usesApiKey: true, account: null });
  expect((await manager().catalog()).providers[0]).toMatchObject({ available: true, codexRuntime: { account: null, limits: null } });
});
