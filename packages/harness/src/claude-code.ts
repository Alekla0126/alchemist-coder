import type { HarnessAdapter, RunOptions } from '@alchemist-coder/core';
import { detectBinary } from './detect.ts';
import { RunBase, spawn, type SpawnFn } from './process.ts';
import { parseClaudeLine } from './stream.ts';

class ClaudeRun extends RunBase {
  constructor(options: RunOptions, bin: string, spawnFn: SpawnFn) {
    super();
    void this.start(options, bin, spawnFn);
  }

  private async start(o: RunOptions, bin: string, spawnFn: SpawnFn) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode', o.permissionMode ?? 'acceptEdits',
    ];
    if (o.resumeSessionId) args.push(`--resume=${o.resumeSessionId}`);
    if (o.fork) args.push('--fork-session');
    args.push(...(o.provider.cliArgs?.('claude-code', o.model) ?? ['--model', o.model]));
    let env: Record<string, string>;
    try {
      env = { ...(process.env as Record<string, string>), ...(await o.provider.env(o.model)) };
    } catch (error) {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.emit({ type: 'status', status: 'error' });
      return;
    }
    if (this.stopped) return;
    const state = { streamed: false };
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(bin, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.emit({ type: 'status', status: 'error' });
      return;
    }
    this.emit({ type: 'status', status: 'running' });
    this.attach(child, (line) => parseClaudeLine(line, state), (code) => {
      this.emit({ type: 'status', status: this.stopped ? 'interrupted' : code === 0 ? 'done' : 'error' });
    });
    this.send(o.prompt);
  }

  override send(text: string): void {
    // stream-json input keeps one process alive across turns.
    this.child?.stdin?.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
  }
}

export function claudeCodeHarness(options: { bin?: string; spawn?: SpawnFn } = {}): HarnessAdapter {
  const bin = options.bin ?? 'claude';
  const spawnFn = options.spawn ?? spawn;
  return {
    id: 'claude-code',
    label: 'Claude Code',
    detect: () => detectBinary(bin),
    run: (runOptions) => new ClaudeRun(runOptions, bin, spawnFn),
  };
}
