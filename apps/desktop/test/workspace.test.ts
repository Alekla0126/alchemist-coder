import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { browsableRoot, rankFiles, Workspace } from '../src/main/workspace';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-')));
const home = join(base, 'home');
const project = join(home, 'code', 'app');
const outside = join(base, 'outside.txt');
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'index.ts'), 'export {};\n');
writeFileSync(outside, 'secret');
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('Workspace', () => {
  it('only opens real project folders, never the home folder, / or top-level folders', () => {
    expect(browsableRoot(project, home)).toBe(true);
    expect(browsableRoot(home, home)).toBe(false);
    expect(browsableRoot(join(home, '..'), home)).toBe(false);
    expect(browsableRoot('/', home)).toBe(false);
    expect(browsableRoot('/tmp', home)).toBe(false);
    expect(browsableRoot('relative/path', home)).toBe(false);

    const ws = new Workspace(() => [project, home, '/'], home);
    expect(ws.resolveInside(join(project, 'index.ts'))).toBe(join(project, 'index.ts'));
    expect(() => ws.resolveInside(join(home, '.zshrc'))).toThrow(/outside/);
    expect(() => ws.resolveInside(outside)).toThrow(/outside/);
    // Agents may still continue a conversation started in the home folder; never in /.
    expect(ws.isProjectFolder(home)).toBe(true);
    expect(ws.isProjectFolder(join(project, '.alchemist'))).toBe(false);
    expect(new Workspace(() => ['/'], home).isProjectFolder(base)).toBe(false);
  });

  it('turns printed paths into files only when they are in your projects', async () => {
    const ws = new Workspace(() => [project], home);
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src', 'app.ts'), 'x');
    expect(await ws.resolveLinks(project, ['src/app.ts', join(project, 'index.ts'), 'missing.ts', outside, '../../outside.txt', 'src', 42])).toEqual([
      join(project, 'src', 'app.ts'),
      join(project, 'index.ts'),
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(await ws.resolveLinks('relative', ['src/app.ts'])).toEqual([]);
  });

  it('refuses symlinks that lead out, broken links and things that are not files', async () => {
    const ws = new Workspace(() => [project], home);
    symlinkSync(outside, join(project, 'leak.txt'));
    await expect(ws.read(join(project, 'leak.txt'))).rejects.toThrow(/outside/);
    symlinkSync(join(base, 'created-by-link.txt'), join(project, 'dangling.txt'));
    await expect(ws.write(join(project, 'dangling.txt'), 'x')).rejects.toThrow(/broken link/);
    expect(() => readFileSync(join(base, 'created-by-link.txt'))).toThrow();
    execFileSync('mkfifo', [join(project, 'pipe')]);
    await expect(ws.read(join(project, 'pipe'))).rejects.toThrow(/Not a file/);
    await ws.write(join(project, 'new.ts'), 'ok');
    expect(readFileSync(join(project, 'new.ts'), 'utf8')).toBe('ok');
  });
});

describe('file search for @-mentions', () => {
  it('ranks names before paths and letters in order last', () => {
    const files = ['src/', 'src/components/', 'src/components/Composer.tsx', 'src/composer-state.ts', 'docs/compose.md', 'README.md', 'src/cmp/other.ts'];
    expect(rankFiles(files, 'composer', 5)).toEqual(['src/composer-state.ts', 'src/components/Composer.tsx']);
    expect(rankFiles(files, 'src/cmp', 5)[0]).toBe('src/cmp/other.ts');
    expect(rankFiles(files, 'cmpsr', 5)).toContain('src/components/Composer.tsx');
    expect(rankFiles(files, '', 5)).toEqual(['src/', 'README.md']);
  });

  it('lists a git project with its folders, and a plain folder without dot or heavy folders', async () => {
    const repo = join(project, 'repo');
    mkdirSync(join(repo, 'lib'), { recursive: true });
    mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(repo, 'lib', 'util.ts'), '');
    writeFileSync(join(repo, 'node_modules', 'x', 'util.ts'), '');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const ws = new Workspace(() => [project], home);
    expect(await ws.searchFiles(repo, 'util')).toEqual(['lib/util.ts']);
    expect(await ws.searchFiles(repo, 'lib')).toContain('lib/');

    const plain = join(project, 'plain');
    mkdirSync(join(plain, '.hidden'), { recursive: true });
    mkdirSync(join(plain, 'dist'), { recursive: true });
    writeFileSync(join(plain, 'a.txt'), '');
    writeFileSync(join(plain, '.hidden', 'a.txt'), '');
    writeFileSync(join(plain, 'dist', 'a.txt'), '');
    // Not a repository of its own, but inside `project`… which isn't one either.
    expect(await ws.searchFiles(plain, 'a.txt')).toEqual(['a.txt']);

    // A folder its repository ignores, holding a repository of its own.
    const ignored = join(repo, 'ignored');
    mkdirSync(join(ignored, 'inner', 'src'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nignored\n');
    writeFileSync(join(ignored, 'notes.md'), '');
    writeFileSync(join(ignored, 'inner', 'src', 'main.ts'), '');
    execFileSync('git', ['init', '-q'], { cwd: join(ignored, 'inner') });
    expect(await ws.searchFiles(ignored, 'notes')).toEqual(['notes.md']);
    expect(await ws.searchFiles(ignored, 'main')).toEqual(['inner/src/main.ts']);
    await expect(ws.searchFiles(outside, 'x')).rejects.toThrow();
  });
});

describe('commit', () => {
  it('commits only the chosen files (deletions too) and refuses paths outside', async () => {
    const repo = join(project, 'commit-repo');
    mkdirSync(repo, { recursive: true });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'keep.txt'), 'a');
    writeFileSync(join(repo, 'gone.txt'), 'b');
    run('add', '-A');
    run('commit', '-qm', 'first');
    writeFileSync(join(repo, 'keep.txt'), 'changed');
    writeFileSync(join(repo, 'new.txt'), 'new');
    writeFileSync(join(repo, 'later.txt'), 'not now');
    rmSync(join(repo, 'gone.txt'));
    // A hook that would fail the commit: it must not run.
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const ws = new Workspace(() => [project], home);
    const r = await ws.commit(repo, [join(repo, 'keep.txt'), join(repo, 'new.txt'), join(repo, 'gone.txt')], 'Second', false);
    expect(r.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(run('show', '--name-status', '--format=%s', 'HEAD').trim().split('\n').filter(Boolean)).toEqual(['Second', 'D\tgone.txt', 'M\tkeep.txt', 'A\tnew.txt']);
    expect(run('status', '--porcelain')).toContain('?? later.txt');
    await expect(ws.commit(repo, [join(project, 'index.ts')], 'x', false)).rejects.toThrow();
    await expect(ws.commit(repo, [join(repo, 'later.txt')], '  ', false)).rejects.toThrow(/message/);
  });
});
