export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

const MAX_CELLS = 250_000;

/**
 * Line diff by longest common subsequence, trimmed to changed regions plus `context` lines.
 * Big inputs skip the LCS and show old lines removed / new lines added.
 */
export function lineDiff(oldText: string | null, newText: string, context = 2): DiffLine[] {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let mid: DiffLine[];
  if (midA.length * midB.length > MAX_CELLS) {
    mid = [...midA.map((text) => ({ kind: 'del' as const, text })), ...midB.map((text) => ({ kind: 'add' as const, text }))];
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    mid = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        mid.push({ kind: 'same', text: midA[i]! });
        i++;
        j++;
      } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) mid.push({ kind: 'add', text: midB[j++]! });
      else mid.push({ kind: 'del', text: midA[i++]! });
    }
  }
  const before = a.slice(Math.max(0, start - context), start).map((text) => ({ kind: 'same' as const, text }));
  const after = a.slice(endA, endA + context).map((text) => ({ kind: 'same' as const, text }));
  return [...before, ...mid, ...after];
}

/** One block of changes: `oldLines` at `oldStart` became `newLines` at `newStart` (0-based). */
export interface Hunk {
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
  /** Unchanged lines shown around the block. */
  before: string[];
  after: string[];
}

/**
 * The changes between two texts as separate blocks, so each can be kept or undone on its own.
 * Uses the same LCS as lineDiff; very large files come back as a single block.
 */
export function hunks(oldText: string, newText: string, context = 3): Hunk[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (!midA.length && !midB.length) return [];
  // Walk both sides and cut a block at every run of equal lines.
  const ops: Array<'same' | 'add' | 'del'> = [];
  if (midA.length * midB.length > MAX_CELLS) {
    ops.push(...midA.map(() => 'del' as const), ...midB.map(() => 'add' as const));
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push('same');
        i++;
        j++;
      } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
        ops.push('add');
        j++;
      } else {
        ops.push('del');
        i++;
      }
    }
  }
  const out: Hunk[] = [];
  let ai = start;
  let bi = start;
  let current: Hunk | null = null;
  for (const op of ops) {
    if (op === 'same') {
      current = null;
      ai++;
      bi++;
      continue;
    }
    if (!current) {
      current = { oldStart: ai, oldLines: [], newStart: bi, newLines: [], before: [], after: [] };
      out.push(current);
    }
    if (op === 'del') current.oldLines.push(a[ai++]!);
    else current.newLines.push(b[bi++]!);
  }
  for (const h of out) {
    h.before = a.slice(Math.max(0, h.oldStart - context), h.oldStart);
    h.after = a.slice(h.oldStart + h.oldLines.length, h.oldStart + h.oldLines.length + context);
  }
  return out;
}

/** `oldText` with one block applied: the baseline after keeping that block. */
export function keepHunk(oldText: string, h: Hunk): string {
  const a = oldText.split('\n');
  a.splice(h.oldStart, h.oldLines.length, ...h.newLines);
  return a.join('\n');
}

/** `newText` with one block reverted: the file after undoing that block. */
export function undoHunk(newText: string, h: Hunk): string {
  const b = newText.split('\n');
  b.splice(h.newStart, h.newLines.length, ...h.oldLines);
  return b.join('\n');
}

export interface PatchFile {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  lines: Array<{ kind: 'same' | 'add' | 'del' | 'hunk'; text: string }>;
}

/** A git patch (`git diff`) split into files, each with its changed lines. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      file = { path: head[2]!, status: head[1] === head[2] ? 'modified' : 'renamed', binary: false, lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('Binary files') || line === 'GIT binary patch') file.binary = true;
      else if (line.startsWith('@@')) {
        inHunk = true;
        file.lines.push({ kind: 'hunk', text: line });
      }
      continue;
    }
    if (line.startsWith('@@')) file.lines.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+')) file.lines.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) file.lines.push({ kind: 'del', text: line.slice(1) });
    else if (line.startsWith(' ')) file.lines.push({ kind: 'same', text: line.slice(1) });
  }
  return files;
}
