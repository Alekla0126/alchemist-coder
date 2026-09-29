import type { FileDiff } from './extensions.ts';
/** Where a conversation came from. */
export type Source = 'claude-code' | 'codex' | 'gemini' | 'grok';

export type AgentStatus = 'running' | 'waiting' | 'done' | 'error' | 'interrupted' | 'idle';

export interface ProjectSummary {
  id: number;
  cwd: string;
  name: string;
  sessionCount: number;
  lastTs: number | null;
  sources: Source[];
  runningAgents: number;
}

export interface SessionSummary {
  id: string;
  source: Source;
  projectId: number;
  title: string;
  firstTs: number | null;
  lastTs: number | null;
  messageCount: number;
  models: string[];
  gitBranch: string | null;
  cliVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** How full the context was on the last reply (tokens it read); 0 when unknown. */
  contextTokens: number;
  /** The model's context size when the CLI recorded it. */
  contextWindow: number | null;
  /** Files the conversation (and its subagents) edited. */
  editedFiles: string[];
  /** Estimated at API list prices; null when the model has no known price. */
  costUsd: number | null;
  agentCount: number;
  runningAgents: number;
  status: AgentStatus;
  archived: boolean;
  /** The CLI deleted it; Alchemist's backup kept it. */
  preserved: boolean;
  favorite: boolean;
}

export interface AgentNode {
  id: string;
  sessionId: string;
  parentId: string | null;
  toolUseId: string | null;
  type: string;
  description: string;
  depth: number;
  model: string | null;
  isFork: boolean;
  worktreePath: string | null;
  worktreeBranch: string | null;
  status: AgentStatus;
  startedTs: number | null;
  endedTs: number | null;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  children: AgentNode[];
}

export interface AskQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      summary: string;
      input: string;
      spawnsAgentId: string | null;
      /** What an edit call changed, when its input says (Edit, Write, apply_patch, ACP diffs). */
      edits?: FileDiff[];
      /** AskUserQuestion: the questions, whole (the input itself is clipped). */
      ask?: AskQuestion[];
    }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; preview: string; /** AskUserQuestion: question → answer. */ answers?: Record<string, string> }
  /** `ref` finds the picture again in the transcript file (the index doesn't keep images). */
  | { kind: 'image'; mediaType: string; bytes: number; ref?: { agentId: string; offset: number; n: number } }
  | { kind: 'notice'; text: string };

export interface TranscriptEntry {
  key: string;
  ts: number | null;
  role: 'user' | 'assistant' | 'meta' | 'notice';
  model: string | null;
  blocks: TranscriptBlock[];
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  total: number;
  /** Position of the first entry of this page (pages asked for from the end start wherever that lands). */
  offset: number;
  nextOffset: number | null;
}

export interface SearchHit {
  sessionId: string;
  agentId: string;
  projectId: number;
  projectName: string;
  title: string;
  snippet: string;
  ts: number | null;
  source: Source;
}

export interface IndexProgress {
  phase: 'scanning' | 'indexing' | 'ready';
  done: number;
  total: number;
}
