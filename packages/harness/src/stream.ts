import type { RunnerEvent } from '@alchemist-coder/core';

type Json = Record<string, any>;

function summarize(input: unknown): string {
  if (typeof input === 'string') return input.split('\n')[0]?.slice(0, 160) ?? '';
  if (!input || typeof input !== 'object') return '';
  const o = input as Json;
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.description ?? '';
  return (Array.isArray(pick) ? pick.join(' ') : String(pick)).split('\n')[0]?.slice(0, 160) ?? '';
}

/**
 * Parses one line of `claude -p --output-format stream-json [--include-partial-messages]`.
 * `state.streamed` avoids printing text twice when partial deltas were already sent.
 */
export function parseClaudeLine(line: string, state: { streamed: boolean }): RunnerEvent[] {
  let d: Json;
  try {
    d = JSON.parse(line);
  } catch {
    return [];
  }
  switch (d.type) {
    case 'system':
      return d.subtype === 'init' ? [{ type: 'started', sessionId: d.session_id ?? null, model: d.model ?? null }] : [];
    case 'stream_event': {
      const e: Json = d.event ?? {};
      if (e.type === 'message_start') state.streamed = false;
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
        state.streamed = true;
        return [{ type: 'text', text: e.delta.text }];
      }
      return [];
    }
    case 'assistant': {
      const out: RunnerEvent[] = [];
      for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (b?.type === 'text' && typeof b.text === 'string' && !state.streamed) out.push({ type: 'text', text: b.text });
        else if (b?.type === 'tool_use') out.push({ type: 'tool', name: String(b.name), summary: summarize(b.input) });
      }
      return out;
    }
    case 'result':
      return [
        {
          type: 'result',
          ok: d.is_error !== true && (d.subtype === undefined || d.subtype === 'success'),
          sessionId: d.session_id ?? null,
          costUsd: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : null,
        },
      ];
    default:
      return [];
  }
}

/** Parses one line of `codex exec --json`. */
export function parseCodexLine(line: string): RunnerEvent[] {
  let d: Json;
  try {
    d = JSON.parse(line);
  } catch {
    return [];
  }
  switch (d.type) {
    case 'thread.started':
      return [{ type: 'started', sessionId: d.thread_id ?? null }];
    case 'item.started':
    case 'item.completed': {
      const item: Json = d.item ?? {};
      if (d.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') return [{ type: 'text', text: item.text }];
      if (d.type === 'item.started' && item.type === 'command_execution') return [{ type: 'tool', name: 'shell', summary: summarize(item.command) }];
      if (d.type === 'item.completed' && item.type === 'file_change') return [{ type: 'tool', name: 'edit', summary: (item.changes ?? []).map((c: Json) => c.path).join(', ') }];
      if (d.type === 'item.started' && item.type === 'mcp_tool_call') return [{ type: 'tool', name: `${item.server}.${item.tool}`, summary: '' }];
      return [];
    }
    case 'turn.completed':
      return [{ type: 'result', ok: true, sessionId: null, costUsd: null }];
    case 'turn.failed':
      return [{ type: 'error', message: String(d.error?.message ?? 'Turn failed') }, { type: 'result', ok: false, sessionId: null, costUsd: null }];
    case 'error':
      return [{ type: 'error', message: String(d.message ?? 'Error') }];
    default:
      return [];
  }
}
