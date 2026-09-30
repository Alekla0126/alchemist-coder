import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SubagentDef } from '../shared/api';

/**
 * The subagent types Claude Code can launch besides its built-in ones: `.claude/agents/*.md` in the
 * project and in your home folder, each with a `name` and a `description` in its front matter.
 * Only those two fields are read; links and big files are skipped.
 */
export function readSubagents(dir: string, scope: SubagentDef['scope']): SubagentDef[] {
  if (!existsSync(dir)) return [];
  const out: SubagentDef[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).slice(0, 100)) {
    const path = join(dir, file);
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 64 * 1024) continue;
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path, 'utf8'))?.[1] ?? '';
    const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(front)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
    const name = field('name') || file.replace(/\.md$/, '');
    if (!/^[\w.-]{1,64}$/.test(name)) continue;
    out.push({ name, description: field('description').slice(0, 300), scope });
  }
  return out;
}

/** The project's own types first; a user type with the same name is shadowed by the project's. */
export function listSubagents(projectRoot: string, home = homedir()): SubagentDef[] {
  const project = readSubagents(join(projectRoot, '.claude', 'agents'), 'project');
  const user = readSubagents(join(home, '.claude', 'agents'), 'user').filter((u) => !project.some((p) => p.name === u.name));
  return [...project, ...user].slice(0, 60);
}
