import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { AgentStatus, IndexProgress, Source } from '@alchemist-coder/core';
import { parseClaudeFile, type SubagentMeta } from './claude.ts';
import { parseCodexFile } from './codex.ts';
import { geminiProjectRoot, grokSessionInfo, parseGeminiFile, parseGrokFile } from './acp-sources.ts';
import { migrate } from './schema.ts';
import type { FileSummary } from './summary.ts';

/** A transcript file still being written within this window counts as live. */
export const RECENT_MS = 90_000;

const ARENA_WORKTREE = /[\\/]\.alchemist[\\/]worktrees[\\/].*$/;

/** Arena agents work in `<project>/.alchemist/worktrees/<task>/<agent>`; their sessions belong to `<project>`. */
export function projectCwd(cwd: string): string {
  return cwd.replace(ARENA_WORKTREE, '') || cwd;
}

export interface IndexerOptions {
  /** ~/.gemini/tmp (Gemini CLI chats) */
  geminiRoot?: string;
  /** ~/.grok/sessions (Grok Build sessions) */
  grokRoot?: string;
  /** Alchemist's backup mirror: sessions the CLIs deleted are read from here instead. */
  backupRoot?: string | null;
  dbPath: string;
  claudeRoot?: string;
  codexRoot?: string;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

export interface SessionFile {
  agentId: string;
  path: string;
  metaPath: string | null;
}

export interface SessionTask {
  key: string;
  source: Source;
  id: string;
  mainPath: string;
  subagents: SessionFile[];
  archived: boolean;
  /** Read from Alchemist's backup because the CLI deleted the original. */
  preserved?: boolean;
  /** Lossy cwd decoded from the Claude project folder, used only if no record carries a cwd. */
  fallbackCwd: string | null;
}

interface ParsedFile {
  summary: FileSummary;
  mtime: number;
  size: number;
  changed: boolean;
}

interface AgentRow {
  id: string;
  parentId: string | null;
  toolUseId: string | null;
  type: string;
  description: string;
  depth: number;
  model: string | null;
  isFork: boolean;
  worktreePath: string | null;
  worktreeBranch: string | null;
  status: AgentStatus;
  startedTs: number | null;
  endedTs: number | null;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  filePath: string;
  fileMtime: number;
}

const promptTokens = (s: FileSummary) => s.usage.input + s.usage.cacheRead + s.usage.cacheWrite5m + s.usage.cacheWrite1h;

function readMeta(path: string | null): SubagentMeta {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SubagentMeta;
  } catch {
    return {};
  }
}

export function subagentStatus(parent: FileSummary | undefined, main: FileSummary, meta: SubagentMeta, own: FileSummary, mtime: number, now: number): AgentStatus {
  const toolUseId = meta.toolUseId;
  const result = toolUseId ? (parent?.results[toolUseId] ?? main.results[toolUseId]) : undefined;
  const note = toolUseId ? (parent?.notifications[toolUseId] ?? main.notifications[toolUseId]) : undefined;
  const notedAt = toolUseId ? (parent?.notifiedAt[toolUseId] ?? main.notifiedAt[toolUseId]) : undefined;
  // Resumed (SendMessage) after it reported back: its own transcript kept going, so the old
  // result or notification no longer says how it is.
  const reportedAt = Math.max(notedAt ?? 0, result && !result.isAsync ? (result.ts ?? 0) : 0);
  if (reportedAt > 0 && own.lastTs != null && own.lastTs > reportedAt + 1000) {
    if (own.lastStopReason === 'end_turn') return 'done';
    return now - mtime < RECENT_MS ? 'running' : 'interrupted';
  }
  if (result?.isError) return 'error';
  if (note) return note === 'completed' ? 'done' : note === 'failed' ? 'error' : 'interrupted'; // killed / stopped
  // A synchronous Agent call returns only when the subagent has finished.
  if (result && !result.isAsync) return 'done';
  if (own.lastStopReason === 'end_turn') return 'done';
  return now - mtime < RECENT_MS ? 'running' : 'interrupted';
}

export class Indexer {
  readonly db: DatabaseSync;
  readonly claudeRoot: string;
  readonly codexRoot: string;
  readonly geminiRoot: string;
  readonly grokRoot: string;
  backupRoot: string | null;
  private readonly now: () => number;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly cache = new Map<string, ParsedFile>();
  private readonly watchers: FSWatcher[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stmt: Record<string, StatementSync>;

  constructor(options: IndexerOptions) {
    this.db = new DatabaseSync(options.dbPath);
    migrate(this.db);
    this.claudeRoot = options.claudeRoot ?? join(homedir(), '.claude', 'projects');
    this.codexRoot = options.codexRoot ?? join(homedir(), '.codex');
    this.backupRoot = options.backupRoot ?? null;
    this.geminiRoot = options.geminiRoot ?? join(homedir(), '.gemini', 'tmp');
    this.grokRoot = options.grokRoot ?? join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'sessions');
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
    const db = this.db;
    this.stmt = {
      project: db.prepare('INSERT INTO project(cwd, name) VALUES (?, ?) ON CONFLICT(cwd) DO UPDATE SET name = excluded.name RETURNING id'),
      session: db.prepare(`INSERT OR REPLACE INTO session
        (id, source, project_id, file_path, title, first_ts, last_ts, message_count, models, git_branch, cli_version,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, archived, has_prompt, context_tokens, context_window, edited_files)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      deleteAgents: db.prepare('DELETE FROM agent WHERE session_id = ?'),
      agent: db.prepare(`INSERT INTO agent
        (session_id, id, parent_id, tool_use_id, type, description, depth, model, is_fork, worktree_path, worktree_branch,
         status, started_ts, ended_ts, tool_calls, input_tokens, output_tokens, cost_usd, file_path, file_mtime)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      deleteMessages: db.prepare('DELETE FROM message WHERE session_id = ? AND agent_id = ?'),
      message: db.prepare('INSERT INTO message (session_id, agent_id, key, role, ts, byte_offset, byte_length, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      file: db.prepare('INSERT OR REPLACE INTO indexed_file (path, session_id, agent_id, mtime, size) VALUES (?, ?, ?, ?, ?)'),
      knownFiles: db.prepare('SELECT path, session_id, mtime, size FROM indexed_file'),
      sessionIds: db.prepare('SELECT id FROM session'),
    };
  }

  // ---------- discovery ----------

  discover(): SessionTask[] {
    const tasks: SessionTask[] = [];
    const claudeDirs = (root: string, archived: boolean, skip?: Set<string>) => {
      if (!existsSync(root)) return;
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const file of readdirSync(join(root, dir.name))) {
          if (!file.endsWith('.jsonl') || skip?.has(basename(file, '.jsonl'))) continue;
          const task = this.claudeTask(dir.name, basename(file, '.jsonl'), root, archived);
          if (task) tasks.push(skip ? { ...task, preserved: true } : task);
        }
      }
    };
    const codexDirs = (root: string, archived: (base: string) => boolean, skip?: Set<string>) => {
      for (const base of ['sessions', 'archived_sessions']) {
        const dir = join(root, base);
        if (!existsSync(dir)) continue;
        for (const path of walkRollouts(dir)) {
          const task = this.codexTask(path, archived(base));
          if (!skip?.has(task.id)) tasks.push(skip ? { ...task, preserved: true } : task);
        }
      }
    };
    claudeDirs(this.claudeRoot, false);
    codexDirs(this.codexRoot, (base) => base === 'archived_sessions');
    tasks.push(...this.geminiTasks(), ...this.grokTasks());
    if (this.backupRoot) {
      // Sessions the CLIs have deleted live on in the backup; a live copy always wins.
      const live = new Set(tasks.map((t) => t.id));
      claudeDirs(join(this.backupRoot, 'claude'), true, live);
      codexDirs(join(this.backupRoot, 'codex'), () => true, live);
      for (const task of [...this.geminiTasks(join(this.backupRoot, 'gemini')), ...this.grokTasks(join(this.backupRoot, 'grok'))]) {
        if (!live.has(task.id)) tasks.push({ ...task, archived: true, preserved: true });
      }
    }
    return tasks;
  }

  claudeTask(projectDir: string, sessionId: string, root = this.claudeRoot, archived = false): SessionTask | null {
    const mainPath = join(root, projectDir, `${sessionId}.jsonl`);
    if (!existsSync(mainPath)) return null;
    const subagents: SessionFile[] = [];
    const subDir = join(root, projectDir, sessionId, 'subagents');
    if (existsSync(subDir)) {
      for (const file of readdirSync(subDir)) {
        if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
        const agentId = file.slice('agent-'.length, -'.jsonl'.length);
        const metaPath = join(subDir, `agent-${agentId}.meta.json`);
        subagents.push({ agentId, path: join(subDir, file), metaPath: existsSync(metaPath) ? metaPath : null });
      }
    }
    return {
      key: `claude-code:${sessionId}`,
      source: 'claude-code',
      id: sessionId,
      mainPath,
      subagents,
      archived,
      fallbackCwd: projectDir.replace(/-/g, '/'),
    };
  }

  /** `~/.gemini/tmp/<project>/chats/session-*.jsonl` (or the same layout inside the backup) */
  geminiTasks(root = this.geminiRoot): SessionTask[] {
    const out: SessionTask[] = [];
    if (!existsSync(root)) return out;
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const chats = join(root, dir.name, 'chats');
      if (!existsSync(chats)) continue;
      for (const file of readdirSync(chats)) if (/^session-.*\.jsonl$/.test(file)) out.push(this.geminiTask(join(chats, file)));
    }
    return out;
  }

  geminiTask(path: string): SessionTask {
    return { key: `gemini:${path}`, source: 'gemini', id: basename(path, '.jsonl'), mainPath: path, subagents: [], archived: false, fallbackCwd: geminiProjectRoot(path) };
  }

  /** `~/.grok/sessions/<encoded cwd>/<session id>/updates.jsonl` (or the same layout inside the backup) */
  grokTasks(root = this.grokRoot): SessionTask[] {
    const out: SessionTask[] = [];
    if (!existsSync(root)) return out;
    for (const cwdDir of readdirSync(root, { withFileTypes: true })) {
      if (!cwdDir.isDirectory()) continue;
      for (const id of readdirSync(join(root, cwdDir.name))) {
        const updates = join(root, cwdDir.name, id, 'updates.jsonl');
        if (existsSync(updates)) out.push(this.grokTask(updates));
      }
    }
    return out;
  }

  grokTask(path: string): SessionTask {
    const id = basename(dirname(path));
    const cwd = grokSessionInfo(path)?.info?.cwd;
    let fallback: string | null = null;
    try {
      fallback = typeof cwd === 'string' ? cwd : decodeURIComponent(basename(dirname(dirname(path))));
    } catch {
      fallback = null;
    }
    return { key: `grok:${id}`, source: 'grok', id, mainPath: path, subagents: [], archived: false, fallbackCwd: fallback };
  }

  codexTask(path: string, archived: boolean): SessionTask {
    const id = basename(path, '.jsonl').slice(-36);
    return { key: `codex:${path}`, source: 'codex', id, mainPath: path, subagents: [], archived, fallbackCwd: null };
  }

  // ---------- indexing ----------

  indexAll(onProgress?: (p: IndexProgress) => void): { indexed: number; skipped: number; removed: number } {
    onProgress?.({ phase: 'scanning', done: 0, total: 0 });
    const tasks = this.discover();
    const known = new Map<string, { sessionId: string; mtime: number; size: number }>();
    for (const row of this.stmt.knownFiles!.all() as Array<{ path: string; session_id: string; mtime: number; size: number }>) {
      known.set(row.path, { sessionId: row.session_id, mtime: row.mtime, size: row.size });
    }
    const seen = new Set<string>();
    let indexed = 0;
    let skipped = 0;
    tasks.forEach((task, i) => {
      const knownId = known.get(task.mainPath)?.sessionId;
      if (knownId && this.isUnchanged(task, known)) {
        seen.add(knownId);
        skipped++;
      } else {
        try {
          const id = this.indexSession(task);
          if (id) seen.add(id);
          indexed++;
        } catch (error) {
          this.onError(error, task.mainPath);
          if (knownId) seen.add(knownId);
        }
      }
      if (onProgress && (i % 10 === 0 || i === tasks.length - 1)) onProgress({ phase: 'indexing', done: i + 1, total: tasks.length });
    });
    let removed = 0;
    for (const { id } of this.stmt.sessionIds!.all() as Array<{ id: string }>) {
      if (!seen.has(id)) {
        this.removeSession(id);
        removed++;
      }
    }
    onProgress?.({ phase: 'ready', done: tasks.length, total: tasks.length });
    return { indexed, skipped, removed };
  }

  private isUnchanged(task: SessionTask, known: Map<string, { mtime: number; size: number }>): boolean {
    const paths = [task.mainPath, ...task.subagents.flatMap((s) => (s.metaPath ? [s.path, s.metaPath] : [s.path]))];
    return paths.every((path) => {
      const k = known.get(path);
      if (!k) return false;
      const st = statSync(path, { throwIfNoEntry: false });
      return !!st && Math.trunc(st.mtimeMs) === k.mtime && st.size === k.size;
    });
  }

  private parseFile(path: string, source: Source): ParsedFile {
    const st = statSync(path);
    const mtime = Math.trunc(st.mtimeMs);
    const cached = this.cache.get(path);
    if (cached && cached.mtime === mtime && cached.size === st.size) return { ...cached, changed: false };
    const summary =
      source === 'codex' ? parseCodexFile(path) : source === 'gemini' ? parseGeminiFile(path).summary : source === 'grok' ? parseGrokFile(path).summary : parseClaudeFile(path);
    const parsed = { summary, mtime, size: st.size, changed: true };
    // Rows are written to the database; the cache keeps only what the agent tree needs.
    this.cache.set(path, { ...parsed, summary: { ...summary, rows: [] } });
    return parsed;
  }

  /** Re-indexes one conversation (main transcript + subagents). Returns the session id. */
  indexSession(task: SessionTask): string | null {
    const now = this.now();
    const main = this.parseFile(task.mainPath, task.source);
    const subs = task.subagents.map((f) => ({ file: f, parsed: this.parseFile(f.path, 'claude-code'), meta: readMeta(f.metaPath) }));
    const summaries = new Map<string, FileSummary>([['main', main.summary]]);
    for (const s of subs) summaries.set(s.file.agentId, s.parsed.summary);

    const m = main.summary;
    const sessionId = task.source === 'claude-code' || task.source === 'grok' ? task.id : (m.sessionId ?? task.id);
    const title = m.customTitle ?? m.aiTitle ?? m.firstPrompt ?? m.firstReply ?? '(untitled)';
    const mainRecent = now - main.mtime < RECENT_MS;
    const mainStatus: AgentStatus =
      task.source === 'claude-code'
        ? mainRecent && m.lastStopReason !== 'end_turn' ? 'running' : 'idle'
        : mainRecent && !m.finished ? 'running' : 'idle';

    const agents: AgentRow[] = [
      {
        id: 'main',
        parentId: null,
        toolUseId: null,
        type: task.source === 'claude-code' ? 'main' : task.source,
        description: title,
        depth: 0,
        model: m.models.at(-1) ?? null,
        isFork: false,
        worktreePath: null,
        worktreeBranch: null,
        status: mainStatus,
        startedTs: m.firstTs,
        endedTs: m.lastTs,
        toolCalls: m.toolCalls,
        inputTokens: promptTokens(m),
        outputTokens: m.usage.output,
        costUsd: m.costUsd,
        filePath: task.mainPath,
        fileMtime: main.mtime,
      },
    ];
    const depthOf = new Map<string, number>([['main', 0]]);
    const pending = [...subs];
    // Parents are resolved before children so nested depths are correct.
    for (let guard = 0; pending.length > 0 && guard < subs.length + 1; guard++) {
      for (let i = 0; i < pending.length; i++) {
        const s = pending[i]!;
        const parentId = s.meta.parentAgentId && summaries.has(s.meta.parentAgentId) ? s.meta.parentAgentId : 'main';
        if (!depthOf.has(parentId) && guard < subs.length) continue;
        pending.splice(i--, 1);
        const own = s.parsed.summary;
        const parent = summaries.get(parentId);
        const spawn = s.meta.toolUseId ? parent?.spawns[s.meta.toolUseId] : undefined;
        const depth = s.meta.spawnDepth ?? (depthOf.get(parentId) ?? 0) + 1;
        depthOf.set(s.file.agentId, depth);
        agents.push({
          id: s.file.agentId,
          parentId,
          toolUseId: s.meta.toolUseId ?? null,
          type: s.meta.agentType ?? spawn?.type ?? 'agent',
          description: s.meta.description || spawn?.description || own.firstPrompt || s.file.agentId,
          depth,
          model: s.meta.model ?? own.models.at(-1) ?? null,
          isFork: s.meta.isFork === true,
          worktreePath: s.meta.worktreePath ?? null,
          worktreeBranch: s.meta.worktreeBranch ?? null,
          status: subagentStatus(parent, m, s.meta, own, s.parsed.mtime, now),
          startedTs: own.firstTs,
          endedTs: own.lastTs,
          toolCalls: own.toolCalls,
          inputTokens: promptTokens(own),
          outputTokens: own.usage.output,
          costUsd: own.costUsd,
          filePath: s.file.path,
          fileMtime: s.parsed.mtime,
        });
      }
    }

    const all = [m, ...subs.map((s) => s.parsed.summary)];
    const sum = (f: (s: FileSummary) => number) => all.reduce((acc, s) => acc + f(s), 0);
    const costs = all.map((s) => s.costUsd).filter((c): c is number => c != null);
    const firstTs = Math.min(...all.map((s) => s.firstTs ?? Infinity));
    const lastTs = Math.max(...all.map((s) => s.lastTs ?? -Infinity));
    const models = [...new Set(all.flatMap((s) => s.models))];
    const cwd = projectCwd(m.cwd ?? task.fallbackCwd ?? '(unknown)');

    this.db.exec('BEGIN');
    try {
      const { id: projectId } = this.stmt.project!.get(cwd, basename(cwd) || cwd) as { id: number };
      this.stmt.session!.run(
        sessionId, task.source, projectId, task.mainPath, title,
        Number.isFinite(firstTs) ? firstTs : null, Number.isFinite(lastTs) ? lastTs : null,
        m.userTurns + m.assistantMessages, JSON.stringify(models), m.gitBranch, m.cliVersion,
        sum((s) => s.usage.input), sum((s) => s.usage.output), sum((s) => s.usage.cacheRead),
        sum((s) => s.usage.cacheWrite5m + s.usage.cacheWrite1h),
        costs.length ? costs.reduce((a, b) => a + b, 0) : null, task.preserved ? 2 : task.archived ? 1 : 0, m.userTurns > 0 ? 1 : 0,
        m.contextTokens ?? 0, m.contextWindow ?? null,
        JSON.stringify([...new Set([m, ...subs.map((x) => x.parsed.summary)].flatMap((f) => [...(f.editedFiles ?? [])]))].slice(0, 500)),
      );
      this.stmt.deleteAgents!.run(sessionId);
      for (const a of agents) {
        this.stmt.agent!.run(
          sessionId, a.id, a.parentId, a.toolUseId, a.type, a.description, a.depth, a.model, a.isFork ? 1 : 0,
          a.worktreePath, a.worktreeBranch, a.status, a.startedTs, a.endedTs, a.toolCalls, a.inputTokens,
          a.outputTokens, a.costUsd, a.filePath, a.fileMtime,
        );
      }
      const files: Array<{ agentId: string; path: string; parsed: ParsedFile; metaPath: string | null }> = [
        { agentId: 'main', path: task.mainPath, parsed: main, metaPath: null },
        ...subs.map((s) => ({ agentId: s.file.agentId, path: s.file.path, parsed: s.parsed, metaPath: s.file.metaPath })),
      ];
      for (const f of files) {
        if (f.parsed.changed) {
          this.stmt.deleteMessages!.run(sessionId, f.agentId);
          for (const r of f.parsed.summary.rows) {
            this.stmt.message!.run(sessionId, f.agentId, r.key, r.role, r.ts, r.offset, r.length, r.text);
          }
        }
        this.stmt.file!.run(f.path, sessionId, f.agentId, f.parsed.mtime, f.parsed.size);
        if (f.metaPath) {
          const st = statSync(f.metaPath, { throwIfNoEntry: false });
          if (st) this.stmt.file!.run(f.metaPath, sessionId, f.agentId, Math.trunc(st.mtimeMs), st.size);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return sessionId;
  }

  removeSession(sessionId: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM message WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM agent WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM indexed_file WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM session WHERE id = ?').run(sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------- live updates ----------

  /** `source`: the CLI that wrote (its usage may have changed too). */
  watch(onChange: (sessionIds: string[], source: string) => void, debounceMs = 800): void {
    const schedule = (task: SessionTask) => {
      clearTimeout(this.timers.get(task.key));
      this.timers.set(
        task.key,
        setTimeout(() => {
          this.timers.delete(task.key);
          try {
            const id = this.indexSession(task);
            if (id) onChange([id], task.source);
          } catch (error) {
            this.onError(error, task.mainPath);
          }
        }, debounceMs),
      );
    };
    if (existsSync(this.claudeRoot)) {
      this.watchers.push(
        watch(this.claudeRoot, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const parts = filename.toString().split(sep);
          let task: SessionTask | null = null;
          if (parts.length === 2 && parts[1]!.endsWith('.jsonl')) {
            const id = basename(parts[1]!, '.jsonl');
            // Deleted by Claude Code (e.g. its 30-day cleanup): keep showing the backup copy.
            const kept = this.backupRoot ? this.claudeTask(parts[0]!, id, join(this.backupRoot, 'claude'), true) : null;
            task = this.claudeTask(parts[0]!, id) ?? (kept && { ...kept, preserved: true });
          }
          else if (parts.length >= 4 && parts[2] === 'subagents') task = this.claudeTask(parts[0]!, parts[1]!);
          if (task) schedule(task);
        }),
      );
    }
    if (existsSync(this.geminiRoot)) {
      this.watchers.push(
        watch(this.geminiRoot, { recursive: true }, (_event, filename) => {
          const f = filename?.toString();
          if (!f || !/chats[\\/]session-.*\.jsonl$/.test(f)) return;
          const path = join(this.geminiRoot, f);
          const kept = this.backupRoot ? join(this.backupRoot, 'gemini', f) : null;
          if (existsSync(path)) schedule(this.geminiTask(path));
          else if (kept && existsSync(kept)) schedule({ ...this.geminiTask(kept), archived: true, preserved: true });
        }),
      );
    }
    if (existsSync(this.grokRoot)) {
      this.watchers.push(
        watch(this.grokRoot, { recursive: true }, (_event, filename) => {
          const f = filename?.toString();
          if (!f || !f.endsWith('updates.jsonl')) return;
          const path = join(this.grokRoot, f);
          const kept = this.backupRoot ? join(this.backupRoot, 'grok', f) : null;
          if (existsSync(path)) schedule(this.grokTask(path));
          else if (kept && existsSync(kept)) schedule({ ...this.grokTask(kept), archived: true, preserved: true });
        }),
      );
    }
    for (const base of ['sessions', 'archived_sessions']) {
      const root = join(this.codexRoot, base);
      if (!existsSync(root)) continue;
      this.watchers.push(
        watch(root, { recursive: true }, (_event, filename) => {
          if (!filename || !/rollout-.*\.jsonl$/.test(filename.toString())) return;
          const path = join(root, filename.toString());
          if (existsSync(path)) schedule(this.codexTask(path, base === 'archived_sessions'));
        }),
      );
    }
  }

  close(): void {
    for (const w of this.watchers) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.db.close();
  }
}

function* walkRollouts(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkRollouts(path);
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) yield path;
  }
}
