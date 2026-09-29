import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages } from 'shiki/langs';
import type { VsTheme } from './theme';

/** Fence names people write, mapped to Shiki's language ids. */
const ALIASES: Record<string, string> = {
  ts: 'typescript', js: 'javascript', py: 'python', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript',
  console: 'shellscript', yml: 'yaml', rb: 'ruby', rs: 'rust', kt: 'kotlin', md: 'markdown', cs: 'csharp', 'c++': 'cpp', objc: 'objective-c',
  dockerfile: 'docker', ps: 'powershell', ps1: 'powershell', jsonl: 'json', tf: 'terraform',
};
const MAX_CHARS = 20_000;

let core: Promise<HighlighterCore> | null = null;
const highlighter = () => (core ??= createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine() }));

/** Only plain colors reach a style attribute (themes come from anywhere). */
const COLOR = /^#[0-9a-f]{3,8}$/i;
export const safeColor = (c: string | undefined) => (c && COLOR.test(c) ? c : undefined);

export function languageId(fence: string): string | null {
  const id = ALIASES[fence.toLowerCase()] ?? fence.toLowerCase();
  return id in bundledLanguages ? id : null;
}

/**
 * Tokens for a code block in the chat, colored by the app's theme; null when the language is
 * unknown, the block is huge or anything fails (it then stays plain).
 */
export async function highlight(code: string, fence: string, theme: VsTheme): Promise<ThemedToken[][] | null> {
  const lang = languageId(fence);
  if (!lang || code.length > MAX_CHARS) return null;
  try {
    const h = await highlighter();
    if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage((bundledLanguages as Record<string, unknown>)[lang] as never);
    if (!h.getLoadedThemes().includes(theme.name)) await h.loadTheme(theme as never);
    return h.codeToTokensBase(code, { lang: lang as never, theme: theme.name });
  } catch {
    return null;
  }
}
