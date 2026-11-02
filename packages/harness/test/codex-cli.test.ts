import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { resolveCodexCli } from '../src/codex-cli';
import { detectBinary } from '../src/detect';
import { requireCodexSelection } from '../src/codex-runtime';
import type { CodexRuntimeSnapshot } from '@alchemist-coder/core';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-cli-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fixture = (name: string) => {
  const folder = join(dir, name); mkdirSync(folder);
  const path = join(folder, 'codex'); writeFileSync(path, 'synthetic fixture'); chmodSync(path, 0o755);
  return { folder, path: realpathSync(path) };
};

it('skips a broken first installation and pins the later working executable before npx starts', async () => {
  const broken = fixture('Homebrew bin'), good = fixture('standalone bin');
  const detect = vi.fn(async (path: string) => ({ installed: path === good.path, path, version: path === good.path ? '0.166.0' : null }));
  const r = await resolveCodexCli({ env: { PATH: `${broken.folder}${delimiter}${good.folder}`, CODEX_PATH: '' }, detect });
  expect(r).toEqual({ path: good.path, version: '0.166.0', skippedPaths: [broken.path], error: null });
  expect(detect.mock.calls.map(([path]) => path)).toEqual([broken.path, good.path]);
});

it('does not substitute another installation when CODEX_PATH explicitly selects a broken one', async () => {
  const good = fixture('explicit-good'), missing = join(dir, 'explicit-missing');
  const detect = vi.fn(async (path: string) => ({ installed: false, version: null, path }));
  const r = await resolveCodexCli({ env: { PATH: good.folder, CODEX_PATH: missing }, detect });
  expect(r.path).toBeNull();
  expect(r.error).toContain('configured CODEX_PATH');
  expect(detect.mock.calls.map(([path]) => path)).toEqual([missing]);
});

it('all broken installations stay unavailable and cancellation does not select a later candidate', async () => {
  const a = fixture('all-broken-a'), b = fixture('all-broken-b');
  const env = { PATH: `${a.folder}${delimiter}${b.folder}`, CODEX_PATH: '' };
  const detect = vi.fn(async (path: string) => ({ installed: false, version: null, path }));
  expect(await resolveCodexCli({ env, detect })).toMatchObject({ path: null, skippedPaths: [a.path, b.path], error: expect.stringContaining('bundled runtime was not used') });
  const c = new AbortController();
  const cancel = vi.fn(async (path: string) => { c.abort(); return { installed: true, version: '1', path }; });
  expect(await resolveCodexCli({ env, detect: cancel, signal: c.signal })).toMatchObject({ path: null, error: expect.stringContaining('cancelled') });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('honors provider PATH changes on the next launch without caching a stale binary', async () => {
  const a = fixture('late-a'), b = fixture('late-b');
  const detect = vi.fn(async (path: string) => ({ installed: true, version: '1', path }));
  const first = await resolveCodexCli({ env: { PATH: a.folder, CODEX_PATH: '' }, detect });
  const second = await resolveCodexCli({ env: { PATH: b.folder, CODEX_PATH: '' }, detect });
  expect(first.path).toBe(a.path); expect(second.path).toBe(b.path);
  expect((await resolveCodexCli({ env: { PATH: undefined, Path: b.folder, CODEX_PATH: '' }, detect })).path).toBe(b.path);
});

it('a missing catalog, a legacy invalid model and unsupported efforts block without selecting a replacement', () => {
  const runtime: CodexRuntimeSnapshot = { connected: true, error: null, models: [{ id: 'available', label: 'Available', reasoningEfforts: [{ id: 'low', label: 'Low' }] }], account: null, accountError: null, limits: null, limitsError: null, checkedAt: 1 };
  expect(() => requireCodexSelection(runtime, 'old-model')).toThrow(/no replacement was selected/);
  for (const effort of ['max', 'ultra']) expect(() => requireCodexSelection(runtime, 'available', effort)).toThrow(/nothing was sent/);
  expect(() => requireCodexSelection({ ...runtime, connected: false, models: [] }, 'available')).toThrow(/conversation is preserved/);
  expect(() => requireCodexSelection(runtime, 'available', 'low')).not.toThrow();
});

it.skipIf(process.platform !== 'win32')('validates an npm .cmd shim under a Windows path with spaces', async () => {
  const folder = join(dir, 'Windows user with spaces~safe'); mkdirSync(folder);
  const path = join(folder, 'codex.cmd'); writeFileSync(path, '@echo off\r\necho codex-cli 0.166.0\r\n');
  expect(await detectBinary(path), `Version probe: ${path}`).toMatchObject({ installed: true, version: '0.166.0' });
  expect(await resolveCodexCli({ env: { CODEX_PATH: path } })).toMatchObject({ path: realpathSync(path), version: '0.166.0' });
});

it.skipIf(process.platform === 'win32')('probes an executable with literal tilde and spaces in its path', async () => {
  const folder = join(dir, 'user~path with spaces'); mkdirSync(folder);
  const path = join(folder, 'codex'); symlinkSync(process.execPath, path);
  expect(await detectBinary(path)).toMatchObject({ installed: true, version: process.versions.node });
});
