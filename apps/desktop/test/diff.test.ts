import { describe, expect, it } from 'vitest';
import { hunks, keepHunk, parsePatch, undoHunk } from '../src/renderer/src/diff';

const before = ['import a', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'end', ''].join('\n');
const after = ['import a', 'import b', 'one', 'TWO', 'three', 'four', 'five', 'six', 'eight', 'end', 'extra', ''].join('\n');

describe('hunks', () => {
  it('splits changes into separate blocks with context', () => {
    const hs = hunks(before, after, 1);
    expect(hs.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, [], 1, ['import b']],
      [2, ['two'], 3, ['TWO']],
      [7, ['seven'], 8, []],
      [10, [], 10, ['extra']],
    ]);
    expect(hs[1]!.before).toEqual(['one']);
    expect(hs[1]!.after).toEqual(['three']);
    expect(hunks(before, before)).toEqual([]);
  });

  it('keeps or undoes one block at a time, and all of them add up', () => {
    const hs = hunks(before, after);
    // Undoing every block, last first so positions stay valid, gives back the original.
    expect(hs.reduceRight((text, h) => undoHunk(text, h), after)).toBe(before);
    expect(hs.reduceRight((text, h) => keepHunk(text, h), before)).toBe(after);
    // Keeping one block moves only that block into the baseline.
    const baseline = keepHunk(before, hs[1]!);
    expect(hunks(baseline, after).map((h) => h.newLines)).toEqual([['import b'], [], ['extra']]);
    // Undoing one block leaves the others on disk.
    const file = undoHunk(after, hs[0]!);
    expect(file.startsWith('import a\none\nTWO')).toBe(true);
  });

  it('treats a new file as one block', () => {
    expect(hunks('', 'a\nb\n').map((h) => [h.oldLines, h.newLines])).toEqual([[[], ['a', 'b']]]);
  });
});

describe('parsePatch', () => {
  it('splits a git patch into files with their changed lines', () => {
    const patch = [
      'diff --git a/app.txt b/app.txt',
      'index 5626abf..814f4a4 100644',
      '--- a/app.txt',
      '+++ b/app.txt',
      '@@ -1 +1,2 @@',
      ' one',
      '+two',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+--flag stays text',
      'diff --git a/logo.png b/logo.png',
      'new file mode 100644',
      'Binary files /dev/null and b/logo.png differ',
      '',
    ].join('\n');
    const files = parsePatch(patch);
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['app.txt', 'modified', false],
      ['new.txt', 'added', false],
      ['logo.png', 'added', true],
    ]);
    expect(files[0]!.lines).toEqual([
      { kind: 'hunk', text: '@@ -1 +1,2 @@' },
      { kind: 'same', text: 'one' },
      { kind: 'add', text: 'two' },
    ]);
    // "+--" inside a hunk is an added line, not a file header.
    expect(files[1]!.lines.at(-1)).toEqual({ kind: 'add', text: '--flag stays text' });
  });
});
