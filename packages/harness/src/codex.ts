import { mentionFiles, type HarnessAdapter, type PromptFile, type PromptImage, type RunOptions } from '@alchemist-coder/core';
import { RunBase, spawn, type SpawnFn } from './process.ts';
import { parseCodexLine } from './stream.ts';
import { resolveCodexCli } from './codex-cli.ts';
import { readCodexRuntime, requireCodexSelection } from './codex-runtime.ts';

const SANDBOX: Record<NonNullable<RunOptions['permissionMode']>, string> = {
  default: 'read-only',
  acceptEdits: 'workspace-write',
  plan: 'read-only',
  bypassPermissions: 'danger-full-access',
};

/** Codex exec runs one turn per process; follow-ups resume the same thread. */
class CodexRun extends RunBase {
  private threadId: string | null;
  private readonly queue: string[] = [];
  private cliPath: string | null = null;
  private failed = false;
  private busy = false;

  constructor(
    private readonly options: RunOptions,
    private readonly resolveCli: typeof resolveCodexCli,
    private readonly spawnFn: SpawnFn,
    private readonly configuredBin?: string,
  ) {
    super();
    this.threadId = options.resumeSessionId ?? null;
    void this.turn(mentionFiles(options.prompt, options.files));
  }

  private async turn(prompt: string) {
    if (this.stopped || this.failed) return;
    this.busy = true;
    const o = this.options;
    if (o.fork) {
      // `codex exec` has no fork; resuming would change the original conversation.
      this.emit({ type: 'error', message: "Codex can't fork a conversation without its ACP adapter; continue it instead." });
      this.emit({ type: 'status', status: 'error' });
      this.busy = false;
      this.failed = true;
      return;
    }
    let env: Record<string, string>;
    let bin: string;
    try {
      env = { ...(process.env as Record<string, string>), ...(await o.provider.env(o.model)) };
      if (!this.cliPath) {
        const cli = await this.resolveCli({ env: { ...env, ...(this.configuredBin ? { CODEX_PATH: this.configuredBin } : {}) } });
        if (!cli.path) throw new Error(cli.error!);
        this.cliPath = cli.path;
      }
      bin = this.cliPath;
      if (o.provider.id === 'openai') requireCodexSelection(await readCodexRuntime({ bin, env }), o.model, o.effort);
    } catch (error) {
      this.failed = true;
      this.busy = false;
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.emit({ type: 'status', status: 'error' });
      return;
    }
    if (this.stopped) { this.busy = false; return; }
    const common = ['--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-c', `sandbox_mode="${SANDBOX[o.permissionMode ?? 'acceptEdits']}"`, ...(o.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(o.effort)}`] : []), ...(o.provider.cliArgs?.('codex', o.model) ?? ['-m', o.model])];
    // `--` ends the options: a prompt (or thread id) starting with a dash can't pass as a flag.
    const args = this.threadId ? ['exec', 'resume', ...common, '--', this.threadId, prompt] : ['exec', ...common, '--', prompt];
    let child: ReturnType<SpawnFn>;
    try {
      child = this.spawnFn(bin, args, { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.failed = true;
      this.busy = false;
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.emit({ type: 'status', status: 'error' });
      return;
    }
    this.emit({ type: 'status', status: 'running' });
    this.attach(
      child,
      (line) => {
        const events = parseCodexLine(line);
        for (const e of events) if (e.type === 'started' && e.sessionId) this.threadId = e.sessionId;
        for (const e of events) if (e.type === 'error' && /model_not_found|model[^\n]+not supported[^\n]+(?:ChatGPT|account)/i.test(e.message)) this.failed = true;
        return events;
      },
      (code) => {
        this.busy = false;
        const next = this.queue.shift();
        if (next && !this.stopped && !this.failed) void this.turn(next);
        else this.emit({ type: 'status', status: this.stopped ? 'interrupted' : !this.failed && code === 0 ? 'done' : 'error' });
      },
    );
  }

  override send(textIn: string, _images?: PromptImage[], files: PromptFile[] = []): void {
    if (this.failed) throw new Error('Codex stopped after an error. Refresh its catalog before continuing the saved conversation; this message was not sent.');
    const text = mentionFiles(textIn, files);
    if (this.busy) this.queue.push(text);
    else void this.turn(text);
  }
}

export function codexHarness(options: { bin?: string; spawn?: SpawnFn; resolveCli?: typeof resolveCodexCli } = {}): HarnessAdapter {
  const spawnFn = options.spawn ?? spawn;
  return {
    id: 'codex',
    label: 'Codex',
    detect: async () => { const cli = await (options.resolveCli ?? resolveCodexCli)({ env: options.bin ? { CODEX_PATH: options.bin } : undefined }); return { installed: !!cli.path, version: cli.version, path: cli.path }; },
    run: (runOptions) => new CodexRun(runOptions, options.resolveCli ?? resolveCodexCli, spawnFn, options.bin),
  };
}
