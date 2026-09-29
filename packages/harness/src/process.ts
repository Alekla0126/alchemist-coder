import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RunnerEvent, RunHandle, PromptImage } from '@alchemist-coder/core';

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Arguments that mean the same to cmd.exe as to the program: no quotes, spaces or metacharacters. */
const PLAIN_ARG = /^[\w@.:/=+-]+$/;

/** On Windows, whether `command` resolves to a .cmd/.bat shim (how npm installs npx, claude, codex…). */
export function isBatchShim(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== 'win32') return false;
  const ext = extname(command).toLowerCase();
  if (ext) return ext === '.cmd' || ext === '.bat';
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase());
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    for (const e of exts) if (dir && existsSync(join(dir, command + e))) return e === '.cmd' || e === '.bat';
  }
  return false;
}

/**
 * spawn() that also starts npm's .cmd shims on Windows, which Node only runs through a shell. That
 * path only takes plain, fixed arguments (package names, flags): anything else could be read as
 * shell syntax, so it's refused rather than quoted.
 */
export const spawn: SpawnFn = (command, args, options) => {
  if (isBatchShim(command, options.env ?? process.env)) {
    if (!args.every((a) => PLAIN_ARG.test(a))) throw new Error(`Can't start ${command} safely on Windows with these arguments.`);
    return nodeSpawn(command, args, { ...options, shell: true });
  }
  return nodeSpawn(command, args, options);
};

/** Ends a process and what it started: its process group on macOS/Linux, its tree on Windows. */
export function killTree(child: ChildProcess, group: boolean): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else if (group) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

let counter = 0;

/** Shared plumbing: event fan-out, line-by-line stdout parsing, bounded stderr. */
export class RunBase implements RunHandle {
  readonly id = `run-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  protected readonly listeners = new Set<(event: RunnerEvent) => void>();
  protected child: ChildProcess | null = null;
  protected stopped = false;

  onEvent(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: RunnerEvent): void {
    for (const l of this.listeners) l(event);
  }

  protected attach(child: ChildProcess, parse: (line: string) => RunnerEvent[], onExit: (code: number | null) => void): void {
    this.child = child;
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => parse(line).forEach((e) => this.emit(e)));
    let stderr = 0;
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep noisy CLIs from flooding the UI.
      if (stderr > 20_000) return;
      stderr += chunk.length;
      this.emit({ type: 'stderr', text: chunk.toString('utf8') });
    });
    child.on('error', (error) => this.emit({ type: 'error', message: error.message }));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      onExit(code);
    });
  }

  send(_text: string, _images?: PromptImage[]): void {}

  stop(): void {
    this.stopped = true;
    if (this.child) killTree(this.child, false);
  }
}
