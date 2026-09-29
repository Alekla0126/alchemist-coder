import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { contentType, PREVIEW_CSP, previewUrl, resolveRequest, rootToken } from '../src/main/preview-files';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-')));
mkdirSync(join(root, 'site/assets'), { recursive: true });
writeFileSync(join(root, 'site/index.html'), '<h1>hi</h1>');
writeFileSync(join(root, 'site/assets/app.css'), 'h1{}');
writeFileSync(join(root, 'mock up.mockup.html'), '<p>mock</p>');
writeFileSync(join(root, '..', 'secret-preview.txt'), 'nope');
// What an agent could leave in its worktree to read files outside it through the preview.
symlinkSync(join(root, '..', 'secret-preview.txt'), join(root, 'site/leak.html'));
symlinkSync(join(root, '..'), join(root, 'up'));
symlinkSync('assets/app.css', join(root, 'site/inside.css'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(join(root, '..', 'secret-preview.txt'), { force: true });
});

describe('preview files', () => {
  it('builds opaque URLs for files inside the root', () => {
    const url = previewUrl(root, join(root, 'mock up.mockup.html'));
    expect(url).toBe(`acpreview://${rootToken(root)}/mock%20up.mockup.html`);
    expect(rootToken(root)).toMatch(/^[0-9a-f]{20}$/);
    expect(() => previewUrl(join(root, 'site'), join(root, 'mock up.mockup.html'))).toThrow(/not inside/);
  });

  it('serves files and folder indexes, never anything outside the root', () => {
    expect(resolveRequest(root, '/site/assets/app.css')).toBe(join(root, 'site/assets/app.css'));
    expect(resolveRequest(root, '/site/')).toBe(join(root, 'site/index.html'));
    expect(resolveRequest(root, '/mock%20up.mockup.html')).toBe(join(root, 'mock up.mockup.html'));
    expect(resolveRequest(root, '/../secret-preview.txt')).toBeNull();
    expect(resolveRequest(root, '/%2e%2e/secret-preview.txt')).toBeNull();
    expect(resolveRequest(root, '/site/%00.html')).toBeNull();
    expect(resolveRequest(root, '/%E0%A4%A')).toBeNull();
    expect(resolveRequest(root, '/missing.html')).toBeNull();
    expect(resolveRequest(root, '/')).toBeNull();
    expect(resolveRequest(root, '/site/leak.html')).toBeNull();
    expect(resolveRequest(root, '/up/secret-preview.txt')).toBeNull();
    expect(resolveRequest(root, '/site/inside.css')).toBe(join(root, 'site/assets/app.css'));
  });

  it('labels content and blocks the network', () => {
    expect(contentType('a/b/Page.HTML')).toBe('text/html; charset=utf-8');
    expect(contentType('x.svg')).toBe('image/svg+xml');
    expect(contentType('x.unknown')).toBe('application/octet-stream');
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
    expect(PREVIEW_CSP).toContain("default-src 'self' data: blob:");
    expect(PREVIEW_CSP).not.toMatch(/https?:|\*/);
  });
});
