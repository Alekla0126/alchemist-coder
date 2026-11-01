import { bundledThemes } from 'shiki/themes';
import { describe, expect, it } from 'vitest';
import { alchemistDark, BUNDLED, contrast, FALLBACK, readableMuted, WORKBENCH, type VsTheme } from '../src/renderer/src/theme';

type RGB = [number, number, number];
const hex = (s: string, over?: RGB): RGB | null => {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})([0-9a-f]{2}|[0-9a-f])?$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
  const a = m[2] ? parseInt(m[2].length === 1 ? m[2] + m[2] : m[2], 16) / 255 : 1;
  return over && a < 1 ? (rgb.map((v, i) => v * a + over[i]! * (1 - a)) as RGB) : rgb;
};
const mix = (a: RGB, b: RGB, p: number) => a.map((v, i) => v * p + b[i]! * (1 - p)) as RGB;

/** The app's colors for a theme, as applyWorkbench sets them (fallbacks mixed from its text and background). */
function varsOf(theme: VsTheme): Record<string, RGB> {
  const colors = theme.colors ?? {};
  const raw = Object.fromEntries(WORKBENCH.map(([v, keys]) => [v, keys.map((k) => colors[k]).find((x) => typeof x === 'string' && x)]));
  const bg = hex(raw['--bg'] ?? '#0f1115')!;
  const fg = hex(raw['--fg'] ?? '#e6e9ef', bg)!;
  const out: Record<string, RGB> = { '--bg': bg, '--fg': fg };
  for (const [v] of WORKBENCH) {
    if (out[v]) continue;
    const own = raw[v] ? hex(raw[v]!, bg) : null;
    const fb = /color-mix\(in srgb, var\(--fg\) (\d+)%, var\(--bg\)\)/.exec(FALLBACK[v] ?? '');
    if (own) out[v] = own;
    else if (fb) out[v] = mix(fg, bg, Number(fb[1]) / 100);
  }
  // The office's own secondary text (styles.css, .ofc).
  out['--ofc-muted'] = mix(fg, bg, 0.86);
  const muted = readableMuted(raw['--fg-3'], raw['--fg'] ?? '#e6e9ef', raw['--bg'] ?? '#0f1115');
  if (muted) out['--fg-3'] = hex(muted)!;
  return out;
}

/** The office's text and the surface right beside it: rooms (--bg), departments (--bg-side), chips (--bg-input), the sheet (--bg-card), hover (--bg-hl). */
const SURFACES = ['--bg', '--bg-side', '--bg-hl', '--bg-input', '--bg-card'];
const PAIRS: Array<[string, string]> = SURFACES.flatMap((b) => [['--fg', b] as [string, string], ['--ofc-muted', b] as [string, string]]);
/** Themes whose own text is under 4.5:1 on their own background: the whole app reads like that there, not only the office. */
const FAINT = ['tokyo-night', 'solarized-light'];

describe("the office's text reads in every bundled theme", async () => {
  const themes: Array<[string, VsTheme]> = [['alchemist-dark', alchemistDark]];
  for (const t of BUNDLED.filter((x) => x.id !== 'alchemist-dark')) {
    const load = (bundledThemes as Record<string, () => Promise<{ default: VsTheme }>>)[t.id];
    if (load) themes.push([t.id, (await load()).default]);
  }
  it.each(themes)('%s', (id, theme) => {
    const v = varsOf(theme);
    // Their own text doesn't reach 4.5:1 on their background, so no gray of theirs can: say so, and
    // fail when it changes, so they join the check.
    if (FAINT.includes(id)) return void expect(contrast(v['--fg']!, v['--bg']!)).toBeLessThan(4.5);
    const low = PAIRS.filter(([f, b]) => v[f] && v[b] && contrast(v[f]!, v[b]!) < 4.5).map(([f, b]) => `${f} on ${b}: ${contrast(v[f]!, v[b]!).toFixed(2)}`);
    expect(low).toEqual([]);
  });
});
