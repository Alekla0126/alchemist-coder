import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { claudeUsage, codexUsage, UsageService } from '../src/main/usage';
import type { ClaudeLimits, PlanUsage } from '../src/shared/api';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'usage-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const now = Date.parse('2026-09-27T20:00:00Z');
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const reply = (id: string, hoursAgo: number, output: number, model = 'claude-sonnet-4-6') => ({
  type: 'assistant',
  timestamp: iso(hoursAgo),
  requestId: `req-${id}`,
  message: { id, model, usage: { input_tokens: 1000, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

const homes = { claudeJson: join(root, '.claude.json'), claudeProjects: join(root, 'projects'), codexRoot: join(root, 'codex') };
writeFileSync(homes.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x', hasExtraUsageEnabled: true } }));
mkdirSync(join(homes.claudeProjects, '-work-app', 's1', 'subagents'), { recursive: true });
writeFileSync(
  join(homes.claudeProjects, '-work-app', 's1.jsonl'),
  jsonl([
    reply('m1', 1, 500),
    reply('m1', 1, 500), // the same reply split over two lines: counted once
    reply('m2', 30, 2000),
    reply('m3', 24 * 10, 9999), // older than a week
    { type: 'assistant', timestamp: iso(2), quotaLimits: { rateLimitType: 'five_hour', resetsAt: (now + 3_600_000) / 1000 }, error: 'rate_limit' },
  ]),
);
writeFileSync(join(homes.claudeProjects, '-work-app', 's1', 'subagents', 'agent-a.jsonl'), jsonl([reply('m4', 3, 100)]));
const day = join(homes.codexRoot, 'sessions', '2026', '09', '27');
mkdirSync(day, { recursive: true });
writeFileSync(
  join(day, 'rollout-2026-09-27T10-00-00-x.jsonl'),
  jsonl([
    { timestamp: iso(5), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: (now - 1000) / 1000 }, secondary: { used_percent: 1, window_minutes: 10080, resets_at: (now + 86_400_000) / 1000 }, plan_type: 'plus' } } },
    { timestamp: iso(1), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: (now + 3_600_000) / 1000 }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: (now + 86_400_000) / 1000 }, plan_type: 'plus' } } },
  ]),
);

describe('plan usage', () => {
  it('reads the Claude plan and sums the last 5 hours and 7 days from transcripts', async () => {
    const u = await claudeUsage(homes, now);
    expect(u).toMatchObject({ plan: 'Max 20x', account: 'me@example.com', extraUsage: true, limit: { type: 'five_hour', resetsAt: now + 3_600_000 } });
    const [five, week] = u!.windows;
    expect(five).toMatchObject({ hours: 5, messages: 2, outputTokens: 600 });
    expect(week).toMatchObject({ hours: 168, messages: 3, outputTokens: 2600 });
    expect(week!.costUsd).toBeGreaterThan(five!.costUsd);
  });

  it('only reads what was appended since the last time, waiting for half-written lines', async () => {
    const tallies = new Map();
    const file = join(homes.claudeProjects, '-work-app', 's2.jsonl');
    writeFileSync(file, jsonl([reply('n1', 1, 10)]) + JSON.stringify(reply('n2', 1, 20)).slice(0, 40));
    const first = await claudeUsage(homes, now, tallies);
    expect(first!.windows[0]!.messages).toBe(3);
    // The rest of the line arrives, plus a new one.
    appendFileSync(file, JSON.stringify(reply('n2', 1, 20)).slice(40) + '\n' + jsonl([reply('n3', 1, 30)]));
    const second = await claudeUsage(homes, now, tallies);
    expect(second!.windows[0]!.messages).toBe(5);
    expect(second!.windows[0]!.outputTokens).toBe(first!.windows[0]!.outputTokens + 50);
    rmSync(file);
  });

  it('reads the Codex plan and both windows from the newest session', async () => {
    const u = await codexUsage(homes, now);
    expect(u).toEqual({
      plan: 'plus',
      windows: [
        { label: 'five_hour', usedPercent: 42, windowMinutes: 300, resetsAt: now + 3_600_000 },
        { label: 'weekly', usedPercent: 12, windowMinutes: 10080, resetsAt: now + 86_400_000 },
      ],
      asOf: now - 3_600_000,
    });
    // After the reset time passes, the window shows as reset.
    expect((await codexUsage(homes, now + 2 * 3_600_000))!.windows[0]!.usedPercent).toBe(0);
  });

  it('returns nothing for CLIs that were never used', async () => {
    const empty = { claudeJson: join(root, 'none.json'), claudeProjects: join(root, 'none'), codexRoot: join(root, 'none') };
    expect(await claudeUsage(empty, now)).toBeNull();
    expect(await codexUsage(empty, now)).toBeNull();
  });
});

describe('Claude limits cache', () => {
  const ok = (pct: number): ClaudeLimits => ({ fiveHour: { percent: pct, resetsAt: Date.now() + 3_600_000 }, sevenDay: null, sevenDayOpus: null, models: [], at: Date.now(), error: null });
  const failed = (error: string): ClaudeLimits => ({ fiveHour: null, sevenDay: null, sevenDayOpus: null, models: [], at: Date.now(), error });
  const none = { claudeJson: '/nonexistent/a.json', claudeProjects: '/nonexistent/p', codexRoot: '/nonexistent/c' };

  it('keeps the last good numbers when a check fails, across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'limits-'));
    const file = join(dir, 'claude-usage.json');
    const answers = [ok(40), failed('rate-limited')];
    let calls = 0;
    const fetchLimits = async () => answers[Math.min(calls++, answers.length - 1)]!;
    // claudeUsage() is null with no account and no transcripts: read the cache through limits directly.
    const svc = new UsageService(none, fetchLimits, file) as unknown as { limitsFor(mode: string): Promise<ClaudeLimits | null> };
    expect((await svc.limitsFor('idle'))?.fiveHour?.percent).toBe(40);
    const stale = await svc.limitsFor('force');
    expect(stale?.fiveHour?.percent).toBe(40);
    expect(stale?.stale).toBe('rate-limited');
    // A rate limit is waited out even when refreshing by hand.
    await svc.limitsFor('force');
    expect(calls).toBe(2);

    const restarted = new UsageService(none, async () => failed('offline'), file) as unknown as { limitsFor(mode: string): Promise<ClaudeLimits | null> };
    const after = await restarted.limitsFor('idle');
    expect(after?.fiveHour?.percent).toBe(40);
    expect(after?.stale).toBe('offline');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('usage pushed as it changes', () => {
  const ok = (pct: number): ClaudeLimits => ({ fiveHour: { percent: pct, resetsAt: Date.now() + 3_600_000 }, sevenDay: null, sevenDayOpus: null, models: [], at: Date.now(), error: null });
  const rateLimits = (pct: number) => ({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: (Date.now() + 3_600_000) / 1000 }, plan_type: 'plus' } } });
  const MIN = 60_000;
  afterEach(() => vi.useRealTimers());

  it('pushes Codex’s new numbers when its session file grows, without asking anyone, and only when they change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now });
    const codexRoot = mkdtempSync(join(tmpdir(), 'codex-'));
    const dir = join(codexRoot, 'sessions', '2026', '09', '27');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-2026-09-27T10-00-00-y.jsonl');
    writeFileSync(file, jsonl([rateLimits(42)]));
    let calls = 0;
    const svc = new UsageService({ claudeJson: '/nonexistent/a.json', claudeProjects: '/nonexistent/p', codexRoot }, async () => (calls++, ok(10)));
    const pushes: PlanUsage[] = [];
    svc.subscribe((u) => pushes.push(u));
    await svc.get();
    expect(pushes.at(-1)!.codex!.windows[0]!.usedPercent).toBe(42);
    appendFileSync(file, jsonl([rateLimits(55)]));
    svc.touch('codex');
    await vi.advanceTimersByTimeAsync(2500);
    expect(pushes.at(-1)!.codex!.windows[0]!.usedPercent).toBe(55);
    // Nothing new: nothing pushed.
    const count = pushes.length;
    svc.touch('codex');
    await vi.advanceTimersByTimeAsync(2500);
    expect(pushes.length).toBe(count);
    expect(calls).toBe(1); // only the first look
    svc.dispose();
    rmSync(codexRoot, { recursive: true, force: true });
  });

  it('asks for Claude’s percentages while it works at most every 5 minutes, once more after it stops, and rarely otherwise', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now });
    let calls = 0;
    let onScreen = true;
    const none = { claudeJson: '/nonexistent/a.json', claudeProjects: '/nonexistent/p', codexRoot: '/nonexistent/c' };
    const svc = new UsageService(none, async () => (calls++, ok(10 + calls)), undefined, () => onScreen);
    svc.subscribe(() => {});
    await svc.get();
    expect(calls).toBe(1);
    // Claude Code writes for a while: no new check before 5 minutes.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(MIN);
      svc.touch('claude-code');
      await vi.advanceTimersByTimeAsync(2500);
    }
    expect(calls).toBe(1);
    // It stops: one more check when it's due, so the meter ends on the final numbers.
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(calls).toBe(2);
    // Idle and off screen: no checks at all.
    onScreen = false;
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(calls).toBe(2);
    // Back on screen: every 30 minutes (Claude may be used elsewhere).
    onScreen = true;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(calls).toBe(3);
    svc.dispose();
  });

  it('finds Codex’s numbers near the end of a big session, or anywhere in it', async () => {
    const codexRoot = mkdtempSync(join(tmpdir(), 'codex-big-'));
    const dir = join(codexRoot, 'sessions', '2026', '09', '27');
    mkdirSync(dir, { recursive: true });
    const filler = jsonl(Array.from({ length: 3000 }, (_, i) => ({ type: 'response_item', payload: { text: 'x'.repeat(250), i } })));
    const file = join(dir, 'rollout-2026-09-27T10-00-00-z.jsonl');
    writeFileSync(file, filler + jsonl([{ ...rateLimits(61), timestamp: iso(1) }]));
    expect((await codexUsage({ ...homes, codexRoot }, now))!.windows[0]!.usedPercent).toBe(61);
    writeFileSync(file, jsonl([{ ...rateLimits(17), timestamp: iso(1) }]) + filler);
    expect((await codexUsage({ ...homes, codexRoot }, now))!.windows[0]!.usedPercent).toBe(17);
    rmSync(codexRoot, { recursive: true, force: true });
  });
});
