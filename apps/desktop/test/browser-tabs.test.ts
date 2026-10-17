import { describe, expect, it } from 'vitest';
import { activeAfterClose, partitionFor, SHARED_PARTITION, tabAt, tabsText } from '../src/main/browser-tabs';

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
