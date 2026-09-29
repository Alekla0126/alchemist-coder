import { describe, expect, it } from 'vitest';
import { contrast, readableMuted } from '../src/renderer/src/theme';

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

describe('readable secondary text', () => {
  it('darkens a faint theme gray until it reads (4.5:1), and leaves a good one alone', () => {
    // GitHub Light's disabled gray on white: about 1.9:1.
    const fixed = readableMuted('#babbbc', '#1f2328', '#ffffff')!;
    expect(contrast(rgb(fixed), rgb('#ffffff'))).toBeGreaterThanOrEqual(4.5);
    expect(readableMuted('#6e7781', '#1f2328', '#ffffff')).toBeNull();
    // Dark themes too, and a theme without the color at all.
    const dark = readableMuted(undefined, '#e6edf3', '#0d1117')!;
    expect(contrast(rgb(dark), rgb('#0d1117'))).toBeGreaterThanOrEqual(4.5);
    expect(readableMuted('#abc', 'color-mix(in srgb, red, blue)', '#fff')).toBeNull();
  });
});
