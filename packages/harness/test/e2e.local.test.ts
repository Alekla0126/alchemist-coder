/**
 * End-to-end check against the real CLIs and a local model. Skipped unless AC_E2E=1.
 *   ollama serve & ollama pull qwen3:0.6b
 *   AC_E2E=1 AC_E2E_MODEL=qwen3:0.6b npx vitest run packages/harness/test/e2e.local.test.ts
 * Test conversations written by the CLIs are removed afterwards.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunHandle, RunnerEvent } from '@alchemist-coder/core';
import { ollamaProvider } from '@alchemist-coder/providers-local';
import { claudeAgent, claudeCodeHarness, codexAgent, codexHarness } from '../src/index.ts';

const enabled = process.env.AC_E2E === '1';
const model = process.env.AC_E2E_MODEL ?? 'qwen3:0.6b';
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ac-e2e-')));
const encoded = cwd.replace(/[^A-Za-z0-9]/g, '-');
const startedAt = Date.now() - 1000;

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
  // Only remove the Claude project folder this test created.
  const claudeDir = join(homedir(), '.claude', 'projects', encoded);
  if (encoded.includes('ac-e2e-') && existsSync(claudeDir)) rmSync(claudeDir, { recursive: true, force: true });
  // Codex rollouts are organised by date; remove only the ones whose cwd is this test's temp folder.
  const walk = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : [];
  for (const file of walk(join(homedir(), '.codex', 'sessions')).filter((f) => f.endsWith('.jsonl') && statSync(f).mtimeMs > startedAt)) {
    const first = readFileSync(file, 'utf8').split('\n', 1)[0] ?? '';
    if (first.includes(cwd)) rmSync(file, { force: true });
  }
});

function run(handle: { onEvent(l: (e: RunnerEvent) => void): () => void; stop(): void }, until: (e: RunnerEvent) => boolean, ms = 180_000) {
  return new Promise<RunnerEvent[]>((resolve) => {
    const events: RunnerEvent[] = [];
    const timer = setTimeout(() => {
      handle.stop();
      resolve(events);
    }, ms);
    handle.onEvent((e) => {
      events.push(e);
      if (until(e)) {
        clearTimeout(timer);
        resolve(events);
      }
    });
  });
}

describe.skipIf(!enabled)('real CLIs against a local model', () => {
  it('claude -p streams a reply from Ollama and records the session', async () => {
    const handle = claudeCodeHarness().run({ cwd, prompt: 'Reply with one short sentence saying hello.', provider: ollamaProvider(), model, permissionMode: 'plan' });
    const events = await run(handle, (e) => e.type === 'result');
    handle.stop();
    const started = events.find((e) => e.type === 'started');
    console.log('claude events:', events.map((e) => e.type).join(' '), '| text:', events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : '')).join('').slice(0, 160));
    expect(started && started.type === 'started' && started.sessionId).toBeTruthy();
    expect(events.some((e) => e.type === 'result')).toBe(true);
    const sessionId = started?.type === 'started' ? started.sessionId : null;
    expect(existsSync(join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`))).toBe(true);
  }, 200_000);

  it('codex exec runs a turn on Ollama', async () => {
    const handle = codexHarness().run({ cwd, prompt: 'Reply with one short sentence saying hello.', provider: ollamaProvider(), model, permissionMode: 'plan' });
    const events = await run(handle, (e) => e.type === 'status' && e.status !== 'running');
    console.log('codex events:', events.map((e) => (e.type === 'error' ? `error(${e.message})` : e.type)).join(' '));
    console.log('codex stderr:', events.filter((e) => e.type === 'stderr').map((e) => (e.type === 'stderr' ? e.text : '')).join('').slice(0, 600));
    expect(events.some((e) => e.type === 'started' || e.type === 'text' || e.type === 'error')).toBe(true);
  }, 200_000);

  const textOf = (events: RunnerEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
  const summary = (events: RunnerEvent[]) => events.map((e) => (e.type === 'error' ? `error(${e.message})` : e.type === 'status' ? `status(${e.status})` : e.type)).join(' ');

  /** Tiny local models wander into tools; deny every permission so the turn can finish. */
  function denyAll(handle: RunHandle) {
    handle.onEvent((e) => {
      if (e.type === 'permission') handle.respond?.(e.requestId, e.choices.find((c) => c.kind === 'reject_once')?.id ?? null);
    });
    return handle;
  }

  it('Claude through ACP opens a session on Ollama in plan mode and streams', async () => {
    const handle = denyAll(claudeAgent().run({ cwd, prompt: 'Reply with one short sentence saying hello. Do not use tools.', provider: ollamaProvider(), model, permissionMode: 'plan' }));
    const events = await run(handle, (e) => e.type === 'result' || (e.type === 'status' && e.status === 'error'), 120_000);
    handle.stop();
    console.log('claude-acp events:', summary(events), '| text:', textOf(events).slice(0, 160));
    const started = events.find((e) => e.type === 'started');
    expect(events.find((e) => e.type === 'config')).toMatchObject({ mode: 'plan' });
    expect(events.some((e) => e.type === 'text' || e.type === 'thought' || e.type === 'tool')).toBe(true);
    const sessionId = started?.type === 'started' ? started.sessionId : null;
    expect(existsSync(join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`))).toBe(true);
  }, 150_000);

  it('Codex through ACP opens a session on Ollama in plan mode', async () => {
    const handle = denyAll(codexAgent().run({ cwd, prompt: 'Reply with one short sentence saying hello. Do not use tools.', provider: ollamaProvider(), model, permissionMode: 'plan' }));
    const events = await run(handle, (e) => e.type === 'result' || e.type === 'text' || (e.type === 'status' && e.status === 'error'), 120_000);
    handle.stop();
    console.log('codex-acp events:', summary(events), '| text:', textOf(events).slice(0, 160));
    expect(events.find((e) => e.type === 'started')).toMatchObject({ sessionId: expect.any(String) });
    expect(events.find((e) => e.type === 'config')).toMatchObject({ mode: 'read-only', options: expect.arrayContaining([expect.objectContaining({ id: 'collaboration_mode', value: 'plan' })]) });
  }, 150_000);
});
