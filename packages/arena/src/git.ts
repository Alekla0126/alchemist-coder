import { execFile } from 'node:child_process';
import { devNull } from 'node:os';

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

/** The repository's top-level folder, or null when `cwd` is not inside a git repo. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim() || null;
  } catch {
    return null;
  }
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
