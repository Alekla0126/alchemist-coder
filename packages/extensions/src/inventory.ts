import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { kindOf, linkTarget } from './fsutil.ts';
import { basename, dirname, join } from 'node:path';
import { obj, readJson, readToml, record, skillFiles, skillMeta, str, strs } from './read.ts';
import type { AgentId, Hook, InstructionFile, Instructions, Inventory, McpDefinition, McpServer, Skill, Source, Via } from './types.ts';

export interface Homes {
  home: string;
  /** $CODEX_HOME, default ~/.codex */
  codex?: string;
  /** $GROK_HOME, default ~/.grok */
  grok?: string;
}

type Json = Record<string, unknown>;

/** Claude Code / Gemini style JSON server entry. */
function jsonServer(v: unknown): McpDefinition | null {
  const o = obj(v);
  const command = str(o.command);
  const httpUrl = str(o.httpUrl);
  const url = str(o.url);
  const type = str(o.type) ?? str(o.transport);
  if (command) return { transport: 'stdio', command, args: strs(o.args) ?? [], env: record(o.env) };
  if (httpUrl) return { transport: 'http', url: httpUrl, headers: record(o.headers) };
  if (url) return { transport: type === 'sse' ? 'sse' : type === 'http' || type === 'streamable-http' ? 'http' : 'sse', url, headers: record(o.headers) };
  return null;
}

/** Claude Code JSON: `type` decides http vs sse; a bare url means http. */
function claudeServer(v: unknown): McpDefinition | null {
  const o = obj(v);
  const def = jsonServer(v);
  if (def && def.transport !== 'stdio' && str(o.type) !== 'sse') def.transport = 'http';
  return def;
}

/** Codex / Grok TOML `[mcp_servers.<name>]` entry. */
function tomlServer(v: unknown): McpDefinition | null {
  const o = obj(v);
  if (o.enabled === false) return null;
  const command = str(o.command);
  const url = str(o.url);
  if (command) return { transport: 'stdio', command, args: strs(o.args) ?? [], env: record(o.env) };
  if (url) return { transport: str(o.transport) === 'sse' ? 'sse' : 'http', url, headers: record(o.headers) ?? record(o.http_headers) };
  return null;
}

class Merger<T extends { sources: Source[]; agents: Partial<Record<AgentId, Via>> }> {
  readonly items = new Map<string, T>();
  add(key: string, make: () => T, source: Source, via: Via = 'own') {
    let item = this.items.get(key);
    if (!item) this.items.set(key, (item = make()));
    if (!item.sources.some((s) => s.file === source.file && s.agent === source.agent)) item.sources.push(source);
    if (item.agents[source.agent] !== 'own') item.agents[source.agent] = via;
  }
  list() {
    return [...this.items.values()];
  }
}

function grokCompat(grokConfig: Json | null) {
  const claude = obj(obj(grokConfig?.compat).claude);
  const off = (k: string, env: string) => claude[k] === false || process.env[env] === 'false';
  return { mcps: !off('mcps', 'GROK_CLAUDE_MCPS_ENABLED'), skills: !off('skills', 'GROK_CLAUDE_SKILLS_ENABLED'), hooks: !off('hooks', 'GROK_CLAUDE_HOOKS_ENABLED') };
}

export function readMcp(h: Homes, root: string | null, compat = { mcps: true }): McpServer[] {
  const m = new Merger<McpServer>();
  const codexHome = h.codex ?? join(h.home, '.codex');
  const grokHome = h.grok ?? join(h.home, '.grok');
  const add = (name: string, def: McpDefinition | null, source: Source) => {
    if (!def) return;
    const fp = createHash('sha256').update(JSON.stringify([def.transport, def.command ?? null, def.args ?? [], def.url ?? null])).digest('hex').slice(0, 10);
    const id = `${name}#${fp}`;
    const make = () => ({ id, name, conflict: false, def, sources: [], agents: {} });
    m.add(id, make, source);
    // Grok reads Claude Code's servers (and .mcp.json) as its own, unless compat is off.
    if (source.agent === 'claude-code' && compat.mcps) m.add(id, make, { ...source, agent: 'grok' }, 'compat');
  };

  const claudeJson = join(h.home, '.claude.json');
  const cj = readJson(claudeJson);
  for (const [name, v] of Object.entries(obj(cj?.mcpServers))) add(name, claudeServer(v), { agent: 'claude-code', scope: 'user', file: claudeJson });
  if (root) {
    for (const [name, v] of Object.entries(obj(obj(obj(cj?.projects)[root]).mcpServers))) add(name, claudeServer(v), { agent: 'claude-code', scope: 'local', file: claudeJson });
    const mcpJson = join(root, '.mcp.json');
    for (const [name, v] of Object.entries(obj(readJson(mcpJson)?.mcpServers))) add(name, claudeServer(v), { agent: 'claude-code', scope: 'project', file: mcpJson });
  }

  const codexToml = join(codexHome, 'config.toml');
  for (const [name, v] of Object.entries(obj(readToml(codexToml)?.mcp_servers))) add(name, tomlServer(v), { agent: 'codex', scope: 'user', file: codexToml });

  const geminiFiles: Array<[string, Source['scope']]> = [[join(h.home, '.gemini', 'settings.json'), 'user']];
  if (root) geminiFiles.push([join(root, '.gemini', 'settings.json'), 'project']);
  for (const [file, scope] of geminiFiles) for (const [name, v] of Object.entries(obj(readJson(file)?.mcpServers))) add(name, jsonServer(v), { agent: 'gemini', scope, file });

  const grokFiles: Array<[string, Source['scope']]> = [[join(grokHome, 'config.toml'), 'user']];
  if (root) grokFiles.push([join(root, '.grok', 'config.toml'), 'project']);
  for (const [file, scope] of grokFiles) for (const [name, v] of Object.entries(obj(readToml(file)?.mcp_servers))) add(name, tomlServer(v), { agent: 'grok', scope, file });

  const list = m.list();
  const byName = new Map<string, number>();
  for (const s of list) byName.set(s.name, (byName.get(s.name) ?? 0) + 1);
  for (const s of list) s.conflict = (byName.get(s.name) ?? 0) > 1;
  return list.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function readSkills(h: Homes, root: string | null, compat = { skills: true }): Skill[] {
  const m = new Merger<Skill>();
  const codexHome = h.codex ?? join(h.home, '.codex');
  const grokHome = h.grok ?? join(h.home, '.grok');
  const scan = (dir: string, agent: AgentId, scope: Source['scope']) => {
    for (const file of skillFiles(dir)) {
      const meta = skillMeta(file, basename(dirname(file)));
      const make = () => ({ name: meta.name, description: meta.description, sources: [], agents: {} });
      m.add(meta.name, make, { agent, scope, file });
      if (agent === 'claude-code' && compat.skills) m.add(meta.name, make, { agent: 'grok', scope, file }, 'compat');
    }
  };
  scan(join(h.home, '.claude', 'skills'), 'claude-code', 'user');
  scan(join(codexHome, 'skills'), 'codex', 'user');
  scan(join(h.home, '.gemini', 'skills'), 'gemini', 'user');
  scan(join(grokHome, 'skills'), 'grok', 'user');
  scan(join(h.home, '.agents', 'skills'), 'grok', 'user');
  if (root) {
    scan(join(root, '.claude', 'skills'), 'claude-code', 'project');
    scan(join(root, '.codex', 'skills'), 'codex', 'project');
    scan(join(root, '.gemini', 'skills'), 'gemini', 'project');
    scan(join(root, '.grok', 'skills'), 'grok', 'project');
    scan(join(root, '.agents', 'skills'), 'grok', 'project');
  }
  return m.list().sort((a, b) => a.name.localeCompare(b.name));
}

/** Claude-style `{ Event: [{ matcher, hooks: [{ type, command }] }] }`, also used by Grok's TOML. */
function hookGroups(hooks: unknown): Array<{ event: string; matcher: string | null; command: string }> {
  const out: Array<{ event: string; matcher: string | null; command: string }> = [];
  for (const [event, groups] of Object.entries(obj(hooks))) {
    for (const g of Array.isArray(groups) ? groups : []) {
      const matcher = str(obj(g).matcher) ?? null;
      const inner = Array.isArray(obj(g).hooks) ? (obj(g).hooks as unknown[]) : [g];
      for (const hk of inner) {
        const command = str(obj(hk).command) ?? str(obj(hk).url);
        if (command) out.push({ event, matcher, command });
      }
    }
  }
  return out;
}

export function readHooks(h: Homes, root: string | null, compat = { hooks: true }): Hook[] {
  const m = new Merger<Hook>();
  const grokHome = h.grok ?? join(h.home, '.grok');
  const add = (data: Json | null, agent: AgentId, scope: Source['scope'], file: string) => {
    for (const hk of hookGroups(data?.hooks)) {
      const key = `${hk.event}\u0000${hk.matcher ?? ''}\u0000${hk.command}`;
      const make = () => ({ ...hk, sources: [], agents: {} });
      m.add(key, make, { agent, scope, file });
      if (agent === 'claude-code' && compat.hooks) m.add(key, make, { agent: 'grok', scope, file }, 'compat');
    }
  };
  const claudeFiles: Array<[string, Source['scope']]> = [
    [join(h.home, '.claude', 'settings.json'), 'user'],
    [join(h.home, '.claude', 'settings.local.json'), 'user'],
  ];
  if (root) claudeFiles.push([join(root, '.claude', 'settings.json'), 'project'], [join(root, '.claude', 'settings.local.json'), 'local']);
  for (const [file, scope] of claudeFiles) add(readJson(file), 'claude-code', scope, file);
  const gemini = join(h.home, '.gemini', 'settings.json');
  add(readJson(gemini), 'gemini', 'user', gemini);
  const grok = join(grokHome, 'config.toml');
  add(readToml(grok), 'grok', 'user', grok);
  return m.list();
}

const IMPORTS_AGENTS = /^\s*@\.?\/?AGENTS\.md\s*$/m;

const MAX_INSTRUCTIONS = 1024 * 1024;

/** Never reads through a symlink (it could point anywhere); CLAUDE.md -> AGENTS.md counts as importing it. */
function file(root: string, name: string): InstructionFile {
  const path = join(root, name);
  const kind = kindOf(path);
  if (kind === 'link') {
    const agents = join(root, 'AGENTS.md');
    const shared = name !== 'AGENTS.md' && kindOf(agents) === 'file' && linkTarget(path) === linkTarget(agents);
    return { name, path, exists: linkTarget(path) != null, bytes: 0, importsAgents: shared };
  }
  if (kind !== 'file') return { name, path, exists: false, bytes: 0, importsAgents: false };
  const size = statSync(path).size;
  const text = size <= MAX_INSTRUCTIONS ? readFileSync(path, 'utf8') : '';
  return { name, path, exists: true, bytes: size, importsAgents: IMPORTS_AGENTS.test(text) };
}

/** Context file names from settings: plain names in the project folder only. */
const plainName = (n: unknown): n is string => typeof n === 'string' && /^[\w.-]{1,100}$/.test(n) && n !== '.' && n !== '..';

/** Gemini reads GEMINI.md unless settings name other context files (e.g. AGENTS.md). */
function geminiContextFiles(h: Homes, root: string): string[] {
  for (const f of [join(root, '.gemini', 'settings.json'), join(h.home, '.gemini', 'settings.json')]) {
    const name = obj(readJson(f)?.context).fileName ?? readJson(f)?.contextFileName;
    if (typeof name === 'string') return plainName(name) ? [name] : ['GEMINI.md'];
    if (Array.isArray(name)) {
      const names = name.filter(plainName);
      return names.length ? names : ['GEMINI.md'];
    }
  }
  return ['GEMINI.md'];
}

export function readInstructions(h: Homes, root: string): Instructions {
  const names = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md'];
  const files = names.map((n) => file(root, n));
  const has = (n: string) => files.find((f) => f.name === n)?.exists ?? existsSync(join(root, n));
  const byName = (n: string) => files.find((f) => f.name === n);
  const gemini = geminiContextFiles(h, root);
  for (const n of gemini) if (!names.includes(n)) files.push(file(root, n));
  const readBy: Record<AgentId, string[]> = {
    'claude-code': ['CLAUDE.md', 'CLAUDE.local.md'].filter(has),
    codex: ['AGENTS.md'].filter(has),
    gemini: gemini.filter(has),
    grok: ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'].filter(has),
  };
  // Everyone reads AGENTS.md directly or through an @AGENTS.md import.
  const reaches = (list: string[]) => list.includes('AGENTS.md') || list.some((n) => byName(n)?.importsAgents);
  const unified = has('AGENTS.md') && (Object.values(readBy) as string[][]).every(reaches);
  return { files, readBy, unified };
}

export function inventory(h: Homes, root: string | null): Inventory {
  const compat = grokCompat(readToml(join(h.grok ?? join(h.home, '.grok'), 'config.toml')));
  return {
    mcp: readMcp(h, root, compat),
    skills: readSkills(h, root, compat),
    hooks: readHooks(h, root, compat),
    instructions: root ? readInstructions(h, root) : null,
    grokCompat: compat,
  };
}
