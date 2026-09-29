import type { HarnessAdapter, RunOptions } from '@alchemist-coder/core';
import { detectBinary } from './detect.ts';
import { RunBase, spawn, type SpawnFn } from './process.ts';
import { parseCodexLine } from './stream.ts';

const SANDBOX: Record<NonNullable<RunOptions['permissionMode']>, string> = {
  default: 'workspace-write',
  acceptEdits: 'workspace-write',
  plan: 'read-only',
  bypassPermissions: 'danger-full-access',
};

/** Codex exec runs one turn per process; follow-ups resume the same thread. */
class CodexRun extends RunBase {
  private threadId: string | null;
  private readonly queue: string[] = [];

  constructor(
    private readonly options: RunOptions,
    private readonly bin: string,
    private readonly spawnFn: SpawnFn,
  ) {
    super();
    this.threadId = options.resumeSessionId ?? null;
    void this.turn(options.prompt);
  }

  private async turn(prompt: string) {
    const o = this.options;
    if (o.fork) {
      // `codex exec` has no fork; resuming would change the original conversation.
      this.emit({ type: 'error', message: "Codex can't fork a conversation without its ACP adapter; continue it instead." });
      this.emit({ type: 'status', status: 'error' });
      return;
    }
    let env: Record<string, string>;
    try {
      env = { ...(process.env as Record<string, string>), ...(await o.provider.env(o.model)) };
    } catch (error) {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.emit({ type: 'status', status: 'error' });
      return;
    }
    if (this.stopped) return;
    const common = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode="${SANDBOX[o.permissionMode ?? 'acceptEdits']}"`, ...(o.provider.cliArgs?.('codex', o.model) ?? ['-m', o.model])];
    // `--` ends the options: a prompt (or thread id) starting with a dash can't pass as a flag.
    const args = this.threadId ? ['exec', 'resume', ...common, '--', this.threadId, prompt] : ['exec', ...common, '--', prompt];
    let child: ReturnType<SpawnFn>;
    try {
      child = this.spawnFn(this.bin, args, { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
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
        return events;
      },
      (code) => {
        const next = this.queue.shift();
        if (next && !this.stopped) void this.turn(next);
        else this.emit({ type: 'status', status: this.stopped ? 'interrupted' : code === 0 ? 'done' : 'error' });
      },
    );
  }

  override send(text: string): void {
    if (this.child) this.queue.push(text);
    else void this.turn(text);
  }
}

export function codexHarness(options: { bin?: string; spawn?: SpawnFn } = {}): HarnessAdapter {
  const bin = options.bin ?? 'codex';
  const spawnFn = options.spawn ?? spawn;
  return {
    id: 'codex',
    label: 'Codex',
    detect: () => detectBinary(bin),
    run: (runOptions) => new CodexRun(runOptions, bin, spawnFn),
  };
}
