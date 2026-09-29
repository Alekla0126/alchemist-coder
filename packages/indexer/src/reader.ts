import { closeSync, openSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AgentNode, AgentStatus, ProjectSummary, SearchHit, SessionSummary, Source, TranscriptEntry, TranscriptPage } from '@alchemist-coder/core';
import { RECENT_MS } from './indexer.ts';
import { readSlice } from './lines.ts';
import { configure } from './schema.ts';
import { SNIPPET_END, SNIPPET_START, toFtsQuery } from './search.ts';
import type { RowRole } from './summary.ts';
import { claudeEntry, codexEntry, mergeEntries } from './transcript.ts';
import { parseGeminiFile, parseGrokFile } from './acp-sources.ts';

type Row = Record<string, any>;

export class IndexReader {
  readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(dbPath: string, now: () => number = Date.now) {
    this.db = new DatabaseSync(dbPath);
    configure(this.db);
    this.now = now;
  }

  /** Stored "running" goes stale if a transcript stops growing without a final record. */
  private effectiveStatus(status: AgentStatus, mtime: number, isMain: boolean): AgentStatus {
    if (status === 'running' && this.now() - mtime > RECENT_MS) return isMain ? 'idle' : 'interrupted';
    return status;
  }

  listProjects(): ProjectSummary[] {
    const running = new Map<number, number>();
    for (const r of this.db
      .prepare(`SELECT s.project_id AS pid, COUNT(*) AS n FROM agent a JOIN session s ON s.id = a.session_id
                WHERE a.status = 'running' AND a.file_mtime > ? GROUP BY s.project_id`)
      .all(this.now() - RECENT_MS) as Row[]) {
      running.set(r.pid, r.n);
    }
    // Projects with a real conversation, plus folders the user opened or created here (still empty).
    return (this.db
      .prepare(`SELECT p.id, p.cwd, p.name, COUNT(s.id) AS sessions, COALESCE(MAX(s.last_ts), p.added_at) AS last_ts, GROUP_CONCAT(DISTINCT s.source) AS sources
                FROM project p LEFT JOIN session s ON s.project_id = p.id AND s.has_prompt = 1
                GROUP BY p.id HAVING COUNT(s.id) > 0 OR p.added_at IS NOT NULL ORDER BY last_ts DESC`)
      .all() as Row[]).map((r) => ({
      id: r.id,
      cwd: r.cwd,
      name: r.name,
      sessionCount: r.sessions,
      lastTs: r.last_ts ?? null,
      sources: String(r.sources ?? '').split(',').filter(Boolean) as Source[],
      runningAgents: running.get(r.id) ?? 0,
    }));
  }

  /** Sessions without a single real prompt (e.g. failed SDK runs) are left out unless asked for. */
  listSessions(options: { projectId?: number | null; limit?: number; offset?: number; favoritesOnly?: boolean; includeEmpty?: boolean } = {}): SessionSummary[] {
    const rows = this.db
      .prepare(`SELECT s.*, a.status AS main_status, a.file_mtime AS main_mtime,
                  (SELECT COUNT(*) FROM agent x WHERE x.session_id = s.id) AS agent_count,
                  (SELECT COUNT(*) FROM agent x WHERE x.session_id = s.id AND x.status = 'running' AND x.file_mtime > ?) AS running,
                  COALESCE(sm.favorite, 0) AS favorite, sm.title AS user_title
                FROM session s
                LEFT JOIN agent a ON a.session_id = s.id AND a.id = 'main'
                LEFT JOIN session_meta sm ON sm.session_id = s.id
                WHERE (? IS NULL OR s.project_id = ?) AND (? = 0 OR sm.favorite = 1) AND (? = 1 OR s.has_prompt = 1) AND COALESCE(sm.hidden, 0) = 0
                ORDER BY s.last_ts DESC LIMIT ? OFFSET ?`)
      .all(this.now() - RECENT_MS, options.projectId ?? null, options.projectId ?? null, options.favoritesOnly ? 1 : 0, options.includeEmpty ? 1 : 0, options.limit ?? 500, options.offset ?? 0) as Row[];
    return rows.map((r) => this.toSession(r));
  }

  getSession(id: string): SessionSummary | null {
    const r = this.db
      .prepare(`SELECT s.*, a.status AS main_status, a.file_mtime AS main_mtime,
                  (SELECT COUNT(*) FROM agent x WHERE x.session_id = s.id) AS agent_count,
                  (SELECT COUNT(*) FROM agent x WHERE x.session_id = s.id AND x.status = 'running' AND x.file_mtime > ?) AS running,
                  COALESCE(sm.favorite, 0) AS favorite, sm.title AS user_title
                FROM session s LEFT JOIN agent a ON a.session_id = s.id AND a.id = 'main'
                LEFT JOIN session_meta sm ON sm.session_id = s.id WHERE s.id = ?`)
      .get(this.now() - RECENT_MS, id) as Row | undefined;
    return r ? this.toSession(r) : null;
  }

  private toSession(r: Row): SessionSummary {
    return {
      id: r.id,
      source: r.source,
      projectId: r.project_id,
      title: r.user_title || r.title,
      firstTs: r.first_ts ?? null,
      lastTs: r.last_ts ?? null,
      messageCount: r.message_count,
      models: JSON.parse(r.models ?? '[]'),
      gitBranch: r.git_branch ?? null,
      cliVersion: r.cli_version ?? null,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      contextTokens: r.context_tokens ?? 0,
      contextWindow: r.context_window ?? null,
      editedFiles: JSON.parse(r.edited_files ?? '[]'),
      costUsd: r.cost_usd ?? null,
      agentCount: r.agent_count ?? 1,
      runningAgents: r.running ?? 0,
      status: this.effectiveStatus((r.main_status ?? 'idle') as AgentStatus, r.main_mtime ?? 0, true),
      archived: r.archived >= 1,
      preserved: r.archived === 2,
      favorite: r.favorite === 1,
    };
  }

  getAgentTree(sessionId: string): AgentNode | null {
    const rows = this.db.prepare('SELECT * FROM agent WHERE session_id = ? ORDER BY started_ts').all(sessionId) as Row[];
    const nodes = new Map<string, AgentNode>();
    for (const r of rows) {
      nodes.set(r.id, {
        id: r.id,
        sessionId,
        parentId: r.parent_id ?? null,
        toolUseId: r.tool_use_id ?? null,
        type: r.type,
        description: r.description,
        depth: r.depth,
        model: r.model ?? null,
        isFork: r.is_fork === 1,
        worktreePath: r.worktree_path ?? null,
        worktreeBranch: r.worktree_branch ?? null,
        status: this.effectiveStatus(r.status, r.file_mtime, r.id === 'main'),
        startedTs: r.started_ts ?? null,
        endedTs: r.ended_ts ?? null,
        toolCalls: r.tool_calls,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costUsd: r.cost_usd ?? null,
        children: [],
      });
    }
    const root = nodes.get('main') ?? null;
    for (const node of nodes.values()) {
      if (node.id === 'main') continue;
      (nodes.get(node.parentId ?? 'main') ?? root)?.children.push(node);
    }
    return root;
  }

  private whole = new Map<string, { mtime: number; entries: TranscriptEntry[] }>();

  /** Gemini and Grok files are parsed as a whole (Gemini rewrites messages in place). */
  private wholeEntries(path: string, source: string): TranscriptEntry[] {
    const mtime = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    const hit = this.whole.get(path);
    if (hit && hit.mtime === mtime) return hit.entries;
    const entries = (source === 'gemini' ? parseGeminiFile(path) : parseGrokFile(path)).entries;
    if (this.whole.size > 20) this.whole.clear();
    this.whole.set(path, { mtime, entries });
    return entries;
  }

  /** One page of an agent's transcript; a negative `offset` means the last `limit` entries. */
  /** The n-th picture of one transcript record, read from the file on demand. */
  image(sessionId: string, agentId: string, byteOffset: number, n: number): { mediaType: string; data: string } | null {
    const row = this.db
      .prepare('SELECT m.byte_offset, m.byte_length, a.file_path FROM message m JOIN agent a ON a.session_id = m.session_id AND a.id = m.agent_id WHERE m.session_id = ? AND m.agent_id = ? AND m.byte_offset = ?')
      .get(sessionId, agentId, byteOffset) as Row | undefined;
    if (!row || row.byte_length > 40 * 1024 * 1024) return null;
    let fd: number | null = null;
    try {
      fd = openSync(row.file_path, 'r');
      const record = JSON.parse(readSlice(fd, row.byte_offset, row.byte_length)) as Row;
      const content = record.message?.content;
      const images = (Array.isArray(content) ? content : []).filter((b: Row) => b?.type === 'image' && b.source?.type === 'base64');
      const img = images[n];
      const mediaType = String(img?.source?.media_type ?? '');
      const data = typeof img?.source?.data === 'string' ? img.source.data : '';
      return /^image\/(png|jpeg|gif|webp)$/.test(mediaType) && data ? { mediaType, data } : null;
    } catch {
      return null;
    } finally {
      if (fd != null) closeSync(fd);
    }
  }

  getTranscript(sessionId: string, agentId: string, offset = 0, limit = 300): TranscriptPage {
    const agent = this.db.prepare('SELECT file_path FROM agent WHERE session_id = ? AND id = ?').get(sessionId, agentId) as Row | undefined;
    const session = this.db.prepare('SELECT source FROM session WHERE id = ?').get(sessionId) as Row | undefined;
    if (!agent || !session) return { entries: [], total: 0, offset: 0, nextOffset: null };
    if (session.source === 'gemini' || session.source === 'grok') {
      let all: TranscriptEntry[] = [];
      try {
        all = this.wholeEntries(agent.file_path, session.source);
      } catch {
        return { entries: [], total: 0, offset: 0, nextOffset: null };
      }
      const start = offset < 0 ? Math.max(0, all.length - limit) : offset;
      const page = all.slice(start, start + limit);
      const next = start + page.length;
      return { entries: page, total: all.length, offset: start, nextOffset: next < all.length ? next : null };
    }
    const { n: total } = this.db.prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ? AND agent_id = ?').get(sessionId, agentId) as Row;
    if (offset < 0) offset = Math.max(0, total - limit);
    const rows = this.db
      .prepare('SELECT key, role, byte_offset, byte_length FROM message WHERE session_id = ? AND agent_id = ? ORDER BY byte_offset LIMIT ? OFFSET ?')
      .all(sessionId, agentId, limit, offset) as Row[];
    const spawnMap = new Map<string, string>();
    for (const r of this.db.prepare('SELECT tool_use_id, id FROM agent WHERE session_id = ? AND tool_use_id IS NOT NULL').all(sessionId) as Row[]) {
      spawnMap.set(r.tool_use_id, r.id);
    }
    const entries: TranscriptEntry[] = [];
    let fd: number | null = null;
    try {
      fd = openSync(agent.file_path, 'r');
      for (const r of rows) {
        let record: Row;
        try {
          record = JSON.parse(readSlice(fd, r.byte_offset, r.byte_length));
        } catch {
          continue; // the file changed since it was indexed; the watcher will catch up
        }
        const entry = session.source === 'codex' ? codexEntry(record, r.role as RowRole, r.key) : claudeEntry(record, r.role as RowRole, r.key, spawnMap);
        if (entry) {
          let n = 0;
          for (const b of entry.blocks) if (b.kind === 'image') b.ref = { agentId, offset: r.byte_offset, n: n++ };
          entries.push(entry);
        }
      }
    } catch {
      return { entries: [], total, offset, nextOffset: null };
    } finally {
      if (fd != null) closeSync(fd);
    }
    const next = offset + rows.length;
    return { entries: mergeEntries(entries), total, offset, nextOffset: next < total ? next : null };
  }

  search(query: string, options: { projectId?: number | null; limit?: number } = {}): SearchHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const rows = this.db
      .prepare(`SELECT m.session_id, m.agent_id, m.ts, COALESCE(sm.title, s.title) AS title, s.project_id, s.source, p.name AS project_name,
                  snippet(message_fts, 0, ?, ?, '…', 14) AS snip
                FROM message_fts
                JOIN message m ON m.id = message_fts.rowid
                JOIN session s ON s.id = m.session_id
                JOIN project p ON p.id = s.project_id
                LEFT JOIN session_meta sm ON sm.session_id = s.id
                WHERE message_fts MATCH ? AND (? IS NULL OR s.project_id = ?) AND COALESCE(sm.hidden, 0) = 0
                ORDER BY rank LIMIT 400`)
      .all(SNIPPET_START, SNIPPET_END, fts, options.projectId ?? null, options.projectId ?? null) as Row[];
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const r of rows) {
      if (seen.has(r.session_id)) continue;
      seen.add(r.session_id);
      hits.push({
        sessionId: r.session_id,
        agentId: r.agent_id,
        projectId: r.project_id,
        projectName: r.project_name,
        title: r.title,
        snippet: r.snip,
        ts: r.ts ?? null,
        source: r.source,
      });
      if (hits.length >= (options.limit ?? 40)) break;
    }
    return hits;
  }

  setFavorite(sessionId: string, favorite: boolean): void {
    this.db
      .prepare('INSERT INTO session_meta(session_id, favorite) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET favorite = excluded.favorite')
      .run(sessionId, favorite ? 1 : 0);
  }

  /** Hides a conversation from lists and search (the CLI's files are untouched). */
  setHidden(sessionId: string, hidden: boolean): void {
    this.db
      .prepare('INSERT INTO session_meta(session_id, hidden) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET hidden = excluded.hidden')
      .run(sessionId, hidden ? 1 : 0);
  }

  /** A title of your own for a conversation; empty goes back to the CLI's title. */
  /** A folder the user opened or created in the app: a project from now on, even before any conversation. */
  addProject(cwd: string, name: string, now = this.now()): number {
    const row = this.db
      .prepare('INSERT INTO project(cwd, name, added_at) VALUES (?, ?, ?) ON CONFLICT(cwd) DO UPDATE SET added_at = COALESCE(project.added_at, excluded.added_at) RETURNING id')
      .get(cwd, name, now) as { id: number };
    return row.id;
  }

  setTitle(sessionId: string, title: string | null): void {
    this.db
      .prepare('INSERT INTO session_meta(session_id, title) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET title = excluded.title')
      .run(sessionId, title?.trim() ? title.trim().slice(0, 200) : null);
  }

  /** Conversations you hid, newest first, to bring back. */
  hiddenSessions(limit = 200): SessionSummary[] {
    const ids = (this.db.prepare('SELECT session_id FROM session_meta WHERE hidden = 1').all() as Row[]).map((r) => r.session_id as string);
    return ids
      .map((id) => this.getSession(id))
      .filter((s): s is SessionSummary => !!s)
      .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
      .slice(0, limit);
  }

  /** The file a conversation lives in (for revealing it or moving it to the Trash). */
  sessionFile(sessionId: string): string | null {
    return ((this.db.prepare('SELECT file_path FROM session WHERE id = ?').get(sessionId) as Row | undefined)?.file_path as string | undefined) ?? null;
  }

  stats(): { projects: number; sessions: number; agents: number; messages: number } {
    const count = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n as number;
    return { projects: count('project'), sessions: count('session'), agents: count('agent'), messages: count('message') };
  }

  close(): void {
    this.db.close();
  }
}
