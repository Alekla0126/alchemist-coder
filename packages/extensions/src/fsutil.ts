import { chmodSync, lstatSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export type Kind = 'missing' | 'file' | 'link' | 'other';

/** What sits at `path` without following symlinks. */
export function kindOf(path: string): Kind {
  const s = lstatSync(path, { throwIfNoEntry: false });
  if (!s) return 'missing';
  if (s.isSymbolicLink()) return 'link';
  return s.isFile() ? 'file' : 'other';
}

/** Where a symlink points, or null when it's dangling. */
export function linkTarget(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Writes via a temp file + rename in the same folder: readers never see half a file, and an
 * existing symlink at `path` is replaced, never followed. Keeps the old file's permissions
 * (config files holding tokens are often 600).
 */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  const old = statSync(path, { throwIfNoEntry: false });
  writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  try {
    chmodSync(tmp, old?.isFile() ? old.mode & 0o777 : 0o644);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw error;
  }
}
