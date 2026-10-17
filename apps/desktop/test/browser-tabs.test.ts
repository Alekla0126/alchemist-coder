import { describe, expect, it } from 'vitest';
import { acceptLanguages, activeAfterClose, browserUserAgent, keepsAsPopup, partitionFor, SHARED_PARTITION, tabAt, tabsText } from '../src/main/browser-tabs';

describe('a browser per project', () => {
  it('keeps each project’s cookies apart, and the same project’s across launches', () => {
    const a = partitionFor('/Users/me/Komodo');
    const b = partitionFor('/Users/me/App Factory');
    expect(a).toMatch(/^persist:alchemist-browser-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(partitionFor('/Users/me/Komodo')).toBe(a);
  });

  it('outside any project, the browser the app always had', () => {
    expect(partitionFor('')).toBe(SHARED_PARTITION);
  });
});

describe('tabs', () => {
  const tabs = [
    { id: 't1', title: 'Docs', url: 'https://example.com/docs' },
    { id: 't2', title: '', url: 'https://example.com/' },
  ];

  it('reads them numbered from 1, the one in front marked', () => {
    expect(tabsText(tabs, 't2')).toBe('[1] Docs — https://example.com/docs\n[2] (in front) Untitled — https://example.com/');
    expect(tabsText([], null)).toMatch(/No tabs open/);
  });

  it('finds a tab by its number, and says which numbers exist when it isn’t one', () => {
    expect(tabAt(tabs, 2)).toBe(tabs[1]);
    expect(() => tabAt(tabs, 3)).toThrow(/1 to 2/);
    expect(() => tabAt(tabs, 'x')).toThrow(/no tab x/);
  });

  it('brings the right neighbour to the front when the front tab closes', () => {
    expect(activeAfterClose(['a', 'b', 'c'], 'b', 'b')).toBe('c');
    expect(activeAfterClose(['a', 'b', 'c'], 'c', 'c')).toBe('b');
    expect(activeAfterClose(['a', 'b', 'c'], 'a', 'c')).toBe('a');
    expect(activeAfterClose(['a'], 'a', 'a')).toBeNull();
  });
});

describe('signing in with Google', () => {
  it('sends Chrome’s user agent without the tokens Google reads as an embedded browser', () => {
    const electron =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AlchemistCoder/1.3.0 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36';
    expect(browserUserAgent(electron)).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36');
    expect(browserUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Alchemist Coder/1.3.1 Chrome/152.0.0.0 Electron/44.4.5 Safari/537.36')).not.toMatch(/Electron|Alchemist/);
  });

  it('keeps a page’s own Chrome user agent as it is', () => {
    const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
    expect(browserUserAgent(chrome)).toBe(chrome);
  });

  it('asks pages for the system’s languages, most preferred first', () => {
    expect(acceptLanguages(['es-MX', 'en-US'])).toBe('es-MX,es,en-US,en');
    expect(acceptLanguages(['es', 'es-419'])).toBe('es,es-419');
    expect(acceptLanguages([])).toBe('en-US,en');
  });

  it('keeps sign-in popups as windows, so they can hand the sign-in back; links still open tabs', () => {
    expect(keepsAsPopup('new-window', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x')).toBe(true);
    expect(keepsAsPopup('new-window', 'about:blank')).toBe(true);
    expect(keepsAsPopup('new-window', '')).toBe(true);
    expect(keepsAsPopup('foreground-tab', 'https://example.com/')).toBe(false);
    expect(keepsAsPopup('background-tab', 'https://example.com/')).toBe(false);
    expect(keepsAsPopup('new-window', 'file:///etc/passwd')).toBe(false);
    expect(keepsAsPopup('new-window', 'javascript:alert(1)')).toBe(false);
  });
});
