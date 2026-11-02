import { emptyUsage, maxUsage, type TokenUsage } from '@alchemist-coder/core';
import { forEachLine } from './lines.ts';
import { addUsage, newSummary, num, summarizeToolInput, titleFrom, touchTs, tsOf, type FileSummary } from './summary.ts';
import { editsOf } from './edits.ts';

const SPAWN_TOOLS = new Set(['Agent', 'Task']);
// Finished background tasks are reported in user, queue-operation or attachment records.
const NOTIFICATIONS = /<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([^<]+)<\/status>/g;
const MAX_TEXT = 20_000;

/* Records are untyped JSON written by different Claude Code versions. */
type Json = Record<string, any>;

function usageOf(u: Json | undefined): TokenUsage {
  const r = emptyUsage();
  if (!u) return r;
  r.input = num(u.input_tokens);
  r.output = num(u.output_tokens);
  r.cacheRead = num(u.cache_read_input_tokens);
  const breakdown = u.cache_creation;
  if (breakdown && typeof breakdown === 'object') {
    r.cacheWrite5m = num(breakdown.ephemeral_5m_input_tokens);
    r.cacheWrite1h = num(breakdown.ephemeral_1h_input_tokens);
  }
  const written = num(u.cache_creation_input_tokens);
  const accounted = r.cacheWrite5m + r.cacheWrite1h;
  if (written > accounted) r.cacheWrite5m += written - accounted;
  return r;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** What has been read of a Claude transcript, so the next read starts where this one stopped. */
export interface ClaudeProgress {
  /** Totals so far; `rows` holds only the rows of the last read. */
  summary: FileSummary;
  /** Byte where the next read starts: after the last whole line. */
  resumeAt: number;
  models: Set<string>;
  /** The latest replies by message id: records still to come can raise their counts. */
  replies: Map<string, { model: string | null; usage: TokenUsage }>;
  /** What's already final: replies with no id and older replies. */
  counted: Pick<FileSummary, 'usage' | 'costUsd'>;
}

/** Replies kept open for more records (one reply's records are written one after another). */
const OPEN_REPLIES = 16;

/** Parses one Claude Code transcript: a main session file or a subagent file. */
export function parseClaudeFile(path: string): FileSummary {
  return readClaudeFile(path).summary;
}

/**
 * Reads a Claude Code transcript from where `progress` stopped, or from the start without it. Transcripts
 * only grow while an agent works, so a live one is read a few lines at a time instead of whole.
 */
export function readClaudeFile(path: string, progress?: ClaudeProgress): ClaudeProgress {
  const p = progress ?? { summary: newSummary(), resumeAt: 0, models: new Set<string>(), replies: new Map(), counted: { usage: emptyUsage(), costUsd: null } };
  const s = p.summary;
  const { models, replies } = p;
  s.rows = [];

  forEachLine(path, (line, offset, length, complete) => {
    let d: Json;
    try {
      d = JSON.parse(line);
    } catch {
      // A last line still being written is read again next time.
      if (complete) p.resumeAt = offset + length + 1;
      return;
    }
    p.resumeAt = complete ? offset + length + 1 : offset + length;
    const ts = tsOf(d.timestamp);
    touchTs(s, ts);
    if (typeof d.sessionId === 'string') s.sessionId ??= d.sessionId;
    if (typeof d.cwd === 'string') s.cwd ??= d.cwd;
    if (typeof d.gitBranch === 'string' && d.gitBranch) s.gitBranch = d.gitBranch;
    if (typeof d.version === 'string') s.cliVersion = d.version;
    const key = typeof d.uuid === 'string' ? d.uuid : String(offset);
    if (d.type !== 'assistant' && line.includes('<task-notification>')) {
      for (const m of line.matchAll(NOTIFICATIONS)) {
        s.notifications[m[1]!.trim()] = m[2]!.trim();
        if (ts != null) s.notifiedAt[m[1]!.trim()] = Math.max(s.notifiedAt[m[1]!.trim()] ?? 0, ts);
      }
    }

    switch (d.type) {
      case 'custom-title':
        if (d.customTitle) s.customTitle = String(d.customTitle);
        return;
      case 'ai-title':
        if (d.aiTitle) s.aiTitle = String(d.aiTitle);
        return;
      case 'summary':
        if (d.summary && !s.aiTitle) s.aiTitle = String(d.summary);
        return;
      case 'cost-state': {
        // Written once per CLI run: its model ids keep the long-context mark («claude-opus-5-5[1m]») that replies drop.
        const ids = Object.keys(d.modelUsage ?? {});
        if (ids.length) s.contextWindow = ids.some((id) => id.endsWith('[1m]')) ? 1_000_000 : null;
        return;
      }
      case 'user': {
        const content = d.message?.content;
        if (d.isMeta) {
          s.rows.push({ key, role: 'meta', ts, offset, length, text: '' });
          return;
        }
        const plain = textOf(content);
        if (d.origin?.kind === 'task-notification' || plain.trimStart().startsWith('<task-notification>')) {
          s.rows.push({ key, role: 'notice', ts, offset, length, text: '' });
          return;
        }
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
            const r = d.toolUseResult && typeof d.toolUseResult === 'object' ? (d.toolUseResult as Json) : null;
            s.results[b.tool_use_id] = {
              isError: b.is_error === true,
              isAsync: r?.isAsync === true,
              status: typeof r?.status === 'string' ? r.status : null,
              ts,
            };
          }
        }
        const isPrompt = plain.length > 0 && !plain.startsWith('<') && !plain.startsWith('Caveat:');
        if (isPrompt) {
          s.userTurns++;
          s.firstPrompt ??= titleFrom(plain);
        }
        s.rows.push({ key, role: 'user', ts, offset, length, text: isPrompt ? plain.slice(0, MAX_TEXT) : '' });
        return;
      }
      case 'assistant': {
        const msg: Json = d.message ?? {};
        const model = typeof msg.model === 'string' && msg.model !== '<synthetic>' ? msg.model : null;
        if (model) models.add(model);
        const messageId = typeof msg.id === 'string' ? msg.id : null;
        const u = usageOf(msg.usage);
        const known = messageId ? replies.get(messageId) : undefined;
        if (known) {
          maxUsage(known.usage, u);
          known.model ??= model;
        } else {
          s.assistantMessages++;
          if (messageId) replies.set(messageId, { model, usage: u });
          else addUsage(p.counted, model, u);
        }
        const current = known?.usage ?? u;
        const read = current.input + current.cacheRead + current.cacheWrite5m + current.cacheWrite1h;
        if (read > 0) s.contextTokens = read;
        if (typeof msg.stop_reason === 'string') s.lastStopReason = msg.stop_reason;
        let text = '';
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b?.type === 'text' && typeof b.text === 'string') text += `${b.text}\n`;
          else if (b?.type === 'tool_use') {
            s.toolCalls++;
            for (const d of editsOf(String(b.name ?? ''), b.input) ?? []) if (s.editedFiles.size < 500) s.editedFiles.add(d.path);
            const summary = summarizeToolInput(b.input);
            text += `[${b.name}${summary ? ` ${summary}` : ''}]\n`;
            if (SPAWN_TOOLS.has(b.name) && typeof b.id === 'string') {
              s.spawns[b.id] = {
                type: String(b.input?.subagent_type ?? 'general-purpose'),
                description: String(b.input?.description ?? ''),
              };
            }
          }
        }
        const trimmed = text.trim();
        if (trimmed && !trimmed.startsWith('[')) s.firstReply ??= titleFrom(trimmed);
        s.rows.push({ key: messageId ?? key, role: 'assistant', ts, offset, length, text: trimmed.slice(0, MAX_TEXT) });
        return;
      }
      case 'attachment':
        if (d.attachment?.type === 'queued_command' && line.includes('<task-notification>')) s.rows.push({ key, role: 'notice', ts, offset, length, text: '' });
        return;
      default:
        return;
    }
  }, p.resumeAt);

  // Older replies are final: they join what's counted, and only the latest stay open.
  for (const [id, r] of replies) {
    if (replies.size <= OPEN_REPLIES) break;
    addUsage(p.counted, r.model, r.usage);
    replies.delete(id);
  }
  s.usage = { ...p.counted.usage };
  s.costUsd = p.counted.costUsd;
  for (const r of replies.values()) addUsage(s, r.model, r.usage);
  s.models = [...models];
  return p;
}

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  parentAgentId?: string;
  spawnDepth?: number;
  worktreePath?: string;
  worktreeBranch?: string;
  model?: string;
  isFork?: boolean;
}
