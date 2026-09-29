import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

type Json = Record<string, unknown>;

export function readJson(file: string): Json | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Json) : null;
  } catch {
    return null;
  }
}

export function readToml(file: string): Json | null {
  try {
    return parseToml(readFileSync(file, 'utf8')) as Json;
  } catch {
    return null;
  }
}

export const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
export const record = (v: unknown): Record<string, string> | undefined => {
  const o = obj(v);
  const entries = Object.entries(o).filter(([, x]) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean');
  return entries.length ? Object.fromEntries(entries.map(([k, x]) => [k, String(x)])) : undefined;
};

/** Folders that contain a SKILL.md, up to `depth` levels below `dir` (hidden folders skipped). */
export function skillFiles(dir: string, depth = 3): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    if (entries.includes('SKILL.md')) {
      out.push(join(d, 'SKILL.md'));
      return;
    }
    if (level >= depth) return;
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue;
      const p = join(d, e);
      try {
        if (statSync(p).isDirectory()) walk(p, level + 1);
      } catch {
        // unreadable
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** `name` and `description` from a SKILL.md front matter. */
export function skillMeta(file: string, fallbackName: string): { name: string; description: string } {
  let text = '';
  try {
    text = readFileSync(file, 'utf8').slice(0, 4000);
  } catch {
    // unreadable
  }
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '');
  return { name: field('name') || fallbackName, description: field('description') ?? '' };
}
