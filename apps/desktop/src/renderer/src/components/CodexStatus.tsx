import { useState } from 'react';
import type { AgentChoice } from '@shared/api';
import { useStore, useT } from '../store';
import { errorText } from './Bots';
import { toast } from '../ui';

/** Account and quota are reported by the same runtime that supplies the model catalog. */
export function CodexStatus({ agent }: { agent: AgentChoice }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const provider = useStore((s) => s.catalog?.providers.find((p) => p.id === agent.providerId));
  const runtime = provider?.codexRuntime;
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try { useStore.setState({ catalog: await window.alchemist.runnerCatalog() }); }
    catch (e) { toast(errorText(e)); }
    finally { setBusy(false); }
  };
  if (agent.providerId !== 'openai') return null;
  return <section className="org-codex-status" aria-label={t('org.codex.title')}>
    <header><b>{t('org.codex.title')}</b><button className="btn-ghost small" disabled={busy} onClick={() => void refresh()}>{busy ? '…' : t('run.refresh')}</button></header>
    <p role="status">{runtime?.connected ? t('org.codex.connected') : t('org.codex.unavailable')}{runtime?.account ? ` · ${[runtime.account.email ?? runtime.account.type, runtime.account.plan].filter(Boolean).join(' · ')}` : ` · ${t('org.codex.accountUnknown')}`}</p>
    {(!provider?.available || runtime?.error || runtime?.accountError) && <p className="picker-warn">{runtime?.error ?? runtime?.accountError ?? provider?.detail ?? t('org.codex.unavailable')}</p>}
    {runtime?.limits?.length ? <ul>{runtime.limits.map((w, i) => <li key={i}>
      {w.label} · {t('org.codex.used', { percent: w.usedPercent })}{w.windowMinutes !== null && ` · ${t('org.codex.window', { minutes: w.windowMinutes })}`}{w.resetsAt !== null && ` · ${t('usage.resets', { when: new Date(w.resetsAt).toLocaleString(locale) })}`}
    </li>)}</ul> : <p className="composer-note">{t('org.codex.quotaUnknown')}</p>}
    {runtime?.checkedAt && <small>{t('usage.updated', { when: new Date(runtime.checkedAt).toLocaleString(locale) })}</small>}
    <p className="composer-note">{t('org.codex.hint')}</p>
  </section>;
}
