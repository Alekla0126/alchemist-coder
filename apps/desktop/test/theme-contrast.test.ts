import { describe, expect, it } from 'vitest';
import { contrast, readableAccent, readableMuted } from '../src/renderer/src/theme';

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
    // A translucent gray counts as it shows on the background, not as its opaque base.
    const faint = readableMuted('#1b1f234d', '#24292e', '#ffffff')!;
    expect(faint).not.toBeNull();
    expect(contrast(rgb(faint), rgb('#ffffff'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('an accent you can see', () => {
  it("skips a theme accent that blends into the background for the theme's next one that shows", () => {
    // Shades of Purple (Super Dark): focusBorder #15152b on #191830, the buttons' yellow after it.
    expect(readableAccent(['#15152b', '#FAD000dd', '#FAD000'], '#191830')).toBe('#FAD000dd');
    // One that already shows stays; none that shows keeps the theme's own.
    expect(readableAccent(['#d97a4a', '#f0b27a'], '#0d1117')).toBeNull();
    expect(readableAccent(['#15152b', '#1a1a33'], '#191830')).toBeNull();
    // Missing ones are skipped, and an unreadable background changes nothing.
    expect(readableAccent([undefined, '#15152b', '#0969da'], '#191830')).toBe('#0969da');
    expect(readableAccent(['#15152b', '#FAD000'], 'color-mix(in srgb, red, blue)')).toBeNull();
  });
});
