import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { kindOf, linkTarget, writeFileAtomic } from './fsutil.ts';
import { maskArgs, maskUrl } from './mask.ts';
import type { AgentId, McpDefinition } from './types.ts';

/** Server names that are safe as CLI arguments and as JSON keys. */
export const SERVER_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
export const validServerName = (name: string) => SERVER_NAME.test(name) && !RESERVED.has(name);

/** One CLI call (no shell) that adds a server to an agent's user config. */
export interface CliStep {
  agent: AgentId;
  kind: 'cli';
  command: string;
  args: string[];
}

/** A direct JSON edit, for agents whose CLI can't take every argument safely. */
export interface JsonStep {
  agent: AgentId;
  kind: 'json';
  file: string;
  key: string[];
  value: Record<string, unknown>;
}

export type InstallStep = CliStep | JsonStep;

export class UnsupportedError extends Error {}

const env = (flag: string, e?: Record<string, string>) => Object.entries(e ?? {}).flatMap(([k, v]) => [flag, `${k}=${v}`]);
const headers = (e?: Record<string, string>) => Object.entries(e ?? {}).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);

/**
 * How to add `def` as `name` to one agent's user-level config, using the agent's own CLI
 * (`claude mcp add-json`, `codex mcp add`, `grok mcp add`) or, for Gemini, its settings.json.
 */
export function installStep(agent: AgentId, name: string, def: McpDefinition, homes: { home: string; grokBin?: string }): InstallStep {
  if (!validServerName(name)) throw new UnsupportedError(`Unsupported server name: ${name}`);
  const stdio = def.transport === 'stdio';
  if (stdio && !def.command) throw new UnsupportedError('This server has no command');
  if (!stdio && !def.url) throw new UnsupportedError('This server has no URL');
  switch (agent) {
    case 'claude-code': {
      const json = stdio ? { type: 'stdio', command: def.command, args: def.args ?? [], env: def.env ?? {} } : { type: def.transport, url: def.url, headers: def.headers ?? {} };
      return { agent, kind: 'cli', command: 'claude', args: ['mcp', 'add-json', '--scope', 'user', name, JSON.stringify(json)] };
    }
    case 'codex':
      if (stdio) return { agent, kind: 'cli', command: 'codex', args: ['mcp', 'add', name, ...env('--env', def.env), '--', def.command!, ...(def.args ?? [])] };
      if (def.transport === 'sse' || Object.keys(def.headers ?? {}).length) throw new UnsupportedError('Codex only takes streamable HTTP servers without custom headers from the command line');
      return { agent, kind: 'cli', command: 'codex', args: ['mcp', 'add', name, '--url', def.url!] };
    case 'grok':
      return {
        agent,
        kind: 'cli',
        command: homes.grokBin ?? 'grok',
        args: stdio
          ? ['mcp', 'add', '--scope', 'user', ...env('-e', def.env), name, '--', def.command!, ...(def.args ?? [])]
          : ['mcp', 'add', '--scope', 'user', '--transport', def.transport, ...headers(def.headers), name, def.url!],
      };
    case 'gemini': {
      const value: Record<string, unknown> = stdio
        ? { command: def.command, args: def.args ?? [], ...(def.env && Object.keys(def.env).length ? { env: def.env } : {}) }
        : { [def.transport === 'http' ? 'httpUrl' : 'url']: def.url, ...(def.headers && Object.keys(def.headers).length ? { headers: def.headers } : {}) };
      return { agent, kind: 'json', file: join(homes.home, '.gemini', 'settings.json'), key: ['mcpServers', name], value };
    }
  }
}

/**
 * Applies a JSON step, keeping every other setting as it was. A settings file that doesn't parse is
 * left alone (never overwritten); a symlinked one (dotfiles) is updated at its real location.
 */
export function applyJsonStep(step: JsonStep): void {
  let file = step.file;
  if (kindOf(file) === 'link') {
    const target = linkTarget(file);
    if (!target) throw new Error(`${file} is a broken symlink`);
    file = target;
  }
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object; add the server by hand`);
    data = parsed as Record<string, unknown>;
  }
  let node = data;
  for (const k of step.key.slice(0, -1)) {
    const next = Object.prototype.hasOwnProperty.call(node, k) ? node[k] : undefined;
    node = (node[k] = next && typeof next === 'object' && !Array.isArray(next) ? next : {}) as Record<string, unknown>;
  }
  node[step.key.at(-1)!] = step.value;
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** The server's command or URL, masked, for confirmation dialogs. */
export function describeDefinition(def: McpDefinition): string {
  const env = Object.keys(def.env ?? {}).map((k) => `${k}=•••`);
  const headers = Object.keys(def.headers ?? {}).map((k) => `${k}: •••`);
  if (def.transport === 'stdio') return [maskArgs([def.command ?? '', ...(def.args ?? [])]).join(' '), ...(env.length ? [`env ${env.join(' ')}`] : [])].join('; ');
  return [`${def.transport} ${maskUrl(def.url ?? '')}`, ...(headers.length ? [`headers ${headers.join(', ')}`] : [])].join('; ');
}

/** What a step would do, for the confirmation dialog: secrets masked, the command always shown. */
export function describeStep(step: InstallStep, def?: McpDefinition): string {
  if (step.kind === 'json') return `${step.file} → ${step.key.join('.')}${def ? ` = ${describeDefinition(def)}` : ''}`;
  const masked = maskArgs(step.args);
  // add-json carries the whole definition (with env values) as its last argument.
  if (step.args[1] === 'add-json') masked[masked.length - 1] = def ? `{ ${describeDefinition(def)} }` : '{…}';
  return [step.command, ...masked].join(' ');
}

const IMPORT = '@AGENTS.md';
const IMPORT_RE = /^\s*@\.?\/?AGENTS\.md\s*$/m;

export interface UnifyResult {
  created: string[];
  changed: string[];
}

/**
 * One set of project instructions for every agent: AGENTS.md holds them (Codex and Grok read it
 * natively); CLAUDE.md and GEMINI.md import it with an `@AGENTS.md` line. If AGENTS.md doesn't
 * exist yet, CLAUDE.md's content moves there (then GEMINI.md's), so nothing is duplicated.
 */
export function unifyInstructions(root: string): UnifyResult {
  const path = (n: string) => join(root, n);
  const agentsPath = path('AGENTS.md');
  // Symlinks are never followed: a repo could point CLAUDE.md at ~/.zshrc. CLAUDE.md -> AGENTS.md
  // already shares one file, so it counts as unified.
  const state = (n: string): 'missing' | 'file' | 'shared' => {
    const kind = kindOf(path(n));
    if (kind === 'missing' || kind === 'file') return kind;
    if (kind === 'link' && n !== 'AGENTS.md' && existsSync(agentsPath) && linkTarget(path(n)) === linkTarget(agentsPath)) return 'shared';
    throw new Error(`${n} is a symlink or not a regular file; unify it by hand.`);
  };
  const states = { agents: state('AGENTS.md'), claude: state('CLAUDE.md'), gemini: state('GEMINI.md') };
  const read = (n: string) => readFileSync(path(n), 'utf8');
  const result: UnifyResult = { created: [], changed: [] };
  let moved: string | null = null;
  if (states.agents === 'missing') {
    const candidates = [states.claude === 'file' ? read('CLAUDE.md') : null, states.gemini === 'file' ? read('GEMINI.md') : null];
    const source = candidates.find((t) => t?.trim() && !IMPORT_RE.test(t)) ?? null;
    if (!source) throw new Error('There are no instructions to share yet: write a CLAUDE.md, GEMINI.md or AGENTS.md first.');
    moved = source;
    writeFileAtomic(agentsPath, source.endsWith('\n') ? source : `${source}\n`);
    result.created.push('AGENTS.md');
  }
  for (const [name, st] of [['CLAUDE.md', states.claude], ['GEMINI.md', states.gemini]] as const) {
    if (st === 'shared') continue;
    if (st === 'missing') {
      writeFileAtomic(path(name), `${IMPORT}\n`);
      result.created.push(name);
      continue;
    }
    const text = read(name);
    if (!IMPORT_RE.test(text)) {
      writeFileAtomic(path(name), text === moved ? `${IMPORT}\n` : `${IMPORT}\n\n${text}`);
      result.changed.push(name);
    }
  }
  return result;
}
