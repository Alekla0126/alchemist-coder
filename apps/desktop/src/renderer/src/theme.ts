import { bundledThemes } from 'shiki/themes';

/** A VS Code color theme (the same JSON format VS Code and Shiki use). */
export interface VsTheme {
  name: string;
  type?: 'dark' | 'light';
  colors?: Record<string, string>;
  tokenColors?: unknown[];
  settings?: unknown[];
  [key: string]: unknown;
}

export interface ThemeEntry {
  id: string;
  label: string;
  type: 'dark' | 'light';
  custom?: boolean;
}

const CUSTOM_KEY = 'alchemist.themes';

export const alchemistDark: VsTheme = {
  name: 'alchemist-dark',
  type: 'dark',
  colors: {
    'editor.background': '#0f1115',
    'editor.foreground': '#e6e9ef',
    'sideBar.background': '#12161e',
    'activityBar.background': '#0c0e12',
    'titleBar.activeBackground': '#0c0e12',
    'list.hoverBackground': '#1b212c',
    'list.activeSelectionBackground': '#d97a4a24',
    'input.background': '#161b24',
    'editorWidget.background': '#151922',
    'panel.border': '#1c222d',
    'input.border': '#2a3240',
    foreground: '#e6e9ef',
    descriptionForeground: '#a3adbb',
    disabledForeground: '#6b7486',
    focusBorder: '#d97a4a',
    'button.hoverBackground': '#f0b27a',
    'editorLineNumber.foreground': '#3b4252',
    'editorLineNumber.activeForeground': '#a3adbb',
    'editor.lineHighlightBackground': '#161b24',
    'editor.selectionBackground': '#d97a4a40',
    'editorCursor.foreground': '#f0b27a',
    'terminal.background': '#0c0e12',
    'terminal.foreground': '#e6e9ef',
    'terminal.ansiBlack': '#1b212c',
    'terminal.ansiRed': '#f85149',
    'terminal.ansiGreen': '#3fb950',
    'terminal.ansiYellow': '#d29922',
    'terminal.ansiBlue': '#5b8def',
    'terminal.ansiMagenta': '#a371f7',
    'terminal.ansiCyan': '#3fd0bf',
    'terminal.ansiWhite': '#c9d1d9',
    'terminal.ansiBrightBlack': '#6b7486',
    'terminal.ansiBrightRed': '#ff7b72',
    'terminal.ansiBrightGreen': '#56d364',
    'terminal.ansiBrightYellow': '#e3b341',
    'terminal.ansiBrightBlue': '#79c0ff',
    'terminal.ansiBrightMagenta': '#d2a8ff',
    'terminal.ansiBrightCyan': '#56e0d0',
    'terminal.ansiBrightWhite': '#f0f6fc',
  },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#6b7486', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier'], settings: { foreground: '#c9a3ff' } },
    { scope: ['string', 'string.template'], settings: { foreground: '#a8d98a' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call'], settings: { foreground: '#8fb6ff' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#6fd6e6' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: '#ff9e64' } },
    { scope: ['variable.parameter'], settings: { foreground: '#f0c27a' } },
    { scope: ['variable.other.property', 'support.variable.property', 'meta.object-literal.key'], settings: { foreground: '#7fe0cc' } },
    { scope: ['keyword.operator', 'punctuation'], settings: { foreground: '#a79fb0' } },
    { scope: ['entity.name.tag'], settings: { foreground: '#ff7a8e' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: '#f0c27a' } },
    { scope: ['markup.heading'], settings: { foreground: '#f0b27a', fontStyle: 'bold' } },
    { scope: ['markup.inline.raw', 'markup.fenced_code'], settings: { foreground: '#f0b27a' } },
  ],
};

// VS Code themes bundled by Shiki (MIT-licensed by their authors).
export const BUNDLED: ThemeEntry[] = [
  { id: 'alchemist-dark', label: 'Alchemist Dark', type: 'dark' },
  { id: 'tokyo-night', label: 'Tokyo Night', type: 'dark' },
  { id: 'dracula', label: 'Dracula', type: 'dark' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', type: 'dark' },
  { id: 'one-dark-pro', label: 'One Dark Pro', type: 'dark' },
  { id: 'github-dark', label: 'GitHub Dark', type: 'dark' },
  { id: 'nord', label: 'Nord', type: 'dark' },
  { id: 'rose-pine', label: 'Rosé Pine', type: 'dark' },
  { id: 'github-light', label: 'GitHub Light', type: 'light' },
  { id: 'solarized-light', label: 'Solarized Light', type: 'light' },
];

function customThemes(): Record<string, VsTheme> {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '{}') as Record<string, VsTheme>;
  } catch {
    return {};
  }
}

export function listThemes(): ThemeEntry[] {
  const custom = Object.entries(customThemes()).map(([id, t]) => ({
    id,
    label: String(t.displayName ?? t.label ?? id.replace(/^custom-/, '')),
    type: (t.type === 'light' ? 'light' : 'dark') as 'dark' | 'light',
    custom: true,
  }));
  return [...BUNDLED, ...custom];
}

export function saveCustomTheme(json: VsTheme): string {
  const label = String(json.name ?? 'Imported theme');
  const id = `custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'theme'}`;
  const all = customThemes();
  all[id] = { ...json, name: id, displayName: label, type: json.type === 'light' ? 'light' : 'dark' };
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(all));
  return id;
}

export async function loadTheme(id: string): Promise<VsTheme> {
  if (id.startsWith('custom-')) {
    const t = customThemes()[id];
    if (t) return t;
  }
  const loader = (bundledThemes as Record<string, () => Promise<{ default: VsTheme }>>)[id];
  if (!loader || id === 'alchemist-dark') return alchemistDark;
  const mod = await loader();
  return { ...mod.default, name: id };
}

/** CSS variable ← first VS Code workbench color that the theme defines. */
const WORKBENCH: Array<[string, string[]]> = [
  ['--bg', ['editor.background']],
  ['--bg-side', ['sideBar.background', 'editor.background']],
  ['--bg-rail', ['activityBar.background', 'sideBar.background', 'editor.background']],
  ['--bg-title', ['titleBar.activeBackground', 'activityBar.background', 'sideBar.background']],
  ['--bg-hl', ['list.hoverBackground', 'editor.lineHighlightBackground']],
  ['--bg-sel', ['list.activeSelectionBackground', 'editor.selectionBackground']],
  ['--bg-input', ['input.background', 'dropdown.background', 'editorWidget.background']],
  ['--bg-card', ['editorWidget.background', 'editorHoverWidget.background', 'sideBar.background']],
  ['--line', ['panel.border', 'sideBar.border', 'editorGroup.border', 'tab.border']],
  ['--line-2', ['input.border', 'dropdown.border', 'panel.border', 'editorGroup.border']],
  ['--fg', ['foreground', 'editor.foreground']],
  ['--fg-2', ['descriptionForeground', 'sideBar.foreground', 'editor.foreground']],
  ['--fg-3', ['disabledForeground', 'editorLineNumber.foreground', 'tab.inactiveForeground']],
  ['--accent', ['focusBorder', 'button.background', 'activityBarBadge.background']],
  ['--accent-2', ['button.hoverBackground', 'textLink.foreground', 'focusBorder']],
];

/** Derived defaults for themes that leave some workbench colors undefined. */
const FALLBACK: Record<string, string> = {
  '--bg-hl': 'color-mix(in srgb, var(--fg) 7%, var(--bg))',
  '--bg-sel': 'color-mix(in srgb, var(--accent) 18%, transparent)',
  '--bg-input': 'color-mix(in srgb, var(--fg) 5%, var(--bg))',
  '--bg-card': 'color-mix(in srgb, var(--fg) 4%, var(--bg))',
  '--line': 'color-mix(in srgb, var(--fg) 10%, var(--bg))',
  '--line-2': 'color-mix(in srgb, var(--fg) 18%, var(--bg))',
  '--fg-2': 'color-mix(in srgb, var(--fg) 72%, var(--bg))',
  '--fg-3': 'color-mix(in srgb, var(--fg) 48%, var(--bg))',
  '--accent': '#d97a4a',
  '--accent-2': '#f0b27a',
};

/** Re-skins the whole app, not just the editor, from a VS Code theme. */
const brightness = (hex: string): number | null => {
  // Six digits first: "#d97a4a" must not read as "#d97". An alpha pair may follow.
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})(?:[0-9a-f]{2}|[0-9a-f])?$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** Dark text on light colors, white on dark ones (averaged over `colors`; unknown → the app's dark text). */
export function onColor(...colors: string[]): string {
  const values = colors.map(brightness).filter((v): v is number => v != null);
  if (!values.length) return '#1a0d05';
  return values.reduce((a, b) => a + b, 0) / values.length > 0.55 ? '#1a0d05' : '#ffffff';
}

const rgbOf = (hex: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})(?:[0-9a-f]{2}|[0-9a-f])?$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
/** WCAG contrast ratio between two opaque colors. */
export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const lum = (c: [number, number, number]) => {
    const [r, g, bl] = c.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
const toHex = (c: [number, number, number]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * Secondary text (times, hints, inactive tabs) readable on the theme's background: themes often use
 * a "disabled" gray far too faint to read (1.9:1 on GitHub Light). Below 4.5:1 it's mixed toward the
 * foreground until it passes.
 */
export function readableMuted(muted: string | undefined, fg: string, bg: string): string | null {
  const f = rgbOf(fg);
  const b = rgbOf(bg);
  if (!f || !b) return null;
  const m = muted ? rgbOf(muted) : null;
  if (m && contrast(m, b) >= 4.5) return null;
  for (let p = 0.5; p <= 0.95; p += 0.05) {
    const mix = f.map((v, i) => v * p + b[i]! * (1 - p)) as [number, number, number];
    if (contrast(mix, b) >= 4.5) return toHex(mix);
  }
  return toHex(f);
}

export function applyWorkbench(theme: VsTheme): void {
  const colors = theme.colors ?? {};
  const root = document.documentElement.style;
  const picked: Record<string, string | undefined> = {};
  for (const [cssVar, keys] of WORKBENCH) {
    const value = keys.map((k) => colors[k]).find((v) => typeof v === 'string' && v.length > 0);
    picked[cssVar] = value;
    if (value) root.setProperty(cssVar, value);
    else if (FALLBACK[cssVar]) root.setProperty(cssVar, FALLBACK[cssVar]!);
    else root.removeProperty(cssVar);
  }
  if (picked['--fg'] && picked['--bg']) {
    const muted = readableMuted(picked['--fg-3'], picked['--fg'], picked['--bg']);
    if (muted) root.setProperty('--fg-3', muted);
  }
  // Text on accent buttons: the theme's own button text, else dark or light by the accent's brightness.
  // Buttons are a gradient between the two accents: judge by both.
  const ends = [colors.focusBorder ?? colors['button.background'], colors['button.hoverBackground'] ?? colors['textLink.foreground']].filter((c): c is string => typeof c === 'string');
  root.setProperty('--on-accent', typeof colors['button.foreground'] === 'string' ? colors['button.foreground'] : onColor(...(ends.length ? ends : ['#d97a4a', '#f0b27a'])));
  root.setProperty('color-scheme', theme.type === 'light' ? 'light' : 'dark');
  document.documentElement.dataset.themeType = theme.type === 'light' ? 'light' : 'dark';
}

export function terminalTheme(theme: VsTheme): Record<string, string | undefined> {
  const c = theme.colors ?? {};
  const pick = (k: string) => c[`terminal.${k}`];
  return {
    background: c['terminal.background'] ?? c['panel.background'] ?? c['editor.background'],
    foreground: c['terminal.foreground'] ?? c['editor.foreground'] ?? c.foreground,
    cursor: c['terminalCursor.foreground'] ?? c['editorCursor.foreground'],
    selectionBackground: c['terminal.selectionBackground'] ?? c['editor.selectionBackground'],
    black: pick('ansiBlack'), red: pick('ansiRed'), green: pick('ansiGreen'), yellow: pick('ansiYellow'),
    blue: pick('ansiBlue'), magenta: pick('ansiMagenta'), cyan: pick('ansiCyan'), white: pick('ansiWhite'),
    brightBlack: pick('ansiBrightBlack'), brightRed: pick('ansiBrightRed'), brightGreen: pick('ansiBrightGreen'),
    brightYellow: pick('ansiBrightYellow'), brightBlue: pick('ansiBrightBlue'), brightMagenta: pick('ansiBrightMagenta'),
    brightCyan: pick('ansiBrightCyan'), brightWhite: pick('ansiBrightWhite'),
  };
}
