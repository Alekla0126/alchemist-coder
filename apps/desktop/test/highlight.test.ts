import { describe, expect, it } from 'vitest';
import { highlight, languageId, safeColor } from '../src/renderer/src/highlight';

const theme = { name: 'test-dark', type: 'dark', colors: { 'editor.foreground': '#dddddd' }, tokenColors: [{ scope: 'keyword', settings: { foreground: '#ff0000' } }] };

describe('chat code highlighting', () => {
  it('maps fence names and refuses unknown ones', () => {
    expect(languageId('ts')).toBe('typescript');
    expect(languageId('bash')).toBe('shellscript');
    expect(languageId('Python')).toBe('python');
    expect(languageId('not-a-language')).toBeNull();
  });

  it('colors tokens with the theme and only lets plain colors through', async () => {
    const lines = await highlight('const a = 1;\nreturn a;', 'ts', theme as never);
    expect(lines).toHaveLength(2);
    expect(lines!.flat().map((t) => t.content).join('')).toBe('const a = 1;return a;');
    expect(lines!.flat().some((t) => t.color?.toLowerCase() === '#ff0000')).toBe(true);
    expect(safeColor('#ff0000')).toBe('#ff0000');
    expect(safeColor('red;background:url(x)')).toBeUndefined();
    expect(await highlight('x', 'nope', theme as never)).toBeNull();
  });
});
