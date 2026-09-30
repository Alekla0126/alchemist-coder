import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { git, repoRoot } from '@alchemist-coder/arena';
import type { GitBranchInfo, GitCommitInfo, GitOverview } from '../shared/api';

/** Coding agents sign their commits with a co-author line (or commit under their own name). */
const AGENT = /co-authored-by:\s*(claude|codex|gemini|grok|copilot|cursor|devin|openai|anthropic|alchemist)|^(claude|codex|gemini)\b/im;

/** A remote's address without any user or token in it. */
export const cleanRemote = (url: string) => url.trim().replace(/^(https?:\/\/)[^@/]+@/i, '$1');

/** `git status --porcelain=v2 --branch -z`: the branch, how far it is from its upstream, and each change. */
export function parseStatus(out: string) {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: Array<{ path: string; status: string }> = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (line.startsWith('# branch.head ')) branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const f = line.split(' ');
      const xy = f[1]!;
      // Ordinary entries have the path as the 9th field; renames/copies as the 10th, then the old path.
      const path = line.startsWith('2 ') ? f.slice(9).join(' ') : f.slice(8).join(' ');
      files.push({ path, status: xy.replace(/\./g, '').slice(0, 2) || 'M' });
      if (line.startsWith('2 ')) i++;
    } else if (line.startsWith('u ')) files.push({ path: line.split(' ').slice(10).join(' '), status: 'U' });
    else if (line.startsWith('? ')) files.push({ path: line.slice(2), status: '?' });
  }
  return { branch: branch === '(detached)' ? null : branch, detached: branch === '(detached)', upstream, ahead, behind, files };
}

export function parseLog(out: string): GitCommitInfo[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, short, subject, author, at, body] = r.split('\x1f');
      return { hash: hash!, short: short!, subject: subject ?? '', author: author ?? '', at: Number(at) * 1000, agent: AGENT.test(`${author}\n${body ?? ''}`) };
    });
}

export function parseBranches(out: string, current: string | null): GitBranchInfo[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, upstream, track, at, subject] = line.split('\x1f');
      const ahead = Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0);
      const behind = Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0);
      return { name: name!, current: name === current, upstream: upstream || null, ahead, behind, gone: /gone/.test(track ?? ''), at: Number(at) * 1000, subject: subject ?? '' };
    });
}

/** Everything the Git panel shows about a project's repository, in one read-only pass. */
export async function gitOverview(cwd: string): Promise<GitOverview> {
  const root = await repoRoot(cwd);
  if (!root) return { repo: false, root: null, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], commits: [], branches: [], worktrees: [], remote: null, lastFetch: null, stashes: 0 };
  const run = (args: string[]) => git(root, args, { timeoutMs: 15_000 }).catch(() => '');
  const [status, log, refs, trees, remote, stash, fetchHead] = await Promise.all([
    run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']),
    run(['log', '-n', '30', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1f%b%x1e']),
    run(['for-each-ref', '--sort=-committerdate', '--count=30', 'refs/heads', '--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix)%1f%(contents:subject)']),
    run(['worktree', 'list', '--porcelain']),
    run(['remote', 'get-url', 'origin']),
    run(['stash', 'list']),
    run(['rev-parse', '--git-path', 'FETCH_HEAD']),
  ]);
  const s = parseStatus(status);
  const worktrees = trees
    .split('\n\n')
    .map((block) => ({ path: /^worktree (.+)$/m.exec(block)?.[1] ?? '', branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null }))
    .filter((w) => w.path && resolve(w.path) !== resolve(root));
  const fetchPath = fetchHead.trim() ? (isAbsolute(fetchHead.trim()) ? fetchHead.trim() : join(root, fetchHead.trim())) : '';
  let lastFetch: number | null = null;
  try {
    lastFetch = fetchPath ? statSync(fetchPath).mtimeMs : null;
  } catch {
    lastFetch = null;
  }
  return {
    repo: true,
    root,
    branch: s.branch,
    detached: s.detached,
    upstream: s.upstream,
    ahead: s.ahead,
    behind: s.behind,
    files: s.files.slice(0, 400).map((f) => ({ path: join(root, f.path), status: f.status })),
    commits: parseLog(log),
    branches: parseBranches(refs, s.branch),
    worktrees: worktrees.slice(0, 30),
    remote: remote.trim() ? cleanRemote(remote) : null,
    lastFetch,
    stashes: stash.split('\n').filter(Boolean).length,
  };
}

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*[\s~^:?*[\\])[\w./-]{1,100}(?<![./])$/;

/** The actions the panel offers. Network ones never prompt (no hidden password dialog hangs). */
export async function gitAction(cwd: string, action: string, arg?: unknown): Promise<string> {
  const root = await repoRoot(cwd);
  if (action === 'init') {
    if (root) throw new Error('This project already uses git.');
    await git(cwd, ['init', '-q']);
    return 'ok';
  }
  if (!root) throw new Error('This project is not a git repository.');
  const net = { timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: '0' } };
  switch (action) {
    case 'fetch':
      return git(root, ['fetch', '--prune', '--quiet'], net);
    case 'pull':
      // Only fast-forward: anything that needs a merge is yours (or an agent's) to decide.
      return git(root, ['pull', '--ff-only', '--quiet'], net);
    case 'push': {
      const upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
      return upstream ? git(root, ['push', '--quiet'], net) : git(root, ['push', '--quiet', '-u', 'origin', 'HEAD'], net);
    }
    case 'switch': {
      const name = typeof arg === 'string' ? arg.trim() : '';
      if (!BRANCH.test(name)) throw new Error('Invalid branch name');
      return git(root, ['switch', '--quiet', name]);
    }
    case 'branch': {
      const name = typeof arg === 'string' ? arg.trim() : '';
      if (!BRANCH.test(name)) throw new Error('Use letters, numbers, "-", "_", "/" or "." for the branch name');
      return git(root, ['switch', '--quiet', '-c', name]);
    }
    default:
      throw new Error(`Unknown git action: ${action}`);
  }
}
