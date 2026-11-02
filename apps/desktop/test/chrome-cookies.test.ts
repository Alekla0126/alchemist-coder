import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signInPlan } from '../src/main/browser-tabs';
import { CHROMIUM_BROWSERS, chromiumKey, decryptChromiumValue, installedBrowsers, profilesOf, rowsToCookies, rowToCookie, type ChromiumRow } from '../src/main/chrome-cookies';

/** Encrypts a value the way Chromium does on macOS (database version 24 prefixes the host's SHA-256). */
function encrypt(value: string, password: string, host: string, dbVersion: number): Buffer {
  const cipher = createCipheriv('aes-128-cbc', chromiumKey(password), Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([dbVersion >= 24 ? createHash('sha256').update(host).digest() : Buffer.alloc(0), Buffer.from(value, 'utf8')]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

const row = (over: Partial<ChromiumRow> = {}): ChromiumRow => ({
  host_key: '.google.com',
  name: 'SID',
  path: '/',
  value: '',
  encrypted_value: '',
  // 2030-01-01 in Chromium's microseconds since 1601.
  expires_utc: (1893456000 + 11644473600) * 1e6,
  is_secure: 1,
  is_httponly: 1,
  samesite: 0,
  has_expires: 1,
  ...over,
});

describe('sign-ins from another browser', () => {
  it('opens values encrypted with the browser’s keychain key, before and after database version 24', () => {
    for (const version of [23, 24]) {
      const enc = encrypt('secret-ñ', 'peanuts', '.google.com', version);
      expect(decryptChromiumValue(enc, chromiumKey('peanuts'), '.google.com', version)).toBe('secret-ñ');
    }
  });

  it('refuses a value it can’t open: another key, another host, or no v10 prefix', () => {
    const enc = encrypt('secret', 'peanuts', '.google.com', 24);
    expect(decryptChromiumValue(enc, chromiumKey('other'), '.google.com', 24)).toBeNull();
    expect(decryptChromiumValue(enc, chromiumKey('peanuts'), '.evil.com', 24)).toBeNull();
    expect(decryptChromiumValue(Buffer.from('v11abcdefghijklmnopqrstuvwxyz'), chromiumKey('peanuts'), '.google.com', 24)).toBeNull();
  });

  it('reads a row as Electron reads a cookie: domain or host-only, expiry in seconds since 1970, SameSite', () => {
    expect(rowToCookie(row(), 'v')).toEqual({
      name: 'SID', value: 'v', domain: '.google.com', hostOnly: false, path: '/', secure: true, httpOnly: true, session: false, expirationDate: 1893456000, sameSite: 'no_restriction',
    });
    const hostOnly = rowToCookie(row({ host_key: 'accounts.google.com', has_expires: 0, expires_utc: 0, samesite: 1, is_httponly: 0 }), 'v');
    expect(hostOnly).toMatchObject({ domain: 'accounts.google.com', hostOnly: true, session: true, sameSite: 'lax', httpOnly: false });
    expect(hostOnly.expirationDate).toBeUndefined();
  });

  it('keeps plain and encrypted values and leaves out the ones that don’t open', () => {
    const key = chromiumKey('peanuts');
    const rows = [
      row({ name: 'plain', value: 'p' }),
      row({ name: 'enc', encrypted_value: encrypt('e', 'peanuts', '.google.com', 24).toString('hex') }),
      row({ name: 'broken', encrypted_value: encrypt('x', 'wrong', '.google.com', 24).toString('hex') }),
    ];
    expect(rowsToCookies(rows, key, 24).map((c) => [c.name, c.value])).toEqual([['plain', 'p'], ['enc', 'e']]);
  });

  it('offers them site by site, like another project’s sign-ins', () => {
    const cookies = rowsToCookies([row({ value: 'a' }), row({ host_key: '.tiktok.com', name: 'sessionid', value: 'b' }), row({ host_key: '.doubleclick.net', name: 'IDE', value: 'c' })], chromiumKey('x'), 24);
    const plan = signInPlan([{ partition: 'external:chrome', cookies }], [], 1_800_000_000);
    expect([...plan.keys()].sort()).toEqual(['google.com', 'tiktok.com']);
    expect(plan.get('tiktok.com')!.cookies[0]).toMatchObject({ url: 'https://tiktok.com/', name: 'sessionid', domain: '.tiktok.com' });
  });

  it('finds a browser’s profiles with cookies, Default first, in either place Chromium keeps them', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-chrome-'));
    const base = join(root, 'Google/Chrome');
    for (const [dir, file] of [['Profile 2', 'Cookies'], ['Default', 'Network/Cookies'], ['Profile 10', 'Cookies'], ['System Profile', 'Cookies']]) {
      mkdirSync(join(base, dir, 'Network'), { recursive: true });
      writeFileSync(join(base, dir, file), '');
    }
    mkdirSync(join(base, 'Profile 3'));
    expect(profilesOf(CHROMIUM_BROWSERS[0]!, root).map((p) => p.profile)).toEqual(['Default', 'Profile 2', 'Profile 10']);
    expect(profilesOf(CHROMIUM_BROWSERS[0]!, root)[0]!.db).toBe(join(base, 'Default/Network/Cookies'));
  });

  it('knows which browsers are installed by their app bundle, without reading their data', () => {
    const apps = mkdtempSync(join(tmpdir(), 'ac-apps-'));
    mkdirSync(join(apps, 'Google Chrome.app'));
    mkdirSync(join(apps, 'Arc.app'));
    const found = installedBrowsers([apps]).map((b) => b.id);
    expect(found).toEqual(process.platform === 'darwin' ? ['chrome', 'arc'] : []);
  });
});
