import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/register.all';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages } from 'shiki/langs';
import { shikiToMonaco } from '@shikijs/monaco';
import type { VsTheme } from '../theme';

// Only the core editor worker: highlighting comes from Shiki (VS Code's TextMate grammars),
// so the heavy TypeScript/JSON/CSS language workers are not bundled.
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', md: 'markdown', mdx: 'mdx', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
  vue: 'vue', svelte: 'svelte', astro: 'astro', py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', dart: 'dart', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', m: 'objective-c',
  cs: 'csharp', sh: 'shellscript', zsh: 'shellscript', bash: 'shellscript', ps1: 'powershell', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'ini', sql: 'sql', xml: 'xml', plist: 'xml', gradle: 'groovy', graphql: 'graphql', gql: 'graphql',
  prisma: 'prisma', lua: 'lua', r: 'r', scala: 'scala', ex: 'elixir', exs: 'elixir', tf: 'terraform', proto: 'proto',
};
const BY_NAME: Record<string, string> = { dockerfile: 'docker', makefile: 'make', '.env': 'dotenv', '.gitignore': 'ini' };

export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name]!;
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return BY_EXTENSION[ext] ?? 'plaintext';
}

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine() });
  return highlighter;
}

export async function useTheme(theme: VsTheme): Promise<void> {
  const h = await getHighlighter();
  if (!h.getLoadedThemes().includes(theme.name)) await h.loadTheme(theme as never);
  shikiToMonaco(h, monaco);
  monaco.editor.setTheme(theme.name);
}

export async function ensureLanguage(lang: string): Promise<void> {
  if (lang === 'plaintext' || loaded.has(lang)) return;
  const loader = (bundledLanguages as Record<string, unknown>)[lang];
  if (!loader) return;
  const h = await getHighlighter();
  await h.loadLanguage(loader as never);
  for (const id of h.getLoadedLanguages()) {
    if (!monaco.languages.getLanguages().some((l) => l.id === id)) monaco.languages.register({ id });
  }
  loaded.add(lang);
  shikiToMonaco(h, monaco);
}

export { monaco };
