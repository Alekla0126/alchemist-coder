import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewManager } from '../src/main/reviews';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-')));
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'review-data-')));
  dirs.push(root, data);
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 'dev@example.com');
  sh('config', 'user.name', 'Dev');
  writeFileSync(join(root, 'app.js'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
  writeFileSync(join(root, 'run.sh'), 'echo hi\n');
  chmodSync(join(root, 'run.sh'), 0o755);
  sh('add', '-A');
  sh('commit', '-qm', 'init');
  const reviews = new ReviewManager(join(data, 'reviews.json'), join(data, 'reviews'), (cwd) => cwd === root);
  return { root, data, sh, reviews };
}

async function startRun(reviews: ReviewManager, root: string, runId = 'run-1') {
  const prepared = await reviews.prepare(root);
  expect(prepared).not.toBeNull();
  reviews.track(runId, prepared!, { cwd: root, harnessId: 'claude-code', model: 'sonnet', prompt: 'Rename things\nand more' });
  reviews.onRunEvent({ runId, event: { type: 'started', sessionId: 'sess-9', model: null } });
}

// Every step runs real git commands; give them room when the whole suite runs in parallel.
describe('ReviewManager', { timeout: 30_000 }, () => {
  it('shows what the agent changed and keeps or undoes it block by block', async () => {
    const { root, sh, reviews } = setup();
    await startRun(reviews, root);
    // The agent edits two places in app.js, deletes run.sh and adds a file.
    writeFileSync(join(root, 'app.js'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n');
    unlinkSync(join(root, 'run.sh'));
    writeFileSync(join(root, 'new.md'), '# new\n');

    const [review] = await reviews.list(root);
    expect(review).toMatchObject({ id: 'run-1', harnessId: 'claude-code', title: 'Rename things', sessionId: 'sess-9' });
    expect(review!.files.map((f) => [f.path, f.status])).toEqual([['app.js', 'modified'], ['new.md', 'added'], ['run.sh', 'deleted']]);
    expect(await reviews.file('run-1', 'app.js')).toEqual({ oldText: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', newText: 'ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n', binary: false });

    // Keep the first block: the baseline now has ONE, so only SEVEN is left to review.
    await reviews.keep('run-1', 'app.js', 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    expect((await reviews.file('run-1', 'app.js')).oldText).toBe('ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    // Undo the second block on disk.
    await reviews.undo('run-1', 'app.js', 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    expect(readFileSync(join(root, 'app.js'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    // Whole files: bring run.sh back (still executable) and keep the new file.
    await reviews.undo('run-1', 'run.sh');
    expect(readFileSync(join(root, 'run.sh'), 'utf8')).toBe('echo hi\n');
    expect(statSync(join(root, 'run.sh')).mode & 0o111).not.toBe(0);
    expect(await reviews.keep('run-1', 'new.md')).toBeNull();
    expect(await reviews.list(root)).toEqual([]);
    // Nothing was staged or committed for the user.
    expect(sh('diff', '--cached', '--name-only')).toBe('');
    expect(sh('log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  it('undoes a new file by deleting it, and survives a restart', async () => {
    const { root, data, reviews } = setup();
    await startRun(reviews, root);
    writeFileSync(join(root, 'scratch.txt'), 'tmp\n');
    const again = new ReviewManager(join(data, 'reviews.json'), join(data, 'reviews'), (cwd) => cwd === root);
    expect((await again.list(root))[0]!.files.map((f) => f.path)).toEqual(['scratch.txt']);
    await again.undo('run-1', 'scratch.txt');
    expect(existsSync(join(root, 'scratch.txt'))).toBe(false);
  });

  it('only touches files the run changed, never through symlinks, and only in projects', async () => {
    const { root, reviews } = setup();
    expect(await reviews.prepare('/')).toBeNull();
    await startRun(reviews, root);
    await expect(reviews.file('run-1', '../../etc/passwd')).rejects.toThrow(/no pending changes/);
    await expect(reviews.undo('run-1', 'app.js')).rejects.toThrow(/no pending changes/);
    const outside = join(tmpdir(), `outside-${Date.now()}.txt`);
    writeFileSync(outside, 'keep me');
    dirs.push(outside);
    symlinkSync(outside, join(root, 'link.txt'));
    await expect(reviews.undo('run-1', 'link.txt')).rejects.toThrow(/symlink/);
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    await expect(reviews.keep('run-1', 'link.txt', 'x')).rejects.toThrow(/as a whole/);
    // A block computed from an old copy of the file is refused.
    writeFileSync(join(root, 'app.js'), 'changed by the agent\n');
    await expect(reviews.undo('run-1', 'app.js', 'one\n', 'an older version\n')).rejects.toThrow(/changed since/);
    await expect(reviews.keep('run-1', 'app.js', 'x\n', 'not the baseline\n')).rejects.toThrow(/changed since/);
    expect(readFileSync(join(root, 'app.js'), 'utf8')).toBe('changed by the agent\n');
    reviews.dismiss('run-1');
    await expect(reviews.file('run-1', 'link.txt')).rejects.toThrow(/gone/);
  });
});
