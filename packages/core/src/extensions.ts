import type { AgentStatus } from './types.ts';

export type Edition = 'community' | 'pro';

export interface Capabilities {
  toolSearch: boolean;
  webFetch: boolean;
  webSearch: boolean;
  subagents: boolean;
}

/** Secrets (API keys) kept by the host in the OS keychain. Values never reach logs or the renderer. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | null): Promise<void>;
  has(key: string): Promise<boolean>;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string | null) {
    if (value) this.values.set(key, value);
    else this.values.delete(key);
  }
  async has(key: string) {
    return this.values.has(key);
  }
}

export interface ModelSpec {
  id: string;
  label: string;
  contextWindow?: number;
}

/** A model provider: where requests go and which credentials/env they need. */
export interface ProviderAdapter {
  id: string;
  label: string;
  edition: Edition;
  harnesses: string[];
  capabilities: Capabilities;
  /** Where requests go, when the provider has a single endpoint (used for edition checks). */
  baseUrl?: string;
  models(): Promise<ModelSpec[]>;
  /** Environment for the harness process. Must not log or persist secrets. */
  env(model: string, harnessId?: string): Promise<Record<string, string>>;
  /** Extra CLI arguments for a given harness (model selection, provider overrides). */
  cliArgs?(harnessId: string, model: string): string[];
  /** Whether the provider is reachable right now. */
  status?(): Promise<{ available: boolean; detail?: string }>;
  /** A secret the user must enter (e.g. an API key), stored under `key` in the host's SecretStore. */
  credential?: { key: string; label: string; placeholder?: string; optional?: boolean };
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface FileDiff {
  path: string;
  /** null for a new file. */
  oldText: string | null;
  newText: string;
}

export type ToolState = 'pending' | 'running' | 'done' | 'failed';

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export interface PermissionChoice {
  id: string;
  label: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/** A setting the agent exposes for the live session (model, reasoning effort…). */
export interface AgentOption {
  id: string;
  label: string;
  value: string;
  choices: Array<{ value: string; label: string }>;
}

/** A "/" command: announced by the agent (ACP) or found in the CLI's command folders. */
export interface SlashCommand {
  name: string;
  description: string;
  /** What to type after it, when it takes input. */
  hint?: string;
  source?: 'agent' | 'command' | 'skill' | 'prompt' | 'plugin' | 'builtin';
}

/** One field of a form an agent asks you to fill (an AskUserQuestion, a consent prompt). */
export interface QuestionField {
  key: string;
  title: string;
  description: string;
  kind: 'single' | 'multi' | 'text' | 'boolean' | 'number';
  options: Array<{ value: string; title: string; description: string }>;
  /** An "Other" box that belongs to the question `forKey`. */
  forKey?: string;
  required?: boolean;
}

/** What you answered: accept with values, or decline (skip). */
export interface QuestionAnswer {
  action: 'accept' | 'decline';
  content?: Record<string, string | string[] | boolean | number>;
}

export type RunnerEvent =
  | { type: 'started'; sessionId: string | null; model?: string | null }
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  /** `id` lets later updates of the same tool call replace the earlier one. */
  | { type: 'tool'; name: string; summary: string; id?: string; kind?: string; state?: ToolState; diffs?: FileDiff[]; /** JSON, clipped */ input?: string; /** text, clipped */ output?: string }
  | { type: 'plan'; entries: PlanEntry[]; markdown?: string }
  /** The agent is waiting for the user; answer with RunHandle.respond(). */
  | { type: 'permission'; requestId: string; toolId: string | null; title: string; kind: string | null; diffs: FileDiff[]; choices: PermissionChoice[]; content: string | null }
  | { type: 'permissionClosed'; requestId: string; choiceId: string | null }
  /** The agent asks you something (a form); answer with RunHandle.answer(). */
  | { type: 'question'; requestId: string; message: string; fields: QuestionField[] }
  | { type: 'questionClosed'; requestId: string; answered: boolean }
  | { type: 'config'; modes: Array<{ id: string; label: string }>; mode: string | null; options: AgentOption[] }
  | { type: 'usage'; usedTokens: number; contextTokens: number; costUsd: number | null }
  | { type: 'commands'; commands: SlashCommand[] }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'status'; status: AgentStatus }
  | { type: 'result'; ok: boolean; sessionId: string | null; costUsd: number | null }
  | { type: 'error'; message: string }
  | { type: 'stderr'; text: string };

/** An image sent with a prompt: base64 without the data: prefix. */
export interface PromptImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
}

export const IMAGE_TYPES: ReadonlyArray<PromptImage['mediaType']> = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Per image, in base64 characters (about 5 MB of image). */
export const MAX_IMAGE_BASE64 = 7_000_000;

/** Only well-formed images, at most 6 (the renderer's input is never trusted). */
export function validImages(value: unknown): PromptImage[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 6)
    .filter((i): i is PromptImage => !!i && IMAGE_TYPES.includes(i.mediaType) && typeof i.data === 'string' && i.data.length > 0 && i.data.length <= MAX_IMAGE_BASE64 && /^[A-Za-z0-9+/]+={0,2}$/.test(i.data))
    .map((i) => ({ mediaType: i.mediaType, data: i.data }));
}

/** An MCP server an agent gets for one session: the command it starts (stdio). */
export interface SessionMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The app's own server: its tools run without asking. */
  trusted?: boolean;
}

export interface RunOptions {
  cwd: string;
  prompt: string;
  /** Extra MCP servers for this session (only the main process sets these). */
  mcpServers?: SessionMcpServer[];
  /** Sent with the prompt when the agent takes images. */
  images?: PromptImage[];
  provider: ProviderAdapter;
  model: string;
  resumeSessionId?: string;
  fork?: boolean;
  permissionMode?: PermissionMode;
}

export interface RunHandle {
  id: string;
  send(text: string, images?: PromptImage[]): void;
  stop(): void;
  onEvent(listener: (event: RunnerEvent) => void): () => void;
  /** Stops the current turn but keeps the session (agents that support it). */
  interrupt?(): void;
  /** Answers a `question` event; null cancels it. */
  answer?(requestId: string, answer: QuestionAnswer | null): void;
  /** Answers a `permission` event; null denies/cancels. */
  respond?(requestId: string, choiceId: string | null): void;
  /** Switches the session mode or one of its options while it runs. */
  configure?(change: { mode?: string; option?: { id: string; value: string } }): Promise<void>;
}

/** A coding agent CLI that the app drives as a subprocess. */
export interface HarnessAdapter {
  id: string;
  label: string;
  detect(): Promise<{ installed: boolean; version: string | null; path: string | null }>;
  run(options: RunOptions): RunHandle;
}

export interface FeatureGate {
  id: string;
  edition: Edition;
}

export interface ExtensionContext {
  edition: Edition;
  secrets: SecretStore;
  registerHarness(harness: HarnessAdapter): void;
  registerProvider(provider: ProviderAdapter): void;
  registerFeatureGate(gate: FeatureGate): void;
}

export type AlchemistExtension = (ctx: ExtensionContext) => void | Promise<void>;

export function defineExtension(extension: AlchemistExtension): AlchemistExtension {
  return extension;
}

export class ExtensionRegistry implements ExtensionContext {
  readonly harnesses = new Map<string, HarnessAdapter>();
  readonly providers = new Map<string, ProviderAdapter>();
  readonly gates = new Map<string, FeatureGate>();

  readonly edition: Edition;
  readonly secrets: SecretStore;

  constructor(edition: Edition, secrets: SecretStore = new MemorySecretStore()) {
    this.edition = edition;
    this.secrets = secrets;
  }

  registerHarness(harness: HarnessAdapter): void {
    this.harnesses.set(harness.id, harness);
  }

  registerProvider(provider: ProviderAdapter): void {
    // Pro providers only register in a Pro build; the Community build ignores them.
    if (provider.edition === 'pro' && this.edition !== 'pro') return;
    this.providers.set(provider.id, provider);
  }

  registerFeatureGate(gate: FeatureGate): void {
    this.gates.set(gate.id, gate);
  }

  isEnabled(featureId: string): boolean {
    const gate = this.gates.get(featureId);
    return !gate || gate.edition === 'community' || this.edition === 'pro';
  }

  async load(extension: AlchemistExtension): Promise<void> {
    await extension(this);
  }
}
