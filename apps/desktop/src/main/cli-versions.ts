import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { detectBinary } from '@alchemist-coder/harness';
import type { CliVersion } from '../shared/api';

const DAY = 86_400_000;

/** "2.1.220 (Claude Code)", "kimi, version 1.33.0", "codex-cli 0.150.1" → the version number. */
export function versionOf(text: string | null | undefined): string | null {
  return /\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?/.exec(text ?? '')?.[0] ?? null;
}

/** Whether `latest` is newer than `installed` (numbers compared part by part; a pre-release is older). */
export function isNewer(latest: string | null, installed: string | null): boolean {
  if (!latest || !installed) return false;
  const parse = (v: string) => {
    const [main = '', pre] = v.split('-');
    return { parts: main.split('.').map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const a = parse(latest);
  const b = parse(installed);
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const d = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (d) return d > 0;
  }
  return !a.pre && !!b.pre;
}

/** How each CLI updates itself, from where it's installed: Homebrew, npm, uv, pipx, or its own updater. */
export function updateCommand(id: CliVersion['id'], path: string | null): string | null {
  const p = (path ?? '').replace(/\\/g, '/');
  if (id === 'claude') {
    if (p.includes('/Caskroom/claude-code/')) return 'brew upgrade --cask claude-code';
    if (p.includes('/node_modules/@anthropic-ai/claude-code')) return 'npm install -g @anthropic-ai/claude-code@latest';
    return 'claude update';
  }
  if (id === 'codex') {
    if (p.includes('/Caskroom/codex/')) return 'brew upgrade --cask codex';
    if (p.includes('/Cellar/codex/')) return 'brew upgrade codex';
    if (p.includes('/node_modules/@openai/codex')) return 'npm install -g @openai/codex@latest';
    return 'codex update';
  }
  if (p.includes('/uv/tools/kimi-cli/')) return 'uv tool upgrade kimi-cli';
  if (p.includes('/pipx/venvs/kimi-cli/')) return 'pipx upgrade kimi-cli';
  return null;
}

/** The first `bin` on PATH, symlinks resolved (where it's really installed). */
function where(bin: string): string | null {
  const names = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const p = dir && join(dir, name);
      if (!p || !statSync(p, { throwIfNoEntry: false })?.isFile()) continue;
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    }
  }
  return null;
}

/** Where the CLIs keep the newest version they've seen themselves (no request needed while it's fresh). */
export interface LatestHomes {
  /** ~/.codex/version.json: {"latest_version": "0.154.0", "last_checked_at": "…"} */
  codexVersionFile: string;
  /** ~/.kimi/latest_version.txt: "1.35.0" */
  kimiVersionFile: string;
}

export const defaultLatestHomes = (): LatestHomes => ({
  codexVersionFile: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'version.json'),
  kimiVersionFile: join(homedir(), '.kimi', 'latest_version.txt'),
});

/** What a CLI noted itself, when it's no older than three days. */
export function noted(id: CliVersion['id'], homes: LatestHomes, now = Date.now()): string | null {
  try {
    if (id === 'codex' && existsSync(homes.codexVersionFile)) {
      const o = JSON.parse(readFileSync(homes.codexVersionFile, 'utf8')) as { latest_version?: unknown; last_checked_at?: unknown };
      const at = Date.parse(String(o.last_checked_at ?? '')) || statSync(homes.codexVersionFile).mtimeMs;
      return now - at < 3 * DAY ? versionOf(String(o.latest_version ?? '')) : null;
    }
    if (id === 'kimi' && existsSync(homes.kimiVersionFile)) {
      return now - statSync(homes.kimiVersionFile).mtimeMs < 3 * DAY ? versionOf(readFileSync(homes.kimiVersionFile, 'utf8')) : null;
    }
  } catch {
    // unreadable: ask the registry
  }
  return null;
}

/** Where each CLI is published. */
const REGISTRY: Record<CliVersion['id'], string> = {
  claude: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
  codex: 'https://registry.npmjs.org/@openai/codex/latest',
  kimi: 'https://pypi.org/pypi/kimi-cli/json',
};

async function published(id: CliVersion['id']): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY[id], { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const o = (await res.json()) as { version?: unknown; info?: { version?: unknown } };
    return versionOf(String(o.version ?? o.info?.version ?? ''));
  } catch {
    return null;
  }
}

const CLIS: Array<{ id: CliVersion['id']; label: string; bin: string }> = [
  { id: 'claude', label: 'Claude Code', bin: 'claude' },
  { id: 'codex', label: 'Codex', bin: 'codex' },
  { id: 'kimi', label: 'Kimi CLI', bin: 'kimi' },
];

/**
 * Each CLI's installed version and the newest one out. The newest comes from what the CLI noted itself
 * (Codex, Kimi) or, at most once a day per CLI, from its registry; the answers are kept in `cacheFile`.
 */
export class CliVersions {
  private cache: Record<string, { at: number; version: string | null }> = {};

  constructor(
    private readonly cacheFile?: string,
    private readonly homes: LatestHomes = defaultLatestHomes(),
    private readonly lookup: (id: CliVersion['id']) => Promise<string | null> = published,
  ) {
    try {
      if (cacheFile && existsSync(cacheFile)) this.cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as typeof this.cache;
    } catch {
      this.cache = {};
    }
  }

  private async latest(id: CliVersion['id'], now: number): Promise<string | null> {
    const own = noted(id, this.homes, now);
    if (own) return own;
    const kept = this.cache[id];
    if (kept && now - kept.at < DAY) return kept.version;
    const version = await this.lookup(id);
    // A failed lookup keeps the last answer and tries again in a day.
    this.cache[id] = { at: now, version: version ?? kept?.version ?? null };
    this.save();
    return this.cache[id]!.version;
  }

  private save() {
    if (!this.cacheFile) return;
    try {
      writeFileSync(`${this.cacheFile}.tmp`, JSON.stringify(this.cache));
      renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
    } catch {
      // asked again next launch
    }
  }

  /** The CLIs that are installed (an uninstalled one isn't listed). */
  async check(now = Date.now()): Promise<CliVersion[]> {
    const found = await Promise.all(
      CLIS.map(async ({ id, label, bin }) => {
        const d = await detectBinary(bin);
        if (!d.installed) return null;
        const version = versionOf(d.version);
        const latest = await this.latest(id, now);
        const outdated = isNewer(latest, version);
        return { id, label, version, latest, outdated, update: outdated ? updateCommand(id, where(bin)) : null };
      }),
    );
    return found.filter((v): v is CliVersion => !!v);
  }
}
