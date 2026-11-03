import { realpathSync } from 'node:fs';
import { delimiter } from 'node:path';
import { binaryPath, detectBinary } from './detect.ts';

export interface CodexCliResolution {
  path: string | null;
  version: string | null;
  /** Broken installations skipped while looking through PATH; never CLI stderr or credentials. */
  skippedPaths: string[];
  error: string | null;
}

/** Resolve before npx changes PATH. Never substitute the adapter's bundled Codex. */
export async function resolveCodexCli(options: {
  env?: NodeJS.ProcessEnv;
  detect?: typeof detectBinary;
  signal?: AbortSignal;
} = {}): Promise<CodexCliResolution> {
  const env = { ...process.env, ...options.env };
  const explicit = env.CODEX_PATH?.trim();
  const searchPath = env.PATH ?? env.Path ?? '';
  const candidates = explicit
    ? [binaryPath(explicit, searchPath) ?? explicit]
    : [...new Set(searchPath.split(delimiter).filter(Boolean).flatMap((dir) => binaryPath('codex', dir) ?? []))];
  const skippedPaths: string[] = [];
  for (const candidate of candidates) {
    if (options.signal?.aborted) return { path: null, version: null, skippedPaths, error: 'Codex catalog request cancelled.' };
    const result = await (options.detect ?? detectBinary)(candidate, env, options.signal);
    if (options.signal?.aborted) return { path: null, version: null, skippedPaths, error: 'Codex catalog request cancelled.' };
    if (result.installed) {
      let path = candidate;
      try { path = realpathSync(candidate); } catch { /* Injected probes can supply virtual paths. */ }
      return { path, version: result.version, skippedPaths, error: null };
    }
    skippedPaths.push(candidate);
  }
  return { path: null, version: null, skippedPaths, error: explicit
    ? 'The configured CODEX_PATH cannot run. Repair that installation or choose its correct path; no other Codex was started.'
    : 'No working Codex CLI was found on PATH. Repair or install Codex, then refresh the catalog; the adapter\'s bundled runtime was not used.' };
}
