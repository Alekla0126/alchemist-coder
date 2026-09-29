import { describe, expect, it } from 'vitest';
import { findLinks } from '../src/renderer/src/terminal-links';

const pick = (text: string) => findLinks(text).map((l) => [l.kind, l.target, l.line, l.column, text.slice(l.start, l.end)]);

describe('findLinks', () => {
  it('finds paths with the positions compilers and test runners print', () => {
    expect(pick('src/app.ts:12:5 - error TS2322')).toEqual([['file', 'src/app.ts', 12, 5, 'src/app.ts:12:5']]);
    expect(pick('  at run (/Users/me/app/lib/run.js:40:13)')).toEqual([['file', '/Users/me/app/lib/run.js', 40, 13, '/Users/me/app/lib/run.js:40:13']]);
    expect(pick('src/a.tsx(7,3): error')).toEqual([['file', 'src/a.tsx', 7, 3, 'src/a.tsx(7,3)']]);
    expect(pick('File "tools/build.py", line 88, in main')).toEqual([['file', 'tools/build.py', 88, 1, 'tools/build.py", line 88']]);
    expect(pick('modified:   README.md')).toEqual([['file', 'README.md', 1, 1, 'README.md']]);
    expect(pick('see ./docs/guide.md and ~/notes/todo.txt')).toEqual([
      ['file', './docs/guide.md', 1, 1, './docs/guide.md'],
      ['file', '~/notes/todo.txt', 1, 1, '~/notes/todo.txt'],
    ]);
  });

  it('finds URLs without trailing punctuation and never treats them as paths', () => {
    expect(pick('Local: http://localhost:5173/, docs at https://vite.dev/guide.')).toEqual([
      ['url', 'http://localhost:5173/', 1, 1, 'http://localhost:5173/'],
      ['url', 'https://vite.dev/guide', 1, 1, 'https://vite.dev/guide'],
    ]);
  });

  it('skips version numbers and domains', () => {
    expect(pick('node v22.13.0 on example.com, version 1.2.3')).toEqual([]);
  });
});
