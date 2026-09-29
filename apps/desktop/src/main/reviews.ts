import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { copyEntry, entryInTree, fileInTree, replaceInTree, repoRoot, snapshotTree, treeChanges } from '@alchemist-coder/arena';
import type { AgentReview, ReviewFile, ReviewFileContent, RunnerEventMessage } from '../shared/api';

interface ReviewRecord {
  id: string;
  root: string;
  cwd: string;
  harnessId: string;
  model: string;
  title: string;
  sessionId: string | null;
  /** The project as the agent found it, minus the changes already kept. */
  base: string;
  createdAt: number;
}

export interface PreparedReview {
  root: string;
  base: string;
  indexFile: string;
}

/** Past this, a run starts without a review rather than keep the user waiting. */
const SNAPSHOT_TIMEOUT_MS = 8000;
const MAX_REVIEWS = 30;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const STALE = 'This file changed since you opened the review; look at it again.';

/**
 * What each agent run changed in its project, reviewed block by block. When a run starts in a git
 * project, the working tree is snapshotted as a git tree; the review compares that baseline with
 * the files now. Keeping a change moves it into the baseline; undoing one writes the baseline back
 * to disk. Nothing touches the user's index, branches or commits.
 */
export class ReviewManager {
  private records: ReviewRecord[] = [];
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly storePath: string,
    private readonly dir: string,
    private readonly isProjectFolder: (cwd: string) => boolean,
  ) {
    try {
      const data = JSON.parse(readFileSync(storePath, 'utf8')) as ReviewRecord[];
      if (Array.isArray(data)) this.records = data.filter((r) => r && typeof r.id === 'string' && typeof r.base === 'string');
    } catch {
      // first run
    }
  }

  /** Snapshots `cwd`'s repository before an agent starts there; null when it isn't a git project. */
  async prepare(cwd: unknown): Promise<PreparedReview | null> {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !this.isProjectFolder(cwd)) return null;
    const root = await repoRoot(cwd);
    if (!root) return null;
    const indexFile = join(this.dir, `${randomBytes(8).toString('hex')}.index`);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS));
    const base = await Promise.race([snapshotTree(root, indexFile).catch(() => null), timeout]);
    return base ? { root, base, indexFile } : null;
  }

  track(runId: string, prepared: PreparedReview, request: { cwd?: unknown; harnessId?: unknown; model?: unknown; prompt?: unknown }) {
    const id = runId;
    renameSync(prepared.indexFile, this.indexOf(id));
    const first = String(request.prompt ?? '').trim().split('\n')[0]!;
    const title = first.length > 120 ? `${first.slice(0, 119)}…` : first;
    this.records.unshift({ id, root: prepared.root, cwd: String(request.cwd), harnessId: String(request.harnessId), model: String(request.model ?? ''), title, sessionId: null, base: prepared.base, createdAt: Date.now() });
    for (const old of this.records.splice(MAX_REVIEWS)) this.forget(old.id);
    this.save();
  }

  /** Remembers which conversation a run belongs to, so the review can link back to it. */
  onRunEvent({ runId, event }: RunnerEventMessage) {
    const r = this.records.find((x) => x.id === runId);
    const sessionId = event.type === 'started' || event.type === 'result' ? event.sessionId : null;
    if (r && sessionId && r.sessionId !== sessionId) {
      r.sessionId = sessionId;
      this.save();
    }
  }

  /** The project's reviews that still have changes to look at, newest first. */
  async list(cwd: unknown): Promise<AgentReview[]> {
    const mine = this.records.filter((r) => r.cwd === cwd);
    const out: AgentReview[] = [];
    for (const r of mine) {
      const files = await this.serial(r.id, () => this.pending(r)).catch(() => []);
      if (files.length) out.push(this.summary(r, files));
    }
    return out;
  }

  async file(id: unknown, path: unknown): Promise<ReviewFileContent> {
    const r = this.get(id);
    return this.serial(r.id, async () => {
      const { change } = await this.change(r, path);
      if (change.binary) return { oldText: null, newText: null, binary: true };
      const full = this.inside(r, change.path);
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (st && st.size > MAX_TEXT_BYTES) return { oldText: null, newText: null, binary: true };
      return { oldText: await fileInTree(r.root, r.base, change.path), newText: st?.isFile() ? readFileSync(full, 'utf8') : null, binary: false };
    });
  }

  /**
   * Accepts a change: the whole file (`baseline` undefined) or, for a text file, the baseline with
   * the kept blocks applied (computed by the review panel).
   */
  async keep(id: unknown, path: unknown, baseline?: unknown, basedOn?: unknown): Promise<AgentReview | null> {
    const r = this.get(id);
    return this.serial(r.id, async () => {
      const { change, current } = await this.change(r, path);
      if (baseline === undefined) r.base = await copyEntry(r.root, current, r.base, change.path, this.scratchOf(r.id));
      else if (typeof baseline === 'string' && change.status === 'modified' && !change.binary) {
        if (basedOn !== undefined && basedOn !== (await fileInTree(r.root, r.base, change.path))) throw new Error(STALE);
        r.base = await replaceInTree(r.root, r.base, change.path, baseline, this.scratchOf(r.id), current);
      } else throw new Error('Keep this file as a whole');
      this.save();
      // Keeping changes nothing on disk: the snapshot taken above is still current.
      return this.after(r, current);
    });
  }

  /**
   * Reverts a change on disk: the whole file (`content` undefined) back to the baseline, or, for a
   * text file, to `content` (the file with the undone blocks restored).
   */
  async undo(id: unknown, path: unknown, content?: unknown, basedOn?: unknown): Promise<AgentReview | null> {
    const r = this.get(id);
    return this.serial(r.id, async () => {
      const { change } = await this.change(r, path);
      const full = this.inside(r, change.path);
      if (content === undefined) {
        const entry = await entryInTree(r.root, r.base, change.path);
        if (!entry) unlinkSync(full);
        else writeAtomic(full, entry.bytes, entry.mode === '100755' ? 0o755 : undefined);
      } else if (typeof content === 'string' && change.status === 'modified' && !change.binary) {
        // The agent may still be writing: never overwrite a version the panel hasn't seen.
        if (basedOn !== undefined && basedOn !== readFileSync(full, 'utf8')) throw new Error(STALE);
        writeAtomic(full, Buffer.from(content, 'utf8'));
      } else {
        throw new Error('Undo this file as a whole');
      }
      return this.after(r);
    });
  }

  dismiss(id: unknown) {
    const r = this.get(id);
    this.records = this.records.filter((x) => x !== r);
    this.forget(r.id);
    this.save();
  }

  // ---------- internals ----------

  private get(id: unknown): ReviewRecord {
    const r = this.records.find((x) => x.id === id);
    if (!r) throw new Error('This review is gone');
    return r;
  }

  private async current(r: ReviewRecord): Promise<string> {
    return snapshotTree(r.root, this.indexOf(r.id));
  }

  private async pending(r: ReviewRecord): Promise<ReviewFile[]> {
    return treeChanges(r.root, r.base, await this.current(r));
  }

  /** The change to `path`, which must be one of the review's pending files (never any other path). */
  private async change(r: ReviewRecord, path: unknown): Promise<{ change: ReviewFile; current: string }> {
    const current = await this.current(r);
    const change = (await treeChanges(r.root, r.base, current)).find((c) => c.path === path);
    if (!change) throw new Error('That file has no pending changes');
    return { change, current };
  }

  private async after(r: ReviewRecord, current?: string): Promise<AgentReview | null> {
    const files = current ? await treeChanges(r.root, r.base, current) : await this.pending(r);
    return files.length ? this.summary(r, files) : null;
  }

  private summary(r: ReviewRecord, files: ReviewFile[]): AgentReview {
    return { id: r.id, cwd: r.cwd, root: r.root, harnessId: r.harnessId, model: r.model, title: r.title, sessionId: r.sessionId, createdAt: r.createdAt, files };
  }

  /** `root/path`, refusing anything that leaves the repository or goes through a symlink. */
  private inside(r: ReviewRecord, path: string): string {
    const full = join(r.root, path);
    const rel = relative(r.root, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path outside the project');
    // The folder may be gone too (a deleted file being restored): check the nearest one that exists.
    let dir = dirname(full);
    while (!lstatSync(dir, { throwIfNoEntry: false }) && dir !== r.root) dir = dirname(dir);
    const parent = realpathSync(dir);
    const realRoot = realpathSync(r.root);
    if (parent !== realRoot && !parent.startsWith(realRoot + sep)) throw new Error('Path outside the project');
    if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('This file is a symlink; review it by hand');
    return full;
  }

  /** One operation at a time per review: they share an index file. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(fn, fn);
    this.chains.set(id, next.catch(() => {}));
    return next;
  }

  private indexOf(id: string) {
    return join(this.dir, `${id.replace(/[^\w-]/g, '_')}.index`);
  }

  private scratchOf(id: string) {
    return join(this.dir, `${id.replace(/[^\w-]/g, '_')}.scratch`);
  }

  private forget(id: string) {
    rmSync(this.indexOf(id), { force: true });
    rmSync(this.scratchOf(id), { force: true });
  }

  private save() {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 1));
    renameSync(tmp, this.storePath);
  }
}

/** Temp file + rename: the file is never half-written. Keeps the old permissions unless told. */
function writeAtomic(path: string, bytes: Buffer, mode?: number) {
  const tmp = join(dirname(path), `.${randomBytes(4).toString('hex')}.alchemist-tmp`);
  const old = lstatSync(path, { throwIfNoEntry: false });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, bytes, { flag: 'wx' });
  chmodSync(tmp, mode ?? (old?.isFile() ? old.mode & 0o777 : 0o644));
  renameSync(tmp, path);
}
