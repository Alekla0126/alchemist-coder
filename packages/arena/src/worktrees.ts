import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dirtyFiles, git, GitError } from './git.ts';

export const WORKTREES_DIR = join('.alchemist', 'worktrees');

export interface Worktree {
  path: string;
  branch: string;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  binary: boolean;
  /** A file other tools run on their own (git hooks, direnv, CI, editor tasks): review it closely. */
  autoRun: boolean;
}

const AUTO_RUN = [
  /^\.husky\//,
  /^\.git-?hooks\//,
  /^\.pre-commit-config\.ya?ml$/,
  /^\.?lefthook(-local)?\.(ya?ml|json|toml)$/,
  /^\.envrc$/,
  /^\.github\/workflows\//,
  /^\.vscode\/(tasks|settings|launch)\.json$/,
  /(^|\/)\.gitattributes$/,
];
/** Whether tools run `path` without being asked (see FileChange.autoRun). */
export const runsOnItsOwn = (path: string) => AUTO_RUN.some((re) => re.test(path));

/** Largest file the diff view reads. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const tooLarge = (bytes: number) => `(${(bytes / 1024 / 1024).toFixed(1)} MB: too large to show)\n`;

export interface TestResult {
  ok: boolean;
  code: number | null;
  output: string;
  durationMs: number;
}

export class MergeConflictError extends Error {
  constructor(readonly files: string[]) {
    super(`The merge has conflicts in ${files.length} file(s): ${files.slice(0, 5).join(', ')}`);
    this.name = 'MergeConflictError';
  }
}

/** Lowercase, dash-separated, safe for branch and folder names. */
export function slug(text: string, max = 32): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'task';
}

/** Keeps .alchemist/ out of `git status` without touching the project's .gitignore. */
async function excludeWorkspaceDir(root: string) {
  const common = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
  const file = join(isAbsolute(common) ? common : join(root, common), 'info', 'exclude');
  mkdirSync(join(file, '..'), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!current.split('\n').some((l) => l.trim() === '/.alchemist/' || l.trim() === '.alchemist/')) {
    appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}# Alchemist Coder worktrees\n/.alchemist/\n`);
  }
}

/** A new branch and worktree at `base` for one agent of one task. */
export async function createWorktree(root: string, taskId: string, agentKey: string, base: string): Promise<Worktree> {
  const path = join(root, WORKTREES_DIR, taskId, agentKey);
  const branch = `alchemist/${taskId}/${agentKey}`;
  await excludeWorkspaceDir(root);
  mkdirSync(join(path, '..'), { recursive: true });
  await git(root, ['worktree', 'add', '-b', branch, path, base]);
  return { path, branch };
}

/** Everything the agent changed since `base`, including new files (staged in its own worktree). */
export async function listChanges(worktree: string, base: string): Promise<FileChange[]> {
  await git(worktree, ['add', '-A']);
  const [numstat, names] = await Promise.all([
    git(worktree, ['diff', '--cached', '--numstat', '-z', '-M', base]),
    git(worktree, ['diff', '--cached', '--name-status', '-z', '-M', base]),
  ]);
  const status = new Map<string, FileChange['status']>();
  const parts = names.split('\0');
  for (let i = 0; i < parts.length - 1; ) {
    const code = parts[i]!;
    if (code.startsWith('R')) {
      status.set(parts[i + 2]!, 'renamed');
      i += 3;
    } else {
      status.set(parts[i + 1]!, code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified');
      i += 2;
    }
  }
  const out: FileChange[] = [];
  const rows = numstat.split('\0');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (!row) continue;
    const [a, r, file] = row.split('\t');
    // Renames print "a\tr\t" followed by the old and the new path as separate fields.
    const path = file ? file : (i += 2, rows[i]!);
    const binary = a === '-';
    out.push({ path, status: status.get(path) ?? 'modified', added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary, autoRun: runsOnItsOwn(path) });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

function inside(root: string, rel: string): string {
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`Path outside the worktree: ${rel}`);
  return full;
}

/**
 * Old (at `base`) and new (in the worktree) text of one file; null when it doesn't exist there.
 * Symlinks show where they point (as git stores them), never the file they point to.
 */
export async function fileVersions(worktree: string, base: string, path: string): Promise<{ oldText: string | null; newText: string | null }> {
  const full = inside(worktree, path);
  const rel = relative(worktree, full).split(sep).join('/');
  const oldSize = await git(worktree, ['cat-file', '-s', `${base}:${rel}`]).then(Number, () => 0);
  const oldText = oldSize > MAX_DIFF_BYTES ? tooLarge(oldSize) : await git(worktree, ['show', `${base}:${rel}`]).catch(() => null);
  const st = lstatSync(full, { throwIfNoEntry: false });
  let newText: string | null = null;
  if (st?.isSymbolicLink()) newText = readlinkSync(full);
  else if (st?.isFile()) newText = st.size > MAX_DIFF_BYTES ? tooLarge(st.size) : await readFile(full, 'utf8');
  return { oldText, newText };
}

/** Commits everything in the worktree; returns the new commit, or null when nothing changed. */
export async function commitAll(worktree: string, message: string): Promise<string | null> {
  await git(worktree, ['add', '-A']);
  const staged = await git(worktree, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) return null;
  await git(worktree, [...(await identity(worktree)), 'commit', '--no-verify', '-q', '-m', message]);
  return (await git(worktree, ['rev-parse', 'HEAD'])).trim();
}

/** The user's git identity when they have one, otherwise a stand-in so commits never fail. */
async function identity(cwd: string): Promise<string[]> {
  const has = await git(cwd, ['config', 'user.email']).then((v) => !!v.trim(), () => false);
  return has ? [] : ['-c', 'user.name=Alchemist Coder', '-c', 'user.email=agents@alchemist.local'];
}

/**
 * Brings the winning branch into the checked-out branch of `root`. The main checkout must be clean
 * so a failed merge can be rolled back without touching the user's work.
 */
export async function mergeBranch(root: string, branch: string, options: { squash: boolean; message: string; into?: string | null }): Promise<string> {
  if (options.into !== undefined) {
    // The task compared against the branch it started on; merging elsewhere would bring surprises.
    const current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (current !== (options.into ?? 'HEAD')) throw new Error(`The task started on ${options.into ?? 'a detached HEAD'}; switch back to it before merging (now on ${current}).`);
  }
  const dirty = await dirtyFiles(root);
  if (dirty.length) throw new Error(`Commit or stash your changes first (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? '…' : ''}).`);
  const who = await identity(root);
  try {
    if (options.squash) {
      await git(root, ['merge', '--squash', branch]);
      await git(root, [...who, 'commit', '--no-verify', '-q', '-m', options.message]);
    } else {
      await git(root, [...who, 'merge', '--no-ff', '--no-verify', '-m', options.message, branch]);
    }
  } catch (error) {
    const conflicts = (await git(root, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
    await git(root, ['merge', '--abort']).catch(() => git(root, ['reset', '--merge']).catch(() => ''));
    if (conflicts.length) throw new MergeConflictError(conflicts);
    throw error;
  }
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

/** Removes a task worktree and its branch; missing ones are fine. */
export async function removeWorktree(root: string, worktree: Worktree): Promise<void> {
  if (existsSync(worktree.path)) await git(root, ['worktree', 'remove', '--force', worktree.path]).catch(() => '');
  await git(root, ['worktree', 'prune']).catch(() => '');
  await git(root, ['branch', '-D', worktree.branch]).catch((e: unknown) => {
    if (!(e instanceof GitError && /not found/.test(e.message))) throw e;
  });
}

/**
 * Runs the project's test command in a worktree through the user's shell, in its own process
 * group: a timeout ends the whole tree (npm → node → test workers), not just the shell.
 */
export function runTests(worktree: string, command: string, timeoutMs = 10 * 60_000): Promise<TestResult> {
  const started = Date.now();
  const win = process.platform === 'win32';
  const shell = win ? 'cmd.exe' : (process.env.SHELL ?? '/bin/sh');
  const args = win ? ['/d', '/s', '/c', command] : ['-lc', command];
  return new Promise((resolveResult) => {
    const child = spawn(shell, args, { cwd: worktree, detached: !win, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8000);
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (win) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
        else process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    const done = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      if (error) output += `\n${error.message}`;
      if (timedOut) output += `\nStopped after ${Math.round(timeoutMs / 1000)} s.`;
      resolveResult({ ok: code === 0 && !timedOut && !error, code: timedOut ? null : code, output: output.slice(-8000), durationMs: Date.now() - started });
    };
    child.on('error', (error) => done(null, error));
    child.on('close', (code) => done(code));
  });
}
