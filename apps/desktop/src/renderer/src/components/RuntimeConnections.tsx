import { useEffect, useRef, useState } from 'react';
import type { ConnectionConfig, ConnectionState } from '@shared/api';
import { useStore, useT } from '../store';
import { errorText } from './Bots';

/** Explicit project opt-in for status-only egress. No remote execution controls. */
export function RuntimeConnectionsCard() {
  const t = useT(), mounted = useRef(false);
  const request = useRef(0);
  const inFlight = useRef(false);
  const [state, setState] = useState<ConnectionState | null>(null);
  const [draft, setDraft] = useState<ConnectionConfig | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [credential, setCredential] = useState('');
  const projects = useStore(s => s.projects);
  const load = async (discard = false, owned = false) => {
    if (inFlight.current && !owned) return;
    if (!owned) inFlight.current = true;
    const id = ++request.current, keepDraft = !discard && !!draft && !!state && JSON.stringify(draft) !== JSON.stringify(state.config);
    setBusy(true);
    try { const next = await window.alchemist.runtimeConnections(); if (mounted.current && id === request.current) {
      if (keepDraft && next.revision !== state?.revision) { setConflict(true); setError(t('connections.conflict')); return; }
      setState(next); if (!keepDraft) setDraft(next.config); setConflict(false); setError('');
    } }
    catch (e) { if (mounted.current && id === request.current) setError(errorText(e)); }
    finally { if (!owned) inFlight.current = false; if (mounted.current && id === request.current) setBusy(false); }
  };
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { mounted.current = true; void load(); const timer = setInterval(() => void loadRef.current(), 5000); return () => { mounted.current = false; request.current++; clearInterval(timer); }; }, []);
  const save = async () => {
    if (inFlight.current || !draft || !state?.revision || conflict) return;
    inFlight.current = true;
    const id = ++request.current;
    setBusy(true); setError('');
    try { const next = await window.alchemist.saveRuntimeConnections(draft, state.revision); if (mounted.current && id === request.current) { setState(next); setDraft(next.config); setCredential(''); } }
    catch (e) { if (mounted.current && id === request.current) setError(errorText(e)); }
    finally { inFlight.current = false; if (mounted.current && id === request.current) setBusy(false); }
  };
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(state?.config);
  const action = async (fn: () => Promise<unknown>) => { if (inFlight.current || busy || dirty || conflict) return; inFlight.current = true; setBusy(true); setError(''); try { await fn(); setCredential(''); await load(false,true); } catch(e) { if (mounted.current) setError(errorText(e)); } finally { inFlight.current = false; if (mounted.current) setBusy(false); } };
  const syncReason = state?.sync?.reason;
  const syncLabel = !syncReason ? null : syncReason === 'sync_disabled' ? 'connections.syncOff' : syncReason === 'synchronized' ? 'connections.syncOk' : syncReason === 'sync_stale' ? 'connections.syncStale' : syncReason === 'authorization_required' ? 'connections.syncAuth' : syncReason === 'sync_pending' ? 'connections.syncPending' : syncReason === 'retry_exhausted' ? 'connections.syncExhausted' : ['network_error','server_error','rate_limited'].includes(syncReason) ? 'connections.syncRetrying' : 'connections.syncError';
  return <div className="runtime-connections">
    <p className="composer-note">{t('connections.hint')}</p>
    {!!error && <p role="alert">{error}</p>}
    {state?.error && <p role="alert">{t('connections.config_unreadable')}</p>}
    <div className="set-row"><div><b>{t('connections.dashboard')}</b><p>{syncLabel ? t(syncLabel) : state ? t(`connections.${state.dashboard.reason}` as 'connections.endpoint_required') : t('connections.unknown')}</p></div><span>{state?.dashboard.connected ? t('connections.syncOk') : t('connections.notConnected')}</span></div>
    <label className="bot-field"><span>{t('connections.dashboardUrl')}</span><input type="url" value={draft?.dashboardUrl ?? ''} disabled={busy || !draft} placeholder="https://dashboard.example" onChange={e => draft && setDraft({ ...draft, dashboardUrl: e.target.value || null })} /></label>
    <fieldset className="runtime-sync-scope" disabled={busy || !draft}>
      <legend>{t('connections.syncScope')}</legend>
      <p className="composer-note">{t('connections.syncHint')}</p>
      <label className="bot-check"><input type="checkbox" checked={!!draft?.dashboardSync} onChange={e => draft && setDraft({ ...draft, ...(e.target.checked ? { dashboardSync: { enabled: false, orgRef: 'my-org', projectRef: 'my-project', projectCwd: projects[0]?.cwd ?? '' } } : { dashboardSync: undefined }) })} /><span>{t('connections.syncSetup')}</span></label>
      {draft?.dashboardSync && <>
        <label className="bot-field"><span>{t('org.project')}</span><select value={draft.dashboardSync.projectCwd} onChange={e => setDraft({ ...draft, dashboardSync: { ...draft.dashboardSync!, projectCwd: e.target.value } })}><option value="">{t('org.project')}</option>{projects.map(p => <option key={p.id} value={p.cwd}>{p.name}</option>)}</select></label>
        <label className="bot-field"><span>{t('connections.orgRef')}</span><input value={draft.dashboardSync.orgRef} onChange={e => setDraft({ ...draft, dashboardSync: { ...draft.dashboardSync!, orgRef: e.target.value } })} /></label>
        <label className="bot-field"><span>{t('connections.projectRef')}</span><input value={draft.dashboardSync.projectRef} onChange={e => setDraft({ ...draft, dashboardSync: { ...draft.dashboardSync!, projectRef: e.target.value } })} /></label>
        <label className="bot-check"><input type="checkbox" checked={draft.dashboardSync.enabled} onChange={e => setDraft({ ...draft, dashboardSync: { ...draft.dashboardSync!, enabled: e.target.checked } })} /><span>{t('connections.syncEnable')}</span></label>
      </>}
    </fieldset>
    <div className="set-row"><div><b>VPS</b><p>{state ? t(`connections.${state.vps.reason}`) : t('connections.unknown')}</p></div><span>{t('connections.notConnected')}</span></div>
    <label className="bot-field"><span>{t('connections.vpsUrl')}</span><input type="url" value={draft?.vpsUrl ?? ''} disabled={busy || !draft} placeholder="https://vps.example" onChange={e => draft && setDraft({ ...draft, vpsUrl: e.target.value || null })} /></label>
    <label className="bot-check"><input type="checkbox" checked={draft?.vpsCapacity === 'exhausted'} disabled={busy || !draft} onChange={e => draft && setDraft({ ...draft, vpsCapacity: e.target.checked ? 'exhausted' : 'unknown' })} /><span>{t('connections.capacityFlag')}</span></label>
    <p className="composer-note">{t('connections.capacityHint')}</p>
    <div className="set-row"><div><b>{t('connections.outbox')}</b><p>{state?.outbox.error ? state.outbox.error : state ? `${state.outbox.retainedEvents ?? '—'} · ${t('connections.sequence')}: ${state.outbox.sequence ?? '—'}` : t('connections.unknown')}</p></div><span>ac.integration.v1</span></div>
    {state?.sync && <div className="set-row"><b>{t('connections.syncPending')}</b><span>{state.sync.pending ?? '—'} · {t('org.queue.attempts')}: {state.sync.attempts}/5</span></div>}
    <div className="set-row"><b>{t('connections.lastSync')}</b><span>{state?.dashboard.lastSyncAt ? new Date(state.dashboard.lastSyncAt).toLocaleString() + ' · ' + t('connections.sequence') + ': ' + state.dashboard.lastAcknowledgedSequence : t('connections.unknown')}</span></div>
    {!state?.dashboard.lastSyncAt && <p className="composer-note">{t('connections.noAck')}</p>}
    {state?.config?.dashboardSync && <>
      <p className="composer-note">{t('connections.grantHint')}</p>
      <label className="bot-field"><span>{t('connections.grant')}</span><input type="password" autoComplete="off" value={credential} disabled={busy || dirty || conflict} onChange={e => setCredential(e.target.value)} /></label>
      <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}><button className="btn-ghost small" disabled={busy || dirty || conflict || !credential || !state.revision} onClick={() => void action(() => window.alchemist.storeDashboardGrant(credential,state.revision!))}>{t('connections.storeGrant')}</button><button className="btn-ghost small" disabled={busy || dirty || conflict || !state.revision} onClick={() => void action(() => window.alchemist.storeDashboardGrant(null,state.revision!))}>{t('connections.removeGrant')}</button><button className="btn-ghost small" disabled={busy || dirty || conflict || !state.sync?.enabled} onClick={() => void action(() => window.alchemist.retryDashboardSync())}>{t('connections.syncRetry')}</button></div>
    </>}
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}><button className="btn-ghost small" disabled={busy || conflict || !draft || !state?.revision || JSON.stringify(draft) === JSON.stringify(state.config)} onClick={() => void save()}>{t('bots.save')}</button><button className="btn-ghost small" disabled={busy} onClick={() => void load()}>{t('connections.refresh')}</button>{conflict && <button className="btn-ghost small" disabled={busy} onClick={() => void load(true)}>{t('connections.discardRefresh')}</button>}</div>
  </div>;
}
