import type { TranscriptBlock, TranscriptEntry } from '@alchemist-coder/core';
import { eventUserText, isCodexContextMessage } from './codex.ts';
import { answersOf, askOf, editsOf } from './edits.ts';
import { summarizeToolInput, tsOf, type RowRole } from './summary.ts';

type Json = Record<string, any>;

const PREVIEW = 1_200;
const INPUT_PREVIEW = 4_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c.text === 'string' ? c.text : c?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function imageBlock(b: Json): TranscriptBlock {
  const data = typeof b.source?.data === 'string' ? b.source.data : '';
  return { kind: 'image', mediaType: String(b.source?.media_type ?? 'image'), bytes: Math.round(data.length * 0.75) };
}

function inputJson(input: unknown): string {
  try {
    return clip(typeof input === 'string' ? input : JSON.stringify(input, null, 2), INPUT_PREVIEW);
  } catch {
    return '';
  }
}

export function claudeEntry(d: Json, role: RowRole, key: string, spawnMap: ReadonlyMap<string, string>): TranscriptEntry | null {
  const ts = tsOf(d.timestamp);
  const content = d.message?.content;
  if (role === 'meta') {
    const text = contentText(content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { key, ts, role: 'meta', model: null, blocks: [{ kind: 'notice', text: clip(text, 200) }] };
  }
  if (role === 'notice') {
    const text = contentText(content) || String(d.attachment?.prompt ?? d.content ?? '');
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
    const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim();
    return { key, ts, role: 'notice', model: null, blocks: [{ kind: 'notice', text: summary ?? `Background task ${status ?? 'updated'}` }] };
  }
  const blocks: TranscriptBlock[] = [];
  if (typeof content === 'string') {
    blocks.push({ kind: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const b of content as Json[]) {
      switch (b?.type) {
        case 'text':
          if (b.text) blocks.push({ kind: 'text', text: String(b.text) });
          break;
        case 'thinking':
          if (b.thinking) blocks.push({ kind: 'thinking', text: String(b.thinking) });
          break;
        case 'tool_use':
          blocks.push({
            kind: 'tool_use',
            id: String(b.id ?? ''),
            name: String(b.name ?? 'tool'),
            summary: summarizeToolInput(b.input),
            input: inputJson(b.input),
            spawnsAgentId: spawnMap.get(String(b.id)) ?? null,
            edits: editsOf(String(b.name ?? ''), b.input),
            ask: askOf(String(b.name ?? ''), b.input),
          });
          break;
        case 'tool_result':
          blocks.push({ kind: 'tool_result', toolUseId: String(b.tool_use_id ?? ''), isError: b.is_error === true, preview: clip(contentText(b.content), PREVIEW), answers: answersOf(d.toolUseResult) });
          break;
        case 'image':
          blocks.push(imageBlock(b));
          break;
      }
    }
  }
  if (blocks.length === 0) return null;
  const model = typeof d.message?.model === 'string' && d.message.model !== '<synthetic>' ? d.message.model : null;
  return { key, ts, role: role === 'assistant' ? 'assistant' : 'user', model, blocks };
}

export function codexEntry(d: Json, role: RowRole, key: string): TranscriptEntry | null {
  const ts = tsOf(d.timestamp);
  const item: Json = d.payload ?? d;
  if (d.type === 'event_msg') {
    const text = eventUserText(item);
    return text ? { key, ts, role: 'user', model: null, blocks: [{ kind: 'text', text }] } : null;
  }
  if (item.type === 'message') {
    const text = contentText(item.content);
    if (role === 'meta' || isCodexContextMessage(text)) {
      return { key, ts, role: 'meta', model: null, blocks: [{ kind: 'notice', text: clip(text.replace(/\s+/g, ' '), 200) }] };
    }
    return { key, ts, role: item.role === 'assistant' ? 'assistant' : 'user', model: null, blocks: [{ kind: 'text', text }] };
  }
  if (typeof item.type === 'string' && item.type.endsWith('_output')) {
    const out = typeof item.output === 'string' ? item.output : contentText(item.output);
    return { key, ts, role: 'user', model: null, blocks: [{ kind: 'tool_result', toolUseId: String(item.call_id ?? ''), isError: false, preview: clip(out, PREVIEW) }] };
  }
  const raw = typeof item.arguments === 'string' ? item.arguments : (item.input ?? item.action ?? '');
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  return {
    key,
    ts,
    role: 'assistant',
    model: null,
    blocks: [
      {
        kind: 'tool_use',
        id: String(item.call_id ?? item.id ?? ''),
        name: String(item.name ?? item.type),
        summary: summarizeToolInput(parsed),
        input: inputJson(parsed),
        spawnsAgentId: null,
        edits: editsOf(String(item.name ?? ''), parsed),
      },
    ],
  };
}

/** Claude splits one response into several records; show them as a single turn. */
export function mergeEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const e of entries) {
    const prev = out.at(-1);
    // The same notification can be queued as an attachment and delivered again as a user turn.
    if (e.role === 'notice' && out.slice(-6).some((o) => o.role === 'notice' && JSON.stringify(o.blocks) === JSON.stringify(e.blocks))) continue;
    if (prev && prev.role === 'assistant' && e.role === 'assistant' && prev.key === e.key) prev.blocks.push(...e.blocks);
    else out.push({ ...e, blocks: [...e.blocks] });
  }
  return out;
}
