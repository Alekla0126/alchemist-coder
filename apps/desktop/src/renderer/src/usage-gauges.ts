import type { CliVersion, KimiWindow, LimitWindow, PlanUsage } from '@shared/api';
import { sourceOf } from './sources';

/** One plan as the rail shows it: the outer ring is the 5-hour session, the inner one the week. */
export type GaugeId = 'claude' | 'codex' | 'kimi';

export interface Gauge {
  id: GaugeId;
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
  /** Its CLI as installed (version, newest out, how to update). */
  cli: CliVersion | null;
  /** Kimi: its numbers come the next time its CLI runs. */
  waiting: boolean;
}

/** 0 once a window's reset time has passed (a window without one keeps its number). */
export const livePercent = (w: LimitWindow | null | undefined, now: number): number => (!w ? 0 : w.resetsAt == null || w.resetsAt > now ? w.percent : 0);

/** Kimi's windows as the rail's two rings: the shortest timed one (5 hours) and the weekly one. */
export function kimiRings(windows: KimiWindow[]): { session: KimiWindow | null; week: KimiWindow | null } {
  const timed = windows.filter((w) => w.minutes != null && w.minutes <= 24 * 60).sort((a, b) => a.minutes! - b.minutes!);
  const week = windows.find((w) => w.minutes == null) ?? windows.filter((w) => (w.minutes ?? 0) > 24 * 60).sort((a, b) => b.minutes! - a.minutes!)[0] ?? null;
  return { session: timed[0] ?? null, week };
}

export const level = (pct: number) => (pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low');

const capitalized = (s: string | null) => (s ? s[0]!.toUpperCase() + s.slice(1) : null);

export function gauges(usage: PlanUsage | null, now = Date.now()): Gauge[] {
  const out: Gauge[] = [];
  const cli = (id: CliVersion['id']) => usage?.versions?.find((v) => v.id === id) ?? null;
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
      cli: cli('claude'),
      waiting: false,
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
    const percent = Math.max(livePercent(session, now), livePercent(week, now));
    // The limit Codex said it reached, until that window resets.
    const full = [session, week].filter((w) => w && livePercent(w, now) >= 99);
    out.push({
      id: 'codex',
      glyph: sourceOf('codex').glyph,
      // Codex runs on the ChatGPT plan: its limits are the plan's.
      name: 'ChatGPT',
      plan: capitalized(x.plan),
      session,
      week,
      percent,
      hit: x.reached && full[0]?.resetsAt ? { resetsAt: full[0].resetsAt } : null,
      stale: false,
      asOf: x.asOf,
      recent: null,
      cli: cli('codex'),
      waiting: false,
    });
  }
  const k = usage?.kimi;
  if (k) {
    const { session, week } = kimiRings(k.windows);
    const known = k.windows.length > 0;
    const full = k.windows.filter((w) => livePercent(w, now) >= 100 && w.resetsAt);
    out.push({
      id: 'kimi',
      glyph: 'K',
      name: 'Kimi',
      plan: 'Kimi Code',
      session,
      week,
      percent: known ? Math.max(livePercent(session, now), livePercent(week, now)) : null,
      hit: full.length ? { resetsAt: Math.max(...full.map((w) => w.resetsAt!)) } : null,
      stale: false,
      asOf: k.asOf,
      recent: null,
      cli: cli('kimi'),
      waiting: k.waiting && !known,
    });
  }
  return out;
}

/** The next time a window resets (the rail redraws then), or null. */
export function nextReset(list: Gauge[], now = Date.now()): number | null {
  const times = list.flatMap((g) => [g.session?.resetsAt, g.week?.resetsAt, g.hit?.resetsAt]).filter((t): t is number => !!t && t > now);
  return times.length ? Math.min(...times) : null;
}
