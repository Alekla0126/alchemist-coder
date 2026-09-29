import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Settings for every git call the app makes. Agents write to worktrees and branches that are later
 * merged: without these, a hook or fsmonitor command an agent planted (.husky/post-merge, a
 * core.hooksPath in the tree) would run on the user's machine when the app merges or commits.
 */
const SAFE = ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false'];

/** Runs git without a shell or hooks; rejects with git's own message. */
export function git(cwd: string, args: string[], options: { timeoutMs?: number; env?: Record<string, string>; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...SAFE, ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs ?? 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...options.env } },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const msg = String(stderr || error.message).trim().split('\n').slice(-3).join(' ');
        reject(new GitError(`git ${args[0]}: ${msg}`, String(stderr)));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/**
 * The repository's top-level folder, or null when `cwd` is not inside a git repo. It is spelled the
 * way `cwd` is: git reports it resolved (symlinks followed; on Windows long names and forward
 * slashes), and `relative(root, cwd)` must stay inside the repository.
 */
export async function repoRoot(cwd: string): Promise<string | null> {
  let top: string;
  try {
    top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
  if (!top) return null;
  try {
    const real = realpathSync.native(top);
    const depth = relative(real, realpathSync.native(cwd));
    if (!depth.startsWith('..') && !isAbsolute(depth)) {
      const up = depth ? depth.split(sep).map(() => '..') : [];
      const root = resolvePath(cwd, ...up);
      // A symlink between the root and cwd would put the root elsewhere: then use git's.
      if (realpathSync.native(root) === real) return root;
    }
  } catch {
    // Unreadable path: git's answer is the best there is.
  }
  return resolvePath(top);
}

export async function headCommit(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const name = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return name === 'HEAD' ? null : name;
}

/** Tracked or untracked changes, ignoring what git ignores (like .alchemist/). */
export async function dirtyFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => line.slice(3));
}
