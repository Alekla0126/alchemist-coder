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

  it('names Codex’s gauge after the ChatGPT plan, and shows when its limit was reached', () => {
    const base = usage().codex!;
    const [, chatgpt] = gauges(usage({ codex: { ...base, reached: true, windows: [{ label: 'weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: now + 5 * H }] } }), now);
    expect(chatgpt).toMatchObject({ name: 'ChatGPT', percent: 100, hit: { resetsAt: now + 5 * H } });
  });

  it('adds Kimi: its 5-hour limit outside, its week inside, or waiting for its CLI', () => {
    const kimi = (over: Partial<NonNullable<PlanUsage['kimi']>>) => gauges(usage({ claude: null, codex: null, kimi: { windows: [], asOf: null, waiting: true, ...over } }), now)[0]!;
    expect(kimi({})).toMatchObject({ id: 'kimi', name: 'Kimi', percent: null, waiting: true });
    const g = kimi({
      waiting: false,
      asOf: now,
      windows: [
        { label: 'Weekly limit', minutes: null, used: 300, limit: 1000, percent: 30, resetsAt: now + 50 * H },
        { label: '5h limit', minutes: 300, used: 60, limit: 100, percent: 60, resetsAt: now + H },
      ],
    });
    expect(g.session?.percent).toBe(60);
    expect(g.week?.percent).toBe(30);
    expect(g.percent).toBe(60);
  });

  it('gives each gauge its CLI’s version', () => {
    const versions = [{ id: 'kimi' as const, label: 'Kimi CLI', version: '1.33.0', latest: '1.35.0', outdated: true, update: 'uv tool upgrade kimi-cli' }];
    const g = gauges(usage({ claude: null, codex: null, kimi: { windows: [], asOf: null, waiting: true }, versions }), now)[0]!;
    expect(g.cli).toEqual(versions[0]);
  });
});
