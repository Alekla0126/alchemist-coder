import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, RunHandle, RunnerEvent } from '@alchemist-coder/core';
import { acpHarness, pickChoice, type AcpAgentSpec } from '../src/index.ts';
import { formFields } from '../src/acp.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'acp-test-'));

function provider(env: Record<string, string> = {}): ProviderAdapter {
  return {
    id: 'fake',
    label: 'Fake',
    edition: 'community',
    harnesses: ['fake'],
    capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false },
    models: async () => [],
    env: async () => env,
  };
}

function spec(extra: Partial<AcpAgentSpec> = {}): AcpAgentSpec {
  return {
    id: 'fake',
    label: 'Fake agent',
    resolve: async () => ({ command: process.execPath, args: [FAKE], version: '1.0.0' }),
    modes: { default: { modes: ['default'] }, acceptEdits: { modes: ['acceptEdits'] }, plan: { modes: ['plan'] }, bypassPermissions: { modes: ['yolo'] } },
    authMethod: (env) => (env.FAKE_KEY ? { id: 'api-key', eager: true } : null),
    ...extra,
  };
}

/** Collects events until `done` says so; answers permission prompts with `answer`. */
function collect(run: RunHandle, answer: string | null, done: (e: RunnerEvent) => boolean): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${JSON.stringify(events.map((e) => e.type))}`)), 15_000);
    const off = run.onEvent((e) => {
      events.push(e);
      if (e.type === 'permission') setTimeout(() => run.respond?.(e.requestId, answer), 10);
      if (done(e)) {
        clearTimeout(timer);
        off();
        resolve(events);
      }
    });
  });
}

describe('acpHarness', () => {
  it('streams text, plan, tools with diffs and cost, and asks before editing', async () => {
    const harness = acpHarness(spec());
    expect(await harness.detect()).toMatchObject({ installed: true, version: '1.0.0' });
    const run = harness.run({ cwd, prompt: 'hi there', provider: provider({ FAKE_KEY: '1' }), model: 'claude-sonnet-5', permissionMode: 'acceptEdits' });
    const events = await collect(run, 'allow', (e) => e.type === 'result');
    run.stop();

    const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
    // Mode, model (mapped by family name) and eager API-key auth were applied before the prompt.
    // A tool call between two chunks starts a new paragraph.
    expect(text).toBe('mode=acceptEdits model=sonnet auth=true prompt=hi there\n\n | edited');
    expect(events.find((e) => e.type === 'started')).toEqual({ type: 'started', sessionId: 'fake-session-1', model: 'sonnet' });
    expect(events.find((e) => e.type === 'thought')).toEqual({ type: 'thought', text: 'thinking…' });
    expect(events.find((e) => e.type === 'plan')).toEqual({ type: 'plan', entries: [{ content: 'Edit a.txt', priority: 'high', status: 'in_progress' }] });

    const config = events.find((e) => e.type === 'config');
    expect(config).toMatchObject({ mode: 'acceptEdits', modes: [{ id: 'default' }, { id: 'acceptEdits' }, { id: 'plan' }] });
    // Grouped select options are flattened.
    expect(config?.type === 'config' && config.options.find((o) => o.id === 'effort')?.choices.map((c) => c.value)).toEqual(['low', 'high']);

    const permission = events.find((e) => e.type === 'permission');
    expect(permission).toMatchObject({ toolId: 't1', title: 'Edit a.txt', kind: 'edit', diffs: [{ path: '/tmp/a.txt', oldText: 'old', newText: 'new' }], content: 'Why: fix the greeting' });
    expect(permission?.type === 'permission' && permission.choices.map((c) => c.kind)).toEqual(['allow_once', 'reject_once']);
    expect(events.some((e) => e.type === 'status' && e.status === 'waiting')).toBe(true);
    expect(events.find((e) => e.type === 'permissionClosed')).toMatchObject({ choiceId: 'allow' });

    const tools = events.filter((e) => e.type === 'tool');
    expect(tools.map((e) => e.type === 'tool' && e.state)).toEqual(['pending', 'done']);
    expect(tools[0]).toMatchObject({ id: 't1', kind: 'edit', summary: 'Edit a.txt', diffs: [{ path: '/tmp/a.txt' }] });
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usedTokens: 1200, contextTokens: 200000, costUsd: 0.042 });
    expect(events.at(-1)).toEqual({ type: 'result', ok: true, sessionId: 'fake-session-1', costUsd: 0.042 });
  });

  it('treats an unknown or missing answer as a denial, and keeps the session for the next turn', async () => {
    const run = acpHarness(spec()).run({ cwd, prompt: 'one', provider: provider(), model: 'default', permissionMode: 'default' });
    const first = await collect(run, 'not-an-option', (e) => e.type === 'result');
    expect(first.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')).toBe('mode=default model=opus[1m] auth=false prompt=one\n\n | denied');
    const second = collect(run, 'allow', (e) => e.type === 'result');
    run.send('two');
    const events = await second;
    run.stop();
    expect(events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')).toContain('prompt=two\n\n | edited');
  });

  it('refuses edits while planning without asking, until the agent leaves plan mode', async () => {
    const run = acpHarness(spec()).run({ cwd, prompt: 'plan it', provider: provider(), model: 'default', permissionMode: 'plan' });
    const planning = await collect(run, 'allow', (e) => e.type === 'result');
    const text = (events: RunnerEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
    expect(text(planning)).toBe('mode=plan model=opus[1m] auth=false prompt=plan it\n\n | denied');
    expect(planning.some((e) => e.type === 'permission')).toBe(false);
    expect(planning.find((e) => e.type === 'notice')).toMatchObject({ text: 'Blocked while planning: Edit a.txt' });
    const approved = collect(run, 'allow', (e) => e.type === 'result');
    run.send('go ahead');
    const building = await approved;
    run.stop();
    expect(text(building)).toContain(' | edited');
    expect(building.some((e) => e.type === 'permission')).toBe(true);
  });

  it('does not start when it cannot plan or ask first', async () => {
    const noPlan = acpHarness(spec({ env: { FAKE_MODES: 'default,acceptEdits' } })).run({ cwd, prompt: 'x', provider: provider(), model: 'default', permissionMode: 'plan' });
    const a = await collect(noPlan, 'allow', (e) => e.type === 'status' && e.status === 'error');
    expect(a.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/no plan mode/) });
    expect(a.some((e) => e.type === 'text')).toBe(false);

    const env = { FAKE_MODES: 'acceptEdits,yolo', FAKE_START_MODE: 'yolo' };
    const noAsk = acpHarness(spec({ env })).run({ cwd, prompt: 'x', provider: provider(), model: 'default', permissionMode: 'default' });
    const b = await collect(noAsk, 'allow', (e) => e.type === 'status' && e.status === 'error');
    expect(b.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/"yolo".*asks first/) });

    // Accept-edits has no such rule: a missing mode is only a warning.
    const edits = acpHarness(spec({ env: { FAKE_MODES: 'default' } })).run({ cwd, prompt: 'x', provider: provider(), model: 'default', permissionMode: 'acceptEdits' });
    const c = await collect(edits, 'deny', (e) => e.type === 'result');
    edits.stop();
    expect(c.some((e) => e.type === 'text')).toBe(true);
  });

  it('switches mode and options on a live session', async () => {
    const run = acpHarness(spec()).run({ cwd, prompt: 'one', provider: provider(), model: 'default' });
    await collect(run, 'allow', (e) => e.type === 'result');
    const configs: RunnerEvent[] = [];
    run.onEvent((e) => e.type === 'config' && configs.push(e));
    await run.configure?.({ mode: 'plan', option: { id: 'model', value: 'sonnet' } });
    await expect(run.configure?.({ option: { id: 'model', value: 'gpt-9' } })).rejects.toThrow(/unknown value/);
    run.stop();
    expect(configs[0]).toMatchObject({ mode: 'plan', options: [{ id: 'model', value: 'sonnet' }, { id: 'effort' }] });
  });

  it('starts with the chosen reasoning effort, and skips a level the model does not offer', async () => {
    const effortOf = (events: RunnerEvent[]) => {
      const config = events.find((e) => e.type === 'config');
      return config?.type === 'config' ? config.options.find((o) => o.category === 'thought_level')?.value : undefined;
    };
    const high = acpHarness(spec()).run({ cwd, prompt: 'x', provider: provider(), model: 'default', effort: 'high' });
    const a = await collect(high, 'allow', (e) => e.type === 'result');
    high.stop();
    expect(effortOf(a)).toBe('high');
    const odd = acpHarness(spec()).run({ cwd, prompt: 'x', provider: provider(), model: 'default', effort: 'ultra' });
    const b = await collect(odd, 'allow', (e) => e.type === 'result');
    odd.stop();
    expect(effortOf(b)).toBe('low');
    expect(b.some((e) => e.type === 'notice' && /doesn't offer the "ultra"/.test(e.text))).toBe(true);
  });

  it('resumes an existing session instead of creating one', async () => {
    const run = acpHarness(spec()).run({ cwd, prompt: 'again', provider: provider(), model: 'default', resumeSessionId: 'old-session-42' });
    const events = await collect(run, 'allow', (e) => e.type === 'result');
    run.stop();
    expect(events.find((e) => e.type === 'started')).toMatchObject({ sessionId: 'old-session-42' });
  });

  it('forks a conversation into a new session, or says it cannot', async () => {
    const run = acpHarness(spec()).run({ cwd, prompt: 'try another idea', provider: provider(), model: 'default', resumeSessionId: 'old-session-42', fork: true });
    const events = await collect(run, 'allow', (e) => e.type === 'result');
    run.stop();
    expect(events.find((e) => e.type === 'started')).toMatchObject({ sessionId: 'fork-of-old-session-42' });

    const noFork = acpHarness(spec({ env: { FAKE_NO_FORK: '1' } })).run({ cwd, prompt: 'x', provider: provider(), model: 'default', resumeSessionId: 'old-session-42', fork: true });
    const failed = await collect(noFork, null, (e) => e.type === 'status' && e.status === 'error');
    expect(failed.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/can't fork/) });
  });

  it('reports a clear error when the agent needs a sign-in it cannot do', async () => {
    const run = acpHarness(spec({ env: { FAKE_REQUIRE_AUTH: '1' } })).run({ cwd, prompt: 'x', provider: provider(), model: 'default' });
    const events = await collect(run, null, (e) => e.type === 'status' && e.status === 'error');
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/Fake agent needs you to sign in/) });
  });

  it('reports agents that are not installed', async () => {
    const harness = acpHarness(spec({ resolve: async () => null }));
    expect(await harness.detect()).toEqual({ installed: false, version: null, path: null });
    const events = await collect(harness.run({ cwd, prompt: 'x', provider: provider(), model: 'm' }), null, (e) => e.type === 'status');
    expect(events[0]).toEqual({ type: 'error', message: 'Fake agent is not installed.' });
  });
});

describe('pickChoice', () => {
  const claude = [{ value: 'default' }, { value: 'opus[1m]' }, { value: 'claude-fable-5-1[1m]' }, { value: 'sonnet' }, { value: 'haiku' }];
  it('maps provider model ids onto agent choices', () => {
    expect(pickChoice(claude, 'claude-opus-5')).toBe('opus[1m]');
    expect(pickChoice(claude, 'claude-fable-5-1')).toBe('claude-fable-5-1[1m]');
    expect(pickChoice(claude, 'claude-haiku-4-5')).toBe('haiku');
    expect(pickChoice(claude, 'sonnet')).toBe('sonnet');
    expect(pickChoice([{ value: 'gpt-6-astra' }, { value: 'gpt-5.5' }], 'gpt-5.5')).toBe('gpt-5.5');
  });
  it('leaves the agent default when nothing matches', () => {
    expect(pickChoice(claude, 'qwen3:0.6b')).toBeNull();
    expect(pickChoice(claude, 'default')).toBeNull();
    expect(pickChoice([{ value: 'grok-4.7' }], 'grok-4.6')).toBeNull();
  });
});

describe('agent questions (ACP forms)', () => {
  const ask = (reply: (requestId: string, run: RunHandle) => void) => {
    const run = acpHarness(spec()).run({ cwd, prompt: 'ask me', provider: provider(), model: 'default', permissionMode: 'default' });
    const events: RunnerEvent[] = [];
    return new Promise<RunnerEvent[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${JSON.stringify(events.map((e) => e.type))}`)), 15_000);
      run.onEvent((e) => {
        events.push(e);
        if (e.type === 'question') setTimeout(() => reply(e.requestId, run), 10);
        if (e.type === 'result' || (e.type === 'status' && e.status === 'error')) {
          clearTimeout(timer);
          run.stop();
          resolve(events);
        }
      });
    });
  };
  const said = (events: RunnerEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');

  it('shows the question as a form and sends back only its own fields', async () => {
    const events = await ask((id, run) => run.answer?.(id, { action: 'accept', content: { question_0: 'Red', question_0_custom: 'dark red', sneaky: 'x' } }));
    const q = events.find((e) => e.type === 'question');
    expect(q).toMatchObject({ message: 'Which color?', fields: [{ key: 'question_0', kind: 'single', title: 'Color', options: [{ value: 'Red', title: 'Red', description: 'Warm' }, { value: 'Blue' }] }, { key: 'question_0_custom', kind: 'text', forKey: 'question_0' }] });
    const i = events.findIndex((e) => e.type === 'question');
    expect(events[i + 1]).toMatchObject({ type: 'status', status: 'waiting' });
    expect(events.find((e) => e.type === 'questionClosed')).toMatchObject({ answered: true });
    expect(said(events)).toContain('answer={"action":"accept","content":{"question_0":"Red","question_0_custom":"dark red"}}');
  });

  it('skipping declines, and a question closed without an answer cancels', async () => {
    const skipped = await ask((id, run) => run.answer?.(id, { action: 'decline' }));
    expect(said(skipped)).toContain('answer={"action":"decline"}');
    expect(skipped.find((e) => e.type === 'questionClosed')).toMatchObject({ answered: false });
    const cancelled = await ask((id, run) => run.answer?.(id, null));
    expect(said(cancelled)).toContain('answer={"action":"cancel"}');
  });

  it('reads choices, yes/no, numbers, required fields and named enums', () => {
    const fields = formFields({
      type: 'object',
      required: ['size'],
      properties: {
        size: { type: 'string', title: 'Size', enum: ['s', 'l'], enumNames: ['Small', 'Large'] },
        tags: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }] } },
        ok: { type: 'boolean', title: 'Agree' },
        n: { type: 'integer' },
        note: { type: 'string', description: 'Anything else' },
        weird: { type: 'object' },
      },
    });
    expect(fields.map((f) => [f.key, f.kind, !!f.required])).toEqual([
      ['size', 'single', true],
      ['tags', 'multi', false],
      ['ok', 'boolean', false],
      ['n', 'number', false],
      ['note', 'text', false],
    ]);
    expect(fields[0]!.options).toEqual([
      { value: 's', title: 'Small', description: '' },
      { value: 'l', title: 'Large', description: '' },
    ]);
    expect(formFields(null)).toEqual([]);
  });
});
