import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, utimes } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join, relative } from 'node:path';

export interface BackupSources {
  /** ~/.claude/projects */
  claudeRoot: string;
  /** ~/.codex (its sessions/ and archived_sessions/ are copied) */
  codexRoot: string;
  /** ~/.gemini/tmp (each project's chats/ and .project_root) */
  geminiRoot?: string;
  /** ~/.grok/sessions (each session's updates.jsonl and summary.json) */
  grokRoot?: string;
}

export interface MirrorResult {
  files: number;
  copied: number;
  bytes: number;
}

/** Where a live history file lives inside the backup. */
export const BACKUP_LAYOUT = { claude: 'claude', codex: 'codex', gemini: 'gemini', grok: 'grok' } as const;
const TOP_LEVEL = Object.values(BACKUP_LAYOUT);

/** Marks a folder as an Alchemist backup: the app only ever runs git in folders that have it. */
export const BACKUP_MARKER = '.alchemist-backup';
/** Used inside the chosen folder when that folder already has other things in it. */
export const BACKUP_FOLDER = 'Alchemist Coder Backup';
const README_TITLE = '# Alchemist Coder backup';

const isDir = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/** Whether `dir` is a real folder (not a symlink) holding the backup marker. */
export function isBackupDir(dir: string): boolean {
  return isDir(dir) && isFile(join(dir, BACKUP_MARKER));
}

/** Backups made before the marker existed: our README and nothing but our own files. */
function isLegacyBackup(dir: string): boolean {
  if (!isDir(dir) || !isFile(join(dir, 'README.md'))) return false;
  const own = new Set(['.git', '.gitattributes', 'README.md', ...TOP_LEVEL]);
  return readFileSync(join(dir, 'README.md'), 'utf8').startsWith(README_TITLE) && readdirSync(dir).every((n) => own.has(n));
}

/**
 * The folder to back up into for a folder the user picked: the folder itself when it's empty or
 * already a backup, otherwise an "Alchemist Coder Backup" folder inside it. Creates it and writes
 * the marker. Never takes over a folder with someone else's files (or git repository) in it.
 */
export function prepareBackupDir(chosen: string): string {
  const usable = (dir: string) => {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st) return true;
    if (!st.isDirectory()) return false;
    return isBackupDir(dir) || isLegacyBackup(dir) || readdirSync(dir).filter((n) => n !== '.DS_Store').length === 0;
  };
  const dir = usable(chosen) ? chosen : join(chosen, BACKUP_FOLDER);
  if (!usable(dir)) throw new Error(`${dir} already has other files in it; choose an empty folder.`);
  mkdirSync(dir, { recursive: true });
  if (!isBackupDir(dir)) writeFileSync(join(dir, BACKUP_MARKER), 'This folder is an Alchemist Coder history backup.\n', { flag: 'wx' });
  return dir;
}

function walk(dir: string, keep: (name: string) => boolean, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out, depth + 1);
    else if (e.isFile() && keep(e.name)) out.push(p);
  }
  return out;
}

/** Every history file worth keeping, with its path inside the backup. */
export function historyFiles(src: BackupSources): Array<{ from: string; rel: string }> {
  const files: Array<{ from: string; rel: string }> = [];
  for (const from of walk(src.claudeRoot, (n) => n.endsWith('.jsonl') || n.endsWith('.meta.json'))) {
    files.push({ from, rel: join(BACKUP_LAYOUT.claude, relative(src.claudeRoot, from)) });
  }
  for (const base of ['sessions', 'archived_sessions']) {
    const root = join(src.codexRoot, base);
    for (const from of walk(root, (n) => /^rollout-.*\.jsonl$/.test(n))) files.push({ from, rel: join(BACKUP_LAYOUT.codex, base, relative(root, from)) });
  }
  // Gemini keeps logs and shell history next to the chats: only the chats and the project path.
  const gemini = src.geminiRoot;
  for (const project of gemini ? subdirs(gemini) : []) {
    const dir = join(gemini!, project);
    const chats = filesIn(join(dir, 'chats'), (n) => /^session-.*\.jsonl$/.test(n)).map((n) => join('chats', n));
    if (chats.length && isFile(join(dir, '.project_root'))) chats.push('.project_root');
    for (const rel of chats) files.push({ from: join(dir, rel), rel: join(BACKUP_LAYOUT.gemini, project, rel) });
  }
  const grok = src.grokRoot;
  for (const cwd of grok ? subdirs(grok) : []) {
    for (const id of subdirs(join(grok!, cwd))) {
      for (const name of ['updates.jsonl', 'summary.json']) {
        const from = join(grok!, cwd, id, name);
        if (isFile(from)) files.push({ from, rel: join(BACKUP_LAYOUT.grok, cwd, id, name) });
      }
    }
  }
  return files;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function filesIn(dir: string, keep: (name: string) => boolean): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && keep(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Copies new and grown history files into `dest`, keeping their timestamps. Never deletes: when
 * the CLIs clean up old sessions, the backup still has them.
 */
export async function mirror(src: BackupSources, dest: string, onProgress?: (done: number, total: number) => void): Promise<MirrorResult> {
  const files = historyFiles(src);
  const result: MirrorResult = { files: files.length, copied: 0, bytes: 0 };
  for (const [i, f] of files.entries()) {
    const target = join(dest, f.rel);
    const s = statSync(f.from, { throwIfNoEntry: false });
    if (!s) continue;
    const d = statSync(target, { throwIfNoEntry: false });
    if (!d || d.size !== s.size || Math.trunc(d.mtimeMs) < Math.trunc(s.mtimeMs)) {
      mkdirSync(dirname(target), { recursive: true });
      await copyFile(f.from, target);
      await utimes(target, s.atime, s.mtime);
      result.copied++;
      result.bytes += s.size;
    }
    if (onProgress && (i % 50 === 0 || i === files.length - 1)) onProgress(i + 1, files.length);
  }
  return result;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // No hooks: a global core.hooksPath shouldn't run on every backup commit.
    execFile('git', ['-c', `core.hooksPath=${devNull}`, ...args], { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim().split('\n').slice(-2).join(' '))) : resolve(stdout),
    );
  });
}

const README = `${README_TITLE}

Copies of your Claude Code (\`claude/\`), Codex (\`codex/\`), Gemini CLI (\`gemini/\`) and Grok
Build (\`grok/\`) conversations, kept by Alchemist Coder. Files are only added or updated, never deleted, so conversations stay here after
the CLIs clean them up. Every backup run is a git commit: \`git log\` shows the history.

These files can contain code, secrets and anything else you pasted into a conversation. Keep this
folder private.
`;

/**
 * Makes `dest` a git repository (once) and commits what changed; returns the commit, or null.
 * Only runs in folders made by prepareBackupDir, and only stages the backup's own files.
 */
export async function commitBackup(dest: string, message: string): Promise<string | null> {
  if (!isBackupDir(dest)) throw new Error(`${dest} is not an Alchemist backup folder; choose the backup folder again.`);
  if (!existsSync(join(dest, '.git'))) {
    await git(dest, ['init', '-q']);
    // Transcripts are append-only logs: line diffs of multi-megabyte JSON are useless and slow.
    writeFileSync(join(dest, '.gitattributes'), '*.jsonl -diff -merge\n*.json -diff\n');
    writeFileSync(join(dest, 'README.md'), README);
    await git(dest, ['config', 'user.name', 'Alchemist Coder']);
    await git(dest, ['config', 'user.email', 'backup@alchemist.local']);
    await git(dest, ['config', 'commit.gpgsign', 'false']);
  }
  const own = ['.gitattributes', 'README.md', BACKUP_MARKER, ...TOP_LEVEL].filter((n) => existsSync(join(dest, n)));
  await git(dest, ['add', '-A', '--', ...own]);
  const staged = await git(dest, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) return null;
  await git(dest, ['commit', '-q', '--no-verify', '-m', message]);
  return (await git(dest, ['rev-parse', 'HEAD'])).trim();
}

/** Files and bytes under the backup's history folders (claude/, codex/, gemini/, grok/). */
export function backupSize(dest: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const top of TOP_LEVEL) {
    for (const f of walk(join(dest, top), () => true)) {
      files++;
      bytes += statSync(f, { throwIfNoEntry: false })?.size ?? 0;
    }
  }
  return { files, bytes };
}

