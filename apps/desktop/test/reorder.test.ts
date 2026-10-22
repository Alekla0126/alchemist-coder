import { describe, expect, it } from 'vitest';
import { arrangePinned, dropOn, dropsAfter, mergeOrder, moveTo, nudge, readOrder } from '../src/renderer/src/reorder';
import { groupSessions } from '../src/renderer/src/session-groups';

describe('moving projects on the rail', () => {
  const rail = [1, 2, 3, 4];

  it('drops a project before or after another one', () => {
    expect(dropOn(rail, 4, 1, false)).toEqual([4, 1, 2, 3]);
    expect(dropOn(rail, 1, 4, true)).toEqual([2, 3, 4, 1]);
    expect(dropOn(rail, 1, 3, false)).toEqual([2, 1, 3, 4]);
    expect(dropOn(rail, 3, 1, true)).toEqual([1, 3, 2, 4]);
  });

  it('leaves the rail as it was when dropped on itself or somewhere unknown', () => {
    expect(dropOn(rail, 2, 2, true)).toEqual(rail);
    expect(dropOn(rail, 2, 9, false)).toEqual(rail);
  });

  it('moves one step with «Move up» and «Move down», and the ends stay put', () => {
    expect(nudge(rail, 3, -1)).toEqual([1, 3, 2, 4]);
    expect(nudge(rail, 3, 1)).toEqual([1, 2, 4, 3]);
    expect(nudge(rail, 1, -1)).toEqual(rail);
    expect(nudge(rail, 4, 1)).toEqual(rail);
  });

  it('puts an item at any position, clamped', () => {
    expect(moveTo(rail, 4, 0)).toEqual([4, 1, 2, 3]);
    expect(moveTo(rail, 1, 99)).toEqual([2, 3, 4, 1]);
    expect(moveTo(rail, 7, 0)).toEqual(rail);
  });

  it('a drop lands after an element once the pointer is past its middle', () => {
    expect(dropsAfter(10, { top: 0, height: 40 })).toBe(false);
    expect(dropsAfter(30, { top: 0, height: 40 })).toBe(true);
  });
});

describe('arranging pinned conversations', () => {
  const s = (id: string, lastTs: number) => ({ id, lastTs, favorite: true, title: id });

  it('keeps the order you gave them; ones pinned since go on top, newest first', () => {
    const items = [s('a', 10), s('b', 30), s('c', 20), s('d', 40)];
    expect(arrangePinned(items, ['c', 'a', 'b']).map((x) => x.id)).toEqual(['d', 'c', 'a', 'b']);
    expect(arrangePinned(items, []).map((x) => x.id)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('saves one project’s order without touching the others’', () => {
    expect(mergeOrder(['x', 'a', 'y', 'b'], ['b', 'a'])).toEqual(['b', 'a', 'x', 'y']);
    expect(mergeOrder(['a', 'b', 'c'], ['c'], 2)).toEqual(['c', 'a']);
  });

  it('reads the saved order, and nothing from a missing or broken value', () => {
    expect(readOrder('["a","b",3]')).toEqual(['a', 'b']);
    expect(readOrder(null)).toEqual([]);
    expect(readOrder('{nope')).toEqual([]);
    expect(readOrder('{"a":1}')).toEqual([]);
  });

  it('the Pinned group follows your order; the date groups stay by date', () => {
    const now = new Date('2026-10-22T12:00:00').getTime();
    const list = [
      { id: 'p1', favorite: true, lastTs: now - 1000 },
      { id: 'p2', favorite: true, lastTs: now - 5000 },
      { id: 't1', favorite: false, lastTs: now - 2000 },
      { id: 't2', favorite: false, lastTs: now - 100 },
    ];
    const groups = groupSessions(list, now, { pinOrder: ['p2', 'p1'] });
    expect(groups.map((g) => [g.group, g.items.map((x) => x.id)])).toEqual([
      ['pinned', ['p2', 'p1']],
      ['today', ['t2', 't1']],
    ]);
    // Without an order, pinned ones go by date like before.
    expect(groupSessions(list, now)[0]!.items.map((x) => x.id)).toEqual(['p1', 'p2']);
  });
});
