import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { installFromOpenVsx, parseJsonc, searchThemes, themesFromVsix } from '../src/index.ts';

/** Minimal zip writer for tests (deflate for some entries, stored for others). */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text);
    const deflate = i % 2 === 0;
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc32(raw), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const vsix = zip({
  'extension/package.json': JSON.stringify({ name: 'night-owl', contributes: { themes: [
    { label: 'Owl Night', uiTheme: 'vs-dark', path: './themes/night.json' },
    { label: 'Owl Day', uiTheme: 'vs', path: 'themes/day.jsonc' },
    { label: 'Escape', uiTheme: 'vs-dark', path: '../../etc/passwd' },
  ] } }),
  'extension/themes/base.json': JSON.stringify({ colors: { 'editor.background': '#000000', 'editor.foreground': '#dddddd' }, tokenColors: [{ scope: 'comment', settings: { foreground: '#666666' } }] }),
  'extension/themes/night.json': JSON.stringify({ include: './base.json', colors: { 'editor.background': '#011627' }, tokenColors: [{ scope: 'string', settings: { foreground: '#ecc48d' } }] }),
  'extension/themes/day.jsonc': '{\n  // light variant\n  "$schema": "vscode://schemas/color-theme",\n  "colors": { "editor.background": "#fbfbfb", },\n}\n',
  '[Content_Types].xml': '<Types/>',
});

describe('parseJsonc', () => {
  it('drops comments and trailing commas but keeps "//" inside strings', () => {
    expect(parseJsonc('{\n // c\n "a": "http://x/y", /* b */ "b": [1, 2,],\n}')).toEqual({ a: 'http://x/y', b: [1, 2] });
    expect(parseJsonc('{"q": "say \\"hi\\" // not a comment"}')).toEqual({ q: 'say "hi" // not a comment' });
  });
});

describe('themesFromVsix', () => {
  it('reads every contributed theme, merging included bases', () => {
    const themes = themesFromVsix(vsix);
    expect(themes.map((t) => [t.name, t.type])).toEqual([
      ['Owl Night', 'dark'],
      ['Owl Day', 'light'],
    ]);
    expect(themes[0]!.colors).toEqual({ 'editor.background': '#011627', 'editor.foreground': '#dddddd' });
    expect(themes[0]!.tokenColors).toHaveLength(2);
    expect(themes[1]!.colors).toEqual({ 'editor.background': '#fbfbfb' });
  });

  it('rejects files that are not theme extensions', () => {
    expect(() => themesFromVsix(Buffer.from('nope'))).toThrow(/zip/);
    expect(() => themesFromVsix(zip({ 'extension/package.json': '{"name":"x"}' }))).toThrow(/no color themes/);
    expect(() => themesFromVsix(zip({ 'readme.md': 'hi' }))).toThrow(/not a VS Code extension/);
  });
});

describe('Open VSX', () => {
  const API = 'https://open-vsx.org/api';
  const sha = createHash('sha256').update(vsix).digest('hex');
  const fakeFetch = (sum: string) =>
    (async (url: string) => {
      const u = String(url);
      if (u.includes('/-/search')) return new Response(JSON.stringify({ extensions: [{ namespace: 'owl', name: 'night-owl', displayName: 'Night Owl', version: '2.0.0', downloadCount: 1200, verified: true }, { namespace: 'old', name: 'x', deprecated: true }] }));
      if (u === `${API}/owl/night-owl/latest`) return new Response(JSON.stringify({ files: { download: `${API}/owl/night-owl/2.0.0/file/owl.vsix`, sha256: `${API}/owl/night-owl/2.0.0/file/owl.sha256` } }));
      if (u.endsWith('owl.vsix')) return new Response(vsix);
      if (u.endsWith('owl.sha256')) return new Response(`${sum}  owl.vsix\n`);
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

  it('searches theme extensions', async () => {
    expect(await searchThemes('owl', fakeFetch(sha))).toEqual([{ namespace: 'owl', name: 'night-owl', displayName: 'Night Owl', description: '', version: '2.0.0', downloads: 1200, verified: true }]);
  });

  it('installs a theme after checking its checksum', async () => {
    expect((await installFromOpenVsx('owl', 'night-owl', fakeFetch(sha))).map((t) => t.name)).toEqual(['Owl Night', 'Owl Day']);
    await expect(installFromOpenVsx('owl', 'night-owl', fakeFetch('0'.repeat(64)))).rejects.toThrow(/checksum/);
    await expect(installFromOpenVsx('../etc', 'x', fakeFetch(sha))).rejects.toThrow(/Invalid/);
  });

  it('stops reading a download as soon as it is too large', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const huge = (async (url: string | URL | Request) =>
      String(url).endsWith('/latest') ? Response.json({ files: { download: 'https://open-vsx.org/api/owl/night-owl/2.0.0/file/owl.vsix' } }) : new Response(endless)) as typeof fetch;
    await expect(installFromOpenVsx('owl', 'night-owl', huge)).rejects.toThrow(/too large/);
    expect(pulled).toBeLessThan(40);
  });
});

describe('limits', () => {
  it('reads each theme file once and ignores absurd theme counts', () => {
    const many = zip({
      'extension/package.json': JSON.stringify({ contributes: { themes: Array.from({ length: 500 }, (_, i) => ({ label: `T${i}`, path: 'themes/t.json' })) } }),
      'extension/themes/t.json': JSON.stringify({ colors: { 'editor.background': '#000000' } }),
    });
    expect(themesFromVsix(many)).toHaveLength(40);
  });
});
