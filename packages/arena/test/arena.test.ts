import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitAll,
  createWorktree,
  currentBranch,
  dirtyFiles,
  executionPrompt,
  extractPlan,
  fileVersions,
  headCommit,
  listChanges,
  mergeBranch,
  MergeConflictError,
  planningPrompt,
  removeWorktree,
  repoRoot,
  runTests,
  slug,
} from '../src/index.ts';

const roots: string[] = [];
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arena-')));
  roots.push(root);
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'dev@example.com');
  sh(root, 'config', 'user.name', 'Dev');
  writeFileSync(join(root, 'app.js'), 'export const greet = () => "hi";\n');
  writeFileSync(join(root, 'old.txt'), 'remove me\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'init');
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('worktrees', () => {
  it('gives each agent its own branch and folder, hidden from git status', async () => {
    const root = repo();
    expect(await repoRoot(join(root))).toBe(root);
    const base = await headCommit(root);
    const wt = await createWorktree(root, 'add-greeting-ab12', '1-claude-code', base);
    expect(wt).toEqual({ path: join(root, '.alchemist/worktrees/add-greeting-ab12/1-claude-code'), branch: 'alchemist/add-greeting-ab12/1-claude-code' });
    expect(existsSync(join(wt.path, 'app.js'))).toBe(true);
    expect(await currentBranch(wt.path)).toBe(wt.branch);
    // The main checkout stays clean: .alchemist/ goes to .git/info/exclude, not .gitignore.
    expect(await dirtyFiles(root)).toEqual([]);
    expect(readFileSync(join(root, '.git/info/exclude'), 'utf8')).toContain('/.alchemist/');
    await createWorktree(root, 'add-greeting-ab12', '2-codex', base);
    expect(readFileSync(join(root, '.git/info/exclude'), 'utf8').match(/\/\.alchemist\//g)).toHaveLength(1);
  });

  it('lists added, modified and deleted files with line counts and shows both versions', async () => {
    const root = repo();
    const base = await headCommit(root);
    const wt = await createWorktree(root, 't1', 'a', base);
    writeFileSync(join(wt.path, 'app.js'), 'export const greet = (name) => `hola ${name}`;\nexport const bye = () => "adiós";\n');
    writeFileSync(join(wt.path, 'new.md'), '# New\n\nfile\n');
    unlinkSync(join(wt.path, 'old.txt'));
    expect(await listChanges(wt.path, base)).toEqual([
      { path: 'app.js', status: 'modified', added: 2, removed: 1, binary: false, autoRun: false },
      { path: 'new.md', status: 'added', added: 3, removed: 0, binary: false, autoRun: false },
      { path: 'old.txt', status: 'deleted', added: 0, removed: 1, binary: false, autoRun: false },
    ]);
    expect(await fileVersions(wt.path, base, 'app.js')).toEqual({ oldText: 'export const greet = () => "hi";\n', newText: expect.stringContaining('hola') });
    expect(await fileVersions(wt.path, base, 'new.md')).toMatchObject({ oldText: null });
    expect(await fileVersions(wt.path, base, 'old.txt')).toEqual({ oldText: 'remove me\n', newText: null });
    await expect(fileVersions(wt.path, base, '../../../../etc/passwd')).rejects.toThrow(/outside/);
  });

  it('merges the winner (squash or merge commit) and cleans every worktree up', async () => {
    const root = repo();
    const base = await headCommit(root);
    const a = await createWorktree(root, 't2', 'a', base);
    const b = await createWorktree(root, 't2', 'b', base);
    writeFileSync(join(a.path, 'app.js'), 'export const greet = () => "hola";\n');
    writeFileSync(join(b.path, 'app.js'), 'export const greet = () => "hello";\n');
    expect(await commitAll(a.path, 'Alchemist: greet in Spanish')).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitAll(a.path, 'nothing new')).toBeNull();

    await mergeBranch(root, a.branch, { squash: true, message: 'Greet in Spanish (Claude Code)' });
    expect(readFileSync(join(root, 'app.js'), 'utf8')).toContain('hola');
    expect(sh(root, 'log', '-1', '--format=%s%n%an')).toBe('Greet in Spanish (Claude Code)\nDev\n');
    expect(await dirtyFiles(root)).toEqual([]);

    for (const w of [a, b]) await removeWorktree(root, w);
    expect(existsSync(a.path) || existsSync(b.path)).toBe(false);
    expect(sh(root, 'branch', '--list', 'alchemist/*')).toBe('');
    await removeWorktree(root, a); // already gone: no error
  });

  it('rolls back a conflicting merge and refuses to merge over uncommitted work', async () => {
    const root = repo();
    const base = await headCommit(root);
    const a = await createWorktree(root, 't3', 'a', base);
    writeFileSync(join(a.path, 'app.js'), 'export const greet = () => "from agent";\n');
    await commitAll(a.path, 'agent change');
    writeFileSync(join(root, 'app.js'), 'export const greet = () => "from you";\n');
    await expect(mergeBranch(root, a.branch, { squash: false, message: 'm' })).rejects.toThrow(/Commit or stash/);
    sh(root, 'commit', '-qam', 'your change');
    await expect(mergeBranch(root, a.branch, { squash: false, message: 'm' })).rejects.toBeInstanceOf(MergeConflictError);
    // Nothing half-merged is left behind.
    expect(await dirtyFiles(root)).toEqual([]);
    expect(readFileSync(join(root, 'app.js'), 'utf8')).toContain('from you');
    await mergeBranch(root, a.branch, { squash: true, message: 'x' }).catch((e: unknown) => expect(e).toBeInstanceOf(MergeConflictError));
    expect(await dirtyFiles(root)).toEqual([]);
  });

  it('never runs hooks an agent planted, and flags files that run on their own', async () => {
    const root = repo();
    const base = await headCommit(root);
    const wt = await createWorktree(root, 't4', 'a', base);
    const marker = join(root, '..', `pwned-${Date.now()}`);
    // A hooks folder committed by the agent, and the repo told to use it (as husky does).
    mkdirSync(join(wt.path, '.husky'));
    for (const hook of ['pre-commit', 'post-commit', 'post-merge', 'post-checkout', 'commit-msg']) writeFileSync(join(wt.path, '.husky', hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    sh(root, 'config', 'core.hooksPath', '.husky');
    expect((await listChanges(wt.path, base)).filter((f) => f.autoRun).map((f) => f.path)).toContain('.husky/post-merge');
    await commitAll(wt.path, 'agent');
    await mergeBranch(root, wt.branch, { squash: false, message: 'merge', into: 'main' });
    expect(existsSync(join(root, '.husky', 'post-merge'))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    await createWorktree(root, 't4', 'b', base);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses to merge into a different branch than the task started on', async () => {
    const root = repo();
    const base = await headCommit(root);
    const wt = await createWorktree(root, 't5', 'a', base);
    writeFileSync(join(wt.path, 'app.js'), 'x\n');
    await commitAll(wt.path, 'agent');
    sh(root, 'checkout', '-q', '-b', 'release');
    await expect(mergeBranch(root, wt.branch, { squash: true, message: 'm', into: 'main' })).rejects.toThrow(/switch back to it/);
  });

  it('names the repository root the way the folder was opened, even through a symlink', async () => {
    const root = repo();
    mkdirSync(join(root, 'src'));
    const link = `${root}-link`;
    symlinkSync(root, link, 'junction');
    roots.push(link);
    // git answers with the resolved path; relative(root, cwd) must still stay inside the repo.
    expect(await repoRoot(join(link, 'src'))).toBe(link);
    expect(await repoRoot(root)).toBe(root);
  });

  it('shows symlinks as links and never follows them', async () => {
    const root = repo();
    const base = await headCommit(root);
    const wt = await createWorktree(root, 't6', 'a', base);
    symlinkSync('/etc/hosts', join(wt.path, 'hosts'));
    // The link's target (as the OS stores it: D:\\etc\\hosts on Windows), never the file it points to.
    expect(await fileVersions(wt.path, base, 'hosts')).toEqual({ oldText: null, newText: readlinkSync(join(wt.path, 'hosts')) });
  });

  it('runs a test command in the worktree', async () => {
    const root = repo();
    // Commands that mean the same to sh and to cmd.exe (Windows).
    const pass = await runTests(root, `node -e "process.exit(require('fs').existsSync('app.js') ? 0 : 1)" && echo tests passed`);
    expect(pass).toMatchObject({ ok: true, code: 0 });
    expect(pass.output).toContain('tests passed');
    const fail = await runTests(root, `node -e "console.error('broken'); process.exit(3)"`);
    expect(fail).toMatchObject({ ok: false, code: 3 });
    expect(fail.output).toContain('broken');
  });

  it('ends the whole test process tree when it times out', async () => {
    const root = repo();
    const marker = join(root, 'still-running');
    // The shell starts a background child that would outlive a plain kill of the shell.
    const result = await runTests(root, `(sleep 2; touch ${marker}) & sleep 30`, 300);
    expect(result).toMatchObject({ ok: false, code: null });
    expect(result.output).toContain('Stopped after');
    await new Promise((r) => setTimeout(r, 2500));
    expect(existsSync(marker)).toBe(false);
  });
});

describe('prompts', () => {
  it('builds planning and execution prompts', () => {
    expect(planningPrompt('  Add dark mode ')).toMatch(/Do not change any files[\s\S]*Task:\nAdd dark mode$/);
    const p = executionPrompt('Add dark mode', '1. Add a toggle', 3);
    expect(p).toContain('one of several agents');
    expect(p).toContain('Approved plan');
    expect(executionPrompt('Fix bug', null, 1)).not.toMatch(/several|Approved plan/);
  });

  it('prefers the plan submitted for approval over chat text', () => {
    expect(extractPlan('## Plan\n1. x', 'Here is my plan…')).toBe('## Plan\n1. x');
    expect(extractPlan(null, '  1. only text  ')).toBe('1. only text');
  });

  it('slugs task names for branches', () => {
    expect(slug('Añadir modo oscuro al Editor!!')).toBe('anadir-modo-oscuro-al-editor');
    expect(slug('???')).toBe('task');
    expect(slug('a'.repeat(50), 10)).toBe('aaaaaaaaaa');
  });
});
