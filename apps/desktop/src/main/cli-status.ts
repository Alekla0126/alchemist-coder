import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { detectBinary } from '@alchemist-coder/harness';

export interface CliStatus {
  /** The CLI's own version (the ACP adapter has its own). */
  cliVersion: string | null;
  /** null = can't tell from what the CLI keeps locally. */
  signedIn: boolean | null;
  account: string | null;
  /** Where the CLI that runs is installed (several installs are common). */
  cliPath: string | null;
}

/** The first `bin` on PATH, symlinks resolved. */
function onPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = dir && join(dir, bin);
    if (p && statSync(p, { throwIfNoEntry: false })?.isFile()) {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    }
  }
  return null;
}

const BINARY: Record<string, string> = { 'claude-code': 'claude', codex: 'codex' };

/**
 * Whether each agent CLI is signed in, from what it keeps on disk. Only presence is checked:
 * tokens are never read or returned.
 */
export async function cliStatus(harnessId: string): Promise<CliStatus> {
  const bin = BINARY[harnessId];
  const version = bin ? (await detectBinary(bin)).version : null;
  const cliPath = bin ? onPath(bin) : null;
  const home = homedir();
  if (harnessId === 'claude-code') {
    try {
      const file = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json');
      const account = (JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount;
      return { cliVersion: version, signedIn: !!account, account: typeof account?.emailAddress === 'string' ? account.emailAddress : null, cliPath };
    } catch {
      return { cliVersion: version, signedIn: false, account: null, cliPath };
    }
  }
  if (harnessId === 'codex') {
    const auth = join(process.env.CODEX_HOME ?? join(home, '.codex'), 'auth.json');
    return { cliVersion: version, signedIn: existsSync(auth), account: null, cliPath };
  }
  return { cliVersion: version, signedIn: null, account: null, cliPath };
}
