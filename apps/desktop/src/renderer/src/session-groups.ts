import { fold } from './fold';

export type SessionGroup = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'older';

const DAY = 86_400_000;

/**
 * Conversations under "Pinned", "Today", "Yesterday", "Previous 7 days", "Previous 30 days" and
 * "Older" by last activity, newest first in each; empty groups are left out.
 */
export function groupSessions<T extends { favorite: boolean; lastTs: number | null }>(list: T[], now = Date.now()): Array<{ group: SessionGroup; items: T[] }> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const groupOf = (s: T): SessionGroup => {
    if (s.favorite) return 'pinned';
    const ts = s.lastTs ?? 0;
    if (ts >= today) return 'today';
    if (ts >= today - DAY) return 'yesterday';
    if (ts >= today - 7 * DAY) return 'week';
    if (ts >= today - 30 * DAY) return 'month';
    return 'older';
  };
  const order: SessionGroup[] = ['pinned', 'today', 'yesterday', 'week', 'month', 'older'];
  const groups = new Map<SessionGroup, T[]>(order.map((g) => [g, []]));
  for (const s of [...list].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))) groups.get(groupOf(s))!.push(s);
  return order.filter((g) => groups.get(g)!.length).map((group) => ({ group, items: groups.get(group)! }));
}


/** Title (or id) contains every word of the query, in any order, ignoring accents. */
export function matchesQuery(s: { title: string; id: string }, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hay = fold(`${s.title} ${s.id}`);
  return words.every((w) => hay.includes(w));
}

export type Collapsed<T> = { kind: 'one'; item: T } | { kind: 'many'; title: string; items: T[] };

/** At least this many conversations with the same title fold into one row. */
export const REPEAT_MIN = 3;

/**
 * Runs of the same title (scheduled jobs, the same prompt over and over) fold into one row that
 * opens; the row sits where the newest of them would. Pinned ones never fold.
 */
export function collapseRepeats<T extends { title: string; favorite: boolean }>(items: T[]): Array<Collapsed<T>> {
  const key = (t: T) => fold(t.title).replace(/\s+/g, ' ').trim().slice(0, 80);
  const counts = new Map<string, number>();
  for (const t of items) if (!t.favorite) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
  const out: Array<Collapsed<T>> = [];
  const groups = new Map<string, Extract<Collapsed<T>, { kind: 'many' }>>();
  for (const t of items) {
    const k = key(t);
    if (t.favorite || (counts.get(k) ?? 0) < REPEAT_MIN) {
      out.push({ kind: 'one', item: t });
      continue;
    }
    const g = groups.get(k);
    if (g) g.items.push(t);
    else {
      const created = { kind: 'many' as const, title: t.title, items: [t] };
      groups.set(k, created);
      out.push(created);
    }
  }
  return out;
}
