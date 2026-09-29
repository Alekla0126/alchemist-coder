import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, join } from 'node:path';
import type { IDisposable, IPty } from 'node-pty';

type PtyModule = typeof import('node-pty');

let pty: PtyModule | null = null;
let loadError: string | null = null;
try {
  // Native module: if it was not rebuilt for this Electron, the rest of the app still works.
  pty = createRequire(import.meta.url)('node-pty') as PtyModule;
} catch (error) {
  loadError = error instanceof Error ? error.message : String(error);
}

export class TerminalManager {
  private readonly terms = new Map<string, IPty>();
  private readonly subs = new Map<string, IDisposable[]>();
  private next = 1;

  constructor(private readonly emit: (channel: 'data' | 'exit', payload: { id: string; data?: string; code?: number }) => void) {}

  available(): { ok: boolean; error: string | null } {
    return { ok: pty != null, error: loadError };
  }

  /** The shells a terminal can start: the user's login shell first, then the others installed. */
  shells(): ShellInfo[] {
    return installedShells();
  }

  /** Starts a terminal with `shell` if it's one of the installed shells, else the default one. */
  create(cwd: string, cols: number, rows: number, shell?: unknown): { id: string; shell: ShellInfo } {
    if (!pty) throw new Error(`Terminal unavailable: ${loadError ?? 'node-pty not loaded'}`);
    const shells = installedShells();
    const chosen = shells.find((s) => s.path === shell) ?? shells[0]!;
    const id = `term-${this.next++}`;
    const term = pty.spawn(chosen.path, chosen.args, {
      name: 'xterm-256color',
      cols: clamp(cols, 20, 500),
      rows: clamp(rows, 5, 200),
      cwd,
      env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AlchemistCoder' },
    });
    this.subs.set(id, [
      term.onData((data) => this.emit('data', { id, data })),
      term.onExit(({ exitCode }) => {
        this.terms.delete(id);
        this.subs.delete(id);
        this.emit('exit', { id, code: exitCode });
      }),
    ]);
    this.terms.set(id, term);
    return { id, shell: chosen };
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.terms.get(id)?.resize(clamp(cols, 20, 500), clamp(rows, 5, 200));
    } catch {
      // the process may have just exited
    }
  }

  /** Ends a terminal without reporting its last output or exit: nobody is listening any more. */
  kill(id: string): void {
    for (const s of this.subs.get(id) ?? []) s.dispose();
    this.subs.delete(id);
    try {
      this.terms.get(id)?.kill();
    } catch {
      // already gone
    }
    this.terms.delete(id);
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

export interface ShellInfo {
  path: string;
  label: string;
  args: string[];
}

/** Shells people use as their daily terminal; login flags make them read the usual profile files. */
const KNOWN: Record<string, string[]> = { zsh: ['-l'], bash: ['-l'], fish: ['-l'], nu: ['-l'], ksh: ['-l'], tcsh: ['-l'], dash: ['-l'], sh: ['-l'], pwsh: ['-NoLogo'], 'powershell.exe': ['-NoLogo'], 'pwsh.exe': ['-NoLogo'], 'cmd.exe': [] };

export function installedShells(): ShellInfo[] {
  const info = (path: string): ShellInfo => ({ path, label: basename(path).replace(/\.exe$/i, ''), args: KNOWN[basename(path)] ?? [] });
  if (process.platform === 'win32') {
    const onPath = (exe: string) => (process.env.PATH ?? '').split(delimiter).map((d) => join(d, exe)).find((p) => existsSync(p));
    const found = ['pwsh.exe', 'powershell.exe', 'cmd.exe'].map(onPath).filter((p): p is string => !!p).map(info);
    return found.length ? found : [info('powershell.exe')];
  }
  let listed: string[] = [];
  try {
    listed = readFileSync('/etc/shells', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
  } catch {
    // no /etc/shells: just the login shell
  }
  const login = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  const seen = new Set<string>();
  const out: ShellInfo[] = [];
  for (const path of [login, ...listed]) {
    const name = basename(path);
    // One entry per shell (skip /usr/bin/zsh when /bin/zsh is listed), only ones that exist.
    if (!(name in KNOWN) || seen.has(name) || !existsSync(path)) continue;
    seen.add(name);
    out.push(info(path));
  }
  return out.length ? out : [info(login)];
}

const clamp = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min);
