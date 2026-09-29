import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileInTree, replaceInTree, snapshotTree, treeChanges } from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'snap-')));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'snap-idx-')));
  dirs.push(root, scratch);
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 'dev@example.com');
  sh('config', 'user.name', 'Dev');
  writeFileSync(join(root, 'app.js'), 'a\nb\nc\n');
  writeFileSync(join(root, 'run.sh'), 'echo hi\n');
  chmodSync(join(root, 'run.sh'), 0o755);
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  sh('add', '-A');
  sh('commit', '-qm', 'init');
  // Uncommitted work from before the agent started is part of the baseline.
  writeFileSync(join(root, 'notes.md'), 'draft\n');
  return { root, sh, index: join(scratch, 'index'), scratch: join(scratch, 'scratch') };
}

describe('snapshots', () => {
  it('sees exactly what changed since the snapshot, including new and deleted files', async () => {
    const { root, sh, index } = repo();
    const statusBefore = sh('status', '--porcelain');
    const base = await snapshotTree(root, index);
    writeFileSync(join(root, 'app.js'), 'a\nB\nc\nd\n');
    writeFileSync(join(root, 'new.ts'), 'export {};\n');
    unlinkSync(join(root, 'notes.md'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'x.js'), 'ignored');
    const now = await snapshotTree(root, index);
    expect(await treeChanges(root, base, now)).toEqual([
      { path: 'app.js', status: 'modified', added: 2, removed: 1, binary: false },
      { path: 'new.ts', status: 'added', added: 1, removed: 0, binary: false },
      { path: 'notes.md', status: 'deleted', added: 0, removed: 1, binary: false },
    ]);
    expect(await fileInTree(root, base, 'notes.md')).toBe('draft\n');
    expect(await fileInTree(root, base, 'new.ts')).toBeNull();
    // The user's own index and status are untouched.
    writeFileSync(join(root, 'app.js'), 'a\nb\nc\n');
    writeFileSync(join(root, 'notes.md'), 'draft\n');
    unlinkSync(join(root, 'new.ts'));
    rmSync(join(root, 'node_modules'), { recursive: true });
    expect(sh('status', '--porcelain')).toBe(statusBefore);
  });

  it('moves the baseline one file at a time, keeping file modes', async () => {
    const { root, index, scratch } = repo();
    const base = await snapshotTree(root, index);
    writeFileSync(join(root, 'run.sh'), 'echo bye\n');
    writeFileSync(join(root, 'new.ts'), 'x\n');
    const now = await snapshotTree(root, index);
    const kept = await replaceInTree(root, base, 'run.sh', 'echo bye\n', scratch, now);
    expect((await treeChanges(root, kept, now)).map((c) => c.path)).toEqual(['new.ts']);
    const keptNew = await replaceInTree(root, kept, 'new.ts', 'x\n', scratch, now);
    expect(keptNew).toBe(now);
    expect(await replaceInTree(root, keptNew, 'new.ts', null, scratch)).toBe(kept);
    expect(readFileSync(join(root, 'run.sh'), 'utf8')).toBe('echo bye\n');
  });
});
