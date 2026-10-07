import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CliVersion, KimiWindow, LimitWindow } from '@shared/api';
import { compactNumber, money, relativeTime } from '../format';
import { create } from 'zustand';
import { useStore, useT } from '../store';
import { toast } from '../ui';
import { gauges, level, livePercent, nextReset, type Gauge, type GaugeId } from '../usage-gauges';

type T = ReturnType<typeof useT>;

/** Which plan's details are open, from its gauge in the rail. */
export const useUsagePopover = create<{ open: GaugeId | null }>(() => ({ open: null }));

type Duration = { days?: number; hours?: number; minutes?: number };
/** "2 h 13 min" in the language's own units (Intl.DurationFormat), or plain units where it's missing. */
function duration(d: Duration, locale: string): string {
  const DurationFormat = (Intl as unknown as { DurationFormat?: new (l: string, o: { style: string }) => { format(d: Duration): string } }).DurationFormat;
  if (DurationFormat) return new DurationFormat(locale, { style: 'narrow' }).format(d);
  return [d.days && `${d.days} d`, d.hours && `${d.hours} h`, d.minutes && `${d.minutes} min`].filter(Boolean).join(' ');
}

/** "in 2 h 13 min" style time until a reset. */
function resetsIn(ts: number | null, locale: string, t: ReturnType<typeof useT>): string {
  if (!ts) return '';
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  // "in <1 min", "in 16 h" (no "0 min"), "in 2 d 3 h".
  const time = mins < 1 ? `<${duration({ minutes: 1 }, locale)}` : duration(d ? { days: d, ...(h ? { hours: h } : {}) } : h ? { hours: h, ...(m ? { minutes: m } : {}) } : { minutes: m }, locale);
  return t('usage.inTime', { time });
}

function Bar({ pct }: { pct: number }) {
  return <span className={`usage-bar ${level(pct)}`}>{pct > 0 && <i style={{ width: `${Math.min(100, Math.max(pct, 1.5))}%` }} />}</span>;
}

/** One aligned row: label, bar, percentage, reset time. */
function LimitRow({ label, w }: { label: string; w: LimitWindow }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const reset = w.resetsAt != null && w.resetsAt <= Date.now();
  return (
    <div className="usage-grid">
      <span className="usage-label">{label}</span>
      <Bar pct={reset ? 0 : w.percent} />
      <span className="usage-pct">{reset ? '—' : `${Math.round(w.percent)}%`}</span>
      <span className="usage-reset">{reset ? t('usage.resetSince') : w.resetsAt ? t('usage.resets', { when: resetsIn(w.resetsAt, locale, t) }) : ''}</span>
    </div>
  );
}

/** Kimi names its limits in English ("5h limit"): the usual ones in the app's language. */
const kimiLabel = (w: KimiWindow, t: T) => (w.minutes == null ? t('usage.windowWeek') : w.minutes === 300 ? t('usage.window5h') : w.label);

let watching: ReturnType<typeof setInterval> | null = null;

/** Updates a CLI in the app's terminal (you see it and answer its questions); the version shown follows. */
function runUpdate(cli: CliVersion, t: T) {
  const s = useStore.getState();
  const projectId = s.settings.activeProjectId ?? s.projects[0]?.id;
  if (!cli.update) return;
  if (projectId == null) return toast(t('settings.needsProject'));
  useUsagePopover.setState({ open: null });
  void s.openTerminalWith(projectId, cli.update, `${cli.label} ${cli.latest ?? ''}`.trim());
  toast(t('usage.updateHint'));
  // Looks again every 10 seconds for 10 minutes, until the new version is there.
  if (watching) clearInterval(watching);
  const until = Date.now() + 10 * 60_000;
  watching = setInterval(() => {
    void window.alchemist.refreshCliVersions().then(() => {
      const now = useStore.getState().planUsage?.versions?.find((v) => v.id === cli.id);
      if ((now && now.version !== cli.version) || Date.now() > until) {
        if (watching) clearInterval(watching);
        watching = null;
      }
    });
  }, 10_000);
}

/** The CLI's version, and an Update button when a newer one is out. */
function VersionRow({ cli }: { cli: CliVersion | null }) {
  const t = useT();
  if (!cli) return null;
  return (
    <div className="usage-version">
      <span>
        {cli.label} {cli.version ?? ''}
        {cli.outdated && cli.latest ? <b> · {t('usage.newVersion', { version: cli.latest })}</b> : cli.latest ? <small> · {t('usage.upToDate')}</small> : null}
      </span>
      {cli.outdated && cli.update && (
        <button className="btn-send small" title={cli.update} onClick={() => runUpdate(cli, t)}>
          {t('usage.update', { version: cli.latest ?? '' })}
        </button>
      )}
    </div>
  );
}

function Popover({ id, onClose }: { id: GaugeId; onClose: () => void }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The rail's gauges toggle the popover themselves.
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.rail-usage .gauge') && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div className={`usage-pop from-rail pop-${id}`} ref={box} role="dialog" aria-label={t('usage.title')}>
      <div className="usage-head">
        <b>{t('usage.title')}</b>
        <button className="link" onClick={() => (onClose(), useStore.setState({ settingsOpen: true, settingsSection: 'usage' }))}>
          {t('usage.more')} →
        </button>
      </div>
      <UsageDetails only={id} />
    </div>
  );
}

/** Plans, usage windows and limits for each signed-in CLI (all in Settings; one from its gauge). */
export function UsageDetails({ only }: { only?: GaugeId }) {
  const t = useT();
  const usage = useStore((s) => s.planUsage);
  const loading = useStore((s) => s.planUsageLoading);
  const onRefresh = () => void useStore.getState().loadPlanUsage(true);
  const locale = useStore((s) => s.locale);
  const show = (id: GaugeId) => !only || only === id;
  const cli = (id: CliVersion['id']) => usage?.versions?.find((v) => v.id === id) ?? null;
  const c = show('claude') ? usage?.claude : null;
  const x = show('codex') ? usage?.codex : null;
  const k = show('kimi') ? usage?.kimi : null;
  return (
    <>
      {!usage && (
        <section className="usage-sec usage-skeleton" aria-busy="true">
          <div className="usage-acct">
            <i className="sk sk-title" />
          </div>
          {[0, 1, 2].map((n) => (
            <div key={n} className="usage-grid">
              <i className="sk" />
              <i className="sk sk-bar" />
              <i className="sk" />
              <i className="sk" />
            </div>
          ))}
        </section>
      )}
      {c && (
        <section className="usage-sec">
          <div className="usage-acct">
            <b>✳ Claude</b>
            {c.plan && <span className="usage-plan">{c.plan}</span>}
          </div>
          {(c.account || c.extraUsage) && (
            <div className="usage-sub">
              {c.account}
              {c.account && c.extraUsage && ' · '}
              {c.extraUsage && t('usage.extra')}
            </div>
          )}
          {c.limit && (
            <div className="usage-limit">
              ⛔ {t('usage.limitHit', { when: new Date(c.limit.resetsAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}
            </div>
          )}
          {c.limits && !c.limits.error && (
            <>
              {c.limits.fiveHour && <LimitRow label={t('usage.session')} w={c.limits.fiveHour} />}
              {c.limits.sevenDay && <LimitRow label={t('usage.windowWeek')} w={c.limits.sevenDay} />}
              {c.limits.sevenDayOpus && <LimitRow label={t('usage.weekModel', { model: 'Opus' })} w={c.limits.sevenDayOpus} />}
              {c.limits.models.map((m) => (
                <LimitRow key={m.model} label={t('usage.weekModel', { model: m.model })} w={m} />
              ))}
            </>
          )}
          {c.limits?.stale && (
            <p className="usage-note">{t(c.limits.stale === 'rate-limited' ? 'usage.staleRateLimited' : 'usage.stale', { when: relativeTime(c.limits.at, locale) })}</p>
          )}
          {c.limits?.error && <p className="usage-note">{t(`usage.limitsError.${c.limits.error.startsWith('http') ? 'other' : c.limits.error}` as never)}</p>}
          {c.windows.map((w) => (
            <div key={w.hours} className="usage-row" title={t('usage.totalTokens', { n: compactNumber(w.tokens, locale) })}>
              <span className="usage-label">{w.hours === 5 ? t('usage.last5h') : t('usage.last7d')}</span>
              <span className="usage-val">
                {t('usage.requests', { n: compactNumber(w.messages, locale) })} · {t('usage.output', { n: compactNumber(w.outputTokens, locale) })}
                <small> · ~{money(w.costUsd, locale)} {t('usage.atApi')}</small>
              </span>
            </div>
          ))}
          {!c.limits && (
            <p className="usage-note">
              {t('usage.claudeNote')}{' '}
              <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">
                claude.ai
              </a>
            </p>
          )}
          {c.limits && !c.limits.error && <p className="usage-note">{t('usage.updated', { when: relativeTime(c.limits.at, locale) })}</p>}
          <VersionRow cli={cli('claude')} />
        </section>
      )}
      {x && (
        <section className="usage-sec">
          <div className="usage-acct">
            <b>◎ ChatGPT</b>
            {x.plan && <span className="usage-plan">{x.plan[0]!.toUpperCase() + x.plan.slice(1)}</span>}
            <span className="usage-tag">{t('usage.viaCodex')}</span>
          </div>
          {x.windows.map((w) => (
            <LimitRow key={w.label} label={w.label === 'five_hour' ? t('usage.window5h') : t('usage.windowWeek')} w={{ percent: w.usedPercent, resetsAt: w.resetsAt }} />
          ))}
          <p className="usage-note">{t('usage.asOf', { when: relativeTime(x.asOf, locale) })}</p>
          <VersionRow cli={cli('codex')} />
        </section>
      )}
      {k && (
        <section className="usage-sec">
          <div className="usage-acct">
            <b>K Kimi</b>
            <span className="usage-plan">Kimi Code</span>
          </div>
          {[...k.windows].sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity)).map((w) => (
            <LimitRow key={`${w.label}:${w.minutes}`} label={kimiLabel(w, t)} w={w} />
          ))}
          {k.waiting ? (
            <p className="usage-note">{t(k.asOf ? 'usage.kimiOld' : 'usage.kimiWaiting', { when: relativeTime(k.asOf, locale) })}</p>
          ) : (
            k.asOf && <p className="usage-note">{t('usage.updated', { when: relativeTime(k.asOf, locale) })}</p>
          )}
          <VersionRow cli={cli('kimi')} />
        </section>
      )}
      {usage && !c && !x && !k && <p className="usage-note">{t('usage.none')}</p>}
      {/* Each plan says when its numbers are from; this asks for them all again. */}
      <div className="usage-foot">
        <span />
        <button className="btn-ghost small" disabled={loading} onClick={onRefresh}>
          {loading ? <span className="spin" /> : '↻'} {t('usage.refresh')}
        </button>
      </div>
    </>
  );
}

/** Two rings: the 5-hour session outside, the week inside. */
function Rings({ session, week }: { session: number; week: number }) {
  const arc = (r: number, width: number, pct: number, cls: string) => (
    <>
      <circle className="track" cx="18" cy="18" r={r} strokeWidth={width} />
      {pct > 0 && <circle className={`val ${cls} ${level(pct)}`} cx="18" cy="18" r={r} strokeWidth={width} pathLength={100} strokeDasharray={`${Math.min(100, pct)} 100`} />}
    </>
  );
  return (
    <svg viewBox="0 0 36 36" aria-hidden>
      {arc(15.5, 3.2, session, 'outer')}
      {arc(10.4, 2.6, week, 'inner')}
    </svg>
  );
}

/** One plan in the rail: its rings, the percentage that limits you first, and the details on hover. */
function RailGauge({ g, now, open, onToggle }: { g: Gauge; now: number; open: boolean; onToggle: () => void }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  // A short glow when the numbers change.
  const [bump, setBump] = useState(false);
  const last = useRef(g.percent);
  useEffect(() => {
    if (last.current === g.percent) return;
    last.current = g.percent;
    setBump(true);
    const timer = setTimeout(() => setBump(false), 1200);
    return () => clearTimeout(timer);
  }, [g.percent]);
  const row = (label: string, w: LimitWindow | null) => {
    if (!w) return null;
    const reset = w.resetsAt != null && w.resetsAt <= now;
    const when = reset ? t('usage.resetSince') : w.resetsAt ? t('usage.resets', { when: resetsIn(w.resetsAt, locale, t) }) : '';
    return `${label}: ${reset ? '—' : `${Math.round(livePercent(w, now))}%`}${when ? ` · ${when}` : ''}`;
  };
  const time = (ts: number) => new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const label = (w: Gauge['session'], fallback: string) => (w && 'label' in w ? kimiLabel(w as KimiWindow, t) : fallback);
  const cli = g.cli;
  const lines = [
    `${g.glyph} ${g.name}${g.plan ? ` · ${g.plan}` : ''}`,
    g.hit && t('usage.limitHit', { when: time(g.hit.resetsAt) }),
    row(label(g.session, g.id === 'claude' ? t('usage.session') : t('usage.window5h')), g.session),
    row(label(g.week, t('usage.windowWeek')), g.week),
    g.percent == null && g.recent && `${t('usage.last5h')}: ${t('usage.requests', { n: compactNumber(g.recent.messages, locale) })}`,
    g.waiting && t('usage.kimiWaiting'),
    g.stale && g.asOf ? t('usage.stale', { when: relativeTime(g.asOf, locale, now) }) : g.asOf ? (g.id === 'codex' ? t('usage.asOf', { when: relativeTime(g.asOf, locale, now) }) : t('usage.updated', { when: relativeTime(g.asOf, locale, now) })) : null,
    cli && `${cli.label} ${cli.version ?? ''}${cli.outdated && cli.latest ? ` · ${t('usage.newVersion', { version: cli.latest })}` : ''}`,
  ].filter(Boolean) as string[];
  const pct = g.percent;
  return (
    <button
      className={`gauge ${g.id} ${g.hit ? 'hit' : ''} ${g.stale ? 'stale' : ''} ${bump ? 'bump' : ''}`}
      title={lines.join('\n')}
      aria-label={lines.join('. ')}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={onToggle}
    >
      <span className="gauge-ring">
        <Rings session={livePercent(g.session, now)} week={livePercent(g.week, now)} />
        <span className="gauge-glyph">{g.glyph}</span>
        {cli?.outdated && <i className="gauge-update" />}
      </span>
      <span className={`gauge-pct ${g.hit ? 'high' : pct != null ? level(pct) : ''}`}>{g.hit ? '⛔' : pct != null ? `${Math.round(pct)}%` : '—'}</span>
    </button>
  );
}

/**
 * Each signed-in plan's usage, over the settings gear in the rail: Claude, ChatGPT (through Codex) and
 * Kimi, each with its own details. The numbers are pushed whenever they change (see UsageService).
 */
export function RailUsage() {
  const open = useUsagePopover((s) => s.open);
  const usage = useStore((s) => s.planUsage);
  const load = useStore((s) => s.loadPlanUsage);
  const captureUsage = useStore((s) => s.info?.capture?.usage ?? false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (captureUsage) useUsagePopover.setState({ open: 'claude' });
  }, [captureUsage]);
  useEffect(() => {
    if (captureUsage && usage) useStore.getState().markCaptureReady();
  }, [captureUsage, usage]);
  // What's there now; after that, every change arrives by itself.
  useEffect(() => void load(), [load]);
  const list = gauges(usage, now);
  // A window that resets empties its ring right then; "updated 3 min ago" is fresh on hover.
  const next = nextReset(list, now);
  useEffect(() => setNow(Date.now()), [usage]);
  useEffect(() => {
    if (!next) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(next - Date.now() + 500, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [next]);
  if (!list.length) return null;
  const close = () => useUsagePopover.setState({ open: null });
  return (
    <div className="rail-usage" onMouseEnter={() => setNow(Date.now())}>
      {list.map((g) => (
        <RailGauge key={g.id} g={g} now={now} open={open === g.id} onToggle={() => useUsagePopover.setState({ open: open === g.id ? null : g.id })} />
      ))}
      {/* Over everything: the rail's foot is a layer of its own, under the panels beside it. */}
      {open && list.some((g) => g.id === open) && createPortal(<Popover id={open} onClose={close} />, document.body)}
    </div>
  );
}
