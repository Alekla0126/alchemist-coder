import { useEffect, useState } from 'react';
import type { AgentChoice, OrgExecutionPolicy, OrgQueueSnapshot } from '@shared/api';
import { useStore, useT } from '../store';
import { confirmAction, toast } from '../ui';
import { errorText } from './Bots';

const empty: OrgQueueSnapshot = { version: 'ac.integration.v1', sequence: 0, jobs: [], events: [] };
/** The existing organization remains the dispatcher. This panel only controls its durable scheduling. */
export function OrgExecution({ cwd, agent }: { cwd: string; agent: AgentChoice }) {
  const t = useT();
  const policy = useStore(s => s.orgExecutionDraft);
  const set = (value: OrgExecutionPolicy | null) => useStore.setState({ orgExecutionDraft: value, orgRequestId: null });
  const [snapshot, setSnapshot] = useState<OrgQueueSnapshot>(empty);
  const [busy, setBusy] = useState(false);
  const teams = useStore(s => s.botTeams);
  const load = async () => { const next = await window.alchemist.orgQueue(); if (next?.jobs) setSnapshot(next); };
  useEffect(() => { let active = true; const refresh = () => window.alchemist.orgQueue().then(next => { if (active && next?.jobs) setSnapshot(next); }).catch(() => {}); void refresh(); const timer = setInterval(refresh, 2000); return () => { active = false; clearInterval(timer); }; }, []);
  const jobs = snapshot.jobs.filter(j => teams.some(team => team.id === j.teamId && team.cwd === cwd)).slice(-30);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await load(); } catch(e) { toast(errorText(e)); } finally { setBusy(false); } };
  const importTemplate = async () => {
    try {
      const preview = await window.alchemist.portableOrg(cwd, agent, false);
      if (!await confirmAction({ title: t('org.queue.import'), message: `${t('org.queue.importHint')}\n\n${preview.names.join(', ')}`, confirmLabel: t('bots.save'), cancelLabel: t('dialog.cancel') })) return;
      await act(() => window.alchemist.portableOrg(cwd, agent, true));
      await useStore.getState().loadBots();
    } catch(e) { toast(errorText(e)); }
  };
  return <details className="org-execution"><summary>{t('org.queue.title')}</summary>
    <label className="bot-check"><input type="checkbox" checked={!!policy} onChange={e => set(e.target.checked ? { maxParallel: 3, maxAttempts: 2, resumePreauthorized: false, executorId: 'local' } : null)} /><span>{t('org.queue.enable')}</span></label>
    {policy && <div className="org-execution-options">
      <label>{t('org.queue.parallel')} <input type="number" min={1} max={8} value={policy.maxParallel} onChange={e => set({ ...policy, maxParallel: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })} /></label>
      <label>{t('org.queue.attempts')} <input type="number" min={1} max={5} value={policy.maxAttempts} onChange={e => set({ ...policy, maxAttempts: Math.min(5, Math.max(1, Number(e.target.value) || 1)) })} /></label>
      <label className="bot-check"><input type="checkbox" checked={policy.resumePreauthorized} onChange={e => set({ ...policy, resumePreauthorized: e.target.checked })} /><span>{t('org.queue.preauthorize')}</span></label>
    </div>}
    <p className="composer-note">{t('org.queue.hint')}</p>
    <button className="btn-ghost small" disabled={!cwd || busy} onClick={() => void importTemplate()}>{t('org.queue.import')}</button>
    {snapshot.error && <p role="alert">{t('org.codex.unavailable')} · {snapshot.error}</p>}
    {!!jobs.length && <ul>{jobs.map(job => <li key={job.id}><span>{teams.find(team => team.id === job.teamId)?.bots.find(bot => bot.id === job.botId)?.name ?? job.botId} · {t(`org.queue.state.${job.state}`)} · {job.executorId} · {job.attempt}/{job.maxAttempts}</span>
      {job.blockedReason && <small>{job.blockedReason}</small>}
      <button className="btn-ghost small" onClick={() => useStore.setState({ activeTeamId: job.teamId, activeBotId: job.botId, activeMemberId: null, orgPage: 'work' })}>{t('org.chat.title')}</button>
      {job.canResume === true && <button className="btn-ghost small" disabled={busy || job.attempt >= job.maxAttempts} onClick={() => void act(() => window.alchemist.resumeOrgJob(job.id))}>{t('org.queue.resume')}</button>}
      {!['completed','cancelled'].includes(job.state) && <button className="btn-ghost small" disabled={busy} onClick={() => void act(() => window.alchemist.cancelOrgJob(job.id))}>{t('org.queue.cancel')}</button>}
    </li>)}</ul>}
  </details>;
}
