import { basename } from 'node:path';
import { forEachLine } from './lines.ts';
import { addUsage, newSummary, num, summarizeToolInput, titleFrom, touchTs, tsOf, type FileSummary } from './summary.ts';
import { editsOf } from './edits.ts';
import { emptyUsage } from '@alchemist-coder/core';

type Json = Record<string, any>;

const TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call']);
const TOOL_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);
const ITEM_TYPES = new Set(['message', 'reasoning', ...TOOL_CALLS, ...TOOL_OUTPUTS]);
const MAX_TEXT = 20_000;

function itemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

/** Codex injects environment and instruction blocks as user messages. */
export function isCodexContextMessage(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<') || t.startsWith('# AGENTS.md') || t.startsWith('# Context from my IDE');
}

export function eventUserText(p: Json): string {
  if (p.type === 'user_message' && typeof p.message === 'string') return p.message;
  if (p.type === 'item_completed' && p.item?.type === 'UserMessage') return itemText(p.item.content);
  return '';
}

function toolArgs(item: Json): unknown {
  if (typeof item.arguments === 'string') {
    try {
      return JSON.parse(item.arguments);
    } catch {
      return item.arguments;
    }
  }
  return item.input ?? item.action ?? item.arguments;
}

export function parseCodexFile(path: string): FileSummary {
  const s = newSummary();
  let model: string | null = null;
  let totals: Json | null = null;
  const perResponse = emptyUsage();
  let sawPerResponse = false;
  let lastEvent = '';
  // Newer rollouts record the user's turn as an event instead of a response item.
  const eventPrompts: Array<{ text: string; ts: number | null; offset: number; length: number }> = [];

  const handleItem = (item: Json, ts: number | null, offset: number, length: number) => {
    const key = String(offset);
    if (item.type === 'message') {
      const text = itemText(item.content);
      if (item.role === 'user') {
        if (!text || isCodexContextMessage(text)) {
          s.rows.push({ key, role: 'meta', ts, offset, length, text: '' });
          return;
        }
        s.userTurns++;
        s.firstPrompt ??= titleFrom(text);
        s.rows.push({ key, role: 'user', ts, offset, length, text: text.slice(0, MAX_TEXT) });
      } else if (item.role === 'assistant') {
        s.assistantMessages++;
        if (text) s.firstReply ??= titleFrom(text);
        s.rows.push({ key, role: 'assistant', ts, offset, length, text: text.slice(0, MAX_TEXT) });
      }
      return;
    }
    if (TOOL_CALLS.has(item.type)) {
      s.toolCalls++;
      const name = String(item.name ?? item.type);
      if (name === 'apply_patch') for (const d of editsOf(name, toolArgs(item)) ?? []) if (s.editedFiles.size < 500) s.editedFiles.add(d.path);
      const summary = summarizeToolInput(toolArgs(item));
      s.rows.push({ key, role: 'assistant', ts, offset, length, text: `[${name}${summary ? ` ${summary}` : ''}]` });
      return;
    }
    if (TOOL_OUTPUTS.has(item.type)) s.rows.push({ key, role: 'user', ts, offset, length, text: '' });
  };

  forEachLine(path, (line, offset, length) => {
    let d: Json;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    const ts = tsOf(d.timestamp);
    touchTs(s, ts);
    const p: Json = d.payload ?? {};
    switch (d.type) {
      case 'session_meta':
        s.sessionId ??= p.id ?? p.session_id ?? null;
        if (typeof p.cwd === 'string') s.cwd ??= p.cwd;
        if (typeof p.cli_version === 'string') s.cliVersion = p.cli_version;
        if (typeof p.model === 'string') model = p.model;
        if (typeof p.git?.branch === 'string') s.gitBranch = p.git.branch;
        return;
      case 'turn_context':
        if (typeof p.model === 'string') model = p.model;
        if (typeof p.cwd === 'string') s.cwd ??= p.cwd;
        return;
      case 'world_state':
        model ??= typeof p.state?.collaboration_mode?.model === 'string' ? p.state.collaboration_mode.model : null;
        return;
      case 'response_item':
        handleItem(p, ts, offset, length);
        return;
      case 'event_msg':
        if (p.type === 'token_count' && p.info?.total_token_usage) totals = p.info.total_token_usage;
        if (p.type === 'token_count' && p.info?.last_token_usage) s.contextTokens = num(p.info.last_token_usage.input_tokens) || s.contextTokens;
        if (p.type === 'token_count' && num(p.info?.model_context_window) > 0) s.contextWindow = num(p.info.model_context_window);
        if (p.type === 'task_started' || p.type === 'task_complete' || p.type === 'turn_aborted') lastEvent = p.type;
        {
          const text = eventUserText(p);
          if (text && !isCodexContextMessage(text)) eventPrompts.push({ text, ts, offset, length });
        }
        return;
      case 'token_usage_record':
        if (p.usage) {
          sawPerResponse = true;
          const cached = num(p.usage.cached_input_tokens);
          perResponse.input += Math.max(0, num(p.usage.input_tokens) - cached);
          perResponse.cacheRead += cached;
          perResponse.output += num(p.usage.output_tokens);
        }
        return;
      default:
        // Very old rollouts wrote items at the top level with no payload wrapper.
        if (!d.payload && ITEM_TYPES.has(d.type)) handleItem(d, ts, offset, length);
        else if (!d.type && typeof d.id === 'string' && !s.sessionId) s.sessionId = d.id;
    }
  });

  if (s.userTurns === 0 && eventPrompts.length > 0) {
    s.userTurns = eventPrompts.length;
    s.firstPrompt = titleFrom(eventPrompts[0]!.text);
    for (const e of eventPrompts) s.rows.push({ key: String(e.offset), role: 'user', ts: e.ts, offset: e.offset, length: e.length, text: e.text.slice(0, MAX_TEXT) });
    s.rows.sort((a, b) => a.offset - b.offset);
  }
  s.sessionId ??= basename(path, '.jsonl').slice(-36);
  if (model) s.models = [model];
  const t = totals as Json | null;
  if (t) {
    const cached = num(t.cached_input_tokens);
    addUsage(s, model, { input: Math.max(0, num(t.input_tokens) - cached), output: num(t.output_tokens), cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0 });
  } else if (sawPerResponse) {
    addUsage(s, model, perResponse);
  }
  s.finished = lastEvent === 'task_complete' || lastEvent === 'turn_aborted';
  return s;
}
