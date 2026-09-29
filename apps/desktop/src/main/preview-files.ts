import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

export const PREVIEW_SCHEME = 'acpreview';

/**
 * Previews may run the agent's scripts but never reach the network: everything must come from the
 * same preview root (or be inline / data:).
 */
export const PREVIEW_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Stable, opaque host name for a preview root. */
export function rootToken(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 20);
}

/** `acpreview://<token>/<relative path>` for a file inside `root`. */
export function previewUrl(root: string, file: string): string {
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== resolve(file)) throw new Error('The file is not inside the preview folder');
  return `${PREVIEW_SCHEME}://${rootToken(root)}/${rel.split(sep).map(encodeURIComponent).join('/')}`;
}

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * Maps a request path back to a regular file under `root`; null when it would escape the root
 * (including through a symlink an agent left in its worktree) or doesn't exist. Folders serve
 * their index.html.
 */
export function resolveRequest(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const realRoot = real(root);
  if (!realRoot || !within(full, root)) return null;
  let file = real(full);
  if (file && statSync(file).isDirectory()) file = real(join(file, 'index.html'));
  if (!file || !within(file, realRoot) || !statSync(file).isFile()) return null;
  return file;
}
