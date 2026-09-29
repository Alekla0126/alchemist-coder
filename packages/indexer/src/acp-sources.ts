import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TranscriptBlock, TranscriptEntry } from '@alchemist-coder/core';
import { acpDiffs } from './edits.ts';
import { newSummary, summarizeToolInput, titleFrom, touchTs, tsOf, type FileSummary, type RowRole } from './summary.ts';

type Json = Record<string, any>;

/** A whole conversation parsed at once: sources whose files are rewritten rather than appended. */
export interface WholeFile {
  summary: FileSummary;
  entries: TranscriptEntry[];
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  if (content && typeof (content as Json).text === 'string') return (content as Json).text;
  return '';
};

const preview = (v: unknown, max = 2000): string => {
  const s = typeof v === 'string' ? v : v == null ? '' : textOf(v) || JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Rows for the database (search + counts) from finished entries; `offset` is the entry's position. */
function finish(summary: FileSummary, entries: TranscriptEntry[]): WholeFile {
  summary.rows = entries.map((e, i) => ({
    key: e.key,
    role: e.role as RowRole,
    ts: e.ts,
    offset: i,
    length: 0,
    text: e.blocks
      .map((b) => (b.kind === 'text' || b.kind === 'notice' ? b.text : b.kind === 'tool_use' ? `${b.name} ${b.summary}` : ''))
      .filter(Boolean)
      .join('\n')
      .slice(0, 20_000),
  }));
  for (const e of entries) touchTs(summary, e.ts);
  return { summary, entries };
}

// ---------- Gemini CLI ----------

/** The project folder Gemini recorded next to its chats (`.project_root`). */
export function geminiProjectRoot(chatFile: string): string | null {
  const file = join(dirname(dirname(chatFile)), '.project_root');
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * `~/.gemini/tmp/<project>/chats/session-*.jsonl`: a metadata line, then message records (a repeated
 * id replaces the earlier one), `$set` records that may replace every message, and `$rewindTo`.
 */
export function parseGeminiFile(path: string): WholeFile {
  const summary = newSummary();
  summary.cwd = existsSync(path) ? geminiProjectRoot(path) : null;
  const messages = new Map<string, Json>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d: Json;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof d.$rewindTo === 'string') {
      let found = false;
      for (const id of [...messages.keys()]) {
        if (id === d.$rewindTo) found = true;
        if (found) messages.delete(id);
      }
      if (!found) messages.clear();
    } else if (typeof d.id === 'string') {
      messages.set(d.id, d);
    } else if (d.$set && typeof d.$set === 'object') {
      if (Array.isArray(d.$set.messages)) {
        messages.clear();
        for (const m of d.$set.messages) if (typeof m?.id === 'string') messages.set(m.id, m);
      }
    } else if (typeof d.sessionId === 'string') {
      summary.sessionId = d.sessionId;
      touchTs(summary, tsOf(d.startTime));
    }
  }

  const entries: TranscriptEntry[] = [];
  for (const m of messages.values()) {
    const ts = tsOf(m.timestamp);
    const text = textOf(m.content).trim();
    if (m.type === 'user') {
      if (!text) continue;
      summary.userTurns++;
      summary.firstPrompt ??= titleFrom(text);
      entries.push({ key: `gm-${m.id}`, ts, role: 'user', model: null, blocks: [{ kind: 'text', text }] });
    } else if (m.type === 'gemini') {
      const blocks: TranscriptBlock[] = [];
      for (const t of Array.isArray(m.thoughts) ? m.thoughts : []) {
        const thought = [t?.subject, t?.description].filter(Boolean).join(': ');
        if (thought) blocks.push({ kind: 'thinking', text: thought });
      }
      if (text) blocks.push({ kind: 'text', text });
      for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        const id = String(c?.id ?? `${m.id}-${blocks.length}`);
        blocks.push({ kind: 'tool_use', id, name: String(c?.name ?? c?.displayName ?? 'tool'), summary: String(c?.description ?? summarizeToolInput(c?.args) ?? ''), input: JSON.stringify(c?.args ?? {}, null, 2), spawnsAgentId: null });
        const result = c?.resultDisplay ?? c?.result;
        if (result != null) blocks.push({ kind: 'tool_result', toolUseId: id, isError: c?.status === 'error', preview: preview(result) });
        summary.toolCalls++;
      }
      if (!blocks.length) continue;
      summary.assistantMessages++;
      if (typeof m.model === 'string' && !summary.models.includes(m.model)) summary.models.push(m.model);
      if (text) summary.firstReply ??= titleFrom(text);
      const tk = m.tokens ?? {};
      summary.usage.input += Number(tk.input) || 0;
      summary.usage.output += Number(tk.output) || 0;
      summary.usage.cacheRead += Number(tk.cached) || 0;
      entries.push({ key: `gm-${m.id}`, ts, role: 'assistant', model: typeof m.model === 'string' ? m.model : null, blocks });
    } else if (text && ['info', 'warning', 'error'].includes(m.type)) {
      entries.push({ key: `gm-${m.id}`, ts, role: 'notice', model: null, blocks: [{ kind: 'notice', text }] });
    }
  }
  const last = [...messages.values()].at(-1);
  summary.finished = last?.type === 'gemini' && !(last.toolCalls ?? []).some((c: Json) => c?.status === 'executing' || c?.status === 'scheduled');
  return finish(summary, entries);
}

// ---------- Grok Build ----------

/** Grok writes `summary.json` next to `updates.jsonl`: id, cwd, title, model, timestamps. */
export function grokSessionInfo(updatesFile: string): Json | null {
  try {
    return JSON.parse(readFileSync(join(dirname(updatesFile), 'summary.json'), 'utf8')) as Json;
  } catch {
    return null;
  }
}

/** The ACP `session/update` payload inside one line, whatever envelope Grok puts around it. */
function acpUpdate(d: Json): Json | null {
  for (const c of [d, d.update, d.params?.update, d.notification?.update, d.params, d.event]) {
    if (c && typeof c === 'object' && typeof c.sessionUpdate === 'string') return c;
  }
  return null;
}

/**
 * `~/.grok/sessions/<cwd>/<id>/updates.jsonl`: one ACP session update per line (Grok's documented
 * format). Streamed chunks are joined back into messages.
 */
export function parseGrokFile(path: string): WholeFile {
  const summary = newSummary();
  const info = grokSessionInfo(path);
  summary.sessionId = typeof info?.info?.id === 'string' ? info.info.id : null;
  summary.cwd = typeof info?.info?.cwd === 'string' ? info.info.cwd : null;
  summary.aiTitle = typeof info?.generated_title === 'string' && info.generated_title ? info.generated_title : typeof info?.session_summary === 'string' && info.session_summary ? titleFrom(info.session_summary) : null;
  if (typeof info?.current_model_id === 'string') summary.models.push(info.current_model_id);
  touchTs(summary, tsOf(info?.created_at));
  touchTs(summary, tsOf(info?.updated_at));

  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, { entry: TranscriptEntry; name: string }>();
  let current: TranscriptEntry | null = null;
  let currentKey = '';
  let n = 0;
  const open = (role: TranscriptEntry['role'], key: string, ts: number | null) => {
    if (current && currentKey === key) return current;
    current = { key: `gk-${n++}`, ts, role, model: role === 'assistant' ? (summary.models.at(-1) ?? null) : null, blocks: [] };
    currentKey = key;
    entries.push(current);
    return current;
  };
  const appendText = (e: TranscriptEntry, kind: 'text' | 'thinking', text: string) => {
    const last = e.blocks.at(-1);
    if (last && last.kind === kind) last.text += text;
    else e.blocks.push({ kind, text });
  };

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d: Json;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const u = acpUpdate(d);
    if (!u) continue;
    const ts = tsOf(d.timestamp ?? d.ts ?? d.time ?? d.created_at ?? u._meta?.timestamp);
    const msgId = typeof u.messageId === 'string' ? u.messageId : '';
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        const e = open('user', `user:${msgId}`, ts);
        appendText(e, 'text', textOf(u.content));
        break;
      }
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const e = open('assistant', `assistant:${msgId}`, ts);
        appendText(e, u.sessionUpdate === 'agent_thought_chunk' ? 'thinking' : 'text', textOf(u.content));
        break;
      }
      case 'tool_call': {
        const e = open('assistant', `assistant:${msgId}`, ts);
        const id = String(u.toolCallId ?? `t${n}`);
        const name = String(u.name ?? u.kind ?? 'tool');
        e.blocks.push({ kind: 'tool_use', id, name, summary: String(u.title ?? ''), input: JSON.stringify(u.rawInput ?? {}, null, 2), spawnsAgentId: null, edits: acpDiffs(u.content) });
        tools.set(id, { entry: e, name });
        summary.toolCalls++;
        break;
      }
      case 'tool_call_update': {
        const t = tools.get(String(u.toolCallId));
        if (!t) break;
        // The diff often only comes with an update.
        const diffs = acpDiffs(u.content);
        const use = diffs && t.entry.blocks.find((b) => b.kind === 'tool_use' && b.id === String(u.toolCallId));
        if (use && use.kind === 'tool_use' && !use.edits) use.edits = diffs;
        if (u.status !== 'completed' && u.status !== 'failed') break;
        const out = (Array.isArray(u.content) ? u.content : [])
          .map((c: Json) => (c?.type === 'content' ? textOf(c.content) : c?.type === 'diff' ? `${c.path}: edited` : ''))
          .filter(Boolean)
          .join('\n');
        t.entry.blocks.push({ kind: 'tool_result', toolUseId: String(u.toolCallId), isError: u.status === 'failed', preview: preview(out || u.rawOutput) });
        break;
      }
      default:
        break;
    }
  }
  const clean = entries.filter((e) => e.blocks.some((b) => b.kind !== 'text' || b.text.trim()));
  for (const e of clean) {
    for (const b of e.blocks) if (b.kind === 'text') b.text = b.text.trim();
    const text = e.blocks.find((b) => b.kind === 'text')?.text ?? '';
    if (e.role === 'user') {
      summary.userTurns++;
      if (text) summary.firstPrompt ??= titleFrom(text);
    } else if (e.role === 'assistant') {
      summary.assistantMessages++;
      if (text) summary.firstReply ??= titleFrom(text);
    }
  }
  summary.finished = clean.at(-1)?.role === 'assistant';
  return finish(summary, clean);
}
