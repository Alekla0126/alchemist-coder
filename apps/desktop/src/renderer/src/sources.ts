import type { Source } from '@alchemist-coder/core';

/** Name and glyph of the CLI that recorded a conversation. */
export const SOURCES: Record<Source, { label: string; glyph: string }> = {
  'claude-code': { label: 'Claude Code', glyph: '✳' },
  codex: { label: 'Codex', glyph: '◎' },
  gemini: { label: 'Gemini CLI', glyph: '✦' },
  grok: { label: 'Grok Build', glyph: '𝕏' },
};

export const sourceOf = (s: string) => SOURCES[s as Source] ?? { label: s, glyph: '•' };
