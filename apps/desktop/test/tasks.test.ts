import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionRegistry, type ProviderAdapter } from '@alchemist-coder/core';
import { acpHarness } from '@alchemist-coder/harness';
import type { ArenaTask } from '../src/shared/api';
import { RunnerManager } from '../src/main/runner';
import { TaskManager } from '../src/main/tasks';

const AGENT = fileURLToPath(new URL('./fixtures/arena-agent.mjs', import.meta.url));
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

const local: ProviderAdapter = {
  id: 'local',
  label: 'Local',
  edition: 'community',
  harnesses: ['fake'],
  capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false },
  baseUrl: 'http://localhost:11434',
  models: async () => [{ id: 'tiny', label: 'tiny' }],
  env: async () => ({}),
};

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arena-app-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  writeFileSync(join(root, 'README.md'), '# demo\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const registry = new ExtensionRegistry('community');
  registry.registerHarness(
    acpHarness({
      id: 'fake',
      label: 'Fake agent',
      resolve: async () => ({ command: process.execPath, args: [AGENT], version: '1' }),
      modes: { default: { modes: ['default'] }, acceptEdits: { modes: ['acceptEdits'] }, plan: { modes: ['plan'] }, bypassPermissions: { modes: ['default'] } },
    }),
  );
  registry.registerProvider(local);
  const runner = new RunnerManager(registry, () => {});
  const updates: ArenaTask[] = [];
  const file = join(root, '..', `${basename(root)}-tasks.json`);
  const tasks = new TaskManager(file, runner, (cwd) => {
    if (cwd !== root) throw new Error('Not an open project');
    return root;
  }, (t) => updates.push(t));
  cleanup.push(() => {
    runner.stopAll();
    tasks.flush();
    rmSync(root, { recursive: true, force: true });
    rmSync(file, { force: true });
  });
  return { root, git, tasks, updates };
}

function until(updates: ArenaTask[], ok: (t: ArenaTask) => boolean, ms = 20_000): Promise<ArenaTask> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const last = updates.at(-1);
      if (last && ok(last)) return resolve(last);
      if (Date.now() - started > ms) return reject(new Error(`timeout; last phase ${last?.phase} ${JSON.stringify(last?.contestants.map((c) => [c.state, c.error, c.tests]))}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const fake = { harnessId: 'fake', providerId: 'local', model: 'tiny' };

describe('TaskManager (Arena)', () => {
  it('plans, runs two agents in worktrees, compares and merges the winner', async () => {
    const { root, git, tasks, updates } = setup();
    const task = tasks.create(root, 'Add a hello file');
    expect(task).toMatchObject({ phase: 'draft', title: 'Add a hello file' });
    expect(() => tasks.create('/elsewhere', 'x')).toThrow(/Not an open project/);

    tasks.plan(task.id, fake);
    const reviewed = await until(updates, (t) => t.phase === 'review');
    // The plan submitted for approval wins over the chat text.
    expect(reviewed.plan).toBe('## Plan\n1. Create hello.txt\n2. Check it exists');

    tasks.edit(task.id, { plan: `${reviewed.plan}\n3. Keep it short`, testCommand: `node -e "process.exit(require('fs').existsSync('hello.txt') ? 0 : 1)"` });
    await tasks.start(task.id, [fake, fake]);
    const compared = await until(updates, (t) => t.phase === 'compare' && t.contestants.every((c) => c.tests && c.tests !== 'running'));
    expect(compared.base).toBe(git('rev-parse', 'HEAD').trim());
    expect(compared.baseBranch).toBe('main');
    for (const c of compared.contestants) {
      expect(c).toMatchObject({ state: 'finished', costUsd: 0.01, changes: [{ path: 'hello.txt', status: 'added', added: 1 }], tests: { ok: true } });
      expect(c.summary).toBe('Created hello.txt (followed the plan).');
      expect(c.worktree!.path).toBe(join(root, '.alchemist/worktrees', task.id, c.id));
    }
    expect(compared.contestants.map((c) => c.id)).toEqual(['1-fake', '2-fake']);
    // The user's checkout is untouched until the merge.
    expect(existsSync(join(root, 'hello.txt'))).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
    expect(await tasks.diff(task.id, '2-fake', 'hello.txt')).toEqual({ oldText: null, newText: 'hello from 2-fake\n' });
    await expect(tasks.diff(task.id, '2-fake', '../../../../etc/hosts')).rejects.toThrow(/Unknown file/);

    const merged = await tasks.merge(task.id, '2-fake', true);
    expect(merged).toMatchObject({ phase: 'merged', winner: '2-fake' });
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hello from 2-fake\n');
    expect(git('log', '-1', '--format=%s')).toBe('Add a hello file (fake · tiny)\n');
    expect(git('branch', '--list', 'alchemist/*')).toBe('');
    expect(existsSync(join(root, '.alchemist/worktrees', task.id))).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
    tasks.remove(task.id);
    expect(tasks.list(root)).toEqual([]);
  }, 60_000);

  it('runs a single agent without a plan and discards its work', async () => {
    const { root, git, tasks, updates } = setup();
    const task = tasks.create(root, 'Try something');
    tasks.edit(task.id, { review: true });
    await tasks.start(task.id, [fake]);
    const done = await until(updates, (t) => t.phase === 'compare' && !!t.contestants[0]?.changes);
    expect(done.contestants[0]).toMatchObject({ state: 'finished', summary: 'Created hello.txt.' });
    await tasks.discard(task.id);
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(git('branch', '--list', 'alchemist/*')).toBe('');
    expect(tasks.list(root)[0]!.phase).toBe('discarded');
  }, 60_000);

  it('stops every agent when the spending cap is reached', async () => {
    const { root, tasks, updates } = setup();
    const task = tasks.create(root, 'EXPENSIVE refactor');
    tasks.edit(task.id, { review: true, budgetUsd: 0.03 });
    expect(tasks.list(root)[0]!.budgetUsd).toBe(0.03);
    await tasks.start(task.id, [fake, fake]);
    const stopped = await until(updates, (t) => t.phase === 'compare' && !!t.error);
    expect(stopped.error).toMatch(/\$0\.03 budget/);
    expect(stopped.contestants.every((c) => c.state === 'stopped')).toBe(true);
    // Stopped before writing anything.
    const inspected = await until(updates, (t) => t.contestants.every((c) => c.changes !== null));
    expect(inspected.contestants.flatMap((c) => c.changes ?? [])).toEqual([]);
    tasks.edit(task.id, { budgetUsd: -5 });
    expect(tasks.list(root)[0]!.budgetUsd).toBe(0.03);
    await tasks.discard(task.id);
  }, 60_000);

  it('needs git for several agents', async () => {
    const { root, tasks } = setup();
    rmSync(join(root, '.git'), { recursive: true, force: true });
    const task = tasks.create(root, 'x');
    await expect(tasks.start(task.id, [fake, fake])).rejects.toThrow(/git repository/);
  });

  it('keeps an unreadable tasks file aside instead of overwriting it', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-file-')));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'tasks.json');
    writeFileSync(file, '[{"id": "half-writ');
    const registry = new ExtensionRegistry('community');
    const tasks = new TaskManager(file, new RunnerManager(registry, () => {}), () => dir, () => {});
    tasks.create(dir, 'new task');
    tasks.flush();
    const aside = readdirSync(dirname(file)).find((n) => n.startsWith('tasks.json.broken-'));
    expect(aside).toBeDefined();
    expect(readFileSync(join(dir, aside!), 'utf8')).toBe('[{"id": "half-writ');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
  });
});
