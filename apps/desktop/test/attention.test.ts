import { describe, expect, it } from 'vitest';
import { isUnread } from '../src/renderer/src/attention';

describe('unread conversations', () => {
  it('is unread when something happened after you last looked, or after the feature started', () => {
    const viewed = { at: { a: 1000 }, since: 500 };
    expect(isUnread({ id: 'a', lastTs: 1500 }, viewed)).toBe(true);
    expect(isUnread({ id: 'a', lastTs: 900 }, viewed)).toBe(false);
    // Never opened: only news from after the first launch count.
    expect(isUnread({ id: 'b', lastTs: 400 }, viewed)).toBe(false);
    expect(isUnread({ id: 'b', lastTs: 600 }, viewed)).toBe(true);
    expect(isUnread({ id: 'c', lastTs: null }, viewed)).toBe(false);
  });
});
