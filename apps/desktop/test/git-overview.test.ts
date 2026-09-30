import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanRemote, gitAction, gitOverview, parseStatus } from '../src/main/git-overview';

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ac-git-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' }).toString();

describe('git overview', () => {
  it('reads the branch, the distance to upstream and each change from porcelain v2', () => {
    const out = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', '1 .M N... 100644 100644 100644 a b src/app.ts', '2 R. N... 100644 100644 100644 a b R100 new name.ts', 'old.ts', '? notes.md', 'u UU N... 1 2 3 4 a b c conflict.ts', ''].join('\0');
    expect(parseStatus(out)).toEqual({
      branch: 'main',
      detached: false,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      files: [
        { path: 'src/app.ts', status: 'M' },
        { path: 'new name.ts', status: 'R' },
        { path: 'notes.md', status: '?' },
        { path: 'conflict.ts', status: 'U' },
      ],
    });
    expect(cleanRemote('https://user:ghp_secret@github.com/a/b.git')).toBe('https://github.com/a/b.git');
  });

  it('describes a real repository: commits by agents, what is to push, branches, and initializing', async () => {
    const remote = dir();
    g(remote, 'init', '-q', '--bare');
    const repo = dir();
    expect((await gitOverview(repo)).repo).toBe(false);
    await gitAction(repo, 'init');
    await expect(gitAction(repo, 'init')).rejects.toThrow(/already/);
    g(repo, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'first');
    g(repo, 'remote', 'add', 'origin', remote);
    g(repo, 'push', '-q', '-u', 'origin', 'main');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    g(repo, 'commit', '-q', '-am', 'second\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    writeFileSync(join(repo, 'b.txt'), 'new\n');
    const o = await gitOverview(repo);
    expect(o).toMatchObject({ repo: true, branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, remote });
    expect(o.files.map((f) => [f.path.endsWith('b.txt'), f.status])).toEqual([[true, '?']]);
    expect(o.commits.map((c) => [c.subject, c.agent])).toEqual([
      ['second', true],
      ['first', false],
    ]);
    await gitAction(repo, 'push');
    expect((await gitOverview(repo)).ahead).toBe(0);
    await gitAction(repo, 'branch', 'feature/x');
    await expect(gitAction(repo, 'branch', '--force')).rejects.toThrow(/branch name/);
    const after = await gitOverview(repo);
    expect(after.branch).toBe('feature/x');
    expect(after.branches.map((b) => [b.name, b.current]).sort()).toEqual([
      ['feature/x', true],
      ['main', false],
    ]);
    await gitAction(repo, 'switch', 'main');
    expect((await gitOverview(repo)).branch).toBe('main');
  });
});
