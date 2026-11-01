import { execFile } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { StoredCookie } from './browser-tabs';

/**
 * The sign-ins of a browser you already use (Chrome, Brave, Edge, Arc, Vivaldi), brought into a project's
 * built-in browser so its agents don't make you sign in again. Only on macOS, and only when you ask from the
 * pane: macOS asks you to let the app read that browser's data, and the keychain asks for its "Safe Storage"
 * key. The cookies are read once, offered site by site, and never kept by the app beyond your answer.
 */

const run = promisify(execFile);

export interface ChromiumBrowser {
  id: string;
  name: string;
  /** Its folder under ~/Library/Application Support. */
  dir: string;
  /** The keychain item that holds the key its cookies are encrypted with. */
  keychain: string;
  /** Its app bundle, to know it's installed without reading its data (macOS guards that). */
  app: string;
}

export const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  { id: 'chrome', name: 'Chrome', dir: 'Google/Chrome', keychain: 'Chrome Safe Storage', app: 'Google Chrome.app' },
  { id: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser', keychain: 'Brave Safe Storage', app: 'Brave Browser.app' },
  { id: 'edge', name: 'Edge', dir: 'Microsoft Edge', keychain: 'Microsoft Edge Safe Storage', app: 'Microsoft Edge.app' },
  { id: 'arc', name: 'Arc', dir: 'Arc/User Data', keychain: 'Arc Safe Storage', app: 'Arc.app' },
  { id: 'vivaldi', name: 'Vivaldi', dir: 'Vivaldi', keychain: 'Vivaldi Safe Storage', app: 'Vivaldi.app' },
];

/** Seconds between 1601-01-01 (Chromium's epoch) and 1970-01-01. */
const EPOCH_GAP_S = 11_644_473_600;

/** Chromium's macOS cookie key: PBKDF2-SHA1 of the keychain password, salt "saltysalt", 1003 rounds, 16 bytes. */
export function chromiumKey(password: string): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

/**
 * A cookie's value from its encrypted_value: "v10" + AES-128-CBC (IV of 16 spaces). Since the cookie
 * database's version 24, the plain text starts with the SHA-256 of the cookie's host, which is checked
 * and removed. Null when it isn't a value this key opens.
 */
export function decryptChromiumValue(encrypted: Buffer, key: Buffer, hostKey: string, dbVersion: number): string | null {
  if (encrypted.length < 3 + 16 || encrypted.subarray(0, 3).toString('latin1') !== 'v10') return null;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    if (dbVersion >= 24) {
      if (plain.length < 32 || !plain.subarray(0, 32).equals(createHash('sha256').update(hostKey).digest())) return null;
      plain = plain.subarray(32);
    }
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

/** A row of Chromium's `cookies` table (the columns this file reads). */
export interface ChromiumRow {
  host_key: string;
  name: string;
  path: string;
  value: string;
  encrypted_value: string; // hex
  expires_utc: number | string;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  has_expires: number;
}

const SAME_SITE: Record<number, StoredCookie['sameSite']> = { [-1]: 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };

/** A row as Electron reads a cookie: host-only when its host has no leading dot, session when it doesn't expire. */
export function rowToCookie(row: ChromiumRow, value: string): StoredCookie {
  const expires = Number(row.expires_utc);
  const session = !row.has_expires || !expires;
  return {
    name: row.name,
    value,
    domain: row.host_key,
    hostOnly: !row.host_key.startsWith('.'),
    path: row.path || '/',
    secure: !!row.is_secure,
    httpOnly: !!row.is_httponly,
    session,
    ...(session ? {} : { expirationDate: Math.floor(expires / 1e6 - EPOCH_GAP_S) }),
    sameSite: SAME_SITE[row.samesite] ?? 'unspecified',
  };
}

/** The rows as cookies: plain values as they are, encrypted ones opened with the key; any that don't open stay behind. */
export function rowsToCookies(rows: ChromiumRow[], key: Buffer, dbVersion: number): StoredCookie[] {
  const out: StoredCookie[] = [];
  for (const row of rows) {
    const value = row.value || (row.encrypted_value ? decryptChromiumValue(Buffer.from(row.encrypted_value, 'hex'), key, row.host_key, dbVersion) : '');
    if (value != null) out.push(rowToCookie(row, value));
  }
  return out;
}

const support = () => join(homedir(), 'Library', 'Application Support');

/** A browser's profiles that have cookies (Default first): where each one's cookie database is. */
export function profilesOf(browser: ChromiumBrowser, root = support()): Array<{ profile: string; db: string }> {
  const base = join(root, browser.dir);
  let dirs: string[] = [];
  try {
    dirs = readdirSync(base);
  } catch {
    return [];
  }
  return dirs
    .filter((d) => d === 'Default' || /^Profile \d+$/.test(d))
    .sort((a, b) => (a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, undefined, { numeric: true })))
    .flatMap((profile) => {
      const db = [join(base, profile, 'Cookies'), join(base, profile, 'Network', 'Cookies')].find((p) => existsSync(p));
      return db ? [{ profile, db }] : [];
    });
}

/**
 * The browsers installed on this Mac, by their app bundle: their data folders can't be listed until you
 * allow it (macOS asks when you bring sign-ins), so the bundle is how the pane knows what to offer.
 */
export function installedBrowsers(appDirs = ['/Applications', join(homedir(), 'Applications')]): ChromiumBrowser[] {
  if (process.platform !== 'darwin') return [];
  return CHROMIUM_BROWSERS.filter((b) => appDirs.some((d) => existsSync(join(d, b.app))));
}

/**
 * Every cookie of one profile of a Chromium browser. The database is copied first (the browser keeps it
 * open), read with the system's sqlite3, and the copy deleted. Asking the keychain shows macOS's prompt.
 */
export async function readChromiumCookies(browser: ChromiumBrowser, profile = 'Default'): Promise<StoredCookie[]> {
  if (process.platform !== 'darwin') throw new Error('Bringing sign-ins from another browser works on macOS only.');
  const found = profilesOf(browser).find((p) => p.profile === profile);
  if (!found) throw new Error(`${browser.name} has no profile "${profile}" with cookies, or macOS didn't let the app read it.`);
  const tmp = mkdtempSync(join(tmpdir(), 'ac-cookies-'));
  try {
    const copy = join(tmp, 'Cookies');
    copyFileSync(found.db, copy);
    for (const side of ['-wal', '-shm']) if (existsSync(found.db + side)) copyFileSync(found.db + side, copy + side);
    const sql = async (q: string) => {
      const { stdout } = await run('/usr/bin/sqlite3', ['-json', copy, q], { maxBuffer: 256 * 1024 * 1024 });
      return (stdout.trim() ? JSON.parse(stdout) : []) as Array<Record<string, unknown>>;
    };
    const version = Number((await sql("SELECT value FROM meta WHERE key = 'version'"))[0]?.value ?? 0);
    const rows = (await sql(
      'SELECT host_key, name, path, value, hex(encrypted_value) AS encrypted_value, expires_utc, is_secure, is_httponly, samesite, has_expires FROM cookies',
    )) as unknown as ChromiumRow[];
    const { stdout: password } = await run('/usr/bin/security', ['find-generic-password', '-w', '-s', browser.keychain]);
    return rowsToCookies(rows, chromiumKey(password.trim()), version);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
