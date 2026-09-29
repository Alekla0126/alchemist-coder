import { posix } from 'node:path';
import { parseJsonc } from './jsonc.ts';
import { readEntry, zipEntries } from './zip.ts';

type Json = Record<string, any>;

export interface ThemeFile {
  name: string;
  type: 'dark' | 'light' | 'hc';
  colors?: Record<string, string>;
  tokenColors?: unknown[];
  semanticTokenColors?: Record<string, unknown>;
}

const UI_TYPE: Record<string, ThemeFile['type']> = { vs: 'light', 'vs-dark': 'dark', 'hc-black': 'hc', 'hc-light': 'light' };

/** More than any real theme pack ships; the rest are ignored. */
const MAX_THEMES = 40;
/** Everything unpacked from one package, all files together (zip bombs stop here). */
const MAX_UNPACKED = 64 * 1024 * 1024;

/** The color themes a VS Code extension package contributes, with `include`d bases merged in. */
export function themesFromVsix(buf: Buffer): ThemeFile[] {
  const entries = zipEntries(buf);
  const cache = new Map<string, string | null>();
  let unpacked = 0;
  const read = (path: string): string | null => {
    if (cache.has(path)) return cache.get(path)!;
    const e = entries.get(path);
    const data = e ? readEntry(buf, e) : null;
    unpacked += data?.length ?? 0;
    if (unpacked > MAX_UNPACKED) throw new Error('This extension unpacks to too much data');
    const text = data ? data.toString('utf8') : null;
    cache.set(path, text);
    return text;
  };
  const pkgText = read('extension/package.json');
  if (!pkgText) throw new Error('This is not a VS Code extension (.vsix)');
  const pkg = parseJsonc(pkgText) as Json;
  const contributed: Json[] = Array.isArray(pkg?.contributes?.themes) ? pkg.contributes.themes : [];
  if (!contributed.length) throw new Error('This extension has no color themes');

  const load = (path: string, depth = 0): Json => {
    if (depth > 4) return {};
    const text = read(path);
    if (text == null) throw new Error(`Missing theme file ${path}`);
    const json = parseJsonc(text) as Json;
    if (typeof json?.include !== 'string') return json;
    const base = load(posix.normalize(posix.join(posix.dirname(path), json.include)), depth + 1);
    return {
      ...base,
      ...json,
      colors: { ...base.colors, ...json.colors },
      tokenColors: [...(Array.isArray(base.tokenColors) ? base.tokenColors : []), ...(Array.isArray(json.tokenColors) ? json.tokenColors : [])],
      semanticTokenColors: { ...base.semanticTokenColors, ...json.semanticTokenColors },
    };
  };

  const themes: ThemeFile[] = [];
  for (const t of contributed.slice(0, MAX_THEMES)) {
    if (typeof t?.path !== 'string') continue;
    const path = posix.normalize(posix.join('extension', t.path));
    if (!path.startsWith('extension/')) continue;
    const json = load(path);
    if (!json.colors && !json.tokenColors) continue;
    themes.push({
      name: String(t.label ?? json.name ?? t.id ?? 'Theme'),
      type: UI_TYPE[t.uiTheme] ?? (json.type === 'light' || json.type === 'hc' ? json.type : 'dark'),
      colors: json.colors,
      tokenColors: Array.isArray(json.tokenColors) ? json.tokenColors : undefined,
      semanticTokenColors: json.semanticTokenColors,
    });
  }
  if (!themes.length) throw new Error('No usable color themes in this extension');
  return themes;
}
