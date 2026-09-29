import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

/** Where the four CLIs keep their conversations. */
export function historyRoots(): string[] {
  const home = homedir();
  return [
    join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects'),
    process.env.CODEX_HOME ?? join(home, '.codex'),
    join(home, '.gemini', 'tmp'),
    join(process.env.GROK_HOME ?? join(home, '.grok'), 'sessions'),
  ];
}

const within = (path: string, root: string) => {
  const r = relative(root, path);
  return !!r && !r.startsWith('..') && !isAbsolute(r);
};

/**
 * Everything a conversation is made of on disk: the transcript, plus Claude's subagent folder or
 * Grok's session folder. Only paths inside the CLIs' history folders are ever returned.
 */
export function conversationFiles(file: string | null, roots = historyRoots()): string[] {
  if (!file || !existsSync(file)) return [];
  const real = realpathSync(file);
  const realRoots = roots.filter(existsSync).map((r) => realpathSync(r));
  const root = realRoots.find((r) => within(real, r));
  if (!root || lstatSync(file).isSymbolicLink()) return [];
  // Grok: <sessions>/<cwd>/<id>/updates.jsonl — the whole session folder.
  if (basename(real) === 'updates.jsonl' && within(dirname(real), root)) return [dirname(real)];
  const out = [real];
  const subagents = real.replace(/\.jsonl$/, '');
  if (subagents !== real && existsSync(subagents) && lstatSync(subagents).isDirectory()) out.push(subagents);
  return out;
}
