import { describe, expect, it } from 'vitest';
import { fitModes, modesRoom } from '../src/renderer/src/mode-fit';

describe('the mode bar', () => {
  const widths = { full: 760, active: 360, icons: 290 };
  it('shows as much as fits: names, the open one’s name, icons, or one menu', () => {
    expect(fitModes(900, widths)).toBe('full');
    expect(fitModes(700, widths)).toBe('active');
    expect(fitModes(300, widths)).toBe('icons');
    expect(fitModes(200, widths)).toBe('menu');
  });
  it('has the room left by the rest of the title bar', () => {
    expect(modesRoom({ inner: 1704, gap: 14, fixedLeft: 162, right: 415, crumbMin: 120 })).toBe(951);
    // A narrower window shows fewer names, never more.
    const room = (inner: number) => fitModes(modesRoom({ inner, gap: 14, fixedLeft: 162, right: 415, crumbMin: 120 }), widths);
    const order = ['full', 'active', 'icons', 'menu'];
    const seen = [1900, 1700, 1500, 1300, 1100, 900, 700].map((w) => order.indexOf(room(w)));
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});
