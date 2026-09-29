import type { Locale } from '@shared/api';

export function compactNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: n >= 1e6 ? 1 : 0 }).format(n);
}

export function money(n: number | null, locale: Locale): string {
  if (n == null) return '—';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: n < 10 ? 2 : 0 }).format(n);
}

export function duration(ms: number | null): string {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${Math.round(h / 24)} d`;
}

export function relativeTime(ts: number | null, locale: Locale, now = Date.now()): string {
  if (ts == null) return '';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const diff = (ts - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  // Spanish "21 ago" (agosto) reads like English "ago": numbers there.
  const month = locale === 'es' ? 'numeric' : 'short';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month, year: abs > 86400 * 300 ? 'numeric' : undefined }).format(ts);
}

export function clockTime(ts: number | null, locale: Locale): string {
  if (ts == null) return '';
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(ts);
}

/** "MyWebApp" → MW, "shop_backend" → SB, "Api24" → A24, "x1234" → X12. */
export function initials(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0) return '•';
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const w = words[0]!;
  const digits = /\d+/.exec(w.slice(1))?.[0] ?? '';
  return (w[0]! + (digits ? digits.slice(0, 2) : (w[1] ?? ''))).toUpperCase();
}

/** Stable pleasant gradient per project name. */
export function projectGradient(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360;
  return `linear-gradient(135deg, hsl(${a} 70% 70%), hsl(${(a + 50) % 360} 65% 62%))`;
}

/** 5.2 GB, 830 MB, 12 KB. */
export function bytes(n: number, locale: Locale): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toLocaleString(locale, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * A model id as people say it: "claude-opus-4-1-20250805" → "Opus 4.1",
 * "claude-3-5-sonnet-20241022" → "Sonnet 3.5", "gpt-5.1-codex" → "GPT-5.1 Codex". Others unchanged.
 */
export function modelLabel(id: string): string {
  if (ALIAS.test(id)) return id[0]!.toUpperCase() + id.slice(1).toLowerCase();
  const big = /\[1m\]$/i.test(id) ? ' 1M' : '';
  const bare = id.replace(/\[[^\]]*\]$/, '').replace(/^(anthropic|openai)[/.]/, '');
  const family = '(opus|sonnet|haiku|fable)';
  const modern = new RegExp(`^claude-${family}(?:-(\\d+))?(?:-(\\d{1,2}))?(?:-\\d{8})?$`).exec(bare);
  if (modern) return `${cap(modern[1]!)}${modern[2] ? ` ${modern[2]}${modern[3] ? `.${modern[3]}` : ''}` : ''}${big}`;
  const old = new RegExp(`^claude-(\\d+)(?:-(\\d{1,2}))?-${family}(?:-\\d{8})?$`).exec(bare);
  if (old) return `${cap(old[3]!)} ${old[1]}${old[2] ? `.${old[2]}` : ''}${big}`;
  const gpt = /^gpt-([\d.]+[a-z]?)((?:-[a-z]+)*)$/i.exec(bare);
  if (gpt) return `GPT-${gpt[1]}${gpt[2]!.split('-').filter(Boolean).map((w) => ` ${cap(w)}`).join('')}${big}`;
  return id;
}

/**
 * A model's context size: what the CLI recorded, else what the model is known for; null when
 * unknown. `used` beyond the usual size means the long-context variant (transcripts don't say).
 */
export function contextWindowFor(model: string | null | undefined, recorded?: number | null, used = 0): number | null {
  if (recorded && recorded > 0) return recorded;
  const m = (model ?? '').toLowerCase();
  const claude = /claude|opus|sonnet|haiku|fable/.test(m);
  const size = /\[1m\]/.test(m) ? 1_000_000 : claude ? 200_000 : /^gpt-5/.test(m) ? 272_000 : null;
  if (size && used > size) return claude && used <= 1_000_000 ? 1_000_000 : null;
  return size;
}

/** The provider's model closest to one a conversation used: same id, then contained ("opus" in "claude-opus-4-8"), then same family. */
export function matchModel(models: Array<{ id: string }>, used: string | undefined): string | undefined {
  if (!used) return undefined;
  const u = used.toLowerCase();
  const exact = models.find((m) => m.id.toLowerCase() === u);
  if (exact) return exact.id;
  const contained = models.find((m) => m.id !== 'default' && u.includes(m.id.toLowerCase()));
  if (contained) return contained.id;
  const family = /(opus|sonnet|haiku|fable|gpt-[\d.]+[a-z-]*)/.exec(u)?.[1];
  return family ? models.find((m) => m.id.toLowerCase().includes(family))?.id : undefined;
}

/** Aliases the CLIs use for models ("opus", "haiku") read like names. */
const ALIAS = /^(opus|sonnet|haiku|fable)$/i;
