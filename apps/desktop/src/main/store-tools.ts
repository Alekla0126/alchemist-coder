import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { SessionMcpServer } from '@alchemist-coder/core';
import { readMcp, type AgentId } from '@alchemist-coder/extensions';

/**
 * Google Play Console, App Store Connect and AdMob tools for every run, through their official APIs
 * (app-console-mcp: listings, releases, rollouts, reviews, vitals, App Review, sales, ad earnings),
 * so agents never drive those consoles in a browser. Only the services you have set up are added: a
 * run gets no extra tools (and no extra tokens) until you do. uv runs the pinned release; no git needed.
 */
export const APP_CONSOLE_VERSION = '0.1.0';
export const APP_CONSOLE_SOURCE = `app-console-mcp @ https://github.com/Alekla0126/app-console-mcp/archive/refs/tags/v${APP_CONSOLE_VERSION}.zip`;

export type StoreService = 'play' | 'appstore' | 'admob';
export const STORE_SERVER: Record<StoreService, string> = { play: 'alchemist_play', appstore: 'alchemist_appstore', admob: 'alchemist_admob' };

/** What app-console reads, from the environment first and then its config file. */
const SETTINGS = ['GOOGLE_PLAY_SERVICE_ACCOUNT', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY_PATH', 'ASC_PRIVATE_KEY', 'ASC_API_KEY_JSON', 'ASC_VENDOR_NUMBER', 'ADMOB_PUBLISHER_ID', 'ADMOB_TOKEN_FILE', 'APPCONSOLE_HOME'];
/** What uv and Google's auth need: an agent may start the server with only the env it's given. */
const PASS = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG'];

/** A value, or '' when empty or an unfilled `${…}` placeholder. */
const value = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.startsWith('${') ? '' : s;
};
const expand = (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
const isFile = (p: string) => !!p && !!statSync(p, { throwIfNoEntry: false })?.isFile();

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The services whose credentials are in place, the way app-console finds them. */
export function configuredServices(env: NodeJS.ProcessEnv, home: string): StoreService[] {
  const dir = expand(value(env.APPCONSOLE_HOME), home) || join(home, '.config', 'appconsole');
  const config = readJson(join(dir, 'config.json'));
  const get = (k: string) => value(env[k]) || value(config[k]);
  const file = (k: string) => isFile(expand(get(k), home));
  const out: StoreService[] = [];
  if (file('GOOGLE_PLAY_SERVICE_ACCOUNT')) out.push('play');
  if (file('ASC_API_KEY_JSON') || (get('ASC_KEY_ID') && get('ASC_ISSUER_ID'))) out.push('appstore');
  // AdMob takes a Google user: the token `appconsole admob login` saves, or gcloud's once a publisher is named.
  if (isFile(expand(get('ADMOB_TOKEN_FILE'), home) || join(dir, 'admob-token.json')) || get('ADMOB_PUBLISHER_ID')) out.push('admob');
  return out;
}

/** The first `uvx` on PATH (the login shell's PATH is adopted at startup). */
export function findUvx(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const bin = platform === 'win32' ? 'uvx.exe' : 'uvx';
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const p = dir && join(dir, bin);
    if (p && isFile(p)) return p;
  }
  return null;
}

const mentionsAppConsole = (parts: Array<string | undefined>) => parts.some((a) => !!a && /\bappconsole\b|app-console-mcp/.test(a));

/** The agent already gets app-console from its own config or a Claude Code plugin: not twice. */
export function alreadyConfigured(agent: string, cwd: string, env: NodeJS.ProcessEnv, home: string): boolean {
  const own = readMcp({ home, codex: env.CODEX_HOME, grok: env.GROK_HOME }, cwd).some(
    (m) => !!m.agents[agent as AgentId] && mentionsAppConsole([m.def.command, ...(m.def.args ?? [])]),
  );
  if (own || agent !== 'claude-code') return own;
  const settings = readJson(join(value(env.CLAUDE_CONFIG_DIR) || join(home, '.claude'), 'settings.json'));
  const plugins = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? (settings.enabledPlugins as Record<string, unknown>) : {};
  return Object.entries(plugins).some(([id, on]) => on === true && id.endsWith('@app-console'));
}

/** The store servers for one run of `agent` in `cwd`; [] when nothing is set up, uv is missing or the agent has them already. */
export function storeMcpServers(agent: string, cwd: string, opts: { env?: NodeJS.ProcessEnv; home?: string; uvx?: string | null } = {}): SessionMcpServer[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const services = configuredServices(env, home);
  if (!services.length) return [];
  const uvx = opts.uvx === undefined ? findUvx(env) : opts.uvx;
  if (!uvx) return [];
  try {
    if (alreadyConfigured(agent, cwd, env, home)) return [];
  } catch {
    // an agent config that can't be read: add them
  }
  const pass = Object.fromEntries([...PASS, ...SETTINGS].flatMap((k) => (env[k] ? [[k, env[k]!]] : [])));
  return services.map((s) => ({ name: STORE_SERVER[s], command: uvx, args: ['--quiet', '--from', APP_CONSOLE_SOURCE, 'appconsole', 'mcp', s], env: pass }));
}
