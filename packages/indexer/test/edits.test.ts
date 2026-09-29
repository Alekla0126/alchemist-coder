import { describe, expect, it } from 'vitest';
import { acpDiffs, editsOf, patchDiffs } from '../src/edits.ts';

describe('edit diffs', () => {
  it('reads Claude Edit, MultiEdit and Write inputs', () => {
    expect(editsOf('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' })).toEqual([{ path: '/p/a.ts', oldText: 'a', newText: 'b' }]);
    expect(editsOf('MultiEdit', { file_path: '/p/a.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: '1', new_string: '2' }] })).toHaveLength(2);
    expect(editsOf('Write', { file_path: '/p/n.ts', content: 'hi' })).toEqual([{ path: '/p/n.ts', oldText: null, newText: 'hi' }]);
    expect(editsOf('Read', { file_path: '/p/a.ts' })).toBeUndefined();
    expect(editsOf('Edit', { file_path: '/p/a.ts' })).toBeUndefined();
  });

  it('splits a Codex patch into hunks and keeps added files whole', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@ function a',
      ' keep',
      '-old',
      '+new',
      '@@ function b',
      '-x',
      '+y',
      '*** Add File: src/b.ts',
      '+line 1',
      '+line 2',
      '*** Delete File: src/c.ts',
      '*** End Patch',
    ].join('\n');
    expect(patchDiffs(patch)).toEqual([
      { path: 'src/a.ts', oldText: 'keep\nold', newText: 'keep\nnew' },
      { path: 'src/a.ts', oldText: 'x', newText: 'y' },
      { path: 'src/b.ts', oldText: null, newText: 'line 1\nline 2' },
    ]);
    expect(editsOf('apply_patch', patch)).toHaveLength(3);
    expect(editsOf('apply_patch', 'not a patch')).toBeUndefined();
  });

  it('follows a moved file and clips huge texts', () => {
    const moved = patchDiffs('*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-1\n+2\n*** End Patch');
    expect(moved[0]!.path).toBe('b.ts');
    const big = editsOf('Write', { file_path: '/p/big', content: 'x'.repeat(50_000) })!;
    expect(big[0]!.newText.length).toBeLessThan(21_000);
  });

  it('reads ACP diff content', () => {
    expect(acpDiffs([{ type: 'content' }, { type: 'diff', path: '/p/a', oldText: null, newText: 'n' }])).toEqual([{ path: '/p/a', oldText: null, newText: 'n' }]);
    expect(acpDiffs(undefined)).toBeUndefined();
  });
});

describe('AskUserQuestion', () => {
  it('keeps the questions and the recorded answers', async () => {
    const { askOf, answersOf } = await import('../src/edits.ts');
    const ask = askOf('AskUserQuestion', { questions: [{ header: 'Stack', question: 'Which stack?', multiSelect: false, options: [{ label: 'Web', description: 'Vite' }, { label: 'Desktop', description: 'Electron' }] }] });
    expect(ask).toEqual([{ header: 'Stack', question: 'Which stack?', multiSelect: false, options: [{ label: 'Web', description: 'Vite' }, { label: 'Desktop', description: 'Electron' }] }]);
    expect(askOf('Bash', { questions: [] })).toBeUndefined();
    expect(answersOf({ questions: [], answers: { 'Which stack?': 'Desktop' } })).toEqual({ 'Which stack?': 'Desktop' });
    expect(answersOf({ success: true })).toBeUndefined();
  });
});
