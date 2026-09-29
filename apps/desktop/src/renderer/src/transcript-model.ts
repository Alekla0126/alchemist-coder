import type { TranscriptBlock, TranscriptEntry } from '@alchemist-coder/core';

export type ToolUse = Extract<TranscriptBlock, { kind: 'tool_use' }>;
export type ToolResult = Extract<TranscriptBlock, { kind: 'tool_result' }>;

/** What a turn shows: tool calls carry their results; runs of calls fold into a group. */
export type RenderBlock =
  | { kind: 'block'; block: TranscriptBlock }
  | { kind: 'tool'; use: ToolUse; result: ToolResult | undefined }
  | { kind: 'group'; tools: Array<{ use: ToolUse; result: ToolResult | undefined }> }
  /** The task list as it stood after a run of TaskCreate / TaskUpdate / TodoWrite calls. */
  | { kind: 'tasks'; items: TaskItem[]; ops: number }
  /** Bookkeeping calls (loading tools, a skill): one dim line. */
  | { kind: 'quiet'; use: ToolUse; result: ToolResult | undefined };

export interface TaskItem {
  id: string;
  subject: string;
  status: string;
}

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);
const QUIET_TOOLS = new Set(['ToolSearch', 'Skill']);

const inputOf = (use: ToolUse): Record<string, any> => {
  try {
    const v = JSON.parse(use.input);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

/** Applies one task call to the list (ids come from the result: "Task #3 created…"). */
export function applyTask(state: Map<string, TaskItem>, use: ToolUse, result: ToolResult | undefined): void {
  const input = inputOf(use);
  if (use.name === 'TodoWrite' && Array.isArray(input.todos)) {
    state.clear();
    input.todos.forEach((t: Record<string, unknown>, i: number) => state.set(String(i + 1), { id: String(i + 1), subject: String(t.content ?? t.subject ?? ''), status: String(t.status ?? 'pending') }));
  } else if (use.name === 'TaskCreate') {
    const id = /#(\d+)/.exec(result?.preview ?? '')?.[1] ?? `new${state.size + 1}`;
    state.set(id, { id, subject: String(input.subject ?? ''), status: 'pending' });
  } else if (use.name === 'TaskUpdate') {
    const id = String(input.taskId ?? '');
    const prev = state.get(id) ?? { id, subject: `#${id}`, status: 'pending' };
    state.set(id, { ...prev, subject: typeof input.subject === 'string' && input.subject ? input.subject : prev.subject, status: typeof input.status === 'string' ? input.status : prev.status });
  }
}

export interface Turn {
  /** 'system': text the harness put in your place (task notifications, messages from other sessions). */
  role: 'user' | 'assistant' | 'notice' | 'system';
  key: string;
  ts: number | null;
  endTs: number | null;
  model: string | null;
  /** The entries it was built from (for copying, and the subagent brief). */
  entries: TranscriptEntry[];
  blocks: RenderBlock[];
}

/** Three or more calls in a row become one "Ran N tools" row. */
export const GROUP_MIN = 3;

const isPrompt = (e: TranscriptEntry) => e.role === 'user' && e.blocks.some((b) => b.kind !== 'tool_result');

/** Claude Code's note when you stop a turn. */
/** Stands for "you stopped the agent here" (the view says it in the app's language). */
export const INTERRUPTED_NOTICE = '\u0000interrupted';
export const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

const INJECTED = [/^\[System[:\]]/, /^<task-notification>/, /^<(agent|cross-session)-message\b/, /^Another Claude session sent a message/, /^\[SYSTEM NOTIFICATION/, /^<system-reminder>/];

/** A "prompt" that the harness wrote, not you. */
export function isInjected(e: TranscriptEntry): boolean {
  if (e.role !== 'user') return false;
  const text = e.blocks
    .filter((b): b is Extract<TranscriptBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('\n')
    .trimStart();
  return !!text && INJECTED.some((re) => re.test(text));
}

/**
 * Turns out of transcript entries: each prompt is a turn, and everything the assistant did until
 * the next prompt (its messages, tool calls and their results) is one assistant turn. Results are
 * matched to their calls by id; results whose call isn't loaded show on their own.
 */
export function buildTurns(entries: TranscriptEntry[]): Turn[] {
  const results = new Map<string, ToolResult>();
  const calls = new Set<string>();
  for (const e of entries)
    for (const b of e.blocks) {
      if (b.kind === 'tool_result') results.set(b.toolUseId, b);
      if (b.kind === 'tool_use') calls.add(b.id);
    }
  const turns: Turn[] = [];
  let current: Turn | null = null;
  const tasks = new Map<string, TaskItem>();
  for (const [i, e] of entries.entries()) {
    if (e.role === 'meta' || e.role === 'notice') {
      turns.push({ role: 'notice', key: `${e.key}-${i}`, ts: e.ts, endTs: e.ts, model: null, entries: [e], blocks: e.blocks.map((block) => ({ kind: 'block' as const, block })) });
      current = null;
      continue;
    }
    if (e.role === 'user' && e.blocks.length === 1 && e.blocks[0]!.kind === 'text' && INTERRUPTED.test(e.blocks[0]!.text.trim())) {
      turns.push({ role: 'notice', key: `${e.key}-${i}`, ts: e.ts, endTs: e.ts, model: null, entries: [e], blocks: [{ kind: 'block', block: { kind: 'notice', text: INTERRUPTED_NOTICE } }] });
      current = null;
      continue;
    }
    if (isInjected(e)) {
      turns.push({ role: 'system', key: `${e.key}-${i}`, ts: e.ts, endTs: e.ts, model: null, entries: [e], blocks: e.blocks.map((block) => ({ kind: 'block' as const, block })) });
      current = null;
      continue;
    }
    if (isPrompt(e)) {
      turns.push({ role: 'user', key: `${e.key}-${i}`, ts: e.ts, endTs: e.ts, model: null, entries: [e], blocks: e.blocks.map((block) => ({ kind: 'block' as const, block })) });
      current = null;
      continue;
    }
    if (!current) {
      current = { role: 'assistant', key: `${e.key}-${i}`, ts: e.ts, endTs: e.ts, model: e.model ?? null, entries: [], blocks: [] };
      turns.push(current);
    }
    current.entries.push(e);
    current.endTs = e.ts ?? current.endTs;
    current.model ??= e.model ?? null;
    for (const b of e.blocks) {
      if (b.kind === 'tool_result' && calls.has(b.toolUseId)) continue; // shown inside its call
      if (b.kind === 'tool_use' && TASK_TOOLS.has(b.name)) {
        applyTask(tasks, b, results.get(b.id));
        const items = [...tasks.values()].filter((x) => x.status !== 'deleted');
        const last = current.blocks.at(-1);
        if (last?.kind === 'tasks') {
          last.items = items;
          last.ops++;
        } else current.blocks.push({ kind: 'tasks', items, ops: 1 });
      } else if (b.kind === 'tool_use' && QUIET_TOOLS.has(b.name)) current.blocks.push({ kind: 'quiet', use: b, result: results.get(b.id) });
      else if (b.kind === 'tool_use') current.blocks.push({ kind: 'tool', use: b, result: results.get(b.id) });
      else current.blocks.push({ kind: 'block', block: b });
    }
  }
  for (const t of turns) t.blocks = groupTools(t.blocks);
  return turns;
}

/** Folds runs of GROUP_MIN+ consecutive tool calls (subagent spawns stay visible; quiet calls ride along). */
function groupTools(blocks: RenderBlock[]): RenderBlock[] {
  const out: RenderBlock[] = [];
  let run: Array<Extract<RenderBlock, { kind: 'tool' | 'quiet' }>> = [];
  const flush = () => {
    if (run.filter((b) => b.kind === 'tool').length >= GROUP_MIN) out.push({ kind: 'group', tools: run.map(({ use, result }) => ({ use, result })) });
    else out.push(...run);
    run = [];
  };
  for (const b of blocks) {
    if ((b.kind === 'tool' && !b.use.spawnsAgentId) || b.kind === 'quiet') run.push(b);
    else {
      flush();
      out.push(b);
    }
  }
  flush();
  return out;
}

/** "Bash ×2, Read, Edit ×3" */
/** "mcp__nimbalyst__update_session_meta" → "update_session_meta": the server adds nothing in a list. */
export const shortToolName = (name: string) => (name.startsWith('mcp__') ? (name.split('__').at(-1) ?? name) : name);

export function toolSummary(tools: Array<{ use: ToolUse }>): string {
  const counts = new Map<string, number>();
  for (const { use } of tools) counts.set(shortToolName(use.name), (counts.get(shortToolName(use.name)) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

/**
 * What a collapsed tool row says: a shell command's own description when it has one, else the
 * command without a leading `cd <folder> &&` (every row starting the same way tells nothing).
 */
export function displaySummary(name: string, input: string | undefined, summary: string): string {
  let o: Record<string, unknown> = {};
  try {
    const v = JSON.parse(input ?? '{}');
    if (v && typeof v === 'object') o = v as Record<string, unknown>;
  } catch {
    o = {};
  }
  const shell = /^(Bash|shell|exec|PowerShell|local_shell)$/i.test(name) || typeof o.command === 'string';
  if (shell && typeof o.description === 'string' && o.description.trim()) return o.description.trim();
  return summary.replace(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/, '');
}
