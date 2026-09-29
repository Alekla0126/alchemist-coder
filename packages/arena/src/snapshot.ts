import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { git } from './git.ts';

/**
 * Snapshots of a working tree as git trees, for reviewing what an agent changed. They go through
 * a private index file, so the user's index, branches and files are never touched; the objects
 * land in the repository's object store like any `git add` would.
 */

export interface TreeChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added: number;
  removed: number;
  binary: boolean;
}

/** Git's name for a file that doesn't exist, on either side of a change. */
const ZERO = /^0+$/;
/** Arena worktrees are other checkouts: never part of a project's snapshot. */
const PATHSPEC = ['--', '.', ':(exclude).alchemist'];

/**
 * The whole working tree (tracked and untracked files, minus what .gitignore hides) as a tree
 * hash. `indexFile` is reused between calls so git only rehashes files that changed.
 */
export async function snapshotTree(root: string, indexFile: string): Promise<string> {
  if (!existsSync(indexFile)) {
    mkdirSync(dirname(indexFile), { recursive: true });
    // Start from the real index: its stat cache spares hashing every file the first time.
    const real = (await git(root, ['rev-parse', '--git-path', 'index'])).trim();
    const realPath = isAbsolute(real) ? real : join(root, real);
    if (existsSync(realPath)) copyFileSync(realPath, indexFile);
  }
  const env = { GIT_INDEX_FILE: indexFile };
  await git(root, ['add', '-A', ...PATHSPEC], { env, timeoutMs: 120_000 });
  return (await git(root, ['write-tree'], { env })).trim();
}

/** Files that differ between two trees, with line counts. */
export async function treeChanges(root: string, from: string, to: string): Promise<TreeChange[]> {
  if (from === to) return [];
  const [raw, numstat] = await Promise.all([
    git(root, ['diff-tree', '-r', '-z', '--no-renames', '--raw', from, to]),
    git(root, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', from, to]),
  ]);
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const row of numstat.split('\0')) {
    const [a, r, path] = row.split('\t');
    if (path) counts.set(path, { added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r), binary: a === '-' });
  }
  const out: TreeChange[] = [];
  const parts = raw.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // ":100644 100644 <old> <new> M" then the path.
    const [, , oldHash, newHash] = parts[i]!.split(' ');
    const path = parts[i + 1]!;
    const status = ZERO.test(oldHash ?? '') ? 'added' : ZERO.test(newHash ?? '') ? 'deleted' : 'modified';
    out.push({ path, status, ...(counts.get(path) ?? { added: 0, removed: 0, binary: false }) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A file's content in a tree, or null when the tree doesn't have it. */
export async function fileInTree(root: string, tree: string, path: string): Promise<string | null> {
  return git(root, ['cat-file', 'blob', `${tree}:${path}`]).catch(() => null);
}

/** A file's mode and raw bytes in a tree (binary-safe), or null when the tree doesn't have it. */
export async function entryInTree(root: string, tree: string, path: string): Promise<{ mode: string; bytes: Buffer } | null> {
  const line = (await git(root, ['ls-tree', tree, '--', path])).trim();
  const m = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(line);
  if (!m) return null;
  const bytes = await new Promise<Buffer>((resolve, reject) =>
    execFile('git', ['cat-file', 'blob', m[2]!], { cwd: root, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );
  return { mode: m[1]!, bytes };
}

/** `to` with `path` exactly as it is in `from` (or removed if `from` lacks it). */
export async function copyEntry(root: string, from: string, to: string, path: string, scratchIndex: string): Promise<string> {
  const env = { GIT_INDEX_FILE: scratchIndex };
  mkdirSync(dirname(scratchIndex), { recursive: true });
  await git(root, ['read-tree', to], { env });
  const m = /^(\d{6}) blob ([0-9a-f]+)\t/.exec((await git(root, ['ls-tree', from, '--', path])).trim());
  if (m) await git(root, ['update-index', '--add', '--cacheinfo', `${m[1]},${m[2]},${path}`], { env });
  else await git(root, ['update-index', '--force-remove', '--', path], { env });
  return (await git(root, ['write-tree'], { env })).trim();
}

/**
 * `tree` with one file replaced (or removed, when `text` is null). Keeps the file's mode (from
 * `tree`, else from `modeTree`), so an executable script stays executable. Returns the new tree.
 */
export async function replaceInTree(root: string, tree: string, path: string, text: string | null, scratchIndex: string, modeTree?: string): Promise<string> {
  const env = { GIT_INDEX_FILE: scratchIndex };
  mkdirSync(dirname(scratchIndex), { recursive: true });
  await git(root, ['read-tree', tree], { env });
  if (text === null) {
    await git(root, ['update-index', '--force-remove', '--', path], { env });
  } else {
    const blob = (await git(root, ['hash-object', '-w', '--stdin'], { input: text })).trim();
    const modeIn = async (t: string) => /^(100755|100644|120000)\s/.exec(await git(root, ['ls-tree', t, '--', path]))?.[1];
    const mode = (await modeIn(tree)) ?? (modeTree ? await modeIn(modeTree) : undefined) ?? '100644';
    await git(root, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], { env });
  }
  return (await git(root, ['write-tree'], { env })).trim();
}
