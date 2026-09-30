import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
  type CreateElicitationResponse,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
  type ToolCallContent,
} from '@agentclientprotocol/sdk';
import type { AgentOption, FileDiff, HarnessAdapter, PermissionMode, PlanEntry, QuestionAnswer, QuestionField, RunnerEvent, RunOptions, ToolState, PromptImage } from '@alchemist-coder/core';
import { killTree, RunBase, spawn, type SpawnFn } from './process.ts';

/** How to start an agent's ACP server; null when it is not installed. */
export interface AcpLaunch {
  command: string;
  args: string[];
  version: string | null;
}

/** Candidate session modes (first available wins) and config values for one permission mode. */
export interface AcpModeRule {
  modes?: string[];
  options?: Record<string, string>;
}

export interface AcpAgentSpec {
  id: string;
  label: string;
  resolve(): Promise<AcpLaunch | null>;
  modes: Record<PermissionMode, AcpModeRule>;
  /**
   * Auth method to use, decided from the provider's env only (never the ambient shell, so a stray
   * API key in ~/.zshrc can't switch billing). `eager` authenticates before opening the session;
   * otherwise only when the agent answers "auth required" (browser sign-ins).
   */
  authMethod?(providerEnv: Record<string, string>): { id: string; eager: boolean } | null;
  /** Extra env for the agent process. */
  env?: Record<string, string>;
  /** Extra launch arguments for one run (e.g. a CLI flag that picks the model). */
  args?(run: { model: string; permissionMode: PermissionMode }): string[];
}

const AUTH_REQUIRED = -32000;
/** Tool kinds that change files or run commands. */
const WRITES = new Set(['edit', 'delete', 'move', 'execute']);
const USD = /^usd$/i;

type Json = Record<string, unknown>;

function text(value: unknown): string {
  return value && typeof value === 'object' && (value as Json).type === 'text' ? String((value as Json).text ?? '') : '';
}

function diffsOf(content: ToolCallContent[] | null | undefined): FileDiff[] {
  const out: FileDiff[] = [];
  for (const c of content ?? []) if (c.type === 'diff') out.push({ path: c.path, oldText: c.oldText ?? null, newText: c.newText });
  return out;
}

/** Text a tool call carries: its text content blocks, or a `plan` argument (ExitPlanMode). */
function contentText(content: ToolCallContent[] | null | undefined, rawInput: unknown): string | null {
  const parts: string[] = [];
  for (const c of content ?? []) if (c.type === 'content') parts.push(text(c.content));
  const joined = parts.filter(Boolean).join('\n\n').trim();
  if (joined) return joined;
  const plan = rawInput && typeof rawInput === 'object' ? (rawInput as Json).plan : null;
  return typeof plan === 'string' && plan.trim() ? plan.trim() : null;
}

function toolState(status: string | null | undefined): ToolState | undefined {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

function flatChoices(option: SessionConfigOption): Array<{ value: string; label: string }> {
  if (option.type !== 'select') return [];
  return option.options.flatMap((o) => ('options' in o ? o.options : [o])).map((o) => ({ value: o.value, label: o.name }));
}

const VENDORS = new Set(['claude', 'gpt', 'grok', 'gemini', 'openai', 'anthropic', 'models']);

/**
 * Maps a provider model id onto the agent's own choices: exact, then without suffixes like
 * "[1m]", then by family name ("claude-opus-5" → "opus[1m]"). No match leaves the agent's default.
 */
export function pickChoice(choices: Array<{ value: string }>, wanted: string): string | null {
  if (!wanted || wanted === 'default') return null;
  const base = (v: string) => v.toLowerCase().replace(/\[.*?\]/g, '').replace(/^models\//, '');
  const w = base(wanted);
  const exact = choices.find((c) => c.value === wanted) ?? choices.find((c) => base(c.value) === w);
  if (exact) return exact.value;
  const tokens = w.split(/[-_/:.\s]+/).filter((t) => t.length >= 4 && !VENDORS.has(t) && !/^\d/.test(t));
  const family = choices.find((c) => tokens.some((t) => base(c.value).split(/[-_/:.\s]+/).includes(t)));
  return family?.value ?? null;
}

class AcpRun extends RunBase {
  private conn: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private modes: SessionModeState | null = null;
  private options: SessionConfigOption[] = [];
  private readonly queue: Array<{ text: string; images: PromptImage[] }> = [];
  /** The agent said it takes images in prompts. */
  private imageInput = false;
  private busy = false;
  private replaying = false;
  /** Config events wait until the session has its mode and model applied. */
  private ready = false;
  /** Planning: edits and commands are refused here too, whatever the agent asks. */
  private planGuard = false;
  private costUsd: number | null = null;
  /** Paragraph breaks: a new message or a tool call between two chunks of reply text. */
  private lastMessageId: string | null = null;
  private textInTurn = false;
  private paragraphBreak = false;
  private permissionCounter = 0;
  private readonly pending = new Map<string, { choices: Set<string>; resolve: (choiceId: string | null) => void }>();
  private readonly forms = new Map<string, { keys: Set<string>; resolve: (answer: QuestionAnswer | null) => void }>();
  private formCounter = 0;

  constructor(
    private readonly options_: RunOptions,
    private readonly spec: AcpAgentSpec,
    private readonly spawnFn: SpawnFn,
  ) {
    super();
    void this.start().catch((error: unknown) => this.fail(error));
  }

  private fail(error: unknown) {
    if (this.stopped) return;
    const message = error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error);
    this.emit({ type: 'error', message });
    this.emit({ type: 'status', status: 'error' });
    this.kill();
  }

  private async start() {
    const o = this.options_;
    const launch = await this.spec.resolve();
    if (!launch) throw new Error(`${this.spec.label} is not installed.`);
    const providerEnv = await o.provider.env(o.model, this.spec.id);
    if (this.stopped) return;
    const env = { ...(process.env as Record<string, string>), ...this.spec.env, ...providerEnv };
    const args = [...launch.args, ...(this.spec.args?.({ model: o.model, permissionMode: o.permissionMode ?? 'acceptEdits' }) ?? [])];
    // Own process group, so stopping also ends what npx and the adapter spawned.
    const child = this.spawnFn(launch.command, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.watch(child);
    this.emit({ type: 'status', status: 'running' });

    const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const conn = new ClientSideConnection(() => this.client(), stream);
    this.conn = conn;
    const init = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      // Forms (AskUserQuestion and the like) show as cards the user fills in.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      clientInfo: { name: 'alchemist-coder', title: 'Alchemist Coder', version: '0.1.0' },
    });
    this.imageInput = init.agentCapabilities?.promptCapabilities?.image === true;
    const auth = this.spec.authMethod?.(providerEnv) ?? null;
    const canAuth = !!auth && (init.authMethods ?? []).some((m) => m.id === auth.id);
    if (auth?.eager && canAuth) await conn.authenticate({ methodId: auth.id });

    let session: { id: string; modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null };
    try {
      session = await this.openSession(conn, init);
    } catch (error) {
      if (!(error instanceof RequestError && error.code === AUTH_REQUIRED)) throw error;
      if (!auth || !canAuth || auth.eager) throw new Error(`${this.spec.label} needs you to sign in. ${error.message}`);
      this.emit({ type: 'notice', level: 'info', text: `Signing in to ${this.spec.label}… finish in your browser if it opens.` });
      await conn.authenticate({ methodId: auth.id });
      session = await this.openSession(conn, init);
    }
    if (this.stopped) return;
    this.sessionId = session.id;
    this.modes = session.modes ?? null;
    this.options = session.configOptions ?? [];
    await this.applyPermissionMode(o.permissionMode ?? 'acceptEdits');
    await this.applyModel(o.model);
    // After the model: the effort levels on offer depend on it.
    await this.applyEffort(o.effort);
    this.ready = true;
    this.emit({ type: 'started', sessionId: session.id, model: this.modelValue() });
    this.emitConfig();
    this.send(o.prompt, o.images);
  }

  /** The session's extra MCP servers, in ACP's shape. */
  private sessionMcp() {
    return (this.options_.mcpServers ?? []).map((m) => ({ name: m.name, command: m.command, args: m.args, env: Object.entries(m.env).map(([name, value]) => ({ name, value })) }));
  }

  /** A tool of one of the app's own MCP servers (their calls don't need your OK). */
  private trustedTool(title: string): boolean {
    return (this.options_.mcpServers ?? []).some((m) => m.trusted && (title.includes(`mcp__${m.name}__`) || title.includes(`${m.name}:`) || title.includes(`(${m.name})`)));
  }

  private async openSession(conn: ClientSideConnection, init: InitializeResponse) {
    const o = this.options_;
    const caps = init.agentCapabilities;
    const sessionCaps = (caps?.sessionCapabilities ?? {}) as Json;
    if (o.resumeSessionId) {
      // Silently continuing the original would be worse than saying no.
      if (o.fork && !sessionCaps.fork) throw new Error(`${this.spec.label} can't fork a conversation yet; continue it instead.`);
      if (o.fork) {
        const r = await conn.unstable_forkSession({ sessionId: o.resumeSessionId, cwd: o.cwd, mcpServers: this.sessionMcp() });
        return { id: r.sessionId, modes: r.modes, configOptions: r.configOptions };
      }
      if (sessionCaps.resume) {
        const r = await conn.resumeSession({ sessionId: o.resumeSessionId, cwd: o.cwd, mcpServers: this.sessionMcp() });
        return { id: o.resumeSessionId, modes: r.modes, configOptions: r.configOptions };
      }
      if (caps?.loadSession) {
        // loadSession replays the whole history as updates; the transcript already shows it.
        this.replaying = true;
        try {
          const r = await conn.loadSession({ sessionId: o.resumeSessionId, cwd: o.cwd, mcpServers: this.sessionMcp() });
          return { id: o.resumeSessionId, modes: r.modes, configOptions: r.configOptions };
        } finally {
          this.replaying = false;
        }
      }
    }
    const r = await conn.newSession({ cwd: o.cwd, mcpServers: this.sessionMcp() });
    return { id: r.sessionId, modes: r.modes, configOptions: r.configOptions };
  }

  private watch(child: ChildProcess) {
    this.child = child;
    let stderr = 0;
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr > 20_000) return;
      stderr += chunk.length;
      this.emit({ type: 'stderr', text: chunk.toString('utf8') });
    });
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      this.closePermissions();
      this.emit({ type: 'status', status: this.stopped ? 'interrupted' : code === 0 || code === null ? 'done' : 'error' });
    });
  }

  private client(): Client {
    return {
      sessionUpdate: async ({ update }) => {
        if (!this.replaying && !this.stopped) this.onUpdate(update);
      },
      requestPermission: (request) => this.askPermission(request),
      createElicitation: (request) => this.askForm(request as unknown as Json) as Promise<CreateElicitationResponse>,
    };
  }

  private onUpdate(u: SessionUpdate) {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = text(u.content);
        if (!t) return;
        const id = u.messageId ?? null;
        const fresh = this.paragraphBreak || (id !== null && this.lastMessageId !== null && id !== this.lastMessageId);
        if (id !== null) this.lastMessageId = id;
        this.emit({ type: 'text', text: this.textInTurn && fresh && !t.startsWith('\n') ? `\n\n${t}` : t });
        this.textInTurn = true;
        this.paragraphBreak = false;
        return;
      }
      case 'agent_thought_chunk': {
        const t = text(u.content);
        if (t) this.emit({ type: 'thought', text: t });
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (u.sessionUpdate === 'tool_call') this.paragraphBreak = true;
        const diffs = diffsOf(u.content);
        const clipText = (v: string) => (v.length > 4000 ? `${v.slice(0, 4000)}…` : v);
        const input = u.rawInput != null ? clipText(JSON.stringify(u.rawInput, null, 2)) : undefined;
        const shown = (Array.isArray(u.content) ? u.content : []).map((c) => (c.type === 'content' ? text(c.content) : '')).filter(Boolean).join('\n');
        const output = shown || (u.rawOutput != null ? (typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput)) : '');
        this.emit({
          type: 'tool',
          id: u.toolCallId,
          name: u.name ?? u.kind ?? 'tool',
          summary: (u.title ?? u.locations?.[0]?.path ?? '').split('\n')[0]!.slice(0, 200),
          kind: u.kind ?? undefined,
          state: toolState(u.status),
          ...(diffs.length ? { diffs } : {}),
          ...(input ? { input } : {}),
          ...(output ? { output: clipText(output) } : {}),
        });
        return;
      }
      case 'plan':
        this.emit({ type: 'plan', entries: u.entries.map(planEntry) });
        return;
      case 'plan_update':
        if (u.plan.type === 'items') this.emit({ type: 'plan', entries: u.plan.entries.map(planEntry) });
        else if (u.plan.type === 'markdown') this.emit({ type: 'plan', entries: [], markdown: String((u.plan as Json).markdown ?? (u.plan as Json).content ?? '') });
        return;
      case 'plan_removed':
        this.emit({ type: 'plan', entries: [] });
        return;
      case 'current_mode_update':
        if (this.modes) this.modes = { ...this.modes, currentModeId: u.currentModeId };
        this.releasePlanGuard();
        this.emitConfig();
        return;
      case 'config_option_update': {
        this.options = u.configOptions;
        // Some agents mirror the session mode as a "mode" option and only announce it here.
        const mode = u.configOptions.find((c) => c.id === 'mode');
        if (this.modes && mode?.type === 'select' && this.modes.availableModes.some((m) => m.id === mode.currentValue)) {
          this.modes = { ...this.modes, currentModeId: mode.currentValue };
        }
        this.releasePlanGuard();
        this.emitConfig();
        return;
      }
      case 'usage_update':
        if (u.cost && USD.test(u.cost.currency)) this.costUsd = u.cost.amount;
        this.emit({ type: 'usage', usedTokens: u.used, contextTokens: u.size, costUsd: this.costUsd });
        return;
      case 'available_commands_update':
        this.emit({
          type: 'commands',
          commands: u.availableCommands.slice(0, 200).map((c) => ({ name: c.name, description: c.description ?? '', ...(c.input?.hint ? { hint: c.input.hint } : {}), source: 'agent' as const })),
        });
        return;
      case 'notice':
        this.emit({ type: 'notice', level: u.severity === 'error' ? 'error' : u.severity === 'warning' ? 'warning' : 'info', text: [u.title, u.description].filter(Boolean).join(' — ') });
        return;
      default:
        return;
    }
  }

  /** Ends the planning guard once the session leaves plan mode (the user approved the plan, or switched). */
  private releasePlanGuard() {
    if (!this.planGuard) return;
    const rule = this.spec.modes.plan;
    const current = this.modes?.currentModeId;
    const leftMode = !!rule.modes?.length && !!current && !rule.modes.includes(current);
    const leftOption = Object.entries(rule.options ?? {}).some(([id, value]) => {
      const o = this.options.find((c) => c.id === id);
      return o?.type === 'select' && o.currentValue !== value;
    });
    if (leftMode || leftOption) this.planGuard = false;
  }

  private askPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = `perm-${++this.permissionCounter}`;
    const tool = request.toolCall;
    if (this.planGuard && tool.kind && WRITES.has(tool.kind)) {
      // Refused without asking: while planning, nothing on disk changes.
      const reject = request.options.find((c) => c.kind === 'reject_once') ?? request.options.find((c) => c.kind === 'reject_always');
      this.emit({ type: 'notice', level: 'info', text: `Blocked while planning: ${(tool.title ?? tool.kind).split('\n')[0]!.slice(0, 200)}` });
      return Promise.resolve(reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } });
    }
    const allow = request.options.find((c) => c.kind === 'allow_once') ?? request.options.find((c) => c.kind === 'allow_always');
    if (allow && this.trustedTool(`${tool.title ?? ''} ${(tool as { name?: string }).name ?? ''}`)) return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } });
    const choices = request.options.map((c) => ({ id: c.optionId, label: c.name, kind: c.kind }));
    return new Promise<string | null>((resolve) => {
      if (this.stopped) return resolve(null);
      this.pending.set(requestId, { choices: new Set(choices.map((c) => c.id)), resolve });
      this.emit({
        type: 'permission',
        requestId,
        toolId: tool.toolCallId ?? null,
        title: (tool.title ?? tool.name ?? tool.kind ?? 'Tool').split('\n')[0]!.slice(0, 300),
        kind: tool.kind ?? null,
        diffs: diffsOf(tool.content),
        choices,
        content: contentText(tool.content, tool.rawInput),
      });
      this.emit({ type: 'status', status: 'waiting' });
    }).then((choiceId) => {
      this.pending.delete(requestId);
      this.emit({ type: 'permissionClosed', requestId, choiceId });
      if (!this.stopped && this.pending.size === 0) this.emit({ type: 'status', status: 'running' });
      return choiceId ? { outcome: { outcome: 'selected', optionId: choiceId } } : { outcome: { outcome: 'cancelled' } };
    });
  }

  respond(requestId: string, choiceId: string | null): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    p.resolve(choiceId && p.choices.has(choiceId) ? choiceId : null);
  }

  private closePermissions() {
    for (const p of this.pending.values()) p.resolve(null);
    for (const f of this.forms.values()) f.resolve(null);
  }

  /**
   * A form the agent wants filled (its AskUserQuestion, a consent prompt): shown as a question card;
   * the answer goes back as ACP's elicitation response. URL-mode requests are declined.
   */
  private askForm(request: Json): Promise<Json> {
    if (request.mode !== 'form' || this.stopped) return Promise.resolve({ action: 'cancel' });
    const fields = formFields(request.requestedSchema);
    if (!fields.length) return Promise.resolve({ action: 'decline' });
    const requestId = `form-${++this.formCounter}`;
    return new Promise<QuestionAnswer | null>((resolve) => {
      this.forms.set(requestId, { keys: new Set(fields.map((f) => f.key)), resolve });
      this.emit({ type: 'question', requestId, message: String(request.message ?? '').slice(0, 2000), fields });
      this.emit({ type: 'status', status: 'waiting' });
    }).then((answer) => {
      this.forms.delete(requestId);
      this.emit({ type: 'questionClosed', requestId, answered: !!answer && answer.action === 'accept' });
      if (!this.stopped && this.pending.size === 0 && this.forms.size === 0) this.emit({ type: 'status', status: 'running' });
      if (!answer) return { action: 'cancel' };
      if (answer.action === 'decline') return { action: 'decline' };
      return { action: 'accept', content: answer.content ?? {} };
    });
  }

  answer(requestId: string, answer: QuestionAnswer | null): void {
    const f = this.forms.get(requestId);
    if (!f) return;
    if (!answer) return f.resolve(null);
    // Only the form's own fields, with plain values.
    const content: Record<string, string | string[] | boolean | number> = {};
    for (const [k, v] of Object.entries(answer.content ?? {})) {
      if (!f.keys.has(k)) continue;
      if (typeof v === 'string') content[k] = v.slice(0, 4000);
      else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) content[k] = v;
      else if (Array.isArray(v)) content[k] = v.filter((x): x is string => typeof x === 'string').slice(0, 50).map((x) => x.slice(0, 500));
    }
    f.resolve(answer.action === 'decline' ? { action: 'decline' } : { action: 'accept', content });
  }

  private modelOption(): SessionConfigOption | undefined {
    return this.options.find((c) => c.id === 'model') ?? this.options.find((c) => c.category === 'model');
  }

  private modelValue(): string | null {
    const m = this.modelOption();
    return m && m.type === 'select' ? m.currentValue : null;
  }

  private async setOption(id: string, value: string) {
    if (!this.conn || !this.sessionId) return;
    const option = this.options.find((c) => c.id === id);
    if (!option || option.type !== 'select' || option.currentValue === value) return;
    if (!flatChoices(option).some((c) => c.value === value)) throw new Error(`${option.name}: unknown value ${value}`);
    const r = await this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId: id, value });
    this.options = r.configOptions ?? this.options;
  }

  private async setMode(modeId: string) {
    if (!this.conn || !this.sessionId || !this.modes || this.modes.currentModeId === modeId) return;
    if (!this.modes.availableModes.some((m) => m.id === modeId)) throw new Error(`Unknown mode ${modeId}`);
    await this.conn.setSessionMode({ sessionId: this.sessionId, modeId });
    this.modes = { ...this.modes, currentModeId: modeId };
  }

  /**
   * Plan and "ask first" fail closed: agents start in whatever mode the user's own CLI config says
   * (often bypassPermissions), so a mode we couldn't apply must stop the run, not just warn.
   */
  private async applyPermissionMode(mode: PermissionMode) {
    const rule = this.spec.modes[mode];
    const label = this.spec.label;
    let applied = false;
    try {
      const modeId = rule.modes?.find((id) => this.modes?.availableModes.some((m) => m.id === id));
      if (modeId) {
        await this.setMode(modeId);
        applied = true;
      }
      for (const [id, value] of Object.entries(rule.options ?? {})) {
        const option = this.options.find((c) => c.id === id);
        if (option && flatChoices(option).some((c) => c.value === value)) await this.setOption(id, value);
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (mode === 'plan' || mode === 'default') throw new Error(`Could not switch ${label} to ${mode} mode (${why}); stopped so it can't change files without asking.`);
      this.emit({ type: 'notice', level: 'warning', text: `Could not switch ${label} to ${mode}: ${why}` });
    }
    if (!applied && rule.modes?.length) {
      if (mode === 'plan') throw new Error(`${label} has no plan mode here; stopped so it can't change files while planning.`);
      const permissive = [...(this.spec.modes.bypassPermissions.modes ?? []), ...(this.spec.modes.acceptEdits.modes ?? [])].filter((id) => !rule.modes!.includes(id));
      const current = this.modes?.currentModeId;
      if (mode === 'default' && current && permissive.includes(current)) throw new Error(`${label} is set to "${current}" and has no mode that asks first; stopped so it can't change files without asking.`);
    }
    this.planGuard = mode === 'plan';
  }

  private async applyModel(model: string) {
    const option = this.modelOption();
    if (!option) return;
    const value = pickChoice(flatChoices(option), model);
    if (!value) return;
    try {
      await this.setOption(option.id, value);
    } catch (error) {
      this.emit({ type: 'notice', level: 'warning', text: `Could not select ${model}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** The reasoning-effort option, when the agent has one for this model. */
  private effortOption(): SessionConfigOption | undefined {
    return this.options.find((c) => c.category === 'thought_level') ?? this.options.find((c) => c.id === 'effort' || c.id === 'reasoning_effort');
  }

  /** A level this model doesn't offer is skipped (and said): the agent keeps its own default. */
  private async applyEffort(effort: string | undefined) {
    if (!effort) return;
    const option = this.effortOption();
    if (!option || !flatChoices(option).some((c) => c.value === effort)) {
      this.emit({ type: 'notice', level: 'info', text: `This model doesn't offer the "${effort}" reasoning effort; it uses its default.` });
      return;
    }
    try {
      await this.setOption(option.id, effort);
    } catch (error) {
      this.emit({ type: 'notice', level: 'warning', text: `Could not set the effort to ${effort}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private emitConfig() {
    if (!this.ready) return;
    const options: AgentOption[] = this.options
      .filter((c) => c.type === 'select' && c.id !== 'mode')
      .map((c) => ({ id: c.id, label: c.name, category: c.category ?? undefined, value: c.type === 'select' ? c.currentValue : '', choices: flatChoices(c) }));
    this.emit({
      type: 'config',
      modes: (this.modes?.availableModes ?? []).map((m) => ({ id: m.id, label: m.name })),
      mode: this.modes?.currentModeId ?? null,
      options,
    });
  }

  async configure(change: { mode?: string; option?: { id: string; value: string } }): Promise<void> {
    if (change.mode) await this.setMode(change.mode);
    if (change.option) await this.setOption(change.option.id, change.option.value);
    this.releasePlanGuard();
    this.emitConfig();
  }

  override send(textIn: string, images: PromptImage[] = []): void {
    this.queue.push({ text: textIn, images });
    void this.pump();
  }

  private async pump() {
    if (this.busy || this.stopped || !this.conn || !this.sessionId) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.busy = true;
    this.textInTurn = false;
    this.paragraphBreak = false;
    this.emit({ type: 'status', status: 'running' });
    try {
      if (next.images.length && !this.imageInput) this.emit({ type: 'notice', level: 'warning', text: `${this.spec.label} doesn't take images here; only your text was sent.` });
      const images = this.imageInput ? next.images.map((i) => ({ type: 'image' as const, mimeType: i.mediaType, data: i.data })) : [];
      const r = await this.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text: next.text }, ...images] });
      if (this.stopped) return;
      if (r.stopReason === 'refusal') this.emit({ type: 'notice', level: 'warning', text: `${this.spec.label} declined this request.` });
      this.emit({ type: 'result', ok: r.stopReason !== 'refusal', sessionId: this.sessionId, costUsd: this.costUsd });
    } catch (error) {
      if (!this.stopped) {
        this.emit({ type: 'error', message: error instanceof Error ? error.message : JSON.stringify(error) });
        this.emit({ type: 'result', ok: false, sessionId: this.sessionId, costUsd: this.costUsd });
      }
    } finally {
      this.busy = false;
      if (this.queue.length) void this.pump();
    }
  }

  interrupt(): void {
    this.closePermissions();
    if (this.conn && this.sessionId && this.busy) void this.conn.cancel({ sessionId: this.sessionId }).catch(() => {});
  }

  private kill() {
    if (this.child) killTree(this.child, true);
  }

  override stop(): void {
    this.stopped = true;
    this.closePermissions();
    if (this.conn && this.sessionId && this.busy) void this.conn.cancel({ sessionId: this.sessionId }).catch(() => {});
    this.kill();
  }
}

function planEntry(e: { content: string; status: string; priority: string }): PlanEntry {
  return {
    content: e.content,
    status: e.status === 'completed' || e.status === 'in_progress' ? e.status : 'pending',
    priority: e.priority === 'high' || e.priority === 'low' ? e.priority : 'medium',
  };
}

/** Any Agent Client Protocol server (Claude, Codex, Gemini CLI, Grok Build…) as a harness. */
export function acpHarness(spec: AcpAgentSpec, options: { spawn?: SpawnFn } = {}): HarnessAdapter {
  const spawnFn = options.spawn ?? spawn;
  return {
    id: spec.id,
    label: spec.label,
    async detect() {
      const launch = await spec.resolve();
      return { installed: !!launch, version: launch?.version ?? null, path: launch ? launch.command : null };
    },
    run: (runOptions) => new AcpRun(runOptions, spec, spawnFn),
  };
}


/** The fields of an ACP form schema: choices (one or many), text, yes/no and numbers. */
export function formFields(schema: unknown): QuestionField[] {
  const props = (schema && typeof schema === 'object' ? (schema as Json).properties : null) as Record<string, Json> | null;
  if (!props || typeof props !== 'object') return [];
  const required = new Set(Array.isArray((schema as Json).required) ? ((schema as Json).required as unknown[]).map(String) : []);
  const named = (values: unknown[], names: unknown) => values.map((v, i) => ({ const: v, title: Array.isArray(names) && names[i] != null ? names[i] : v }));
  const options = (list: unknown) =>
    (Array.isArray(list) ? (list as Json[]) : [])
      .slice(0, 30)
      .map((o) => ({ value: String(o?.const ?? ''), title: String(o?.title ?? o?.const ?? '').slice(0, 300), description: String(o?.description ?? '').slice(0, 600) }))
      .filter((o) => o.value);
  const out: QuestionField[] = [];
  for (const [key, p] of Object.entries(props).slice(0, 20)) {
    if (!p || typeof p !== 'object') continue;
    const base = { key, title: String(p.title ?? '').slice(0, 200), description: String(p.description ?? '').slice(0, 1000), ...(required.has(key) ? { required: true } : {}) };
    const meta = (p._meta ?? {}) as Json;
    const custom = Object.values(meta).find((m) => m && typeof m === 'object' && (m as Json).isCustomAnswer) as Json | undefined;
    if (p.type === 'string' && (p.oneOf || p.enum)) out.push({ ...base, kind: 'single', options: p.oneOf ? options(p.oneOf) : options(named(p.enum as unknown[], p.enumNames)) });
    else if (p.type === 'array' && p.items && ((p.items as Json).anyOf || (p.items as Json).enum)) {
      const items = p.items as Json;
      out.push({ ...base, kind: 'multi', options: items.anyOf ? options(items.anyOf) : options(named(items.enum as unknown[], items.enumNames)) });
    }
    else if (p.type === 'boolean') out.push({ ...base, kind: 'boolean', options: [] });
    else if (p.type === 'number' || p.type === 'integer') out.push({ ...base, kind: 'number', options: [] });
    else if (p.type === 'string') out.push({ ...base, kind: 'text', options: [], ...(custom?.questionId ? { forKey: String(custom.questionId) } : {}) });
  }
  return out;
}
