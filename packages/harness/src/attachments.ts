import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { PromptFile, PromptImage } from '@alchemist-coder/core';

/**
 * Files sent with a prompt live in the project, where every agent can open them without asking to
 * read outside it: `<project>/.alchemist/attachments/<date>-<name>`. `.alchemist/` keeps a
 * `.gitignore` of `*`, so nothing in it is ever committed (worktrees, attachments…).
 */
export const ATTACHMENTS_DIR = join('.alchemist', 'attachments');

/** Bigger files stay where they are (a video or a disk image isn't worth a copy). */
export const COPY_LIMIT = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

/** A file's media type by its extension; null when it isn't a known one. */
export function mimeOf(name: string): string | null {
  return MIME[extname(name).slice(1).toLowerCase()] ?? null;
}

/** A file name that is safe in any folder: no path, no control characters, not too long. */
export function safeName(name: unknown, fallback = 'file'): string {
  const base = basename(String(name ?? '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!base) return fallback;
  if (base.length <= 120) return base;
  const ext = extname(base).slice(0, 16);
  return base.slice(0, 120 - ext.length) + ext;
}

/** The folder, created with its `.gitignore` the first time. */
export function attachmentsDir(cwd: string): string {
  const root = join(cwd, '.alchemist');
  const dir = join(root, 'attachments');
  mkdirSync(dir, { recursive: true });
  const ignore = join(root, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# Alchemist Coder: worktrees, attachments… never committed\n*\n');
  return dir;
}

let counter = 0;
/** `20261013-142501-report.pdf`: in order, and never over another one. */
function freshPath(dir: string, name: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  for (;;) {
    const path = join(dir, `${stamp}${counter ? `-${counter}` : ''}-${name}`);
    counter = (counter + 1) % 1000;
    if (!existsSync(path)) return path;
  }
}

/** Whether `path` is inside `cwd` (then it's used where it is). */
export function insideProject(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/**
 * A file the user picked or dropped, ready for the agent: copied into the attachments folder, or
 * linked where it is when it is already in the project or bigger than COPY_LIMIT. Null when it
 * isn't a readable regular file.
 */
export function stageFile(cwd: string, source: string, name?: string): PromptFile | null {
  if (!isAbsolute(source)) return null;
  const s = statSync(source, { throwIfNoEntry: false });
  if (!s?.isFile()) return null;
  const shown = safeName(name ?? basename(source));
  const path = insideProject(cwd, source) || s.size > COPY_LIMIT ? source : freshPath(attachmentsDir(cwd), shown);
  if (path !== source) copyFileSync(source, path);
  return { path, name: shown, mimeType: mimeOf(shown), size: s.size };
}

/** File contents that have no path of their own (pasted from the clipboard). */
export function stageData(cwd: string, name: string, data: Buffer): PromptFile {
  const shown = safeName(name);
  const path = freshPath(attachmentsDir(cwd), shown);
  writeFileSync(path, data);
  return { path, name: shown, mimeType: mimeOf(shown), size: data.length };
}

const EXT: Record<PromptImage['mediaType'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** An image for an agent that can't see images: as a file it can still open. */
export function stageImage(cwd: string, image: PromptImage, index: number): PromptFile {
  return stageData(cwd, `image-${index + 1}.${EXT[image.mediaType]}`, Buffer.from(image.data, 'base64'));
}
