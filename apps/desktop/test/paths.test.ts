import { describe, expect, it } from 'vitest';
import { baseName, isInside, joinPath, parentOf, relativePath, samePath, tailOf, tildify, withoutRoot } from '../src/renderer/src/paths';

describe('renderer paths', () => {
  it('reads macOS and Linux paths', () => {
    expect(baseName('/Users/me/proj/src/a.ts')).toBe('a.ts');
    expect(baseName('/Users/me/proj/')).toBe('proj');
    expect(parentOf('/Users/me/proj/src/a.ts')).toBe('/Users/me/proj/src');
    expect(parentOf('/a')).toBe('/');
    expect(joinPath('/Users/me/proj/', 'src/a.ts')).toBe('/Users/me/proj/src/a.ts');
    expect(relativePath('/Users/me/proj/src/a.ts', '/Users/me/proj')).toBe('src/a.ts');
    expect(relativePath('/Users/me/proj', '/Users/me/proj/')).toBe('');
    expect(relativePath('/Users/me/project2/a.ts', '/Users/me/proj')).toBeNull();
    // Case matters here.
    expect(relativePath('/users/me/proj/a.ts', '/Users/me/proj')).toBeNull();
    expect(tailOf('/Users/me/proj', 2)).toBe('me/proj');
    expect(withoutRoot('Read /Users/me/proj/src/a.ts', '/Users/me/proj')).toBe('Read src/a.ts');
    expect(tildify('/Users/me/proj', '/Users/me')).toBe('~/proj');
    expect(tildify('/Users/meg/proj', '/Users/me')).toBe('/Users/meg/proj');
  });

  it('reads Windows paths, whatever the separator or case', () => {
    expect(baseName('C:\\Users\\me\\proj\\src\\a.ts')).toBe('a.ts');
    expect(parentOf('C:\\Users\\me\\proj\\src\\a.ts')).toBe('C:\\Users\\me\\proj\\src');
    expect(parentOf('C:\\proj')).toBe('C:\\');
    expect(joinPath('C:\\Users\\me\\proj', 'src/a.ts')).toBe('C:\\Users\\me\\proj\\src\\a.ts');
    expect(relativePath('C:\\Users\\me\\proj\\src\\a.ts', 'C:\\Users\\me\\proj')).toBe('src/a.ts');
    expect(relativePath('c:/users/me/PROJ/src/a.ts', 'C:\\Users\\me\\proj')).toBe('src/a.ts');
    expect(isInside('C:\\Users\\me\\proj2', 'C:\\Users\\me\\proj')).toBe(false);
    expect(samePath('C:\\Users\\me\\proj\\a.ts', 'C:/Users/me/proj/a.ts')).toBe(true);
    expect(tailOf('D:\\a\\alchemist-coder\\alchemist-coder', 2)).toBe('alchemist-coder\\alchemist-coder');
    expect(withoutRoot('Edit C:\\proj\\src\\a.ts', 'C:\\proj')).toBe('Edit src\\a.ts');
    expect(tildify('C:\\Users\\me\\proj', 'C:\\Users\\me')).toBe('~\\proj');
  });
});
