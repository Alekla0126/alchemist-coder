import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { backupSize, commitBackup, historyFiles, isBackupDir, mirror, prepareBackupDir, type BackupSources } from '@alchemist-coder/archive';
import type { BackupStatus } from '../shared/api';
import type { SettingsStore } from './settings';

const EVERY_MS = 30 * 60_000;
const FIRST_AFTER_MS = 90_000;

export function historySources(): BackupSources {
  return {
    claudeRoot: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
    codexRoot: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    geminiRoot: join(homedir(), '.gemini', 'tmp'),
    grokRoot: join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'sessions'),
  };
}

/** `path` with symlinks resolved as far as it exists (the rest may not be created yet). */
function real(path: string): string {
  let p = resolve(path);
  const rest: string[] = [];
  while (!existsSync(p) && dirname(p) !== p) {
    rest.unshift(p.slice(dirname(p).length + 1));
    p = dirname(p);
  }
  try {
    p = realpathSync(p);
  } catch {
    // keep the plain path
  }
  return join(p, ...rest);
}

const within = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r));
};

function lastCommit(dir: string): Promise<{ ts: number; hash: string } | null> {
  return new Promise((resolve) => {
    if (!existsSync(join(dir, '.git'))) return resolve(null);
    execFile('git', ['log', '-1', '--format=%ct%x09%H'], { cwd: dir, timeout: 10_000 }, (error, stdout) => {
      const [ts, hash] = stdout.trim().split('\t');
      resolve(error || !hash ? null : { ts: Number(ts) * 1000, hash });
    });
  });
}

/**
 * Versioned backup of the Claude Code, Codex, Gemini CLI and Grok Build history: a mirror that
 * only grows, committed to git. The indexer reads sessions the CLIs deleted from here, so they stay
 * in the app.
 */
export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private progress: { done: number; total: number } | null = null;
  private error: string | null = null;
  private sizeCache: { at: number; files: number; bytes: number; sourceBytes: number } | null = null;

  constructor(
    private readonly settings: SettingsStore,
    /** Tells the indexer where preserved sessions live. */
    private readonly onRoot: (dir: string | null) => void,
    private readonly notify: (status: BackupStatus) => void,
    private readonly sources: () => BackupSources = historySources,
  ) {}

  start() {
    this.schedule(FIRST_AFTER_MS);
  }

  /** The backup folder, if it's still a real Alchemist backup (settings.json is user-editable). */
  root(): string | null {
    const dir = this.settings.get().backupDir;
    return dir && isBackupDir(dir) ? dir : null;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay = EVERY_MS) {
    this.stop();
    const { backupDir, backupAuto } = this.settings.get();
    if (!backupDir || !backupAuto) return;
    this.timer = setTimeout(() => void this.run().finally(() => this.schedule()), delay);
  }

  async status(): Promise<BackupStatus> {
    const { backupDir: dir, backupAuto: auto } = this.settings.get();
    if (!this.sizeCache || Date.now() - this.sizeCache.at > 15_000) {
      const size = dir && existsSync(dir) ? backupSize(dir) : { files: 0, bytes: 0 };
      const sourceBytes = historyFiles(this.sources()).reduce((acc, f) => acc + (statSize(f.from) ?? 0), 0);
      this.sizeCache = { at: Date.now(), ...size, sourceBytes };
    }
    const last = dir ? await lastCommit(dir) : null;
    return {
      dir,
      auto,
      running: this.running,
      progress: this.progress,
      lastRun: last?.ts ?? null,
      lastCommit: last?.hash ?? null,
      files: this.sizeCache.files,
      bytes: this.sizeCache.bytes,
      sourceBytes: this.sizeCache.sourceBytes,
      error: this.error,
    };
  }

  private async emit() {
    try {
      this.notify(await this.status());
    } catch {
      // the window is gone (quitting)
    }
  }

  async enable(chosen: string): Promise<BackupStatus> {
    if (!isAbsolute(chosen)) throw new Error('Choose a folder');
    const target = real(chosen);
    const sources = Object.values(this.sources()).filter((p): p is string => !!p).map(real);
    if (target === '/' || sources.some((src) => within(target, src) || within(src, target))) {
      throw new Error('Choose a folder outside the folders where your coding CLIs keep their history.');
    }
    const dir = prepareBackupDir(target);
    this.settings.update({ backupDir: dir });
    this.onRoot(dir);
    this.sizeCache = null;
    void this.run().finally(() => this.schedule());
    return this.status();
  }

  async setAuto(auto: boolean): Promise<BackupStatus> {
    this.settings.update({ backupAuto: auto });
    this.schedule(auto ? EVERY_MS : 0);
    return this.status();
  }

  async run(): Promise<BackupStatus> {
    const dir = this.settings.get().backupDir;
    if (!dir || this.running) return this.status();
    if (!isBackupDir(dir)) {
      this.error = 'The backup folder is gone or is no longer an Alchemist backup; choose it again.';
      return this.status();
    }
    this.running = true;
    this.error = null;
    this.progress = { done: 0, total: 0 };
    await this.emit();
    let last = 0;
    try {
      const result = await mirror(this.sources(), dir, (done, total) => {
        this.progress = { done, total };
        if (Date.now() - last > 500) {
          last = Date.now();
          void this.emit();
        }
      });
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      await commitBackup(dir, `Backup ${stamp} UTC · ${result.copied} of ${result.files} files updated`);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.running = false;
      this.progress = null;
      this.sizeCache = null;
      await this.emit();
    }
    return this.status();
  }
}

function statSize(path: string): number | null {
  return statSync(path, { throwIfNoEntry: false })?.size ?? null;
}
