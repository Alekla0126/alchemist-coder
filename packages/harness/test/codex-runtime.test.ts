import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';
import { codexAgent } from '../src/agents';
import { binaryPath } from '../src/detect';

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
  const harness = codexAgent({
    detectBinary: async (bin) => ({ installed: true, version: '1', path: bin === 'codex' ? path : 'npx' }),
    spawn: (_cmd, _args, options) => { seen = options.env; return spawn(process.execPath, [fake], options); },
  });
  vi.stubEnv('CODEX_PATH', '');
  const run = harness.run({ cwd: dir, model: 'default', prompt: 'hello', permissionMode: 'plan', provider: { id: 'openai', label: 'ChatGPT', edition: 'pro', harnesses: ['codex'], capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false }, models: async () => [], env: async () => ({}) } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('adapter did not start')), 3000);
      const off = run.onEvent((e) => { if (e.type === 'started' || e.type === 'error') { clearTimeout(timer); off(); resolve(); } });
    });
    expect(seen?.CODEX_PATH).toBe(path);
  } finally { run.stop(); vi.unstubAllEnvs(); }
});
