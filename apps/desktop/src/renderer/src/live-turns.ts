import type { FileDiff, PermissionChoice, PromptImage, QuestionAnswer, QuestionField, RunnerEvent, ToolState } from '@alchemist-coder/core';

export interface LiveTool {
  id?: string;
  name: string;
  summary: string;
  kind?: string;
  state?: ToolState;
  diffs?: FileDiff[];
  input?: string;
  output?: string;
}

export interface LivePermission {
  requestId: string;
  title: string;
  kind: string | null;
  diffs: FileDiff[];
  choices: PermissionChoice[];
}

/** A question the agent asks you (a form). */
export interface LiveQuestion {
  requestId: string;
  message: string;
  fields: QuestionField[];
}

/** What a running agent has done in a turn, in the order it happened. */
export type LiveBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; tool: LiveTool }
  | { kind: 'permission'; request: LivePermission; resolved: boolean; choiceId: string | null }
  /** `summary` is what you answered; empty when you skipped it. */
  | { kind: 'question'; request: LiveQuestion; resolved: boolean; answered: boolean; summary: string };

export interface LiveTurn {
  prompt: string;
  /** Images sent with the prompt. */
  images?: PromptImage[];
  startedAt: number;
  endedAt: number | null;
  blocks: LiveBlock[];
}

/** Your message starts a turn (shown right away, before the agent answers). */
export function startTurn(turns: LiveTurn[], prompt: string, now = Date.now(), images: PromptImage[] = []): LiveTurn[] {
  const last = turns.at(-1);
  const extra = images.length ? { images } : {};
  // Events can beat the reply to "start": a turn opened by them just gets its prompt.
  if (last && !last.prompt && last.endedAt === null) return [...turns.slice(0, -1), { ...last, prompt, ...extra }];
  return [...turns, { prompt, startedAt: now, endedAt: null, blocks: [], ...extra }];
}

/** Folds one runner event into the live turns. Events that don't show in the chat change nothing. */
export function applyToTurns(turns: LiveTurn[], event: RunnerEvent, now = Date.now()): LiveTurn[] {
  const shown = ['text', 'thought', 'tool', 'permission', 'permissionClosed', 'question', 'questionClosed', 'result', 'status'];
  if (!shown.includes(event.type)) return turns;
  if (event.type === 'status' && (event.status === 'running' || event.status === 'waiting')) return turns;
  let list = turns;
  if (!list.length || list.at(-1)!.endedAt !== null) {
    if (event.type === 'result' || event.type === 'status' || event.type === 'permissionClosed' || event.type === 'questionClosed') return turns;
    list = [...list, { prompt: '', startedAt: now, endedAt: null, blocks: [] }];
  }
  const turn = { ...list.at(-1)!, blocks: [...list.at(-1)!.blocks] };
  const last = turn.blocks.at(-1);
  switch (event.type) {
    case 'text':
      if (last?.kind === 'text') turn.blocks[turn.blocks.length - 1] = { kind: 'text', text: last.text + event.text };
      else if (event.text.trim()) turn.blocks.push({ kind: 'text', text: event.text.replace(/^\n+/, '') });
      break;
    case 'thought':
      if (last?.kind === 'thinking') turn.blocks[turn.blocks.length - 1] = { kind: 'thinking', text: last.text + event.text };
      else turn.blocks.push({ kind: 'thinking', text: event.text });
      break;
    case 'tool': {
      const i = event.id ? turn.blocks.findIndex((b) => b.kind === 'tool' && b.tool.id === event.id) : -1;
      if (i < 0) turn.blocks.push({ kind: 'tool', tool: { id: event.id, name: event.name, summary: event.summary, kind: event.kind, state: event.state, diffs: event.diffs, input: event.input, output: event.output } });
      else {
        // Updates only carry what changed.
        const prev = (turn.blocks[i] as Extract<LiveBlock, { kind: 'tool' }>).tool;
        turn.blocks[i] = { kind: 'tool', tool: { ...prev, summary: event.summary || prev.summary, kind: event.kind ?? prev.kind, state: event.state ?? prev.state, diffs: event.diffs ?? prev.diffs, input: event.input ?? prev.input, output: event.output ?? prev.output } };
      }
      break;
    }
    case 'permission':
      turn.blocks.push({ kind: 'permission', request: { requestId: event.requestId, title: event.title, kind: event.kind, diffs: event.diffs, choices: event.choices }, resolved: false, choiceId: null });
      break;
    case 'permissionClosed':
      turn.blocks = turn.blocks.map((b) => (b.kind === 'permission' && b.request.requestId === event.requestId ? { ...b, resolved: true, choiceId: event.choiceId } : b));
      break;
    case 'question':
      turn.blocks.push({ kind: 'question', request: { requestId: event.requestId, message: event.message, fields: event.fields }, resolved: false, answered: false, summary: '' });
      break;
    case 'questionClosed':
      // Your answer (kept when you sent it) stays; a question closed any other way reads as skipped.
      turn.blocks = turn.blocks.map((b) => (b.kind === 'question' && b.request.requestId === event.requestId ? { ...b, resolved: true, answered: event.answered, summary: event.answered ? b.summary : '' } : b));
      break;
    case 'result':
    case 'status':
      turn.endedAt = now;
      break;
  }
  return [...list.slice(0, -1), turn];
}

/** Marks a question answered (or skipped) at once, keeping what you answered to show in the chat. */
export function markQuestion(turns: LiveTurn[], requestId: string, answered: boolean, summary: string): LiveTurn[] {
  return turns.map((turn) =>
    turn.blocks.some((b) => b.kind === 'question' && b.request.requestId === requestId)
      ? { ...turn, blocks: turn.blocks.map((b) => (b.kind === 'question' && b.request.requestId === requestId ? { ...b, resolved: true, answered, summary } : b)) }
      : turn,
  );
}

/**
 * What you answered, one line per question ("Color: Red — “dark”"): the picked options and your
 * own words from its "Other" box, labelled with the question so the history reads on its own.
 */
export function answerSummary(fields: QuestionField[], content: NonNullable<QuestionAnswer['content']>): string {
  const keys = new Set(fields.map((f) => f.key));
  const lines: string[] = [];
  for (const f of fields) {
    if (f.forKey && keys.has(f.forKey)) continue;
    const v = content[f.key];
    const title = (x: string) => f.options.find((o) => o.value === x)?.title ?? x;
    const parts: string[] = [];
    if (Array.isArray(v) && v.length) parts.push(v.map(title).join(', '));
    else if (typeof v === 'boolean') parts.push(v ? '✓' : '✕');
    else if (v != null && v !== '') parts.push(title(String(v)));
    const own = fields.find((x) => x.forKey === f.key);
    const extra = own ? content[own.key] : undefined;
    if (typeof extra === 'string' && extra.trim()) parts.push(`“${extra.trim()}”`);
    if (!parts.length) continue;
    const label = f.title || f.description;
    lines.push(`${label ? `${label}: ` : ''}${parts.join(' — ')}`);
  }
  return lines.join('\n').slice(0, 600);
}
