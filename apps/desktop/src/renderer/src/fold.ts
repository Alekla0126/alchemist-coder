/** Lowercase without accents: "Búsqueda" matches "busqueda". */
export const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * `text` lowercased without accents, and for each of its characters the index in `text` it came
 * from ("é" folds to "e": the lengths can differ).
 */
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]!);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
  }
  map.push(text.length);
  return { folded, map };
}

