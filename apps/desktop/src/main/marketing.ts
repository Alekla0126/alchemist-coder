import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MarketingBrand, MarketingChannel, MarketingData, MarketingDraft, MarketingPiece, MarketingStatus } from '../shared/api';
import { brandMarkdown } from '../shared/marketing';

export { brandMarkdown };

/**
 * Marketing mode keeps everything in the project's own marketing/ folder, so it travels with the
 * project and any agent can read it: marketing.json (brand and pieces), BRAND.md (the brand as
 * text, rewritten on every save) and drafts/ (what the marketing team writes).
 */

export const CHANNELS: MarketingChannel[] = ['x', 'thread', 'instagram', 'linkedin', 'tiktok', 'email', 'landing', 'blog', 'appstore', 'play', 'seo'];
const STATUSES: MarketingStatus[] = ['idea', 'draft', 'approved', 'scheduled', 'published'];
const BRAND_KEYS: Array<keyof MarketingBrand> = ['product', 'pitch', 'audience', 'tone', 'say', 'avoid', 'claims', 'links', 'languages'];
const MAX_PIECES = 2000;

export const emptyBrand = (): MarketingBrand => ({ product: '', pitch: '', audience: '', tone: '', say: '', avoid: '', claims: '', links: '', languages: '' });
export const emptyMarketing = (): MarketingData => ({ version: 1, brand: emptyBrand(), pieces: [] });

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Date.now());

/** Whatever was stored or sent, as valid marketing data: unknown fields dropped, sizes capped. */
export function cleanMarketing(raw: unknown): MarketingData {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const b = o.brand && typeof o.brand === 'object' ? (o.brand as Record<string, unknown>) : {};
  const brand = emptyBrand();
  for (const k of BRAND_KEYS) brand[k] = str(b[k], 4000);
  const pieces: MarketingPiece[] = [];
  for (const p of Array.isArray(o.pieces) ? o.pieces.slice(0, MAX_PIECES) : []) {
    if (!p || typeof p !== 'object') continue;
    const x = p as Record<string, unknown>;
    const id = str(x.id, 64);
    if (!/^[\w-]{1,64}$/.test(id)) continue;
    const date = str(x.date, 10);
    pieces.push({
      id,
      channel: CHANNELS.includes(x.channel as MarketingChannel) ? (x.channel as MarketingChannel) : 'x',
      title: str(x.title, 300),
      brief: str(x.brief, 4000),
      body: str(x.body, 60_000),
      status: STATUSES.includes(x.status as MarketingStatus) ? (x.status as MarketingStatus) : 'idea',
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      language: str(x.language, 12),
      createdAt: num(x.createdAt),
      updatedAt: num(x.updatedAt),
      source: typeof x.source === 'string' ? str(x.source, 300) : null,
    });
  }
  return { version: 1, brand, pieces };
}

/** Writes through a temporary file, so a crash never leaves half a file. */
function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** `root` is the project folder, already checked by the caller (Workspace.projectFolder). */
export function loadMarketing(root: string): MarketingData {
  const file = join(root, 'marketing', 'marketing.json');
  if (!existsSync(file)) return emptyMarketing();
  try {
    return cleanMarketing(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return emptyMarketing();
  }
}

export function saveMarketing(root: string, data: unknown): MarketingData {
  const clean = cleanMarketing(data);
  const dir = join(root, 'marketing');
  // Never follow a symlink out of the project.
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('marketing/ is a link; refusing to write through it');
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, 'marketing.json'), `${JSON.stringify(clean, null, 2)}\n`);
  writeAtomic(join(dir, 'BRAND.md'), brandMarkdown(clean.brand));
  return clean;
}

/** marketing/drafts/*.md, with an optional front matter (channel: x, title: …). */
export function readDrafts(root: string): MarketingDraft[] {
  const dir = join(root, 'marketing', 'drafts');
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return [];
  const out: MarketingDraft[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(0, 300)) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 200_000) continue;
    const text = readFileSync(path, 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    const meta: Record<string, string> = {};
    for (const line of fm?.[1]?.split('\n') ?? []) {
      const m = /^(\w+):\s*(.*)$/.exec(line.trim());
      if (m) meta[m[1]!.toLowerCase()] = m[2]!.replace(/^["']|["']$/g, '');
    }
    const body = (fm ? text.slice(fm[0].length) : text).trim();
    const channel = CHANNELS.includes(meta.channel as MarketingChannel) ? (meta.channel as MarketingChannel) : null;
    out.push({ file: `marketing/drafts/${name}`, title: meta.title || basename(name, '.md').replace(/[-_]+/g, ' '), channel, body });
  }
  return out;
}
