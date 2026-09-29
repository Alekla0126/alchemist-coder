import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SlashCommand } from '@alchemist-coder/core';
import { readSkills, type AgentId } from '@alchemist-coder/extensions';

const MAX = 200;
const MAX_BYTES = 64 * 1024;

/** `description:` from a Markdown file's front matter, or its first line of text. */
async function describe(file: string): Promise<string> {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return '';
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
    const desc = front && /^description:\s*["']?(.+?)["']?\s*$/m.exec(front)?.[1];
    if (desc) return desc.slice(0, 200);
    const body = front ? text.slice(text.indexOf('---', 3) + 3) : text;
    return (body.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim().slice(0, 200);
  } finally {
    await handle.close();
  }
}

/** Markdown commands in `dir` (one level of subfolders becomes `folder:name`). */
async function markdownCommands(dir: string, source: SlashCommand['source'], prefix = ''): Promise<SlashCommand[]> {
  if (!existsSync(dir)) return [];
  const out: SlashCommand[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && e.name.endsWith('.md')) out.push({ name: `${prefix}${e.name.slice(0, -3)}`, description: await describe(join(dir, e.name)), source });
    else if (e.isDirectory() && !prefix && !e.name.startsWith('.')) out.push(...(await markdownCommands(join(dir, e.name), source, `${e.name}:`)));
    if (out.length >= MAX) break;
  }
  return out;
}

/**
 * Commands each CLI answers itself over ACP, shown before the agent runs and announces its own.
 * Only ones that work outside the CLI's terminal UI.
 */
const BUILTIN: Record<string, Array<[string, string]>> = {
  'claude-code': [
    ['compact', 'Summarize the conversation to free up context'],
    ['init', 'Write a CLAUDE.md for this project'],
    ['review', 'Review the current changes'],
    ['security-review', 'Look for security issues in the current changes'],
    ['pr-comments', 'Fetch the comments on the pull request'],
  ],
  codex: [
    ['init', 'Write an AGENTS.md for this project'],
    ['review', 'Review the current changes'],
    ['compact', 'Summarize the conversation to free up context'],
  ],
};

/** Skills the CLI reads (the extensions hub's scan: nested folders, shared ones). */
function skillsFor(agent: AgentId, cwd: string | null, home: string): SlashCommand[] {
  try {
    return readSkills({ home, codex: process.env.CODEX_HOME, grok: process.env.GROK_HOME }, cwd)
      .filter((s) => s.agents[agent])
      .map((s) => ({ name: s.name, description: s.description.slice(0, 200), source: 'skill' as const }));
  } catch {
    return [];
  }
}

/** Claude Code plugins installed for everyone or for this project: `plugin:command` and `plugin:skill`. */
async function pluginCommands(claudeDir: string, cwd: string | null): Promise<SlashCommand[]> {
  let installed: Record<string, Array<{ scope?: string; projectPath?: string; installPath?: string }>> = {};
  try {
    installed = (JSON.parse(await fs.readFile(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: typeof installed }).plugins ?? {};
  } catch {
    return [];
  }
  const out: SlashCommand[] = [];
  for (const [id, installs] of Object.entries(installed)) {
    const plugin = id.split('@')[0]!;
    const install = (Array.isArray(installs) ? installs : []).find((i) => i.scope !== 'local' || (cwd && i.projectPath === cwd));
    if (!install?.installPath || !/^[\w.-]+$/.test(plugin)) continue;
    for (const c of await markdownCommands(join(install.installPath, 'commands'), 'plugin')) out.push({ ...c, name: `${plugin}:${c.name}` });
    const skillsDir = join(install.installPath, 'skills');
    for (const e of existsSync(skillsDir) ? await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []) : []) {
      const file = join(skillsDir, e.name, 'SKILL.md');
      if (e.isDirectory() && existsSync(file)) out.push({ name: `${plugin}:${e.name}`, description: await describe(file), source: 'plugin' });
    }
  }
  return out;
}

/** Gemini CLI's TOML commands: `description = "…"`. */
async function tomlCommands(dir: string, prefix = ''): Promise<SlashCommand[]> {
  if (!existsSync(dir)) return [];
  const out: SlashCommand[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && e.name.endsWith('.toml')) {
      const text = (await fs.readFile(join(dir, e.name), 'utf8').catch(() => '')).slice(0, MAX_BYTES);
      out.push({ name: `${prefix}${e.name.slice(0, -5)}`, description: /^description\s*=\s*"(.*)"\s*$/m.exec(text)?.[1]?.slice(0, 200) ?? '', source: 'command' });
    } else if (e.isDirectory() && !prefix) out.push(...(await tomlCommands(join(dir, e.name), `${e.name}:`)));
  }
  return out;
}

/**
 * The custom "/" commands each CLI would offer in `cwd` (a checked project folder or null), before
 * an agent is running to announce its own.
 */
export async function slashCommands(harnessId: string, cwd: string | null, home = homedir()): Promise<SlashCommand[]> {
  const project = (...p: string[]) => (cwd ? join(cwd, ...p) : null);
  const lists: Array<Promise<SlashCommand[]>> = [];
  const builtin = (BUILTIN[harnessId] ?? []).map(([name, description]) => ({ name, description, source: 'builtin' as const }));
  lists.push(Promise.resolve(builtin));
  if (harnessId === 'claude-code') {
    const claude = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
    lists.push(markdownCommands(join(claude, 'commands'), 'command'), pluginCommands(claude, cwd));
    const dir = project('.claude');
    if (dir) lists.push(markdownCommands(join(dir, 'commands'), 'command'));
    lists.push(Promise.resolve(skillsFor('claude-code', cwd, home)));
  } else if (harnessId === 'codex') {
    lists.push(markdownCommands(join(process.env.CODEX_HOME ?? join(home, '.codex'), 'prompts'), 'prompt', 'prompts:'));
    lists.push(Promise.resolve(skillsFor('codex', cwd, home)));
  } else if (harnessId === 'gemini') {
    lists.push(tomlCommands(join(home, '.gemini', 'commands')));
    const dir = project('.gemini', 'commands');
    if (dir) lists.push(tomlCommands(dir));
  }
  const seen = new Set<string>();
  // Project commands come last and win over personal ones with the same name.
  const all = (await Promise.all(lists)).flat().reverse().filter((c) => !seen.has(c.name) && seen.add(c.name));
  return all.reverse().slice(0, MAX);
}
