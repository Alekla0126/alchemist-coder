import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ActionPrompt, BoardData, BoardPhase, BoardPlacement, BoardTask } from '../shared/api';

/**
 * The board (the project-management view) keeps its tasks and where you put each conversation in
 * one file of the app's data. Conversations themselves stay where the CLIs keep them.
 */

export const PHASES: BoardPhase[] = ['backlog', 'planning', 'implementing', 'validating', 'done'];
const MAX_TASKS = 2000;
const MAX_PLACED = 5000;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : Date.now());
const phase = (v: unknown): BoardPhase => (PHASES.includes(v as BoardPhase) ? (v as BoardPhase) : 'backlog');
const SESSION_ID = /^[\w.:-]{1,128}$/;

/** Whatever was stored or sent, as a valid board: unknown fields dropped, sizes capped. */
export function cleanBoard(raw: unknown): BoardData {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const tasks: BoardTask[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(o.tasks) ? o.tasks.slice(0, MAX_TASKS) : []) {
    if (!t || typeof t !== 'object') continue;
    const x = t as Record<string, unknown>;
    const id = str(x.id, 64);
    const cwd = str(x.cwd, 4096);
    if (!/^[\w-]{1,64}$/.test(id) || seen.has(id) || !isAbsolute(cwd)) continue;
    seen.add(id);
    const sessionId = str(x.sessionId, 128);
    tasks.push({
      id,
      cwd,
      title: str(x.title, 300),
      notes: str(x.notes, 20_000),
      phase: phase(x.phase),
      sessionId: SESSION_ID.test(sessionId) ? sessionId : null,
      createdAt: num(x.createdAt),
      updatedAt: num(x.updatedAt),
    });
  }
  const placed: Record<string, BoardPlacement> = {};
  const p = o.placed && typeof o.placed === 'object' ? (o.placed as Record<string, unknown>) : {};
  for (const [id, v] of Object.entries(p).slice(0, MAX_PLACED)) {
    if (!SESSION_ID.test(id) || !v || typeof v !== 'object') continue;
    const x = v as Record<string, unknown>;
    placed[id] = { phase: phase(x.phase), at: num(x.at) };
  }
  return { tasks, placed };
}

export function loadBoard(dir: string): BoardData {
  const file = join(dir, 'board.json');
  if (!existsSync(file)) return { tasks: [], placed: {} };
  try {
    return cleanBoard(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { tasks: [], placed: {} };
  }
}

export function saveBoard(dir: string, raw: unknown): BoardData {
  const data = cleanBoard(raw);
  const file = join(dir, 'board.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
  return data;
}

/**
 * The project's ai-actions.md (the file Nimbalyst reads too): each "## Name" section is a prompt
 * you can drop into the message box. Text before the first heading is ignored.
 */
export function parseActions(text: string): ActionPrompt[] {
  const out: ActionPrompt[] = [];
  let current: ActionPrompt | null = null;
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      current = { label: h[1]!.slice(0, 120), body: '' };
      out.push(current);
      if (out.length > 60) break;
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  return out.map((a) => ({ label: a.label, body: a.body.trim().slice(0, 20_000) })).filter((a) => a.label && a.body).slice(0, 60);
}

const ACTIONS_FILE = 'ai-actions.md';

export function listActions(root: string): { exists: boolean; path: string; actions: ActionPrompt[] } {
  const path = join(root, ACTIONS_FILE);
  if (!existsSync(path)) return { exists: false, path, actions: [] };
  const st = lstatSync(path);
  // A link could point anywhere on disk; a huge file isn't a list of prompts.
  if (!st.isFile() || st.size > 256 * 1024) return { exists: true, path, actions: [] };
  return { exists: true, path, actions: parseActions(readFileSync(path, 'utf8')) };
}

/** Writes the example file unless there is one already (never overwrites). */
export function createActions(root: string, example: string): string {
  const path = join(root, ACTIONS_FILE);
  if (!existsSync(path)) writeFileSync(path, example.slice(0, 20_000), { flag: 'wx' });
  return path;
}
