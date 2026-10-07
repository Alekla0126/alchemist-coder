import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Where agent CLIs and Node.js usually get installed: they're looked up there too, so they're found
 * even before (or without) the login shell's PATH. The newest Node of nvm only.
 */
export function commonBinDirs(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, list: (dir: string) => string[] = readdirSync): string[] {
  if (platform === 'win32') {
    return [env.ProgramFiles && join(env.ProgramFiles, 'nodejs'), env.APPDATA && join(env.APPDATA, 'npm'), join(home, '.local', 'bin')].filter((d): d is string => !!d);
  }
  let nvm: string[] = [];
  try {
    const versions = join(home, '.nvm', 'versions', 'node');
    nvm = list(versions)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .slice(0, 1)
      .map((v) => join(versions, v, 'bin'));
  } catch {
    // no nvm
  }
  return [
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : []),
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.claude', 'local'),
    ...nvm,
    ...(platform === 'linux' ? ['/snap/bin'] : []),
  ];
}

/** The folders of each PATH in turn, each once. */
export function mergePath(...paths: string[]): string {
  return [...new Set(paths.flatMap((p) => p.split(delimiter)).filter(Boolean))].join(delimiter);
}

const isDir = (dir: string) => !!statSync(dir, { throwIfNoEntry: false })?.isDirectory();

/** The usual install folders that exist now, after the PATH's own (Node.js installed since is found). */
function addCommonDirs() {
  const dirs = commonBinDirs(process.platform, homedir(), process.env).filter(isDir);
  process.env.PATH = mergePath(process.env.PATH ?? '', dirs.join(delimiter));
}

let loginPath: Promise<void> | null = null;

/**
 * Apps launched from the Finder or Dock get a minimal PATH, so user-installed CLIs like `claude`,
 * `codex` or `npx` would not be found. The usual install folders are added right away; the login
 * shell's PATH, first, once the shell answers (version managers and banners can take seconds).
 */
export function adoptLoginShellPath(): Promise<void> {
  addCommonDirs();
  if (process.platform === 'win32') return Promise.resolve();
  loginPath ??= new Promise<void>((resolve) => {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const child = execFile(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 20_000 }, (_error, stdout) => {
      const path = /__PATH__(.*)__PATH__/s.exec(stdout ?? '')?.[1];
      if (path) process.env.PATH = mergePath(path, process.env.PATH ?? '');
      resolve();
    });
    child.stdin?.end();
  });
  return loginPath;
}

/** Adds the folders installed since (Node.js just installed); resolves once the login shell's PATH is in too. */
export function cliSearchPath(): Promise<void> {
  addCommonDirs();
  return (loginPath ?? adoptLoginShellPath()).then(addCommonDirs);
}
