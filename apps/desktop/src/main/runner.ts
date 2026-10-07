import { statSync } from 'node:fs';
import { cliStatus } from './cli-status';
import { installStep } from './install';
import { cliSearchPath } from './shell-path';
import { detectBinary } from '@alchemist-coder/harness';
import { isLocalEndpoint, type ExtensionRegistry, type QuestionAnswer, type RunHandle, type SessionMcpServer, validImages } from '@alchemist-coder/core';
import type { PermissionMode, RunnerCatalog, RunnerEventMessage, StartRunRequest } from '../shared/api';

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export class RunnerManager {
  private readonly runs = new Map<string, RunHandle>();
  private readonly observers = new Set<(message: RunnerEventMessage) => void>();

  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly emit: (message: RunnerEventMessage) => void,
    /** Providers allowed in the Community edition although they aren't local (a personal module's). */
    private readonly exempt: ReadonlySet<string> = new Set(),
    /** Agents only run inside the user's projects (and Arena worktrees in them). */
    private readonly isProjectFolder?: (cwd: string) => boolean,
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
  /** `internal`: what only the main process may add (the bots' own MCP server). */
  start(request: StartRunRequest, internal: { mcpServers?: SessionMcpServer[] } = {}): { runId: string } {
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
    const handle = harness.run({ cwd, prompt, images: validImages(request.images), provider, model, resumeSessionId: resume, fork: !!resume && request.fork === true, permissionMode, effort, mcpServers: internal.mcpServers });
    this.runs.set(handle.id, handle);
    handle.onEvent((event) => {
      const message = { runId: handle.id, event };
      this.emit(message);
      for (const o of this.observers) o(message);
    });
    return { runId: handle.id };
  }

  /** Main-process listeners (e.g. the Arena) see every run's events too. */
  observe(listener: (message: RunnerEventMessage) => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  isRunning(runId: string): boolean {
    return this.runs.has(runId);
  }

  async setCredential(providerId: string, value: string | null): Promise<void> {
    const provider = this.registry.providers.get(String(providerId));
    if (!provider?.credential) throw new Error('This provider has no credential');
    const v = typeof value === 'string' ? value.trim() : null;
    if (v && (v.length > 400 || /\s/.test(v))) throw new Error('That does not look like an API key');
    await this.registry.secrets.set(provider.credential.key, v || null);
  }

  send(runId: string, text: string, images?: unknown): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error('This run has ended');
    const t = typeof text === 'string' ? text.trim() : '';
    if (t) run.send(t, validImages(images));
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
  }

  stopAll(): void {
    for (const run of this.runs.values()) run.stop();
    this.runs.clear();
  }
}
