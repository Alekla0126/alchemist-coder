import { create } from 'zustand';

const KEY = 'alchemist.lastViewed';
const SINCE_KEY = 'alchemist.viewedSince';

interface Viewed {
  /** When you last looked at each conversation. */
  at: Record<string, number>;
  /** Conversations older than this count as seen (the feature's first launch): no wall of dots. */
  since: number;
}

function load(): Viewed {
  try {
    const at = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
    let since = Number(localStorage.getItem(SINCE_KEY));
    if (!since) {
      since = Date.now();
      localStorage.setItem(SINCE_KEY, String(since));
    }
    return { at, since };
  } catch {
    return { at: {}, since: Date.now() };
  }
}

export const useViewed = create<Viewed>(load);

export function markViewed(sessionId: string, now = Date.now()) {
  const at = { ...useViewed.getState().at, [sessionId]: now };
  // Only the most recent 1000 are kept.
  const trimmed = Object.fromEntries(Object.entries(at).sort((a, b) => b[1] - a[1]).slice(0, 1000));
  useViewed.setState({ at: trimmed });
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // no storage (tests)
  }
}

/** Something happened in the conversation since you last looked at it. */
export function isUnread(s: { id: string; lastTs: number | null }, viewed: Viewed): boolean {
  if (!s.lastTs) return false;
  return s.lastTs > (viewed.at[s.id] ?? viewed.since);
}
