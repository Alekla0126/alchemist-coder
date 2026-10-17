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
