/** Why `name` can't be a folder on every OS, or null: no separators, reserved characters or names. */
export function projectNameError(name: string): 'empty' | 'long' | 'chars' | 'reserved' | null {
  const n = name.trim();
  if (!n) return 'empty';
  if (n.length > 80) return 'long';
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return 'chars';
  if (n === '.' || n === '..' || n.endsWith('.') || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) return 'reserved';
  return null;
}
