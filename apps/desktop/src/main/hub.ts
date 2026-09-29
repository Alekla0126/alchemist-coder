import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  AGENTS,
  applyJsonStep,
  describeStep,
  installStep,
  inventory,
  maskArgs,
  maskCommand,
  maskUrl,
  scrub,
  unifyInstructions,
  type AgentId,
  type Homes,
  type McpDefinition,
  type McpServer,
} from '@alchemist-coder/extensions';
import type { HubAgent, HubInstallPlan, HubInventory, HubMcp } from '../shared/api';

export { maskArgs };

/** Whether a CLI is on PATH, without running it (some take seconds to start). */
function onPath(bin: string): boolean {
  if (isAbsolute(bin)) return existsSync(bin);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && exts.some((e) => existsSync(join(dir, bin + e))));
}

/**
 * Every value that must never reach the renderer: env and header values, values of secret-looking
 * arguments, URL credentials. Anything shown is scrubbed against this list, whatever its format.
 */
export function secretsOf(def: McpDefinition): string[] {
  const out = [...Object.values(def.env ?? {}), ...Object.values(def.headers ?? {})];
  const args = def.args ?? [];
  const masked = maskArgs(args);
  args.forEach((a, i) => {
    if (masked[i] === a) return;
    const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : a.includes(':') && /^(-H|--header)$/.test(args[i - 1] ?? '') ? a.slice(a.indexOf(':') + 1).trim() : a;
    out.push(value, a);
  });
  for (const u of [def.url, ...args]) {
    if (!u || !/^[a-z][\w+.-]*:\/\//i.test(u)) continue;
    try {
      const url = new URL(u);
      if (url.password) out.push(decodeURIComponent(url.password), url.password);
      for (const [k, v] of url.searchParams) if (/(key|token|secret|password|auth|sig)/i.test(k)) out.push(v, encodeURIComponent(v));
    } catch {
      // not a URL after all
    }
  }
  return out.filter((v) => v.length >= 4);
}

function safe(s: McpServer): HubMcp {
  return {
    id: s.id,
    name: s.name,
    conflict: s.conflict,
    transport: s.def.transport,
    command: s.def.command ?? null,
    args: maskArgs(s.def.args ?? []),
    url: s.def.url ? maskUrl(s.def.url) : null,
    envKeys: Object.keys(s.def.env ?? {}),
    headerKeys: Object.keys(s.def.headers ?? {}),
    sources: s.sources,
    agents: s.agents,
  };
}

/**
 * The extensions hub: reads the four CLIs' MCP servers, skills, hooks and instructions, and copies a
 * server to the agents that lack it with each CLI's own `mcp add`.
 */
export class ExtensionsHub {
  constructor(private readonly resolveProject: (cwd: unknown) => string) {}

  private homes(): Homes {
    return { home: homedir(), codex: process.env.CODEX_HOME, grok: process.env.GROK_HOME };
  }

  private grokBin(): string {
    const local = join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'bin', 'grok');
    return existsSync(local) ? local : 'grok';
  }

  /** The project's folder, or null for global-only views (no project, or one the app can't browse like ~). */
  private root(cwd: unknown): string | null {
    if (cwd == null) return null;
    try {
      return this.resolveProject(cwd);
    } catch {
      return null;
    }
  }

  inventory(cwd: unknown): HubInventory {
    const inv = inventory(this.homes(), this.root(cwd));
    return {
      mcp: inv.mcp.map(safe),
      skills: inv.skills,
      hooks: inv.hooks.map((h) => ({ ...h, command: maskCommand(h.command) })),
      instructions: inv.instructions && { files: inv.instructions.files.map(({ name, exists, bytes, importsAgents }) => ({ name, exists, bytes, importsAgents })), readBy: inv.instructions.readBy, unified: inv.instructions.unified },
      grokCompat: inv.grokCompat,
      installed: { 'claude-code': onPath('claude'), codex: onPath('codex'), gemini: onPath('gemini'), grok: onPath(this.grokBin()) },
    };
  }

  private server(id: unknown, cwd: unknown): McpServer {
    const s = inventory(this.homes(), this.root(cwd)).mcp.find((x) => x.id === id);
    if (!s) throw new Error('That MCP server is no longer configured');
    return s;
  }

  plan(id: unknown, cwd: unknown): HubInstallPlan[] {
    const s = this.server(id, cwd);
    const secrets = secretsOf(s.def);
    const warnings: HubInstallPlan['warnings'] = [];
    if (s.conflict) warnings.push('conflict');
    if (s.sources.every((src) => src.scope === 'project')) warnings.push('project');
    return AGENTS.filter((a) => !s.agents[a]).map((agent) => {
      try {
        const description = scrub(describeStep(installStep(agent, s.name, s.def, { home: homedir(), grokBin: this.grokBin() }), s.def), secrets);
        return { agent, description, reason: null, warnings };
      } catch (e) {
        return { agent, description: null, reason: scrub(e instanceof Error ? e.message : String(e), secrets), warnings };
      }
    });
  }

  async install(id: unknown, agents: unknown, cwd: unknown): Promise<Array<{ agent: HubAgent; ok: boolean; message: string }>> {
    const s = this.server(id, cwd);
    const secrets = secretsOf(s.def);
    const wanted = (Array.isArray(agents) ? agents : []).filter((a): a is AgentId => AGENTS.includes(a as AgentId) && !s.agents[a as AgentId]);
    const results: Array<{ agent: HubAgent; ok: boolean; message: string }> = [];
    for (const agent of wanted) {
      try {
        const step = installStep(agent, s.name, s.def, { home: homedir(), grokBin: this.grokBin() });
        if (step.kind === 'json') applyJsonStep(step);
        else await run(step.command, step.args);
        results.push({ agent, ok: true, message: scrub(describeStep(step, s.def), secrets) });
      } catch (e) {
        results.push({ agent, ok: false, message: scrub(e instanceof Error ? e.message : String(e), secrets) });
      }
    }
    return results;
  }

  unify(cwd: unknown) {
    return unifyInstructions(this.resolveProject(cwd));
  }
}

/**
 * Runs a CLI without a shell. On failure only the exit code and stderr are reported (the caller
 * scrubs them): Node's own error message repeats the whole command line, secrets included.
 */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60_000, env: process.env }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      const why = e.killed ? 'timed out' : e.code === 'ENOENT' ? `${command.split(/[\\/]/).pop()} is not installed` : `exited with code ${e.code ?? '?'}`;
      const detail = String(stderr ?? '').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
      reject(new Error(detail ? `${why}: ${detail}` : why));
    });
  });
}
