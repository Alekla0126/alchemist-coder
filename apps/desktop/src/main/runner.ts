import { statSync } from 'node:fs';
import { cliStatus } from './cli-status';
import { installStep } from './install';
import { cliSearchPath } from './shell-path';
import { detectBinary, stageData, stageFile } from '@alchemist-coder/harness';
import { isLocalEndpoint, type Autopilot, type ExtensionRegistry, type PromptFile, type QuestionAnswer, type RunHandle, type RunnerEvent, type SessionMcpServer, validImages } from '@alchemist-coder/core';
import type { PermissionMode, RunnerCatalog, RunnerEventMessage, StartRunRequest } from '../shared/api';

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** At most this many files with one message, and this much pasted content per file (base64). */
const MAX_FILES = 10;
const MAX_PASTED_BASE64 = 35_000_000; // about 25 MB

/**
 * The renderer's attachments, ready for the agent: each one checked (a real file, or base64 of a
 * sane size) and put in the project (harness/attachments.ts). A file that can't be read is left out.
 */
export function stageAttachments(cwd: string, value: unknown): PromptFile[] {
  if (!Array.isArray(value)) return [];
  const out: PromptFile[] = [];
  for (const item of value.slice(0, MAX_FILES)) {
    if (!item || typeof item !== 'object') continue;
    const { name, path, data } = item as { name?: unknown; path?: unknown; data?: unknown };
    try {
      if (typeof path === 'string' && path) {
        const staged = stageFile(cwd, path, typeof name === 'string' ? name : undefined);
        if (staged) out.push(staged);
      } else if (typeof data === 'string' && data.length > 0 && data.length <= MAX_PASTED_BASE64 && /^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        out.push(stageData(cwd, typeof name === 'string' ? name : 'pasted', Buffer.from(data, 'base64')));
      }
    } catch {
      // Unreadable, or no room to copy it: the rest still go.
    }
  }
  return out;
}

export class RunnerManager {
  private readonly runs = new Map<string, RunHandle>();
  /** Each run's project folder, where its attachments go. */
  private readonly cwds = new Map<string, string>();
  private readonly observers = new Set<(message: RunnerEventMessage) => void>();
  /** Runs with an agent at work or waiting (their last status said so). */
  private readonly active = new Set<string>();
  /** What each run is waiting on you for (permissions and questions), until it's answered. */
  private readonly waiting = new Map<string, Map<string, Extract<RunnerEvent, { type: 'permission' | 'question' }>>>();
  /** Who decides for each run while you're away: the app's Autopilot, or its organization's. */
  private readonly pilots = new Map<string, Autopilot>();

  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly emit: (message: RunnerEventMessage) => void,
    /** Providers allowed in the Community edition although they aren't local (a personal module's). */
    private readonly exempt: ReadonlySet<string> = new Set(),
    /** Agents only run inside the user's projects (and Arena worktrees in them). */
    private readonly isProjectFolder?: (cwd: string) => boolean,
    /** Decides for you while you're away (asked by every run, on or off). */
    private readonly autopilot?: Autopilot,
  ) {}

  private harnessStatus() {
    return Promise.all(
      [...this.registry.harnesses.values()].map(async (h) => {
        const [d, cli] = await Promise.all([h.detect(), cliStatus(h.id).catch(() => ({ cliVersion: null, signedIn: null, account: null, cliPath: null }))]);
        return { id: h.id, label: h.label, installed: d.installed, version: d.version, ...cli };
      }),
    );
  }

  async catalog(): Promise<RunnerCatalog> {
    const shellPath = cliSearchPath();
    let found = await this.harnessStatus();
    // Something not found: the login shell's PATH may still be on its way (it can take seconds). Look again with it.
    if (found.some((h) => !h.installed)) {
      await shellPath;
      found = await this.harnessStatus();
    }
    // How to install what's missing (only looked into when something is).
    const missing = found.some((h) => !h.installed);
    const hasNpx = missing && (await detectBinary('npx')).installed;
    const hasBrew = missing && process.platform === 'darwin' && (await detectBinary('brew')).installed;
    const harnesses = found.map((h) => ({ ...h, install: installStep(h.id, { installed: h.installed, hasNpx, hasBrew, platform: process.platform }) }));
    const providers = await Promise.all(
      [...this.registry.providers.values()].map(async (p) => {
        const status = p.status ? await p.status() : { available: true };
        const models = status.available ? await p.models().catch(() => []) : [];
        const credential = p.credential
          ? { label: p.credential.label, placeholder: p.credential.placeholder ?? null, isSet: await this.registry.secrets.has(p.credential.key), optional: p.credential.optional === true }
          : null;
        return { id: p.id, label: p.label, edition: p.edition, harnesses: p.harnesses, available: status.available, detail: status.detail ?? null, models, credential };
      }),
    );
    return { harnesses, providers };
  }

  /** Validates everything coming from the renderer before starting a subprocess. */
  /** `internal`: what only the main process may add (the bots' own MCP server, the organization's Autopilot). */
  start(request: StartRunRequest, internal: { mcpServers?: SessionMcpServer[]; autopilot?: Autopilot } = {}): { runId: string } {
    const harness = this.registry.harnesses.get(String(request?.harnessId));
    const provider = this.registry.providers.get(String(request?.providerId));
    if (!harness) throw new Error('Unknown agent CLI');
    if (!provider) throw new Error('Unknown model provider');
    if (!provider.harnesses.includes(harness.id)) throw new Error(`${provider.label} does not support ${harness.label}`);
    const local = provider.edition === 'community' && !!provider.baseUrl && isLocalEndpoint(provider.baseUrl);
    if (this.registry.edition === 'community' && !local && !this.exempt.has(provider.id)) {
      throw new Error('The Community edition only runs agents on local models.');
    }
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt || prompt.length > 100_000) throw new Error('Write a prompt first');
    const model = typeof request.model === 'string' ? request.model : '';
    if (!/^[\w.:/@-]{1,120}$/.test(model)) throw new Error('Choose a model');
    const cwd = typeof request.cwd === 'string' ? request.cwd : '';
    if (!cwd || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Project folder not found: ${cwd}`);
    if (this.isProjectFolder && !this.isProjectFolder(cwd)) throw new Error(`Not one of your projects: ${cwd}`);
    const resume = typeof request.resumeSessionId === 'string' && /^[A-Za-z0-9][\w-]{7,79}$/.test(request.resumeSessionId) ? request.resumeSessionId : undefined;
    const permissionMode = PERMISSION_MODES.includes(request.permissionMode as PermissionMode) ? request.permissionMode : 'acceptEdits';

    const effort = typeof request.effort === 'string' && /^[\w-]{1,24}$/.test(request.effort) ? request.effort : undefined;
    const handle = harness.run({ cwd, prompt, images: validImages(request.images), files: stageAttachments(cwd, request.files), provider, model, resumeSessionId: resume, fork: !!resume && request.fork === true, permissionMode, effort, mcpServers: internal.mcpServers, autopilot: internal.autopilot ?? this.autopilot });
    this.runs.set(handle.id, handle);
    const pilot = internal.autopilot ?? this.autopilot;
    if (pilot) this.pilots.set(handle.id, pilot);
    this.cwds.set(handle.id, cwd);
    handle.onEvent((event) => {
      this.track(handle.id, event);
      this.publish(handle.id, event);
    });
    return { runId: handle.id };
  }

  private publish(runId: string, event: RunnerEvent) {
    const message = { runId, event };
    this.emit(message);
    for (const o of this.observers) o(message);
  }

  private track(runId: string, event: RunnerEvent) {
    if (event.type === 'status') {
      if (event.status === 'running' || event.status === 'waiting') this.active.add(runId);
      else this.active.delete(runId);
    } else if (event.type === 'permission' || event.type === 'question') {
      const list = this.waiting.get(runId) ?? new Map();
      list.set(event.requestId, event);
      this.waiting.set(runId, list);
    } else if (event.type === 'permissionClosed' || event.type === 'questionClosed') this.waiting.get(runId)?.delete(event.requestId);
  }

  /** Autopilot was just turned on: what was already waiting for you is decided now, the same way. */
  decideWaiting(): void {
    for (const [runId, list] of this.waiting) {
      const run = this.runs.get(runId);
      const pilot = this.pilots.get(runId);
      if (!pilot) continue;
      for (const e of [...list.values()]) {
        if (e.type === 'permission') {
          const d = pilot.permission({ title: e.title, kind: e.kind, command: e.command ?? null, choices: e.choices });
          if (!d || !run?.respond) continue;
          if (d.note) this.publish(runId, { type: 'notice', level: 'info', text: d.note });
          run.respond(e.requestId, d.choiceId);
        } else {
          const d = pilot.question({ message: e.message, fields: e.fields });
          if (!d || !run?.answer) continue;
          this.publish(runId, { type: 'notice', level: 'info', text: d.note });
          run.answer(e.requestId, d.answer);
        }
      }
    }
  }

  /** Main-process listeners (e.g. the Arena) see every run's events too. */
  observe(listener: (message: RunnerEventMessage) => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  isRunning(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Whether some agent is at work (or waiting) right now. */
  working(): boolean {
    return this.active.size > 0;
  }

  async setCredential(providerId: string, value: string | null): Promise<void> {
    const provider = this.registry.providers.get(String(providerId));
    if (!provider?.credential) throw new Error('This provider has no credential');
    const v = typeof value === 'string' ? value.trim() : null;
    if (v && (v.length > 400 || /\s/.test(v))) throw new Error('That does not look like an API key');
    await this.registry.secrets.set(provider.credential.key, v || null);
  }

  send(runId: string, text: string, images?: unknown, files?: unknown): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error('This run has ended');
    const t = typeof text === 'string' ? text.trim() : '';
    const cwd = this.cwds.get(runId);
    if (t) run.send(t, validImages(images), cwd ? stageAttachments(cwd, files) : []);
  }

  respond(runId: string, requestId: string, choiceId: string | null): void {
    const run = this.runs.get(runId);
    if (!run?.respond) throw new Error('This run is not waiting for you');
    run.respond(requestId, choiceId);
  }

  answer(runId: string, requestId: string, answer: QuestionAnswer | null): void {
    const run = this.runs.get(runId);
    if (!run?.answer) throw new Error('This run is not waiting for you');
    run.answer(requestId, answer);
  }

  async configure(runId: string, change: unknown): Promise<void> {
    const run = this.runs.get(runId);
    if (!run?.configure) throw new Error('This agent cannot change settings while it runs');
    const c = (change ?? {}) as { mode?: unknown; option?: { id?: unknown; value?: unknown } };
    const id = /^[\w.:/@\[\]-]{1,80}$/;
    const mode = typeof c.mode === 'string' && id.test(c.mode) ? c.mode : undefined;
    const option =
      c.option && typeof c.option.id === 'string' && typeof c.option.value === 'string' && id.test(c.option.id) && id.test(c.option.value)
        ? { id: c.option.id, value: c.option.value }
        : undefined;
    if (!mode && !option) throw new Error('Nothing to change');
    await run.configure({ mode, option });
  }

  interrupt(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.interrupt) run.interrupt();
    else this.stop(runId);
  }

  stop(runId: string): void {
    this.runs.get(runId)?.stop();
    this.runs.delete(runId);
    this.cwds.delete(runId);
    this.waiting.delete(runId);
    this.active.delete(runId);
    this.pilots.delete(runId);
  }

  stopAll(): void {
    for (const run of this.runs.values()) run.stop();
    this.runs.clear();
    this.waiting.clear();
    this.active.clear();
  }
}
