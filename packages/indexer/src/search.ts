/** Turns free text into a safe FTS5 query: every word must match, as a prefix. */
export function toFtsQuery(input: string): string | null {
  const tokens = input
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

export const SNIPPET_START = '\u0001';
export const SNIPPET_END = '\u0002';
