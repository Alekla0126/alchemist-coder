import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stageAttachments } from '../src/main/runner';
import { fileSize } from '../src/renderer/src/format';
import { startTurn } from '../src/renderer/src/live-turns';

const dir = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('attachments from the composer', () => {
  it('dropped files by path, pasted ones by content: both end up in the project', () => {
    const cwd = dir('ac-project-');
    const src = join(dir('ac-src-'), 'budget.xlsx');
    writeFileSync(src, 'XLSX');
    const staged = stageAttachments(cwd, [
      { name: 'budget.xlsx', path: src },
      { name: 'notes.txt', data: Buffer.from('hola').toString('base64') },
    ]);
    expect(staged.map((f) => [f.name, f.size])).toEqual([
      ['budget.xlsx', 4],
      ['notes.txt', 4],
    ]);
    expect(staged.every((f) => f.path.startsWith(join(cwd, '.alchemist', 'attachments')))).toBe(true);
    expect(readFileSync(staged[1]!.path, 'utf8')).toBe('hola');
  });

  it("the renderer's input isn't trusted: bad entries are left out, the rest still go", () => {
    const cwd = dir('ac-project-');
    const ok = join(cwd, 'ok.md');
    writeFileSync(ok, '# ok');
    const staged = stageAttachments(cwd, [
      null,
      'just a string',
      { name: 'x', path: 'relative/x.txt' },
      { name: 'y', path: join(cwd, 'missing.pdf') },
      { name: 'z', data: 'not base64 !!' },
      { name: 'ok.md', path: ok },
    ]);
    expect(staged.map((f) => f.path)).toEqual([ok]);
    expect(stageAttachments(cwd, 'nope')).toEqual([]);
    // At most ten per message.
    expect(stageAttachments(cwd, Array.from({ length: 15 }, () => ({ name: 'ok.md', path: ok })))).toHaveLength(10);
  });

  it('sizes read short', () => {
    expect([fileSize(812), fileSize(4300), fileSize(13 * 1024 * 1024), fileSize(1.4 * 1024 ** 3)]).toEqual(['812 B', '4.2 KB', '13 MB', '1.4 GB']);
    expect(fileSize(2048)).toBe('2 KB');
  });

  it('your message shows the files you sent with it', () => {
    const [turn] = startTurn([], 'summarize this', 1000, [], ['report.pdf', 'data.csv']);
    expect(turn).toMatchObject({ prompt: 'summarize this', files: ['report.pdf', 'data.csv'] });
    const [plain] = startTurn([], 'hi', 1000);
    expect(plain).not.toHaveProperty('files');
  });
});
