import { createReadStream, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { emptyUsage, estimateCost, type TokenUsage } from '@alchemist-coder/core';
import type { ClaudeLimits, PlanUsage, UsageWindow } from '../shared/api';

export interface UsageHomes {
  /** ~/.claude.json (account and plan) */
  claudeJson: string;
  /** ~/.claude/projects (transcripts) */
  claudeProjects: string;
  /** ~/.codex */
  codexRoot: string;
}

export const defaultHomes = (): UsageHomes => ({
  claudeJson: process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'),
  claudeProjects: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
  codexRoot: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
});

const HOUR = 3_600_000;
const WINDOWS_H = [5, 24 * 7];

/** "default_claude_max_20x" → "Max 20x"; organization types as a fallback. */
function claudePlan(account: Record<string, unknown>): string | null {
  const tier = String(account.organizationRateLimitTier ?? account.userRateLimitTier ?? '');
  const max = /max_(\d+x)/.exec(tier);
  if (max) return `Max ${max[1]}`;
  const type = String(account.organizationType ?? '');
  const names: Record<string, string> = { claude_max: 'Max', claude_pro: 'Pro', claude_team: 'Team', claude_enterprise: 'Enterprise', claude_free: 'Free' };
  return names[type] ?? (type ? type.replace(/^claude_/, '') : null);
}

async function eachLine(file: string, fn: (line: string) => void, start = 0, end?: number) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8', start, end }), crlfDelay: Infinity });
  for await (const line of rl) fn(line);
}

/** What one transcript contributed: each reply's time, tokens and cost, and any usage limit it hit. */
interface FileTally {
  /** Bytes already read (transcripts only grow, so a refresh reads what was appended). */
  offset: number;
  replies: Array<{ ts: number; usage: TokenUsage; cost: number }>;
  seen: Set<string>;
  limits: Array<{ ts: number; type: string; resetsAt: number }>;
}

/** Reads the lines appended to `file` since the last time (whole lines only). */
async function tallyFile(file: string, tally: FileTally, since: number): Promise<void> {
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size < tally.offset) Object.assign(tally, { offset: 0, replies: [], seen: new Set(), limits: [] }); // rewritten
  if (size === tally.offset) return;
  let consumed = tally.offset;
  let partial = false;
  await eachLine(
    file,
    (line) => {
      // A line still being written (only ever the last one): it and anything after wait for next time.
      if (partial || !line.endsWith('}')) {
        partial = true;
        return;
      }
      consumed += Buffer.byteLength(line, 'utf8') + 1;
      const hasUsage = line.includes('"usage"');
      const hasLimit = line.includes('"quotaLimits"');
      if (!hasUsage && !hasLimit) return;
      let o: Record<string, any>;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      const ts = Date.parse(o.timestamp ?? '');
      if (!Number.isFinite(ts) || ts < since) return;
      const q = o.quotaLimits;
      if (q && Number(q.resetsAt)) tally.limits.push({ ts, type: String(q.rateLimitType ?? ''), resetsAt: Number(q.resetsAt) * 1000 });
      const m = o.message;
      const u = m?.usage;
      if (o.type !== 'assistant' || !u) return;
      // Claude Code writes one line per content block of a reply, all with the same usage.
      const key = `${m.id ?? ''}:${o.requestId ?? ''}`;
      if (m.id && tally.seen.has(key)) return;
      tally.seen.add(key);
      const cc = u.cache_creation ?? {};
      const usage: TokenUsage = {
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        cacheWrite5m: Number(cc.ephemeral_5m_input_tokens ?? (cc.ephemeral_1h_input_tokens == null ? u.cache_creation_input_tokens : 0)) || 0,
        cacheWrite1h: Number(cc.ephemeral_1h_input_tokens) || 0,
      };
      tally.replies.push({ ts, usage, cost: estimateCost(m.model, usage) ?? 0 });
    },
    tally.offset,
    size - 1,
  );
  tally.offset = consumed;
}

/** Transcripts touched in the last `ms`: main conversations and their subagents. */
function recentTranscripts(root: string, since: number): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isFile() && st.mtimeMs >= since) out.push(p);
  };
  for (const project of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) add(join(dir, e.name));
      else if (e.isDirectory()) {
        const sub = join(dir, e.name, 'subagents');
        for (const f of existsSync(sub) ? readdirSync(sub) : []) if (f.endsWith('.jsonl')) add(join(sub, f));
      }
    }
  }
  return out;
}

/**
 * Claude: the plan from the signed-in account, and what the last 5 hours and 7 days used,
 * summed from your own transcripts (Anthropic doesn't store the percentages locally). A usage
 * limit Claude Code ran into, with its reset time, when it's still in effect.
 */
export async function claudeUsage(homes: UsageHomes, now = Date.now(), tallies = new Map<string, FileTally>()): Promise<PlanUsage['claude']> {
  let account: Record<string, unknown> | null = null;
  try {
    account = (JSON.parse(readFileSync(homes.claudeJson, 'utf8')) as { oauthAccount?: Record<string, unknown> }).oauthAccount ?? null;
  } catch {
    account = null;
  }
  const since = now - Math.max(...WINDOWS_H) * HOUR;
  const files = recentTranscripts(homes.claudeProjects, since);
  if (!account && !files.length) return null;
  for (const file of files) {
    let tally = tallies.get(file);
    if (!tally) tallies.set(file, (tally = { offset: 0, replies: [], seen: new Set(), limits: [] }));
    await tallyFile(file, tally, since);
  }
  const windows = WINDOWS_H.map((hours) => ({ hours, usage: emptyUsage(), costUsd: 0, messages: 0 }));
  let limit: { type: string; resetsAt: number } | null = null;
  for (const [file, tally] of tallies) {
    if (!files.includes(file)) {
      tallies.delete(file); // not touched for a week
      continue;
    }
    tally.replies = tally.replies.filter((r) => r.ts >= since);
    for (const r of tally.replies) {
      for (const w of windows) {
        if (r.ts < now - w.hours * HOUR) continue;
        w.messages++;
        w.costUsd += r.cost;
        for (const k of Object.keys(r.usage) as Array<keyof TokenUsage>) w.usage[k] += r.usage[k];
      }
    }
    for (const l of tally.limits) if (l.resetsAt > now && (!limit || l.resetsAt > limit.resetsAt)) limit = { type: l.type, resetsAt: l.resetsAt };
  }
  const summary = (w: (typeof windows)[number]): UsageWindow => ({
    hours: w.hours,
    tokens: w.usage.input + w.usage.output + w.usage.cacheRead + w.usage.cacheWrite5m + w.usage.cacheWrite1h,
    outputTokens: w.usage.output,
    costUsd: Math.round(w.costUsd * 100) / 100,
    messages: w.messages,
  });
  return {
    plan: account ? claudePlan(account) : null,
    account: account && typeof account.emailAddress === 'string' ? account.emailAddress : null,
    extraUsage: account?.hasExtraUsageEnabled === true,
    windows: windows.map(summary),
    limit,
  };
}

/** Newest Codex session files first (sessions/YYYY/MM/DD/rollout-*.jsonl). */
function codexRollouts(root: string): string[] {
  const dir = join(root, 'sessions');
  const sorted = (p: string) => (existsSync(p) ? readdirSync(p).sort().reverse() : []);
  const out: string[] = [];
  for (const y of sorted(dir))
    for (const m of sorted(join(dir, y)))
      for (const d of sorted(join(dir, y, m))) {
        for (const f of sorted(join(dir, y, m, d))) if (f.startsWith('rollout-') && f.endsWith('.jsonl')) out.push(join(dir, y, m, d, f));
        if (out.length >= 20) return out;
      }
  return out;
}

/**
 * Codex: the plan and both usage windows (5 hours, weekly) exactly as OpenAI reported them in the
 * most recent session. A window whose reset time has passed shows as reset.
 */
export async function codexUsage(homes: UsageHomes, now = Date.now()): Promise<PlanUsage['codex']> {
  for (const file of codexRollouts(homes.codexRoot)) {
    let last: { at: number; limits: Record<string, any> } | null = null;
    await eachLine(file, (line) => {
      if (!line.includes('"rate_limits"')) return;
      try {
        const o = JSON.parse(line);
        const limits = o.payload?.rate_limits ?? o.rate_limits;
        if (limits?.primary || limits?.secondary) last = { at: Date.parse(o.timestamp ?? '') || statSync(file).mtimeMs, limits };
      } catch {
        // partial line
      }
    });
    if (!last) continue;
    const { at, limits } = last as { at: number; limits: Record<string, any> };
    const window = (w: Record<string, any> | undefined, label: 'five_hour' | 'weekly') => {
      if (!w) return null;
      const resetsAt = Number(w.resets_at) * 1000 || (Number(w.resets_in_seconds) ? at + Number(w.resets_in_seconds) * 1000 : 0);
      const reset = resetsAt > 0 && resetsAt <= now;
      return { label, usedPercent: reset ? 0 : Math.max(0, Math.min(100, Number(w.used_percent) || 0)), windowMinutes: Number(w.window_minutes) || 0, resetsAt: resetsAt || null };
    };
    return {
      plan: typeof limits.plan_type === 'string' ? limits.plan_type : null,
      windows: [window(limits.primary, 'five_hour'), window(limits.secondary, 'weekly')].filter((w): w is NonNullable<typeof w> => !!w),
      asOf: at,
    };
  }
  return null;
}

/** Plans and usage for the subscriptions this machine is signed in to, cached for a minute. */
export class UsageService {
  private cache: { at: number; value: PlanUsage } | null = null;
  private pending: Promise<PlanUsage> | null = null;
  private readonly tallies = new Map<string, FileTally>();
  /** The latest check, good or not: Claude's percentages change slowly and the endpoint is rate-limited. */
  private checked: { at: number; value: ClaudeLimits } | null = null;
  /** The last numbers that came back fine, kept across launches. */
  private good: ClaudeLimits | null = null;

  constructor(
    private readonly homes: UsageHomes = defaultHomes(),
    private readonly claudeLimits?: () => Promise<ClaudeLimits>,
    private readonly cacheFile?: string,
  ) {
    try {
      const saved = cacheFile && existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as ClaudeLimits) : null;
      if (saved && !saved.error && Number.isFinite(saved.at)) this.good = saved;
    } catch {
      this.good = null;
    }
  }

  /** How long a check stands: 30 minutes when it worked, less when it failed (longer when rate-limited). */
  private static ttl(value: ClaudeLimits): number {
    if (!value.error) return 30 * 60_000;
    return value.error === 'rate-limited' ? 10 * 60_000 : 3 * 60_000;
  }

  private async limitsFor(force: boolean): Promise<ClaudeLimits | null> {
    if (!this.claudeLimits) return null;
    // Even a forced refresh waits out a rate limit.
    const fresh = this.checked && Date.now() - this.checked.at < UsageService.ttl(this.checked.value);
    if (!fresh || (force && this.checked?.value.error !== 'rate-limited')) {
      const value = await this.claudeLimits().catch(() => null);
      if (value) {
        this.checked = { at: Date.now(), value };
        if (!value.error) this.save(value);
      }
    }
    const latest = this.checked?.value ?? null;
    if (latest && !latest.error) return latest;
    // A failed check keeps showing the last good numbers, saying they're old.
    if (this.good) return { ...this.good, stale: latest?.error ?? 'offline' };
    return latest;
  }

  private save(value: ClaudeLimits) {
    this.good = value;
    if (!this.cacheFile) return;
    try {
      writeFileSync(`${this.cacheFile}.tmp`, JSON.stringify(value));
      renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
    } catch {
      // the numbers still show; they just won't survive a restart
    }
  }

  get(force = false): Promise<PlanUsage> {
    if (!force && this.cache && Date.now() - this.cache.at < 60_000) return Promise.resolve(this.cache.value);
    this.pending ??= (async () => {
      const [claude, codex, limits] = await Promise.all([claudeUsage(this.homes, Date.now(), this.tallies).catch(() => null), codexUsage(this.homes).catch(() => null), this.limitsFor(force)]);
      const value = { claude: claude ? { ...claude, limits } : null, codex, at: Date.now() };
      this.cache = { at: Date.now(), value };
      return value;
    })().finally(() => (this.pending = null));
    return this.pending;
  }
}
