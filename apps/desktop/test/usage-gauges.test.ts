import { describe, expect, it } from 'vitest';
import { gauges, nextReset } from '../src/renderer/src/usage-gauges';
import type { PlanUsage } from '../src/shared/api';

const now = Date.parse('2026-10-07T20:00:00Z');
const H = 3_600_000;
const usage = (over: Partial<PlanUsage> = {}): PlanUsage => ({
  claude: {
    plan: 'Max 20x',
    account: 'me@example.com',
    extraUsage: false,
    windows: [],
    limit: null,
    limits: { fiveHour: { percent: 24, resetsAt: now + 2 * H }, sevenDay: { percent: 71, resetsAt: now + 50 * H }, sevenDayOpus: null, models: [], at: now - 60_000, error: null },
  },
  codex: { plan: 'plus', windows: [{ label: 'five_hour', usedPercent: 40, windowMinutes: 300, resetsAt: now - 1000 }, { label: 'weekly', usedPercent: 12, windowMinutes: 10080, resetsAt: now + 24 * H }], asOf: now - H },
  at: now,
  ...over,
});

describe('the rail’s usage gauges', () => {
  it('shows what limits you first, and a window past its reset as empty', () => {
    const [claude, codex] = gauges(usage(), now);
    expect(claude).toMatchObject({ id: 'claude', glyph: '✳', plan: 'Max 20x', percent: 71, hit: null, stale: false });
    // Codex's 5-hour window already reset: only the week counts.
    expect(codex).toMatchObject({ id: 'codex', glyph: '◎', plan: 'Plus', percent: 12 });
    expect(nextReset(gauges(usage(), now), now)).toBe(now + 2 * H);
  });

  it('says when a limit is reached, when numbers are old, and when Claude’s percentages are unknown', () => {
    const base = usage().claude!;
    expect(gauges(usage({ claude: { ...base, limit: { type: 'five_hour', resetsAt: now + H } } }), now)[0]!.hit).toEqual({ resetsAt: now + H });
    expect(gauges(usage({ claude: { ...base, limits: { ...base.limits!, stale: 'offline' } } }), now)[0]!.stale).toBe(true);
    expect(gauges(usage({ claude: { ...base, limits: null } }), now)[0]!.percent).toBeNull();
    expect(gauges({ claude: null, codex: null, at: now }, now)).toEqual([]);
  });
});
