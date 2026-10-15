import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { QuestionAnswer, RunnerEvent } from '@alchemist-coder/core';
import { appAutopilot } from '../src/main/autopilot';
import { mainWords } from '../src/main/locales';
import { RunnerManager } from '../src/main/runner';
import { sanitize, defaultSettings } from '../src/main/settings';
import type { RunnerEventMessage } from '../src/shared/api';

const dir = mkdtempSync(join(tmpdir(), 'autopilot-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const choices = [
  { id: 'yes', label: 'Allow', kind: 'allow_once' as const },
  { id: 'no', label: 'Deny', kind: 'reject_once' as const },
];
const color = [
  { key: 'q', title: 'Color', description: '', kind: 'single' as const, options: [{ value: 'r', title: 'Red', description: '' }, { value: 'b', title: 'Blue', description: '' }] },
];

describe('Autopilot in the app', () => {
  it('is off unless your settings say so', () => {
    expect(defaultSettings().autopilot).toBe(false);
    expect(sanitize({ autopilot: true }, defaultSettings()).autopilot).toBe(true);
    expect(sanitize({ autopilot: 'yes' }, defaultSettings()).autopilot).toBe(false);
    const off = appAutopilot(() => false, () => mainWords('en').autopilot);
    expect(off.permission({ title: 'npm test', kind: 'execute', command: 'npm test', choices })).toBeNull();
    expect(off.question({ message: 'Which?', fields: color })).toBeNull();
  });

  it('allows quietly, refuses out loud, and says how it answered, in your language', () => {
    const pilot = appAutopilot(() => true, () => mainWords('es').autopilot);
    expect(pilot.permission({ title: 'npm test', kind: 'execute', command: 'npm test', choices })).toEqual({ choiceId: 'yes', note: null });
    expect(pilot.permission({ title: 'Run a command', kind: 'execute', command: 'npm publish', choices })).toEqual({ choiceId: 'no', note: 'El piloto automático rechazó «npm publish»: no se puede deshacer, así que queda para ti.' });
    expect(pilot.question({ message: '¿Qué color?', fields: color })).toEqual({ answer: { action: 'accept', content: { q: 'r' } }, note: 'El piloto automático respondió «¿Qué color?»: Red' });
    const other = [...color, { key: 'q_custom', title: 'Other', description: '', kind: 'text' as const, options: [], forKey: 'q' }];
    expect(pilot.question({ message: '¿Qué color?', fields: other })?.note).toBe('El piloto automático devolvió «¿Qué color?» al agente para que decida.');
  });

  it('decides what was already waiting for you once it is turned on', () => {
    let on = false;
    const listeners: Array<(e: RunnerEvent) => void> = [];
    const responded: Array<[string, string | null]> = [];
    const answered: Array<[string, QuestionAnswer | null]> = [];
    const handle = {
      id: 'run-1',
      send() {},
      stop() {},
      onEvent: (l: (e: RunnerEvent) => void) => (listeners.push(l), () => {}),
      respond: (id: string, choice: string | null) => void responded.push([id, choice]),
      answer: (id: string, a: QuestionAnswer | null) => void answered.push([id, a]),
    };
    const registry = {
      edition: 'pro',
      harnesses: new Map([['fake', { id: 'fake', label: 'Fake', detect: async () => ({ installed: true, version: null, path: null }), run: () => handle }]]),
      providers: new Map([['p', { id: 'p', label: 'P', edition: 'pro', harnesses: ['fake'], env: async () => ({}), models: async () => [] }]]),
    };
    const out: RunnerEventMessage[] = [];
    const runner = new RunnerManager(registry as never, (m) => out.push(m), new Set(), undefined, appAutopilot(() => on, () => mainWords('en').autopilot));
    const { runId } = runner.start({ harnessId: 'fake', providerId: 'p', model: 'm', cwd: dir, prompt: 'go' } as never);
    const say = (e: RunnerEvent) => listeners.forEach((l) => l(e));
    say({ type: 'status', status: 'running' });
    expect(runner.working()).toBe(true);
    say({ type: 'permission', requestId: 'perm-1', toolId: null, title: 'Push', kind: 'execute', diffs: [], choices, content: null, command: 'git push --force' });
    say({ type: 'permission', requestId: 'perm-2', toolId: null, title: 'npm test', kind: 'execute', diffs: [], choices, content: null });
    say({ type: 'permissionClosed', requestId: 'perm-2', choiceId: 'yes' });
    say({ type: 'question', requestId: 'form-1', message: 'Which color?', fields: color });
    // Off: nothing is decided for you.
    runner.decideWaiting();
    expect(responded).toEqual([]);
    on = true;
    runner.decideWaiting();
    expect(responded).toEqual([['perm-1', 'no']]);
    expect(answered).toEqual([['form-1', { action: 'accept', content: { q: 'r' } }]]);
    expect(out.filter((m) => m.runId === runId && m.event.type === 'notice').map((m) => (m.event as { text: string }).text)).toEqual([
      'Autopilot refused "git push --force": it can\'t be undone, so it\'s left for you.',
      'Autopilot answered "Which color?": Red',
    ]);
    say({ type: 'status', status: 'done' });
    expect(runner.working()).toBe(false);
  });
});
