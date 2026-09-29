/** Something clickable in a line of terminal output. */
export interface LinkCandidate {
  /** Index of the first and one past the last character in the line. */
  start: number;
  end: number;
  kind: 'url' | 'file';
  /** The URL, or the path as printed (without its line and column). */
  target: string;
  line: number;
  column: number;
}

const URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]{}]+[^\s"'`<>()[\]{}.,;:!?]/g;
/**
 * Paths with a file extension, optionally followed by a position in the forms compilers and test
 * runners print: `src/a.ts:12:5`, `src/a.ts(12,5)`, `src/a.ts:12`, `"src/a.ts", line 12`.
 */
const PATH_RE = /(?<![\w/.~-])((?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z][\w]{0,9})(?:(?::(\d+))(?::(\d+))?|\((\d+),(\d+)\)|", line (\d+))?/g;

/** Finds URLs and file-looking paths in one line; the caller checks which paths really exist. */
export function findLinks(text: string): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  const taken: Array<[number, number]> = [];
  for (const m of text.matchAll(URL_RE)) {
    out.push({ start: m.index!, end: m.index! + m[0].length, kind: 'url', target: m[0], line: 1, column: 1 });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(PATH_RE)) {
    const start = m.index!;
    if (taken.some(([a, b]) => start >= a && start < b)) continue;
    const path = m[1]!;
    // A bare version number or domain ("v1.2.3", "example.com") is not worth asking about.
    if (!path.includes('/') && /^(v?\d[\w.-]*|www\..*|.*\.(com|org|net|io|dev|app))$/i.test(path)) continue;
    const line = Number(m[2] ?? m[4] ?? m[6] ?? 1);
    const column = Number(m[3] ?? m[5] ?? 1);
    out.push({ start, end: start + m[0].length, kind: 'file', target: path, line: line || 1, column: column || 1 });
  }
  return out.sort((a, b) => a.start - b.start);
}
