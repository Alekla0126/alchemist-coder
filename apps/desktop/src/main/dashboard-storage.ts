import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeDashboardState(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    if (process.platform !== 'win32') { const dir = openSync(dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
  } finally { rmSync(temp, { force: true }); }
}

/** One writer per stream/inbox. Recover a dead process, never steal a live writer's lock. */
export function claimDashboardState(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + '.lock', recovery = lock + '.recovery';
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const acquire = () => { const fd = openSync(lock, 'wx', 0o600); try { writeFileSync(fd, owner); fsyncSync(fd); } finally { closeSync(fd); } };
  try { if (existsSync(recovery)) throw new Error('Recovery busy'); acquire(); }
  catch {
    const gate = openSync(recovery, 'wx', 0o600);
    try {
      if (existsSync(lock)) {
        const saved = JSON.parse(readFileSync(lock, 'utf8')) as { pid?: unknown };
        if (!Number.isSafeInteger(saved.pid) || Number(saved.pid) < 1) throw new Error('Invalid writer lock');
        try { process.kill(Number(saved.pid), 0); throw new Error('Writer busy'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Writer busy'); }
        rmSync(lock);
      }
      acquire();
    } finally { closeSync(gate); rmSync(recovery, { force: true }); }
  }
  let released = false;
  return () => { if (released) return; released = true; if (existsSync(lock) && readFileSync(lock, 'utf8') === owner) rmSync(lock); };
}
