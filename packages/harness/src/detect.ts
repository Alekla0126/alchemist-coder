import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { isBatchShim } from './process.ts';

/** Resolve before npx prepends its bundled binaries to PATH. Keep explicit paths intact. */
export function binaryPath(bin: string, searchPath = process.env.PATH ?? ''): string | null {
  if (isAbsolute(bin)) return bin;
  const suffixes = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  const dirs = /[\\/]/.test(bin) ? ['.'] : searchPath.split(delimiter).filter(Boolean);
  for (const dir of dirs) for (const suffix of suffixes) {
    const path = resolve(dir, bin + suffix);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return path;
    } catch { /* next candidate */ }
  }
  return null;
}

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
