import { createHash } from 'node:crypto';
import { themesFromVsix, type ThemeFile } from './vsix.ts';

const API = 'https://open-vsx.org/api';
const MAX_VSIX = 25 * 1024 * 1024;

export interface ThemeExtension {
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  downloads: number;
  verified: boolean;
}

type FetchFn = typeof fetch;

/** Theme extensions on Open VSX, the open registry of VS Code extensions. */
export async function searchThemes(query: string, fetchImpl: FetchFn = fetch): Promise<ThemeExtension[]> {
  const url = `${API}/-/search?${new URLSearchParams({ query: query.slice(0, 80), category: 'Themes', size: '24', sortBy: 'downloadCount', sortOrder: 'desc' })}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open VSX search failed (${res.status})`);
  const data = (await res.json()) as { extensions?: Array<Record<string, any>> };
  return (data.extensions ?? [])
    .filter((e) => !e.deprecated && typeof e.namespace === 'string' && typeof e.name === 'string')
    .map((e) => ({
      namespace: e.namespace,
      name: e.name,
      displayName: String(e.displayName || e.name),
      description: String(e.description ?? ''),
      version: String(e.version ?? ''),
      downloads: Number(e.downloadCount) || 0,
      verified: e.verified === true,
    }));
}

const ID = /^[\w.-]{1,100}$/;

/** The response body, stopping as soon as it passes `max` bytes (never buffers a huge download). */
async function readLimited(res: Response, max: number): Promise<Buffer> {
  const tooLarge = () => new Error('This extension is too large');
  if (Number(res.headers.get('content-length') ?? 0) > max) throw tooLarge();
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > max) {
      await res.body.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Downloads the latest version, checks its SHA-256 when Open VSX publishes one, and reads its themes. */
export async function installFromOpenVsx(namespace: string, name: string, fetchImpl: FetchFn = fetch): Promise<ThemeFile[]> {
  if (!ID.test(namespace) || !ID.test(name)) throw new Error('Invalid extension id');
  const meta = await fetchImpl(`${API}/${namespace}/${name}/latest`, { signal: AbortSignal.timeout(15_000) });
  if (!meta.ok) throw new Error(`Extension not found (${meta.status})`);
  const info = (await meta.json()) as { files?: { download?: string; sha256?: string } };
  const download = info.files?.download;
  if (!download || !download.startsWith(`${API}/`)) throw new Error('This extension has no download');
  const res = await fetchImpl(download, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = await readLimited(res, MAX_VSIX);
  if (info.files?.sha256?.startsWith(`${API}/`)) {
    const sum = await fetchImpl(info.files.sha256, { signal: AbortSignal.timeout(15_000) });
    if (sum.ok) {
      const expected = (await sum.text()).trim().split(/\s+/)[0]?.toLowerCase();
      const actual = createHash('sha256').update(buf).digest('hex');
      if (expected && expected !== actual) throw new Error('The download did not match its checksum');
    }
  }
  return themesFromVsix(buf);
}
