/**
 * Shortcuts are written the Mac way in the code ("⌘K", "⌘⇧F", "⌘↵"); on Windows and Linux they
 * read "Ctrl+K", "Ctrl+Shift+F", "Ctrl+Enter". The key handlers accept both ⌘ and Ctrl.
 */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);

const NAMES: Record<string, string> = { '⌘': 'Ctrl', '⌃': 'Ctrl', '⇧': 'Shift', '⌥': 'Alt' };
const KEYS: Record<string, string> = { '↵': 'Enter', '⌫': 'Backspace' };

export function keys(text: string, mac = IS_MAC): string {
  if (mac || !/[⌘⌃⇧⌥]/.test(text)) return text;
  return text
    .replace(/⌘\/Ctrl/g, 'Ctrl')
    .replace(/([⌘⌃⇧⌥]+)(?:(\s\+\s)|([^\s]))?/g, (_, mods: string, plus?: string, key?: string) => {
      const names = [...new Set([...mods].map((m) => NAMES[m]!))];
      if (plus) return `${names.join('+')}${plus}`;
      return key ? [...names, KEYS[key] ?? key].join('+') : names.join('+');
    });
}
