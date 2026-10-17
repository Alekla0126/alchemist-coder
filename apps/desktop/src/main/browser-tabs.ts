import { createHash } from 'node:crypto';

/**
 * The built-in browser's tabs and projects, without Electron: each project has a browser of its own
 * (its own cookies and sign-ins, its own tabs), and agents and the pane speak of tabs by position.
 */

/** The browser outside any project keeps the cookies the app had before there was one per project. */
export const SHARED_PARTITION = 'persist:alchemist-browser';

/** Where a project's browser keeps its cookies and sign-ins (persists across launches). */
export function partitionFor(project: string): string {
  return project ? `persist:alchemist-browser-${createHash('sha1').update(project).digest('hex').slice(0, 16)}` : SHARED_PARTITION;
}

/**
 * The user agent the built-in browser sends: Chromium's own, without the app's and Electron's tokens.
 * Google refuses "Sign in with Google" from what it takes for an embedded browser (disallowed_useragent),
 * and those two tokens are how it tells. Nothing else changes: it says the Chrome it really is.
 */
export function browserUserAgent(electronUserAgent: string): string {
  return electronUserAgent.replace(/\s(?:Electron|AlchemistCoder|Alchemist[ -]?Coder)\/\S+/gi, '').replace(/\s{2,}/g, ' ').trim();
}

/** The Accept-Language a page sees: the system's languages, most preferred first (Chrome's own format). */
export function acceptLanguages(preferred: string[]): string {
  const out: string[] = [];
  for (const tag of preferred) {
    for (const t of [tag, tag.split('-')[0]!]) if (t && !out.includes(t)) out.push(t);
  }
  return out.join(',') || 'en-US,en';
}

/**
 * Whether a page's window.open is a popup to keep as a real window. Sign-in popups ("Continue with
 * Google") open with window features (disposition 'new-window') and hand the result back to the page
 * that opened them through window.opener, which a tab doesn't keep. Links with target=_blank and
 * window.open without features still become tabs.
 */
export function keepsAsPopup(disposition: string, url: string): boolean {
  return disposition === 'new-window' && (url === '' || /^(https?:|about:blank)/i.test(url));
}

/** A cookie as Electron reads it (the fields this file needs). */
export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

/**
 * The sign-ins a project's browser brings from the browser the app had before there was one per
 * project (1.3.1): the cookies it doesn't have yet, as `cookies.set` wants them. A cookie the project
 * already has (same site, name and path) is kept, since it's newer. Expired cookies stay behind.
 */
export function cookiesToImport(from: StoredCookie[], existing: StoredCookie[], nowSeconds: number) {
  const key = (c: StoredCookie) => `${c.domain ?? ''}|${c.name}|${c.path ?? '/'}`;
  const have = new Set(existing.map(key));
  return from
    .filter((c) => c.domain && !have.has(key(c)) && (c.session || !c.expirationDate || c.expirationDate > nowSeconds))
    .map((c) => {
      const host = c.domain!.replace(/^\./, '');
      return {
        url: `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`,
        name: c.name,
        value: c.value,
        // A host-only cookie (and every __Host- one) is set without a domain, or it would widen to subdomains.
        ...(c.hostOnly || c.name.startsWith('__Host-') ? {} : { domain: c.domain }),
        path: c.path ?? '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(c.session || !c.expirationDate ? {} : { expirationDate: c.expirationDate }),
        sameSite: c.sameSite,
      };
    });
}

export interface TabSummary {
  id: string;
  title: string;
  url: string;
}

/** The tabs as an agent reads them: numbered from 1, the one in front marked. */
export function tabsText(tabs: TabSummary[], active: string | null): string {
  if (!tabs.length) return 'No tabs open: open a page with browser_open.';
  return tabs.map((t, i) => `[${i + 1}]${t.id === active ? ' (in front)' : ''} ${t.title || 'Untitled'} — ${t.url || 'about:blank'}`).join('\n');
}

/** The tab a number (1-based, from browser_tabs) names, or an error an agent can act on. */
export function tabAt<T>(tabs: T[], n: unknown): T {
  const i = Number(n);
  if (!Number.isInteger(i) || i < 1 || i > tabs.length) throw new Error(`There is no tab ${String(n)}: browser_tabs lists them (1 to ${tabs.length}).`);
  return tabs[i - 1]!;
}

/** Which tab comes to the front when one closes: the one that was in front, else its right neighbour, else its left. */
export function activeAfterClose(ids: string[], active: string | null, closed: string): string | null {
  if (active !== closed) return active;
  const i = ids.indexOf(closed);
  const rest = ids.filter((id) => id !== closed);
  return rest[Math.min(i, rest.length - 1)] ?? null;
}
