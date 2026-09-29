import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const CHUNK = 4 * 1024 * 1024;

/**
 * Streams a JSONL file line by line with exact byte offsets, so the index can
 * point back into the original file instead of copying its contents.
 */
export function forEachLine(path: string, onLine: (line: string, offset: number, length: number) => void): number {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry: Buffer | null = null;
    let carryStart = 0;
    let pos = 0;
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      const data: Buffer = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const dataStart = carry ? carryStart : pos;
      let lineStart = 0;
      let nl = data.indexOf(10, lineStart);
      while (nl !== -1) {
        if (nl > lineStart) onLine(data.toString('utf8', lineStart, nl), dataStart + lineStart, nl - lineStart);
        lineStart = nl + 1;
        nl = data.indexOf(10, lineStart);
      }
      // Copy the tail: `buf` is reused on the next read.
      carry = lineStart < data.length ? Buffer.from(data.subarray(lineStart)) : null;
      carryStart = dataStart + lineStart;
      pos += n;
    }
    // A trailing line without newline may still be mid-write; callers ignore JSON that fails to parse.
    if (carry && carry.length > 0) onLine(carry.toString('utf8'), carryStart, carry.length);
    return size;
  } finally {
    closeSync(fd);
  }
}

export function readSlice(fd: number, offset: number, length: number): string {
  const buf = Buffer.allocUnsafe(length);
  readSync(fd, buf, 0, length, offset);
  return buf.toString('utf8');
}
