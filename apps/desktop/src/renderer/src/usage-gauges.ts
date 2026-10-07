import type { LimitWindow, PlanUsage } from '@shared/api';
import { sourceOf } from './sources';

/** One plan as the rail shows it: the outer ring is the 5-hour session, the inner one the week. */
export interface Gauge {
  id: 'claude' | 'codex';
  glyph: string;
  name: string;
  plan: string | null;
  /** Each window as it stands now (a window past its reset time counts as 0); null when unknown. */
  session: LimitWindow | null;
  week: LimitWindow | null;
  /** What limits you first: the higher of the two; null when the plan's percentages aren't known. */
  percent: number | null;
  /** A usage limit is in effect (Claude Code ran into it). */
  hit: { resetsAt: number } | null;
  /** The last check failed: these are older numbers. */
  stale: boolean;
  /** When the numbers are from (Claude: the last check; Codex: its last turn). */
  asOf: number | null;
  /** Claude's replies in the last 5 hours on this computer (shown when its percentages aren't known). */
  recent: { messages: number } | null;
}

/** 0 once a window's reset time has passed. */
export const livePercent = (w: LimitWindow | null | undefined, now: number): number => (w && w.resetsAt && w.resetsAt > now ? w.percent : 0);

export const level = (pct: number) => (pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low');

const capitalized = (s: string | null) => (s ? s[0]!.toUpperCase() + s.slice(1) : null);

export function gauges(usage: PlanUsage | null, now = Date.now()): Gauge[] {
  const out: Gauge[] = [];
  const c = usage?.claude;
  if (c) {
    const limits = c.limits && !c.limits.error ? c.limits : null;
    out.push({
      id: 'claude',
      glyph: sourceOf('claude-code').glyph,
      name: 'Claude',
      plan: c.plan,
      session: limits?.fiveHour ?? null,
      week: limits?.sevenDay ?? null,
      percent: limits ? Math.max(livePercent(limits.fiveHour, now), livePercent(limits.sevenDay, now)) : null,
      hit: c.limit && c.limit.resetsAt > now ? { resetsAt: c.limit.resetsAt } : null,
      stale: !!limits?.stale,
      asOf: limits?.at ?? null,
      recent: c.windows.find((w) => w.hours === 5) ?? null,
    });
  }
  const x = usage?.codex;
  if (x) {
    const win = (label: 'five_hour' | 'weekly') => {
      const w = x.windows.find((w) => w.label === label);
      return w ? { percent: w.usedPercent, resetsAt: w.resetsAt } : null;
    };
    const session = win('five_hour');
    const week = win('weekly');
    out.push({
      id: 'codex',
      glyph: sourceOf('codex').glyph,
      name: 'Codex',
      plan: capitalized(x.plan),
      session,
      week,
      percent: Math.max(livePercent(session, now), livePercent(week, now)),
      hit: null,
      stale: false,
      asOf: x.asOf,
      recent: null,
    });
  }
  return out;
}

/** The next time a window resets (the rail redraws then), or null. */
export function nextReset(list: Gauge[], now = Date.now()): number | null {
  const times = list.flatMap((g) => [g.session?.resetsAt, g.week?.resetsAt, g.hit?.resetsAt]).filter((t): t is number => !!t && t > now);
  return times.length ? Math.min(...times) : null;
}
