import { describe, expect, it } from 'vitest';
import { fold, foldWithMap } from '../src/renderer/src/fold';

describe('accent folding', () => {
  it('maps folded positions back to the original text', () => {
    expect(fold('Búsqueda Ñandú')).toBe('busqueda nandu');
    const text = 'La búsqueda rápida';
    const { folded, map } = foldWithMap(text);
    const i = folded.indexOf('busqueda');
    expect(text.slice(map[i], map[i + 'busqueda'.length - 1]! + 1)).toBe('búsqueda');
    // A precomposed character that folds away cleanly keeps the lengths aligned.
    expect(foldWithMap('é').folded).toBe('e');
  });
});
