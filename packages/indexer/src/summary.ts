import { emptyUsage, estimateCost, type TokenUsage } from '@alchemist-coder/core';

export type RowRole = 'user' | 'assistant' | 'meta' | 'notice';

export interface ParsedRow {
  key: string;
  role: RowRole;
  ts: number | null;
  offset: number;
  length: number;
  /** Searchable text; empty for rows that only matter to the transcript view. */
  text: string;
}

export interface SpawnInfo {
  type: string;
  description: string;
}

export interface ResultInfo {
  isError: boolean;
  isAsync: boolean;
  status: string | null;
  ts: number | null;
}

export interface FileSummary {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  cliVersion: string | null;
  firstTs: number | null;
  lastTs: number | null;
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  firstReply: string | null;
  models: string[];
  usage: TokenUsage;
  costUsd: number | null;
  toolCalls: number;
  userTurns: number;
  assistantMessages: number;
  lastStopReason: string | null;
  /** Tokens the last reply read (its prompt: history + context), i.e. how full the context was. */
  contextTokens: number;
  /** The model's context size, when the CLI records it (Codex). */
  contextWindow: number | null;
  /** Files this transcript's edit calls wrote to (paths as the tools gave them). */
  editedFiles: Set<string>;
  /** Agent/Task tool calls made from this transcript, keyed by tool_use id. */
  spawns: Record<string, SpawnInfo>;
  results: Record<string, ResultInfo>;
  /** Background task notifications: tool_use id -> final status. */
  notifications: Record<string, string>;
  /** When each notification arrived. */
  notifiedAt: Record<string, number>;
  rows: ParsedRow[];
  finished: boolean;
}

export function newSummary(): FileSummary {
  return {
    sessionId: null,
    cwd: null,
    gitBranch: null,
    cliVersion: null,
    firstTs: null,
    lastTs: null,
    customTitle: null,
    aiTitle: null,
    firstPrompt: null,
    firstReply: null,
    models: [],
    usage: emptyUsage(),
    costUsd: null,
    toolCalls: 0,
    userTurns: 0,
    assistantMessages: 0,
    lastStopReason: null,
    contextTokens: 0,
    contextWindow: null,
    editedFiles: new Set(),
    spawns: {},
    results: {},
    notifications: {},
    notifiedAt: {},
    rows: [],
    finished: false,
  };
}

export function tsOf(value: unknown): number | null {
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  return null;
}

export function touchTs(s: FileSummary, ts: number | null): void {
  if (ts == null) return;
  if (s.firstTs == null || ts < s.firstTs) s.firstTs = ts;
  if (s.lastTs == null || ts > s.lastTs) s.lastTs = ts;
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function titleFrom(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const clean = line.replace(/^#+\s*/, '').replace(/\s+/g, ' ');
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean;
}

export function addUsage(s: FileSummary, model: string | null, u: TokenUsage): void {
  s.usage.input += u.input;
  s.usage.output += u.output;
  s.usage.cacheRead += u.cacheRead;
  s.usage.cacheWrite5m += u.cacheWrite5m;
  s.usage.cacheWrite1h += u.cacheWrite1h;
  const cost = estimateCost(model, u);
  if (cost != null) s.costUsd = (s.costUsd ?? 0) + cost;
}

/** One-line description of a tool call, used in search text and the transcript. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') return input.split('\n')[0]?.slice(0, 160) ?? '';
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const pick = o.command ?? o.cmd ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.description ?? o.skill ?? o.prompt ?? '';
  return String(pick).split('\n')[0]?.slice(0, 160) ?? '';
}
