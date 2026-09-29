import { useEffect, useRef } from 'react';
import type { LimitWindow } from '@shared/api';
import { compactNumber, money, relativeTime } from '../format';
import { create } from 'zustand';
import { useStore, useT } from '../store';

/** The popover is opened from the status bar and from the edition chip in the title bar. */
export const useUsagePopover = create<{ open: boolean }>(() => ({ open: false }));

const level = (pct: number) => (pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low');

/** "in 2 h 13 min" / "en 2 h 13 min" style time until a reset. */
function resetsIn(ts: number | null, locale: string): string {
  if (!ts) return '';
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  // "in <1 min", "in 16 h" (no "0 min"), "in 2 d 3 h".
  const parts = d ? [`${d} d`, ...(h ? [`${h} h`] : [])] : h ? [`${h} h`, ...(m ? [`${m} min`] : [])] : [mins < 1 ? '<1 min' : `${m} min`];
  return locale === 'es' ? `en ${parts.join(' ')}` : `in ${parts.join(' ')}`;
}

function Bar({ pct }: { pct: number }) {
  return <span className={`usage-bar ${level(pct)}`}>{pct > 0 && <i style={{ width: `${Math.min(100, Math.max(pct, 1.5))}%` }} />}</span>;
}

/** One aligned row: label, bar, percentage, reset time. */
function LimitRow({ label, w }: { label: string; w: LimitWindow }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const reset = !w.resetsAt || w.resetsAt <= Date.now();
  return (
    <div className="usage-grid">
      <span className="usage-label">{label}</span>
      <Bar pct={reset ? 0 : w.percent} />
      <span className="usage-pct">{reset ? '—' : `${Math.round(w.percent)}%`}</span>
      <span className="usage-reset">{reset ? t('usage.resetSince') : t('usage.resets', { when: resetsIn(w.resetsAt, locale) })}</span>
    </div>
  );
}

function Popover({ onClose }: { onClose: () => void }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The pill and the edition chip toggle the popover themselves.
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.usage-pill, .chip.edition') && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div className="usage-pop" ref={box} role="dialog" aria-label={t('usage.title')}>
      <div className="usage-head">
        <b>{t('usage.title')}</b>
        <button className="link" onClick={() => (onClose(), useStore.setState({ settingsOpen: true, settingsSection: 'usage' }))}>
          {t('usage.more')} →
        </button>
      </div>
      <UsageDetails />
    </div>
  );
}

/** Plans, usage windows and limits for each signed-in CLI (also shown in Settings). */
export function UsageDetails() {
  const t = useT();
  const usage = useStore((s) => s.planUsage);
  const loading = useStore((s) => s.planUsageLoading);
  const onRefresh = () => void useStore.getState().loadPlanUsage(true);
  const locale = useStore((s) => s.locale);
  const c = usage?.claude;
  const x = usage?.codex;
  return (
    <>
      {!usage && (
        <section className="usage-sec usage-skeleton" aria-busy="true">
          <div className="usage-acct">
            <i className="sk sk-title" />
          </div>
          {[0, 1, 2].map((k) => (
            <div key={k} className="usage-grid">
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
        </section>
      )}
      {x && (
        <section className="usage-sec">
          <div className="usage-acct">
            <b>◎ Codex</b>
            {x.plan && <span className="usage-plan">{x.plan[0]!.toUpperCase() + x.plan.slice(1)}</span>}
          </div>
          {x.windows.map((w) => (
            <LimitRow key={w.label} label={w.label === 'five_hour' ? t('usage.window5h') : t('usage.windowWeek')} w={{ percent: w.usedPercent, resetsAt: w.resetsAt }} />
          ))}
          <p className="usage-note">{t('usage.asOf', { when: relativeTime(x.asOf, locale) })}</p>
        </section>
      )}
      {usage && !c && !x && <p className="usage-note">{t('usage.none')}</p>}
      <div className="usage-foot">
        <span>{usage ? t('usage.updated', { when: relativeTime(usage.at, locale) }) : ''}</span>
        <button className="btn-ghost small" disabled={loading} onClick={onRefresh}>
          {loading ? <span className="spin" /> : '↻'} {t('usage.refresh')}
        </button>
      </div>
    </>
  );
}

/** Status-bar pills for each signed-in plan; click for the details. */
export function UsageMeter() {
  const t = useT();
  const open = useUsagePopover((s) => s.open);
  const usage = useStore((s) => s.planUsage);
  const load = useStore((s) => s.loadPlanUsage);
  const captureUsage = useStore((s) => s.info?.capture?.usage ?? false);
  useEffect(() => {
    if (captureUsage) useUsagePopover.setState({ open: true });
  }, [captureUsage]);
  useEffect(() => {
    if (captureUsage && usage) useStore.getState().markCaptureReady();
  }, [captureUsage, usage]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  const live = (w: LimitWindow | null | undefined) => (w && w.resetsAt && w.resetsAt > Date.now() ? w.percent : 0);
  const codexPct = usage?.codex ? Math.max(0, ...usage.codex.windows.map((w) => live({ percent: w.usedPercent, resetsAt: w.resetsAt }))) : null;
  const claude = usage?.claude;
  const claudePct = claude?.limits && !claude.limits.error ? Math.max(live(claude.limits.fiveHour), live(claude.limits.sevenDay)) : null;
  return (
    <span className="usage-meter">
      <button className="usage-pill" title={t('usage.title')} onClick={() => useUsagePopover.setState({ open: !open })}>
        {claude && (
          <span className={claude.limit ? 'usage-hit' : claudePct != null ? `usage-codex ${level(claudePct)}` : ''}>
            ✳ {claude.limit ? t('usage.limitShort') : claudePct != null ? `${Math.round(claudePct)}%` : (claude.plan ?? 'Claude')}
          </span>
        )}
        {codexPct != null && (
          <span className={`usage-codex ${level(codexPct)}`}>
            ◎ {Math.round(codexPct)}%
          </span>
        )}
        {!claude && codexPct == null && <span>{t('usage.title')}</span>}
      </button>
      {open && <Popover onClose={() => useUsagePopover.setState({ open: false })} />}
    </span>
  );
}
