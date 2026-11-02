import { useEffect, useRef, useState } from 'react';
import type { ConnectionConfig, ConnectionState } from '@shared/api';
import { useT } from '../store';
import { errorText } from './Bots';

/** Endpoint preferences and actual local readiness; this panel never opens a remote session. */
export function RuntimeConnectionsCard() {
  const t = useT(), mounted = useRef(false);
  const request = useRef(0);
  const [state, setState] = useState<ConnectionState | null>(null);
  const [draft, setDraft] = useState<ConnectionConfig | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const load = async (discard = false) => {
    const id = ++request.current, keepDraft = !discard && !!draft && !!state && JSON.stringify(draft) !== JSON.stringify(state.config);
    setBusy(true);
    try { const next = await window.alchemist.runtimeConnections(); if (mounted.current && id === request.current) {
      if (keepDraft && next.revision !== state?.revision) { setConflict(true); setError(t('connections.conflict')); return; }
      setState(next); if (!keepDraft) setDraft(next.config); setConflict(false); setError('');
    } }
    catch (e) { if (mounted.current && id === request.current) setError(errorText(e)); }
    finally { if (mounted.current && id === request.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, []);
  const save = async () => {
    if (!draft || !state?.revision || conflict) return;
    const id = ++request.current;
    setBusy(true); setError('');
    try { const next = await window.alchemist.saveRuntimeConnections(draft, state.revision); if (mounted.current && id === request.current) { setState(next); setDraft(next.config); } }
    catch (e) { if (mounted.current && id === request.current) setError(errorText(e)); }
    finally { if (mounted.current && id === request.current) setBusy(false); }
  };
  return <div>
    <p className="composer-note">{t('connections.hint')}</p>
    {!!error && <p role="alert">{error}</p>}
    {state?.error && <p role="alert">{t('connections.config_unreadable')}</p>}
    <div className="set-row"><div><b>{t('connections.dashboard')}</b><p>{state ? t(`connections.${state.dashboard.reason}`) : t('connections.unknown')}</p></div><span>{t('connections.notConnected')}</span></div>
    <label className="bot-field"><span>{t('connections.dashboardUrl')}</span><input type="url" value={draft?.dashboardUrl ?? ''} disabled={busy || !draft} placeholder="https://dashboard.example" onChange={e => draft && setDraft({ ...draft, dashboardUrl: e.target.value || null })} /></label>
    <div className="set-row"><div><b>VPS</b><p>{state ? t(`connections.${state.vps.reason}`) : t('connections.unknown')}</p></div><span>{t('connections.notConnected')}</span></div>
    <label className="bot-field"><span>{t('connections.vpsUrl')}</span><input type="url" value={draft?.vpsUrl ?? ''} disabled={busy || !draft} placeholder="https://vps.example" onChange={e => draft && setDraft({ ...draft, vpsUrl: e.target.value || null })} /></label>
    <label className="bot-check"><input type="checkbox" checked={draft?.vpsCapacity === 'exhausted'} disabled={busy || !draft} onChange={e => draft && setDraft({ ...draft, vpsCapacity: e.target.checked ? 'exhausted' : 'unknown' })} /><span>{t('connections.capacityFlag')}</span></label>
    <p className="composer-note">{t('connections.capacityHint')}</p>
    <div className="set-row"><div><b>{t('connections.outbox')}</b><p>{state?.outbox.error ? state.outbox.error : state ? `${state.outbox.retainedEvents ?? '—'} · ${t('connections.sequence')}: ${state.outbox.sequence ?? '—'}` : t('connections.unknown')}</p></div><span>ac.integration.v1</span></div>
    <div className="set-row"><b>{t('connections.lastSync')}</b><span>{t('connections.unknown')}</span></div>
    <p className="composer-note">{t('connections.noAck')}</p>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}><button className="btn-ghost small" disabled={busy || conflict || !draft || !state?.revision || JSON.stringify(draft) === JSON.stringify(state.config)} onClick={() => void save()}>{t('bots.save')}</button><button className="btn-ghost small" disabled={busy} onClick={() => void load()}>{t('connections.refresh')}</button>{conflict && <button className="btn-ghost small" disabled={busy} onClick={() => void load(true)}>{t('connections.discardRefresh')}</button>}</div>
  </div>;
}
