/**
 * Paths reach the renderer in the OS's own form: "C:\proj\src\a.ts" on Windows, where "/" works
 * too and case doesn't matter. Paths relative to a project, from the main process, use "/".
 */

const SEPS = /[\\/]+/;
const windowsLike = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
const slashes = (p: string) => p.replace(/\\/g, '/');

/** The separator a path already uses. */
export const sepOf = (p: string) => (windowsLike(p) ? '\\' : '/');

/** Without trailing separators (a lone "/" stays). */
const trimSep = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') || p.slice(0, 1) : p);

export const baseName = (p: string) => trimSep(p).split(SEPS).pop() || p;

/** The folder a path is in ("/" or "C:\" at the top). */
export function parentOf(p: string): string {
  const t = trimSep(p);
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (i < 0) return t;
  const parent = t.slice(0, i);
  return !parent || /^[A-Za-z]:$/.test(parent) ? t.slice(0, i + 1) : parent;
}

/** A "/"-separated path inside `root`, written the way `root` is. */
export function joinPath(root: string, rel: string): string {
  const s = sepOf(root);
  const parts = rel.split(SEPS).filter(Boolean);
  const base = trimSep(root);
  return parts.length ? `${base}${base.endsWith(s) ? '' : s}${parts.join(s)}` : base;
}

/** `p` relative to `root`, "/"-separated: "" when it is `root`, null when it is outside. */
export function relativePath(p: string, root: string): string | null {
  const r = slashes(trimSep(root));
  const q = slashes(p);
  const head = q.slice(0, r.length);
  if (windowsLike(root) ? head.toLowerCase() !== r.toLowerCase() : head !== r) return null;
  if (r.endsWith('/')) return q.slice(r.length);
  if (q.length === r.length) return '';
  return q[r.length] === '/' ? q.slice(r.length + 1).replace(/\/+$/, '') : null;
}

/** Whether `p` is `root` or inside it. */
export const isInside = (p: string, root: string) => relativePath(p, root) !== null;

/** Whether two paths name the same file. */
export const samePath = (a: string, b: string) => relativePath(a, b) === '';

/** The last `n` parts of a long path, for showing it. */
export const tailOf = (p: string, n: number) => trimSep(p).split(SEPS).slice(-n).join(sepOf(p));

/** `p` with the home folder written as ~ (macOS and Linux style, also on Windows). */
export function tildify(p: string, home: string): string {
  if (!home) return p;
  const rel = relativePath(p, home);
  return rel === null ? p : rel ? `~${sepOf(p)}${rel.split('/').join(sepOf(p))}` : '~';
}

/** Text with every mention of `root/` taken out ("Read /proj/src/a.ts" → "Read src/a.ts"). */
export const withoutRoot = (text: string, root: string) => {
  const r = trimSep(root);
  return [`${r}/`, `${r}\\`].reduce((s, prefix) => s.split(prefix).join(''), text);
};
