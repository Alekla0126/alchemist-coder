import type { AskQuestion, FileDiff } from '@alchemist-coder/core';

type Json = Record<string, any>;

/** Per text: an edit bigger than this shows its start. */
const MAX_TEXT = 20_000;
const MAX_DIFFS = 20;

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * Codex's apply_patch: one diff per hunk (a hunk carries only a few lines of context, so each is
 * shown on its own), and added files whole. Deleted files have nothing to show.
 */
export function patchDiffs(patch: string): FileDiff[] {
  const out: FileDiff[] = [];
  let path: string | null = null;
  let adding = false;
  let oldLines: string[] = [];
  let newLines: string[] = [];
  const flush = () => {
    if (path && (oldLines.length || newLines.length)) out.push({ path, oldText: adding ? null : clip(oldLines.join('\n')), newText: clip(newLines.join('\n')) });
    oldLines = [];
    newLines = [];
  };
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      flush();
      path = header[1] === 'Delete' ? null : header[2]!.trim();
      adding = header[1] === 'Add';
      continue;
    }
    const moved = /^\*\*\* Move to: (.+)$/.exec(line);
    if (moved) {
      path = moved[1]!.trim();
      continue;
    }
    if (line.startsWith('*** ')) {
      flush();
      continue;
    }
    if (line.startsWith('@@')) {
      if (!adding) flush();
      continue;
    }
    if (!path) continue;
    if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith(' ') || line === '') {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }
  flush();
  return out.slice(0, MAX_DIFFS);
}

/** What an edit tool call changed, from its input: Claude's Edit / MultiEdit / Write and Codex's apply_patch. */
export function editsOf(name: string, input: unknown): FileDiff[] | undefined {
  const o = (input && typeof input === 'object' ? input : {}) as Json;
  const path = str(o.file_path) ?? str(o.path) ?? str(o.notebook_path);
  let diffs: FileDiff[] = [];
  if (name === 'Edit' && path && str(o.new_string) != null) diffs = [{ path, oldText: clip(str(o.old_string) ?? ''), newText: clip(o.new_string) }];
  else if (name === 'MultiEdit' && path && Array.isArray(o.edits))
    diffs = (o.edits as Json[]).filter((e) => str(e?.new_string) != null).map((e) => ({ path, oldText: clip(str(e.old_string) ?? ''), newText: clip(e.new_string) }));
  else if (name === 'Write' && path && str(o.content) != null) diffs = [{ path, oldText: null, newText: clip(o.content) }];
  else if (name === 'apply_patch') {
    const patch = typeof input === 'string' ? input : (str(o.input) ?? str(o.patch));
    if (patch?.includes('*** Begin Patch')) diffs = patchDiffs(patch);
  }
  return diffs.length ? diffs.slice(0, MAX_DIFFS) : undefined;
}

/** ACP tool content: `{ type: 'diff', path, oldText, newText }` items. */
export function acpDiffs(content: unknown): FileDiff[] | undefined {
  const diffs = (Array.isArray(content) ? (content as Json[]) : [])
    .filter((c) => c?.type === 'diff' && str(c.path) && str(c.newText) != null)
    .map((c) => ({ path: c.path as string, oldText: str(c.oldText) == null ? null : clip(c.oldText), newText: clip(c.newText) }));
  return diffs.length ? diffs.slice(0, MAX_DIFFS) : undefined;
}

/** AskUserQuestion's questions, trimmed to what the chat shows. */
export function askOf(name: string, input: unknown): AskQuestion[] | undefined {
  if (name !== 'AskUserQuestion') return undefined;
  const qs = (input && typeof input === 'object' ? (input as Json).questions : null) as Json[] | null;
  if (!Array.isArray(qs)) return undefined;
  const out = qs.slice(0, 8).map((q) => ({
    header: String(q?.header ?? '').slice(0, 40),
    question: String(q?.question ?? '').slice(0, 500),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? (q.options as Json[]) : []).slice(0, 8).map((o) => ({ label: String(o?.label ?? '').slice(0, 200), description: String(o?.description ?? '').slice(0, 300) })),
  }));
  return out.length ? out : undefined;
}

/** The answers Claude Code recorded for an AskUserQuestion call. */
export function answersOf(toolUseResult: unknown): Record<string, string> | undefined {
  const a = toolUseResult && typeof toolUseResult === 'object' ? (toolUseResult as Json).answers : null;
  if (!a || typeof a !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [q, v] of Object.entries(a as Json).slice(0, 8)) if (typeof v === 'string') out[q.slice(0, 500)] = v.slice(0, 1000);
  return Object.keys(out).length ? out : undefined;
}
