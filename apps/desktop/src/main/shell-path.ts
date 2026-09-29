import { execFileSync } from 'node:child_process';

/**
 * Apps launched from the Finder or Dock get a minimal PATH, so user-installed CLIs
 * like `claude` or `codex` would not be found. Read the PATH from the login shell once.
 */
export function adoptLoginShellPath(): void {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const path = /__PATH__(.*)__PATH__/s.exec(out)?.[1];
    if (path) process.env.PATH = [...new Set([...path.split(':'), ...(process.env.PATH ?? '').split(':')])].filter(Boolean).join(':');
  } catch {
    // keep the inherited PATH
  }
}
