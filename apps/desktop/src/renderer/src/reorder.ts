/**
 * Putting things where you want them: the projects on the rail and your pinned conversations keep
 * the order you give them, by dragging or with «Move up» / «Move down». Nothing here moves on its
 * own: only what you dragged changes place.
 */

/** The list with `item` taken out and put back so it ends up at `index` (clamped); unchanged if it isn't there. */
export function moveTo<T>(list: readonly T[], item: T, index: number): T[] {
  const from = list.indexOf(item);
  if (from < 0) return [...list];
  const rest = list.filter((_, i) => i !== from);
  const at = Math.max(0, Math.min(Math.round(index), rest.length));
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

/** The list after dropping `dragged` on `target`, just before it or just after it. */
export function dropOn<T>(list: readonly T[], dragged: T, target: T, after: boolean): T[] {
  if (dragged === target || !list.includes(target)) return [...list];
  const rest = list.filter((x) => x !== dragged);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), dragged, ...rest.slice(at)];
}

/** One step up (-1) or down (+1); the ends stay where they are. */
export function nudge<T>(list: readonly T[], item: T, step: -1 | 1): T[] {
  const from = list.indexOf(item);
  return from < 0 ? [...list] : moveTo(list, item, from + step);
}

/** Whether a drop on an element lands after it: the pointer is past its middle (vertical lists). */
export function dropsAfter(pointerY: number, rect: { top: number; height: number }): boolean {
  return pointerY > rect.top + rect.height / 2;
}

/**
 * Pinned conversations in the order you arranged them. Ones you pinned since (not in `order` yet) go
 * on top, newest activity first, so a conversation you just pinned shows up where you look.
 */
export function arrangePinned<T extends { id: string; lastTs: number | null }>(items: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const fresh = items.filter((s) => !rank.has(s.id)).sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  const placed = items.filter((s) => rank.has(s.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...fresh, ...placed];
}

/**
 * The saved order after you arranged one project's pinned conversations: those, in their new order,
 * then everything else as it was (other projects keep theirs). Bounded so it never grows forever.
 */
export function mergeOrder(saved: readonly string[], arranged: readonly string[], max = 500): string[] {
  const mine = new Set(arranged);
  return [...arranged, ...saved.filter((id) => !mine.has(id))].slice(0, max);
}

/** The saved order, from storage: only strings, at most `max` (anything else reads as no order yet). */
export function readOrder(raw: string | null, max = 500): string[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : [];
  } catch {
    return [];
  }
}
