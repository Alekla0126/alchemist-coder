import { describe, expect, it } from 'vitest';
import { groupSessions, matchesQuery } from '../src/renderer/src/session-groups';

const now = new Date(2026, 8, 28, 15, 0).getTime();
const at = (daysAgo: number, hour = 12) => new Date(2026, 8, 28 - daysAgo, hour).getTime();
const s = (id: string, lastTs: number | null, favorite = false) => ({ id, title: id, lastTs, favorite });

describe('sidebar groups', () => {
  it('puts pinned first, then by day, newest first, skipping empty groups', () => {
    const groups = groupSessions([s('old', at(90)), s('today-early', at(0, 1)), s('pin', at(40), true), s('yday', at(1)), s('week', at(5)), s('today', at(0, 14)), s('none', null)], now);
    expect(groups.map((g) => g.group)).toEqual(['pinned', 'today', 'yesterday', 'week', 'older']);
    expect(groups[1]!.items.map((x) => x.id)).toEqual(['today', 'today-early']);
    expect(groups.at(-1)!.items.map((x) => x.id)).toEqual(['old', 'none']);
  });

  it('matches every word of the filter in any order', () => {
    expect(matchesQuery({ title: 'Fix login bug', id: 'abc' }, 'bug login')).toBe(true);
    expect(matchesQuery({ title: 'Fix login bug', id: 'abc' }, 'logout')).toBe(false);
    expect(matchesQuery({ title: 'x', id: 'abc123' }, 'ABC')).toBe(true);
    expect(matchesQuery({ title: 'x', id: 'y' }, '  ')).toBe(true);
  });
});

describe('repeated titles', () => {
  it('folds three or more of the same title into one row where the newest was', async () => {
    const { collapseRepeats } = await import('../src/renderer/src/session-groups');
    const list = [s('Monitor nodos', 5), s('Other', 4), s('monitor  NODOS', 3), s('Monitor nodos', 2), s('Pinned', 1, true), s('Twice', 1), s('Twice', 0)];
    const out = collapseRepeats(list);
    expect(out.map((c) => (c.kind === 'one' ? c.item.id : `${c.title}×${c.items.length}`))).toEqual(['Monitor nodos×3', 'Other', 'Pinned', 'Twice', 'Twice']);
  });

  it('matches without accents', () => {
    expect(matchesQuery({ title: 'Búsqueda rápida', id: 'x' }, 'busqueda RAPIDA')).toBe(true);
  });
});
