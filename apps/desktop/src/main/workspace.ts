import { execFile } from 'node:child_process';
import { lstatSync, promises as fs, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_ENTRIES = 3000;
/** Shown in the tree but never expanded automatically. */
export const HEAVY_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'Pods', '.gradle', 'DerivedData', 'target']);

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  heavy: boolean;
}

export interface FileContent {
  path: string;
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}

export interface GitChange {
  path: string;
  status: string;
}

const realOrNull = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};
/** A single file or folder name: no separators, no "." or "..", nothing empty. */
function validName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n === '.' || n === '..' || /[\\/\0]/.test(n) || n.length > 255) throw new Error('Invalid name');
  return n;
}

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Whether a project folder may be browsed and edited from the app. Conversations started in `/`,
 * the home folder or a top-level folder like /Users would otherwise open up the whole disk.
 */
export function browsableRoot(root: string, home = homedir()): boolean {
  if (!isAbsolute(root)) return false;
  const real = realOrNull(root);
  if (!real) return false;
  const realHome = realOrNull(home) ?? home;
  // Both as written and resolved (/tmp is /private/tmp on macOS).
  const depth = (p: string) => p.slice(parse(p).root.length).split(sep).filter(Boolean).length;
  return depth(resolve(root)) >= 2 && depth(real) >= 2 && real !== realHome && !within(realHome, real);
}

/**
 * All file access from the renderer goes through here, and only inside the folders
 * of projects the index knows about. Symlinks are resolved before the check.
 */
export class Workspace {
  constructor(
    private readonly roots: () => string[],
    private readonly home = homedir(),
  ) {}

  resolveInside(path: unknown): string {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('Invalid path');
    let real = realOrNull(path);
    if (!real) {
      // A symlink pointing nowhere: writing through it would create its target, wherever that is.
      if (lstatSync(path, { throwIfNoEntry: false })) throw new Error('Path is a broken link');
      // New files: check the parent folder instead.
      const parent = realOrNull(dirname(path));
      if (!parent) throw new Error('Folder not found');
      real = join(parent, basename(path));
    }
    const target = real;
    const ok = this.roots().some((root) => {
      const r = browsableRoot(root, this.home) ? realOrNull(root) : null;
      return !!r && within(target, r);
    });
    if (!ok) {
      if (this.isProjectFolder(real)) throw new Error("Alchemist doesn't browse your whole home folder or system folders; open a project inside it.");
      throw new Error('Path is outside of your projects');
    }
    return real;
  }

  /**
   * For paths printed in a terminal: each one that is a file inside a browsable project (relative
   * paths are taken from `cwd`), as an absolute path, else null. Never says anything about files
   * outside your projects.
   */
  async resolveLinks(cwd: unknown, candidates: unknown): Promise<Array<string | null>> {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !Array.isArray(candidates)) return [];
    return Promise.all(
      candidates.slice(0, 100).map(async (c) => {
        if (typeof c !== 'string' || !c || c.length > 1000) return null;
        const path = c.startsWith('~/') ? join(this.home, c.slice(2)) : isAbsolute(c) ? c : join(cwd, c);
        try {
          const real = this.resolveInside(path);
          return (await fs.stat(real)).isFile() ? real : null;
        } catch {
          return null;
        }
      }),
    );
  }

  /** `cwd` resolved, if agents and terminals may run there (see isProjectFolder). */
  projectFolder(cwd: unknown): string {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Invalid path');
    if (!realOrNull(cwd)) throw new Error(`This project's folder no longer exists: ${cwd}`);
    if (!this.isProjectFolder(cwd)) throw new Error('Not one of your projects');
    return realpathSync(cwd);
  }

  /** Whether agents may run in `cwd`: a known project folder (any, even home) or a folder inside one. */
  isProjectFolder(cwd: string): boolean {
    const real = realOrNull(cwd);
    if (!real || real === parse(real).root) return false;
    return this.roots().some((root) => {
      const r = realOrNull(root);
      return !!r && r !== parse(r).root && within(real, r);
    });
  }

  async list(dir: unknown): Promise<DirEntry[]> {
    const real = this.resolveInside(dir);
    const entries = await fs.readdir(real, { withFileTypes: true });
    return entries
      .filter((e) => e.name !== '.DS_Store')
      .slice(0, MAX_ENTRIES)
      .map((e) => ({ name: e.name, path: join(real, e.name), dir: e.isDirectory(), heavy: e.isDirectory() && HEAVY_DIRS.has(e.name) }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
  }

  async read(path: unknown): Promise<FileContent> {
    const real = this.resolveInside(path);
    const st = await fs.stat(real);
    // Only regular files: reading a FIFO or a device would hang or never end.
    if (!st.isFile()) throw new Error('Not a file');
    if (st.size > MAX_FILE_BYTES) return { path: real, text: null, binary: false, tooLarge: true, size: st.size };
    const buf = await fs.readFile(real);
    const binary = buf.subarray(0, 8000).includes(0);
    return { path: real, text: binary ? null : buf.toString('utf8'), binary, tooLarge: false, size: st.size };
  }

  async write(path: unknown, text: unknown): Promise<void> {
    if (typeof text !== 'string' || text.length > MAX_FILE_BYTES * 2) throw new Error('Invalid content');
    const real = this.resolveInside(path);
    await fs.writeFile(real, text, 'utf8');
  }

  /** A new empty file or folder `name` inside the folder `dir` (both inside your projects). */
  async create(dir: unknown, name: unknown, kind: 'file' | 'folder'): Promise<string> {
    const parent = this.resolveInside(dir);
    if (!(await fs.stat(parent)).isDirectory()) throw new Error('Not a folder');
    const target = this.resolveInside(join(parent, validName(name)));
    if (kind === 'folder') await fs.mkdir(target);
    else await fs.writeFile(target, '', { flag: 'wx' });
    return target;
  }

  /** Renames a file or folder in place (never moves it to another folder). */
  async rename(path: unknown, name: unknown): Promise<string> {
    const from = this.resolveInside(path);
    if (this.isRoot(from)) throw new Error("A project's folder can't be renamed from here");
    const to = this.resolveInside(join(dirname(from), validName(name)));
    if (lstatSync(to, { throwIfNoEntry: false })) throw new Error('Something with that name already exists');
    await fs.rename(from, to);
    return to;
  }

  /** `path` resolved for moving to the Trash: inside a project, and never a project folder itself. */
  trashable(path: unknown): string {
    const real = this.resolveInside(path);
    if (this.isRoot(real)) throw new Error("A project's folder can't be moved to the Trash from here");
    return real;
  }

  private isRoot(real: string): boolean {
    return this.roots().some((r) => realOrNull(r) === real);
  }

  async gitStatus(cwd: unknown): Promise<GitChange[]> {
    const root = this.resolveInside(cwd);
    const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).catch(() => '');
    const changes: GitChange[] = [];
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      if (entry.length < 4) continue;
      const status = entry.slice(0, 2).trim() || '?';
      changes.push({ path: join(root, entry.slice(3)), status });
      if (entry[0] === 'R' || entry[0] === 'C') i++; // rename: the next part is the old path
    }
    return changes;
  }

  private readonly fileLists = new Map<string, { at: number; files: string[] }>();

  /** Files and folders of a project matching `query`, for @-mentions: relative paths, best first. */
  async searchFiles(cwd: unknown, query: unknown, limit = 12): Promise<string[]> {
    const root = this.resolveInside(cwd);
    const q = typeof query === 'string' ? query.trim().slice(0, 200) : '';
    return rankFiles(await this.fileList(root), q, Math.min(Math.max(1, Math.floor(Number(limit)) || 12), 50));
  }

  private async fileList(root: string): Promise<string[]> {
    const hit = this.fileLists.get(root);
    if (hit && Date.now() - hit.at < 20_000) return hit.files;
    let files: string[] = [];
    try {
      const listed = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean).slice(0, MAX_LISTED);
      // Git lists a repository nested inside as just its folder: its files come from walking it.
      for (const f of listed) {
        if (!f.endsWith('/')) files.push(f);
        else files.push(...(await walkFiles(join(root, f), MAX_LISTED - files.length)).map((x) => f + x));
        if (files.length >= MAX_LISTED) break;
      }
    } catch {
      files = [];
    }
    // Not a repository, or one that ignores this folder altogether.
    if (!files.length) files = await walkFiles(root, MAX_LISTED);
    const dirs = new Set<string>();
    for (const f of files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i + 1));
    const all = [...dirs, ...files];
    this.fileLists.set(root, { at: Date.now(), files: all });
    if (this.fileLists.size > 20) this.fileLists.delete(this.fileLists.keys().next().value!);
    return all;
  }

  /**
   * Commits the chosen files (new, changed or deleted) with `message`, and pushes when asked.
   * Only files inside the project; the repository's hooks don't run (like every git call here).
   */
  async commit(cwd: unknown, files: unknown, message: unknown, push: unknown): Promise<{ commit: string; pushed: boolean; pushError: string | null }> {
    const root = this.resolveInside(cwd);
    const msg = typeof message === 'string' ? message.trim() : '';
    if (!msg || msg.length > 20_000) throw new Error('Write a commit message');
    if (!Array.isArray(files) || !files.length || files.length > 5000) throw new Error('Choose the files to commit');
    const rels = files.map((f) => {
      if (typeof f !== 'string' || !isAbsolute(f)) throw new Error('Invalid path');
      // Deleted files can't be resolved on disk: check the path itself stays inside.
      const rel = relative(root, resolve(f));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Not in this project: ${f}`);
      return rel.split(sep).join('/');
    });
    await git(root, ['add', '-A', '--', ...rels]);
    await git(root, ['commit', '-m', msg, '--', ...rels]);
    const commit = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
    if (push !== true) return { commit, pushed: false, pushError: null };
    try {
      await git(root, ['push'], { timeout: 90_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      return { commit, pushed: true, pushError: null };
    } catch (e) {
      const text = e instanceof Error ? ((e as { stderr?: string }).stderr || e.message) : String(e);
      return { commit, pushed: false, pushError: text.trim().split('\n').slice(-3).join('\n').slice(0, 500) };
    }
  }

  async gitHead(cwd: unknown, path: unknown): Promise<string | null> {
    const root = this.resolveInside(cwd);
    const file = this.resolveInside(path);
    const rel = relative(root, file).split(sep).join('/');
    return git(root, ['show', `HEAD:${rel}`]).catch(() => null);
  }
}

const MAX_LISTED = 60_000;

/** Files under `root` when it isn't a git repository: no dot folders or heavy ones. */
async function walkFiles(root: string, max: number): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length < max) {
    const rel = queue.shift()!;
    const entries = await fs.readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !HEAVY_DIRS.has(e.name) && path.split('/').length < 12) queue.push(path);
      } else if (e.isFile()) out.push(path);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** True when the letters of `q` appear in `s` in order. */
const subsequence = (s: string, q: string) => {
  let i = 0;
  for (const ch of s) if (ch === q[i] && ++i === q.length) return true;
  return q.length === 0;
};

/**
 * Best matches first: exact name, name starting with the query, name containing it, path
 * containing it, then the letters in order. Shorter paths win ties.
 */
export function rankFiles(files: string[], query: string, limit: number): string[] {
  const q = query.toLowerCase();
  if (!q) return files.filter((f) => !f.slice(0, -1).includes('/')).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
  const scored: Array<[number, string]> = [];
  for (const f of files) {
    const path = f.toLowerCase();
    const name = path.replace(/\/$/, '').split('/').pop()!;
    const score = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : path.includes(q) ? 3 : subsequence(path, q) ? 4 : -1;
    if (score >= 0) scored.push([score * 10_000 + Math.min(f.length, 9_999), f]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, limit).map(([, f]) => f);
}

function git(cwd: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // A repository's own config must not run anything (fsmonitor, hooks).
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout ?? 15_000, env: opts.env }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr: String(stderr ?? '') })) : resolve(stdout),
    );
  });
}
