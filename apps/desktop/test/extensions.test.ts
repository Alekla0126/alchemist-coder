import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkoutLink, loadProModule } from '../src/main/extensions';

const dir = mkdtempSync(join(tmpdir(), 'pro-module-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
/** A Pro module the way the official build ships one: resources/extensions/pro.cjs. */
const module = (body: string) => {
  const resources = mkdtempSync(join(dir, 'res-'));
  const ext = join(resources, 'extensions');
  mkdirSync(ext);
  writeFileSync(join(ext, 'pro.cjs'), `exports.extension = () => {}; exports.isPro = async () => false; ${body}`);
  return loadProModule(resources);
};

describe('the Pro module', () => {
  it('may offer activation and a payment link, or neither (an older module)', async () => {
    const older = module('');
    expect(older && typeof older.isPro).toBe('function');
    expect(older?.activate).toBeUndefined();
    expect(checkoutLink(older)).toBeNull();
    const current = module(`exports.activate = async (_h, code) => ({ ok: code === 'k' }); exports.checkoutUrl = () => 'https://buy.stripe.com/test_123';`);
    expect(await current?.activate?.({ userData: dir }, 'k')).toEqual({ ok: true });
    expect(checkoutLink(current)).toBe('https://buy.stripe.com/test_123');
  });

  it('opens only an https payment link, never anything else it says', () => {
    const link = (value: unknown) => checkoutLink({ checkoutUrl: () => value as string });
    expect(link('http://buy.stripe.com/test_123')).toBeNull();
    expect(link('javascript:alert(1)')).toBeNull();
    expect(link('file:///etc/passwd')).toBeNull();
    expect(link('https://user:pass@buy.stripe.com/x')).toBeNull();
    expect(link('not a url')).toBeNull();
    expect(link(42)).toBeNull();
    expect(link(`https://buy.stripe.com/${'x'.repeat(600)}`)).toBeNull();
    expect(checkoutLink({ checkoutUrl: () => { throw new Error('broken'); } })).toBeNull();
    expect(checkoutLink(null)).toBeNull();
  });
});
