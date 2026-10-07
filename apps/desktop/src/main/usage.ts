import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { emptyUsage, estimateCost, type TokenUsage } from '@alchemist-coder/core';
import type { ClaudeLimits, CliVersion, KimiUsage, KimiWindow, PlanUsage, UsageWindow } from '../shared/api';

export interface UsageHomes {
  /** ~/.claude.json (account and plan) */
  claudeJson: string;
  /** ~/.claude/projects (transcripts) */
  claudeProjects: string;
  /** ~/.codex */
  codexRoot: string;
  /** ~/.kimi (Kimi Code's sign-in) */
  kimiRoot?: string;
}

export const defaultHomes = (): UsageHomes => ({
  claudeJson: process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'),
  claudeProjects: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
  codexRoot: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  kimiRoot: kimiHome(),
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

type RateLimitsAt = { at: number; limits: Record<string, any> };

/**
 * Codex's limits as any version wrote them: today's `primary`/`secondary` objects (reset as a time or as
 * seconds from then), or early versions' flat `primary_used_percent`… fields. Null for an empty report
 * (some report a second, empty pool).
 */
export function normalizeRateLimits(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  if (r.primary || r.secondary) return r;
  if (r.primary_used_percent == null && r.secondary_used_percent == null) return null;
  const flat = (k: 'primary' | 'secondary') =>
    r[`${k}_used_percent`] == null ? null : { used_percent: r[`${k}_used_percent`], window_minutes: r[`${k}_window_minutes`], resets_in_seconds: r[`${k}_resets_in_seconds`] ?? r[`${k}_reset_after_seconds`] };
  return { ...r, primary: flat('primary'), secondary: flat('secondary') };
}

/** How much of a session file's end is read first: Codex records its limits after every turn. */
const TAIL_BYTES = 512 * 1024;

/** The last limits Codex recorded in a session file, read from the end (sessions grow to megabytes). */
async function lastRateLimits(file: string, size: number): Promise<RateLimitsAt | null> {
  const parse = (line: string): RateLimitsAt | null => {
    if (!line.includes('"rate_limits"')) return null;
    try {
      const o = JSON.parse(line);
      const limits = normalizeRateLimits(o.payload?.rate_limits ?? o.rate_limits);
      return limits ? { at: Date.parse(o.timestamp ?? '') || statSync(file).mtimeMs, limits } : null;
    } catch {
      return null; // partial line
    }
  };
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift(); // cut in the middle
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = parse(lines[i]!);
    if (found) return found;
  }
  if (start === 0) return null;
  // Not near the end: the whole file.
  let last: RateLimitsAt | null = null;
  await eachLine(file, (line) => (last = parse(line) ?? last));
  return last;
}

/** What was found in each session file at a given size: files that didn't grow aren't read again. */
export type CodexSeen = Map<string, { size: number; found: RateLimitsAt | null }>;

/**
 * Codex: the plan and both usage windows (5 hours, weekly) exactly as OpenAI reported them in the
 * most recent session. A window whose reset time has passed shows as reset.
 */
export async function codexUsage(homes: UsageHomes, now = Date.now(), seen: CodexSeen = new Map()): Promise<PlanUsage['codex']> {
  for (const file of codexRollouts(homes.codexRoot)) {
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    let entry = seen.get(file);
    if (!entry || entry.size !== size) seen.set(file, (entry = { size, found: size ? await lastRateLimits(file, size) : null }));
    if (!entry.found) continue;
    const { at, limits } = entry.found;
    const window = (w: Record<string, any> | null | undefined, fallback: 'five_hour' | 'weekly') => {
      if (!w) return null;
      const minutes = Number(w.window_minutes) || 0;
      // Which window it is comes from its length (a plan may have only the weekly one).
      const label = minutes ? (minutes > 24 * 60 ? 'weekly' : 'five_hour') : fallback;
      const resetsAt = Number(w.resets_at) * 1000 || (Number(w.resets_in_seconds) ? at + Number(w.resets_in_seconds) * 1000 : 0);
      const reset = resetsAt > 0 && resetsAt <= now;
      return { label, usedPercent: reset ? 0 : Math.max(0, Math.min(100, Number(w.used_percent) || 0)), windowMinutes: minutes, resetsAt: resetsAt || null } as const;
    };
    return {
      plan: typeof limits.plan_type === 'string' ? limits.plan_type : null,
      windows: [window(limits.primary, 'five_hour'), window(limits.secondary, 'weekly')].filter((w): w is NonNullable<typeof w> => !!w),
      asOf: at,
      reached: !!limits.rate_limit_reached_type,
    };
  }
  return null;
}

/** Kimi Code's sign-in as the `kimi` CLI keeps it, and where its usage is. */
export const kimiHome = () => join(homedir(), '.kimi');
const kimiUsageUrl = () => `${(process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1').replace(/\/$/, '')}/usages`;

const toInt = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));

/** A reset given as a time (ISO, or seconds/milliseconds since 1970) or as seconds from now. */
function kimiReset(d: Record<string, any>, now: number): number | null {
  for (const k of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
    const v = d[k];
    if (v == null || v === '') continue;
    if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) return Number(v) > 1e12 ? Number(v) : Number(v) * 1000;
    const t = Date.parse(String(v).replace(/(\.\d{3})\d+/, '$1'));
    if (Number.isFinite(t)) return t;
  }
  for (const k of ['reset_in', 'resetIn', 'ttl']) {
    const sec = toInt(d[k]);
    if (sec) return now + sec * 1000;
  }
  return null;
}

/** "5h limit" style length of a limit: `duration` in a `timeUnit`. */
function kimiMinutes(...sources: Array<Record<string, any>>): number | null {
  for (const o of sources) {
    const n = toInt(o.duration);
    if (!n) continue;
    const unit = String(o.timeUnit ?? o.time_unit ?? '').toUpperCase();
    if (unit.includes('MINUTE')) return n;
    if (unit.includes('HOUR')) return n * 60;
    if (unit.includes('DAY')) return n * 1440;
    return Math.round(n / 60);
  }
  return null;
}

/**
 * What Kimi Code's usage endpoint answers, read as tolerantly as the `kimi` CLI reads it (its fields have
 * changed between versions): the plan's weekly summary, then each limit (5 hours…).
 */
export function parseKimiUsage(payload: Record<string, any>, now = Date.now()): KimiWindow[] {
  const row = (d: Record<string, any>, label: string, minutes: number | null): KimiWindow | null => {
    const limit = toInt(d.limit);
    let used = toInt(d.used);
    const remaining = toInt(d.remaining);
    if (used == null && remaining != null && limit != null) used = limit - remaining;
    if (used == null && limit == null) return null;
    const percent = limit && limit > 0 ? Math.max(0, Math.min(100, ((used ?? 0) / limit) * 100)) : 0;
    return { label: String(d.name ?? d.title ?? label), minutes, used: used ?? 0, limit: limit ?? 0, percent, resetsAt: kimiReset(d, now) };
  };
  const out: KimiWindow[] = [];
  if (payload.usage && typeof payload.usage === 'object') {
    const summary = row(payload.usage, 'Weekly limit', null);
    if (summary) out.push(summary);
  }
  const limits: unknown[] = Array.isArray(payload.limits) ? payload.limits : [];
  limits.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const it = item as Record<string, any>;
    const detail = it.detail && typeof it.detail === 'object' ? (it.detail as Record<string, any>) : it;
    const win = it.window && typeof it.window === 'object' ? (it.window as Record<string, any>) : {};
    const minutes = kimiMinutes(win, it, detail);
    const named = it.name ?? it.title ?? it.scope ?? detail.name ?? detail.title ?? detail.scope;
    const label = named ? String(named) : minutes ? (minutes % 60 ? `${minutes}m limit` : minutes % 1440 ? `${minutes / 60}h limit` : `${minutes / 1440}d limit`) : `Limit #${i + 1}`;
    const r = row(detail, label, minutes);
    if (r) out.push({ ...r, label });
  });
  return out;
}

/** The `kimi` CLI's access token while it's still good (it lasts minutes; the CLI renews it as it runs). */
function kimiToken(root: string, now: number): string | null {
  try {
    const o = JSON.parse(readFileSync(join(root, 'credentials', 'kimi-code.json'), 'utf8')) as { access_token?: unknown; expires_at?: unknown };
    const expires = Number(o.expires_at) * 1000;
    return typeof o.access_token === 'string' && o.access_token && expires > now + 15_000 ? o.access_token : null;
  } catch {
    return null;
  }
}

const kimiSignedIn = (root: string) => existsSync(join(root, 'credentials', 'kimi-code.json'));

interface KimiCheck {
  windows: KimiWindow[];
  at: number;
  error: string | null;
}

/** Asks Kimi Code for its usage with the CLI's current sign-in; null without one (nothing is asked then). */
async function fetchKimi(root: string): Promise<KimiCheck | null> {
  const now = Date.now();
  const token = kimiToken(root, now);
  if (!token) return null;
  try {
    const res = await fetch(kimiUsageUrl(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401) return null; // the CLI renews it next time it runs
    if (res.status === 429) return { windows: [], at: now, error: 'rate-limited' };
    if (!res.ok) return { windows: [], at: now, error: `http-${res.status}` };
    return { windows: parseKimiUsage((await res.json()) as Record<string, any>, now), at: now, error: null };
  } catch {
    return { windows: [], at: now, error: 'offline' };
  }
}

/**
 * How often a plan's numbers are asked for when only its servers have them (Claude, Kimi). Codex
 * writes its own into its session files, which are read as they change, without any request.
 */
export const CLAUDE_GAP = {
  /** While the CLI writes on this computer: at most every 5 minutes, plus one once it stops. */
  active: 5 * 60_000,
  /** Otherwise (used on the web or another computer): every 30 minutes, with the window on screen. */
  idle: 30 * 60_000,
};
/** Local recount (windows sliding past old replies, resets): no request involved. */
const RECOUNT_MS = 5 * 60_000;
/** Agents write in bursts: count once they pause. */
const SETTLE_MS = 2000;
/** Installed versions looked at again (the newest out is asked for at most daily). */
const VERSIONS_MS = 6 * 3_600_000;

type LimitsMode = 'idle' | 'active' | 'force';

/**
 * Numbers only a server has: asked for while the CLI works (at most every 5 minutes, and once more when
 * it stops), every 30 minutes otherwise with the window on screen, and waited out after a failure.
 */
class Checker<T extends { at: number; error: string | null }> {
  checked: { at: number; value: T } | null = null;
  /** The last numbers that came back fine. */
  good: T | null = null;
  touched = false;
  wroteAt = 0;
  trailing: ReturnType<typeof setTimeout> | null = null;

  constructor(
    /** Null: there was nothing to ask with (no sign-in); try again next time. */
    private readonly ask: () => Promise<T | null>,
    private readonly onScreen: () => boolean,
    private readonly onGood: (value: T) => void = () => {},
  ) {}

  private static retry(value: { error: string | null }): number {
    return value.error === 'rate-limited' ? 10 * 60_000 : 3 * 60_000;
  }

  private due(gap: number): boolean {
    if (!this.checked) return true;
    const age = Date.now() - this.checked.at;
    return age >= (this.checked.value.error ? Checker.retry(this.checked.value) : gap);
  }

  /** The latest check's numbers (asking again when due); the last good ones, marked, after a failure. */
  async get(mode: LimitsMode): Promise<(T & { stale?: string | null }) | null> {
    // Even a refresh by hand waits out a rate limit.
    const rateLimited = this.checked?.value.error === 'rate-limited' && Date.now() - this.checked.at < Checker.retry(this.checked.value);
    const ask =
      mode === 'force' ? !rateLimited : mode === 'active' ? this.due(CLAUDE_GAP.active) : this.due(CLAUDE_GAP.idle) && (!this.checked || this.onScreen());
    if (ask) {
      const value = await this.ask().catch(() => null);
      if (value) {
        this.checked = { at: Date.now(), value };
        if (!value.error) {
          this.good = value;
          this.onGood(value);
        }
      }
    }
    const latest = this.checked?.value ?? null;
    if (latest && !latest.error) return latest;
    if (this.good) return { ...this.good, stale: latest?.error ?? 'offline' };
    return latest;
  }

  /** The CLI wrote: the next count asks again when due. */
  touch() {
    this.touched = true;
    this.wroteAt = Date.now();
  }

  /** It may keep working past the last check: once more when that's due, so the numbers end up final. */
  followUp(recheck: () => void) {
    if (this.trailing || !this.checked) return;
    const wait = this.checked.at + CLAUDE_GAP.active - Date.now();
    this.trailing = setTimeout(
      () => {
        this.trailing = null;
        if (this.checked && this.wroteAt > this.checked.at) recheck();
      },
      Math.max(0, wait) + 1000,
    );
  }

  dispose() {
    if (this.trailing) clearTimeout(this.trailing);
  }
}

function readJson<T>(file: string | undefined, valid: (v: T) => boolean): T | null {
  try {
    const v = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
    return v && valid(v) ? v : null;
  } catch {
    return null;
  }
}

function writeJson(file: string | undefined, value: unknown) {
  if (!file) return;
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(value));
    renameSync(`${file}.tmp`, file);
  } catch {
    // the numbers still show; they just won't survive a restart
  }
}

/**
 * Plans and usage for the subscriptions this machine is signed in to, pushed to whoever listens
 * whenever they change. Nothing polls: the CLIs' own files say when something happened.
 */
export class UsageService {
  private value: PlanUsage | null = null;
  private pending: Promise<PlanUsage> | null = null;
  private readonly tallies = new Map<string, FileTally>();
  private readonly codexSeen: CodexSeen = new Map();
  private readonly claude: Checker<ClaudeLimits>;
  private readonly kimi: Checker<KimiCheck>;
  private versions: CliVersion[] = [];
  private readonly listeners = new Set<(usage: PlanUsage) => void>();
  private pushed = '';
  private settle: ReturnType<typeof setTimeout> | null = null;
  private recount: ReturnType<typeof setInterval> | null = null;
  private versionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly homes: UsageHomes = defaultHomes(),
    private readonly claudeLimits?: () => Promise<ClaudeLimits>,
    cacheFile?: string,
    /** Whether the app's window is on screen: checks with nothing happening wait until it is. */
    onScreen: () => boolean = () => true,
    private readonly cliVersions?: { check(): Promise<CliVersion[]> },
    kimiCacheFile?: string,
  ) {
    const fetchClaude = claudeLimits;
    this.claude = new Checker<ClaudeLimits>(async () => (fetchClaude ? fetchClaude() : null), onScreen, (v) => writeJson(cacheFile, v));
    this.claude.good = readJson<ClaudeLimits>(cacheFile, (v) => !v.error && Number.isFinite(v.at));
    const kimiRoot = homes.kimiRoot;
    this.kimi = new Checker<KimiCheck>(async () => (kimiRoot ? fetchKimi(kimiRoot) : null), onScreen, (v) => writeJson(kimiCacheFile, v));
    this.kimi.good = readJson<KimiCheck>(kimiCacheFile, (v) => !v.error && Array.isArray(v.windows));
  }

  private limitsFor(mode: LimitsMode): Promise<ClaudeLimits | null> {
    return this.claudeLimits ? this.claude.get(mode) : Promise.resolve(null);
  }

  private async kimiUsage(mode: LimitsMode): Promise<KimiUsage | null> {
    const root = this.homes.kimiRoot;
    if (!root || !kimiSignedIn(root)) return null;
    const v = await this.kimi.get(mode);
    const fresh = !!v && !v.stale && !v.error;
    return { windows: v?.windows ?? [], asOf: v && !v.error ? v.at : (this.kimi.good?.at ?? null), waiting: !fresh && !kimiToken(root, Date.now()) };
  }

  /** One count at a time; a refresh by hand waits for the one running, then asks again. */
  private compute(claudeMode: LimitsMode, kimiMode: LimitsMode = claudeMode === 'force' ? 'force' : 'idle'): Promise<PlanUsage> {
    const force = claudeMode === 'force' || kimiMode === 'force';
    if (this.pending && !force) return this.pending;
    const run = async (): Promise<PlanUsage> => {
      const now = Date.now();
      const [claude, codex, limits, kimi] = await Promise.all([
        claudeUsage(this.homes, now, this.tallies).catch(() => null),
        codexUsage(this.homes, now, this.codexSeen).catch(() => null),
        this.limitsFor(claudeMode),
        this.kimiUsage(kimiMode).catch(() => null),
      ]);
      const value: PlanUsage = { claude: claude ? { ...claude, limits } : null, codex, kimi, versions: this.versions, at: Date.now() };
      this.value = value;
      this.push(value);
      return value;
    };
    const task = (this.pending ? this.pending.catch(() => null) : Promise.resolve(null)).then(run);
    this.pending = task;
    void task.finally(() => this.pending === task && (this.pending = null)).catch(() => {});
    return task;
  }

  /** To every listener, only when something they'd see changed. */
  private push(value: PlanUsage) {
    const key = JSON.stringify({ ...value, at: 0 });
    if (key === this.pushed) return;
    this.pushed = key;
    for (const listener of this.listeners) listener(value);
  }

  /** The latest numbers; `force` (the refresh button) also asks the servers again. */
  get(force = false): Promise<PlanUsage> {
    if (!force && this.value) return Promise.resolve(this.value);
    return this.compute(force ? 'force' : 'idle');
  }

  /** The CLIs' versions, looked at again (after an update); pushed with the usage. */
  async refreshVersions(): Promise<void> {
    if (!this.cliVersions) return;
    this.versions = await this.cliVersions.check().catch(() => this.versions);
    if (this.value) {
      this.value = { ...this.value, versions: this.versions };
      this.push(this.value);
    }
  }

  /** Gets the numbers now and every time they change. */
  subscribe(listener: (usage: PlanUsage) => void): () => void {
    this.listeners.add(listener);
    if (this.value) listener(this.value);
    this.recount ??= setInterval(() => void this.compute('idle'), RECOUNT_MS);
    if (this.cliVersions && !this.versionTimer) this.versionTimer = setInterval(() => void this.refreshVersions(), VERSIONS_MS);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      if (this.recount) clearInterval(this.recount);
      if (this.versionTimer) clearInterval(this.versionTimer);
      this.recount = this.versionTimer = null;
    };
  }

  /**
   * A CLI wrote to its files (a reply, a finished turn): count again once it pauses. Codex's numbers
   * come with its files; Claude's and Kimi's are asked for at most every few minutes while they work.
   */
  touch(source: string): void {
    if (source === 'claude-code') this.claude.touch();
    else if (source === 'kimi') this.kimi.touch();
    else if (source !== 'codex') return;
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      const claude = this.claude.touched;
      const kimi = this.kimi.touched;
      this.claude.touched = this.kimi.touched = false;
      void this.compute(claude ? 'active' : 'idle', kimi ? 'active' : 'idle').then(() => {
        if (claude && this.claudeLimits) this.claude.followUp(() => void this.compute('active', 'idle'));
        if (kimi) this.kimi.followUp(() => void this.compute('idle', 'active'));
      });
    }, SETTLE_MS);
  }

  /** Back to the window after a while: whatever changed meanwhile (used elsewhere, resets). */
  wake(): void {
    if (!this.value || Date.now() - this.value.at > 60_000) void this.compute('idle');
  }

  dispose(): void {
    if (this.settle) clearTimeout(this.settle);
    this.claude.dispose();
    this.kimi.dispose();
    if (this.recount) clearInterval(this.recount);
    if (this.versionTimer) clearInterval(this.versionTimer);
    this.listeners.clear();
  }
}
