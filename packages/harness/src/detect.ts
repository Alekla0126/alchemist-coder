import { execFile } from 'node:child_process';
import { isBatchShim } from './process.ts';

/** Finds a CLI on PATH and reads its version (without a shell, except for Windows .cmd shims). */
export function detectBinary(bin: string): Promise<{ installed: boolean; version: string | null; path: string | null }> {
  return new Promise((resolve) => {
    if (!/^[\w@.:/\\ -]+$/.test(bin)) return resolve({ installed: false, version: null, path: null });
    const shell = isBatchShim(bin) && !bin.includes(' ');
    execFile(bin, ['--version'], { timeout: 8000, env: process.env, shell }, (error, stdout) => {
      if (error) return resolve({ installed: false, version: null, path: null });
      const version = /\d+\.\d+\.\d+[\w.-]*/.exec(stdout)?.[0] ?? stdout.trim().slice(0, 40);
      resolve({ installed: true, version, path: bin });
    });
  });
}
