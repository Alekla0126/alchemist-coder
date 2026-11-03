import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionConfig, DashboardSyncBinding, DashboardSyncStatus, OrgQueueSnapshot } from '../shared/api';
import { DASHBOARD_INGEST_PATH, DASHBOARD_PROTOCOL, validDashboardAck, validDashboardBatch } from '../shared/dashboard-protocol.ts';
import type { DashboardAgent, DashboardBatch, DashboardJob, DashboardProjection } from '../shared/dashboard-protocol.ts';
import { claimDashboardState, writeDashboardState } from './dashboard-storage.ts';

export interface DashboardSource {
  queue: OrgQueueSnapshot; firstRetainedSequence: number;
  agents: { teamId: string; botId: string; state: DashboardAgent['state']; hasReply: boolean }[];
}
interface Saved {
  version: 1; streamId: string; nextSequence: number; sourceHash: string; sourceSequence: number;
  eventSequence: number; pending: DashboardBatch[]; acknowledged: number | null; lastSyncAt: number | null;
  attempts: number; retryAt: number; failure: DashboardSyncStatus['reason'] | null;
}
export const dashboardDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const dashboardGrantKey = (origin: string, binding: DashboardSyncBinding) => 'dashboard.events-write.' + dashboardDigest([origin,binding.orgRef,binding.projectRef,binding.projectCwd]);
const reasonCodes = new Set(['executor_unavailable','capacity_exhausted','resume_confirmation_required','result_reconciliation_required','predecessor_unresolved','queue_persistence_failed','executor_start_failed','execution_failed','connection_failed','rate_limited','model_unavailable','permission_required','cancelled','lease_expired','execution_timeout','result_verification_failed','fixture_effect_conflict','workflow_not_allowed']);
const initial = (): Saved => ({ version: 1, streamId: randomUUID(), nextSequence: 1, sourceHash: '', sourceSequence: 0, eventSequence: 0, pending: [], acknowledged: null, lastSyncAt: null, attempts: 0, retryAt: 0, failure: null });

/** Egress-only, explicit project opt-in. Queue/agents remain owned by BotManager. */
export class DashboardSync {
  private saved: Saved | null = null;
  private file = '';
  private scope = '';
  private release: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flight: AbortController | null = null;
  private generation = 0;
  private busy = false;
  private closed = false;
  private localError: DashboardSyncStatus['reason'] | null = null;
  private grantPresent = false;
  private confirmed = false;
  private handshake = true;
  constructor(private dir: string, private options: {
    config: () => ConnectionConfig;
    source: (cwd: string) => DashboardSource;
    secrets: { get(key: string): Promise<string | null>; set(key: string, value: string | null): Promise<void> };
    fetch?: typeof fetch; now?: () => number; maxPending?: number; maxBytes?: number;
  }) {}
  private now() { return (this.options.now ?? Date.now)(); }
  start() { this.closed = false; this.timer ??= setInterval(() => void this.pump(), 1000); this.timer.unref(); void this.pump(); }
  close() { this.closed = true; this.generation++; this.flight?.abort(); if (this.timer) clearInterval(this.timer); this.timer = null; this.release?.(); this.release = null; this.saved = null; this.scope = ''; }
  /** Cancels in-flight work before an origin/scope/opt-in change can take effect. */
  refresh() { this.generation++; this.flight?.abort(); this.grantPresent = false; this.confirmed = false; this.handshake = !this.saved?.pending.length; void this.pump(); }
  private select() {
    const c = this.options.config(), b = c.dashboardSync;
    if (!b?.enabled || !c.dashboardUrl) { this.generation++; this.flight?.abort(); this.release?.(); this.release = null; this.saved = null; this.scope = ''; this.localError = null; return null; }
    const scope = dashboardDigest([c.dashboardUrl,b.orgRef,b.projectRef,b.projectCwd]);
    if (scope === this.scope) return { origin: c.dashboardUrl, binding: b };
    this.generation++; this.flight?.abort(); this.release?.(); this.release = null; this.saved = null; this.scope = scope; this.localError = null; this.grantPresent = false; this.confirmed = false; this.handshake = true;
    this.file = join(this.dir, scope + '.json');
    try {
      this.release = claimDashboardState(this.file);
      if (existsSync(this.file)) {
        if (statSync(this.file).size > 16_000_000) throw new Error('Outbox too large');
        const s = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
        if (s.version !== 1 || !Number.isSafeInteger(s.nextSequence) || s.nextSequence < 1 || !Array.isArray(s.pending) || s.pending.length > 100 || !s.pending.every(validDashboardBatch) || s.pending.some((q,i) => q.message.orgRef !== b.orgRef || q.message.projectRef !== b.projectRef || q.message.streamId !== s.streamId || q.digest !== dashboardDigest(q.message) || (i > 0 && q.message.sequence !== s.pending[i-1]!.message.sequence+1)) || (s.pending.length && s.pending.at(-1)!.message.sequence !== s.nextSequence-1) || !(s.acknowledged === null || Number.isSafeInteger(s.acknowledged) && s.acknowledged < s.nextSequence) || !Number.isInteger(s.attempts) || s.attempts < 0 || s.attempts > 5 || !Number.isFinite(s.retryAt) || typeof s.sourceHash !== 'string' || !Number.isSafeInteger(s.sourceSequence) || !Number.isSafeInteger(s.eventSequence) || s.eventSequence < 0) throw new Error('Invalid outbox');
        this.saved = s; this.handshake = s.pending.length === 0;
      } else { this.saved = initial(); this.persist(); }
    } catch { this.localError = 'outbox_unavailable'; this.saved = null; this.release?.(); this.release = null; }
    return { origin: c.dashboardUrl, binding: b };
  }
  private persist() {
    try { if (Buffer.byteLength(JSON.stringify(this.saved)) > 16_000_000) throw new Error('Outbox limit'); writeDashboardState(this.file, this.saved); }
    catch { this.localError = 'outbox_unavailable'; throw new Error('Dashboard outbox could not be saved'); }
  }
  status(): DashboardSyncStatus {
    let c: ConnectionConfig; try { c = this.options.config(); } catch { return { enabled: false, connected: false, reason: 'config_unreadable', pending: null, attempts: 0, lastAcknowledgedSequence: null, lastSyncAt: null }; }
    const enabled = c.dashboardSync?.enabled === true;
    const sameScope = c.dashboardSync && c.dashboardUrl && dashboardDigest([c.dashboardUrl,c.dashboardSync.orgRef,c.dashboardSync.projectRef,c.dashboardSync.projectCwd]) === this.scope;
    const s = sameScope ? this.saved : null;
    const reason = !enabled ? 'sync_disabled' : !c.dashboardUrl ? 'endpoint_required' : this.localError ?? (s?.failure === 'authorization_required' ? s.failure : s?.attempts === 5 && s.pending.length ? 'retry_exhausted' : s?.failure) ?? (!s ? 'sync_pending' : s.pending.length ? 'sync_pending' : s.lastSyncAt === null ? 'sync_pending' : !this.confirmed || this.now()-s.lastSyncAt > 60_000 ? 'sync_stale' : 'synchronized');
    return { enabled, connected: reason === 'synchronized', reason, pending: this.localError ? null : s?.pending.length ?? null, attempts: s?.attempts ?? 0, lastAcknowledgedSequence: s?.acknowledged ?? null, lastSyncAt: s?.lastSyncAt ?? null, grantPresent: this.grantPresent };
  }
  private projection(source: DashboardSource): DashboardProjection {
    const s = this.saved!, opaque = (kind: string, value: string) => dashboardDigest([s.streamId,kind,value]);
    const job = (j: Pick<OrgQueueSnapshot['jobs'][number], 'id' | 'teamId' | 'botId' | 'executorId' | 'state' | 'attempt' | 'verification' | 'blockedReason'>): DashboardJob => ({ taskRef: opaque('task',j.id), teamRef: opaque('team',j.teamId), botRef: opaque('bot',j.teamId+':'+j.botId), executor: j.executorId, state: j.state, attempt: j.attempt, verification: j.verification, reason: j.blockedReason === null ? null : reasonCodes.has(j.blockedReason) ? j.blockedReason : 'execution_failed' });
    const q = source.queue;
    return {
      available: !q.error, sourceSequence: q.error ? null : s.nextSequence,
      historyCoverage: 'partial',
      jobs: q.error ? null : q.jobs.map(job),
      agents: source.agents.map(a => ({ teamRef: opaque('team',a.teamId), botRef: opaque('bot',a.teamId+':'+a.botId), state: a.state, verification: a.hasReply && ['idle','done'].includes(a.state) ? 'reported' : 'not_run' })),
      events: q.error ? [] : q.events.filter(e => e.sequence > s.sourceSequence).map((e,index) => ({ ...job({ ...e, id: e.taskId, blockedReason: e.reason }), eventRef: opaque('event',e.eventId), sourceSequence: s.eventSequence+index+1, type: e.type, occurredAt: e.occurredAt })),
    };
  }
  async pump(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const target = this.select(), s = this.saved;
      if (!target || !s || this.localError) return;
      const generation = this.generation;
      let source: DashboardSource;
      try { source = this.options.source(target.binding.projectCwd); } catch { this.localError = 'project_unavailable'; return; }
      const data = this.projection(source), sourceHash = dashboardDigest({ available: data.available, jobs: data.jobs, agents: data.agents });
      if (this.handshake || sourceHash !== s.sourceHash || data.events.length > 0) {
        if (s.pending.length >= (this.options.maxPending ?? 100)) { s.failure = 'outbox_full'; this.persist(); }
        else {
          const message: DashboardBatch['message'] = { version: DASHBOARD_PROTOCOL, orgRef: target.binding.orgRef, projectRef: target.binding.projectRef, streamId: s.streamId, sequence: s.nextSequence, messageId: randomUUID(), createdAt: this.now(), kind: 'snapshot', data };
          const batch = { message, digest: dashboardDigest(message) };
          if (!validDashboardBatch(batch) || Buffer.byteLength(JSON.stringify(batch)) > 1_000_000) { this.localError = 'projection_invalid'; return; }
          if (Buffer.byteLength(JSON.stringify({ ...s, pending: [...s.pending,batch] })) > Math.min(15_000_000, this.options.maxBytes ?? 15_000_000)) { s.failure = 'outbox_full'; this.persist(); }
          else { s.pending.push(batch); s.nextSequence++; s.eventSequence += data.events.length; s.sourceHash = sourceHash; this.handshake = false; if (!source.queue.error) s.sourceSequence = source.queue.sequence; this.persist(); }
        }
      }
      if (!source.queue.error && !this.handshake && sourceHash === s.sourceHash && data.events.length === 0 && s.sourceSequence !== source.queue.sequence && s.pending.length < (this.options.maxPending ?? 100)) { s.sourceSequence = source.queue.sequence; this.persist(); }
      if (!s.pending.length || (s.failure && !['network_error','server_error','rate_limited','outbox_full'].includes(s.failure)) || s.attempts >= 5 || s.retryAt > this.now()) return;
      const local = ['127.0.0.1','localhost','[::1]'].includes(new URL(target.origin).hostname);
      let token: string | null = null;
      {
        try { token = await this.options.secrets.get(dashboardGrantKey(target.origin,target.binding)); } catch { /* Never expose vault errors. */ }
        if (generation !== this.generation || this.closed) return;
        this.grantPresent = !!token;
        if (!local && !token) { s.failure = 'authorization_required'; this.persist(); return; }
      }
      const batch = s.pending[0]!;
      s.attempts++; s.retryAt = this.now() + Math.min(60_000, 1000 * 2 ** (s.attempts-1)); this.persist();
      const abort = new AbortController(); this.flight = abort; const timeout = setTimeout(() => abort.abort(), 10_000); timeout.unref();
      try {
        const response = await (this.options.fetch ?? fetch)(target.origin + DASHBOARD_INGEST_PATH, { method: 'POST', redirect: 'error', signal: abort.signal, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer '+token } : {}) }, body: JSON.stringify(batch) });
        if (generation !== this.generation || this.closed) return;
        if (response.status === 401 || response.status === 403) s.failure = 'authorization_required';
        else if (response.status === 429) s.failure = 'rate_limited';
        else if (response.status >= 500) s.failure = 'server_error';
        else if (!response.ok) s.failure = 'protocol_error';
        else {
          const raw = await limitedBody(response, 8192);
          if (generation !== this.generation || this.closed) return;
          let ack: unknown = null; try { ack = JSON.parse(raw); } catch { /* A 200 with malformed JSON is not an acknowledgment. */ }
          if (!validDashboardAck(ack, batch)) s.failure = 'invalid_ack';
          else { s.pending.shift(); s.acknowledged = batch.message.sequence; s.lastSyncAt = this.now(); s.attempts = 0; s.retryAt = 0; s.failure = null; this.confirmed = true; }
        }
      } catch { if (generation !== this.generation || this.closed) return; s.failure = 'network_error'; }
      finally { clearTimeout(timeout); if (this.flight === abort) this.flight = null; }
      if (s.attempts >= 5 && ['network_error','server_error','rate_limited'].includes(s.failure ?? '')) s.failure = 'retry_exhausted';
      this.persist();
    } catch { /* status exposes bounded error codes, never URLs, credentials or raw remote bodies. */ }
    finally { this.busy = false; }
  }
  async retry() {
    if (this.busy) throw new Error('Dashboard synchronization is busy');
    if (this.localError) { this.release?.(); this.release = null; this.saved = null; this.scope = ''; this.localError = null; }
    const t = this.select(); if (!t || !this.saved || this.localError) throw new Error('Dashboard outbox is unavailable');
    this.saved.attempts = 0; this.saved.retryAt = 0; this.saved.failure = null; this.confirmed = false; this.handshake = this.saved.pending.length === 0; this.persist(); await this.pump();
  }
  async storeGrant(token: string | null) {
    const c = this.options.config(), b = c.dashboardSync;
    if (!c.dashboardUrl || !b) throw new Error('Save a project and destination before storing its write-only credential');
    if (token !== null && (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{20,4096}$/.test(token))) throw new Error('Invalid writer credential');
    await this.options.secrets.set(dashboardGrantKey(c.dashboardUrl,b), token);
    this.generation++; this.flight?.abort(); this.grantPresent = !!token; this.confirmed = false; this.handshake = !this.saved?.pending.length;
    if (!token && this.saved && dashboardDigest([c.dashboardUrl,b.orgRef,b.projectRef,b.projectCwd]) === this.scope && !['127.0.0.1','localhost','[::1]'].includes(new URL(c.dashboardUrl).hostname)) { this.saved.failure = 'authorization_required'; this.persist(); }
    // A missing/replaced credential requires an explicit retry; no replay or new grant is inferred.
  }
}

async function limitedBody(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Response too large');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > limit) throw new Error('Response too large'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
