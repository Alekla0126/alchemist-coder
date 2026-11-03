import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { OrgJob, OrgJobEvent, OrgQueueSnapshot } from '../shared/api';
import { claimDashboardState, writeDashboardState } from './dashboard-storage.ts';
import { executionResultDigest, validExecutionRecord, validExecutionResult, validLeasePolicy, validLeaseRef, validWorker } from './org-execution-types.ts';
import type { ExecutionAck, ExecutionRecord, ExecutionResult, LeaseAssignment, LeaseDisposition, LeasePolicy, LeaseRef, WorkerCapabilities } from './org-execution-types.ts';

export interface OrgJobPayload { teamId: string; botId: string; prompt: string; cwd: string; kind: 'start' | 'send'; resumeSessionId?: string }
interface StoredJob extends OrgJob { payload: OrgJobPayload; fingerprint: string; resumePreauthorized: boolean; retryAt: number; checkpoint: { sessionId?: string } | null; retrySafe?: boolean; coordinationWait?: boolean; resumeRequested?: boolean; execution?: ExecutionRecord }
interface Saved { version: 1; sequence: number; jobs: StoredJob[]; events: OrgJobEvent[] }
const TERMINAL = new Set(['completed', 'cancelled']);
const ACTIVE = new Set(['running', 'waiting']);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Durable scheduling around BotManager, never a second coordinator or model provider. */
export class OrgQueue {
  private state: Saved = { version: 1, sequence: 0, jobs: [], events: [] };
  private error: OrgQueueSnapshot['error'];
  private enabled = false;
  private pumping = false;
  private closed = false;
  private online = new Set(['local']);
  private unavailableReasons = new Map<string, 'executor_unavailable' | 'capacity_exhausted'>();
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(snapshot: OrgQueueSnapshot) => void>();
  private release: (() => void) | null = null;
  constructor(private file: string, private execute: (job: OrgJob, payload: OrgJobPayload) => void, private now = Date.now) {
    // Every writer, including a legacy BotManager, participates in the same ownership lock.
    try { this.release = claimDashboardState(file); }
    catch { this.error = 'queue_persistence_failed'; this.closed = true; return; }
    if (existsSync(file)) {
      try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Saved;
      if (saved.version !== 1 || !Number.isInteger(saved.sequence) || !Array.isArray(saved.jobs) || !Array.isArray(saved.events) || saved.jobs.some(j => !j || typeof j.id !== 'string' || !/^[\w:-]{1,160}$/.test(j.id) || !j.payload || typeof j.payload.prompt !== 'string' || typeof j.payload.cwd !== 'string' || !['start','send'].includes(j.payload.kind) || !Number.isInteger(j.attempt) || !Number.isInteger(j.maxAttempts) || !['queued','running','waiting','blocked','interrupted','completed','failed','cancelled'].includes(j.state))) throw new Error('Unsupported organization queue file');
      this.state = saved;
      for (const job of this.state.jobs) {
        if (job.execution) {
          const e = job.execution;
          if (!validExecutionRecord(e) || e.generation !== job.attempt
            || Boolean(e.lease) !== ACTIVE.has(job.state)
            || Boolean(e.receipt) !== (job.state === 'completed')
            || (job.state !== 'completed' && job.verification !== 'not_run')
            || e.lease && e.lease.taskId !== job.id
            || e.receipt && (e.receipt.ack.taskId !== job.id || e.receipt.ref.taskId !== job.id || job.verification !== e.receipt.ack.verification)) throw new Error('Invalid execution checkpoint');
        }
        if (ACTIVE.has(job.state) && !job.execution?.lease) { job.state = 'interrupted'; job.blockedReason = 'resume_confirmation_required'; }
        else if (['queued','blocked'].includes(job.state) && !job.resumePreauthorized) { job.state = 'blocked'; job.blockedReason = 'resume_confirmation_required'; }
      }
      } catch { this.error = 'queue_unreadable'; this.closed = true; }
    }
  }
  watch(fn: (snapshot: OrgQueueSnapshot) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  snapshot(): OrgQueueSnapshot {
    const jobs = this.state.jobs.map(j => ({ id: j.id, teamId: j.teamId, botId: j.botId, executorId: j.executorId, state: j.state, attempt: j.attempt, maxAttempts: j.maxAttempts, maxParallel: j.maxParallel, verification: j.verification, blockedReason: j.blockedReason, createdAt: j.createdAt, updatedAt: j.updatedAt, canResume: this.resumable(j) }));
    const events = this.state.events.map(e => ({ version: e.version, eventId: e.eventId, sequence: e.sequence, type: e.type, occurredAt: e.occurredAt, taskId: e.taskId, teamId: e.teamId, botId: e.botId, executorId: e.executorId, state: e.state, attempt: e.attempt, verification: e.verification, reason: e.reason }));
    return { version: 'ac.integration.v1', ...(this.error ? { error: this.error } : {}), sequence: this.state.sequence, jobs, events };
  }
  private persist() {
    if (!this.release) throw new Error('queue_unavailable');
    writeDashboardState(this.file, this.state);
  }
  private changed(job: StoredJob, type: OrgJobEvent['type']) {
    job.updatedAt = this.now();
    this.state.events.push({ version: 'ac.integration.v1', eventId: randomUUID(), sequence: ++this.state.sequence, type, occurredAt: job.updatedAt, taskId: job.id, teamId: job.teamId, botId: job.botId, executorId: job.executorId, state: job.state, attempt: job.attempt, verification: job.verification, reason: job.blockedReason });
    this.state.events = this.state.events.slice(-1000);
    try { this.persist(); } catch { this.error = 'queue_persistence_failed'; this.enabled = false; this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; return false; }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    return true;
  }
  private resumable(j: StoredJob) { return j.attempt < j.maxAttempts && ((j.state === 'blocked' && j.attempt === 0 && j.blockedReason !== 'predecessor_unresolved') || (j.state === 'failed' && j.retrySafe === true)); }
  start() { if (this.error || !this.release) return; this.closed = false; this.enabled = true; try { this.persist(); } catch { this.error = 'queue_persistence_failed'; this.closed = true; this.enabled = false; return; } this.timer ??= setInterval(() => this.pump(), 1000); this.timer.unref(); this.pump(); }
  ensureStarted() { if (!this.enabled && !this.closed) this.start(); }
  close() { if (this.closed && !this.enabled) { this.release?.(); this.release = null; return; } this.closed = true; this.enabled = false; if (this.timer) clearInterval(this.timer); this.timer = null; try { if (!this.error) this.persist(); } catch { this.error = 'queue_persistence_failed'; } this.release?.(); this.release = null; for (const fn of this.listeners) fn(this.snapshot()); }
  enqueue(input: { id: string; payload: OrgJobPayload; executorId?: 'local' | 'vps'; maxParallel: number; maxAttempts: number; resumePreauthorized: boolean; execution?: LeasePolicy }): OrgJob {
    if (this.error) throw new Error('The organization queue is unavailable; review its checkpoint before continuing');
    this.requireOwner();
    if (!/^[\w:-]{1,160}$/.test(input.id)) throw new Error('Invalid organization job id');
    if (input.execution && (!validLeasePolicy(input.execution) || !/^[A-Za-z0-9][\w:-]{0,159}$/.test(input.id) || !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 5 || !Number.isInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > 8 || typeof input.resumePreauthorized !== 'boolean')) throw new Error('Invalid leased execution request');
    const fingerprint = digest(input.execution ? { payload: input.payload, execution: input.execution } : input.payload);
    const previous = this.state.jobs.find(j => j.id === input.id);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('Organization job idempotency conflict'); return this.snapshot().jobs.find(j => j.id === previous.id)!; }
    if (this.state.jobs.filter(j => !TERMINAL.has(j.state)).length >= 100) throw new Error('The organization queue holds at most 100 unfinished jobs');
    const job: StoredJob = { id: input.id, teamId: input.payload.teamId, botId: input.payload.botId, executorId: input.executorId ?? 'local', state: 'queued', attempt: 0, maxAttempts: Math.min(5, Math.max(1, Math.floor(input.maxAttempts))), maxParallel: Math.min(8, Math.max(1, Math.floor(input.maxParallel))), resumePreauthorized: input.resumePreauthorized, verification: 'not_run', blockedReason: null, createdAt: this.now(), updatedAt: this.now(), retryAt: 0, checkpoint: null, payload: structuredClone(input.payload), fingerprint };
    if (input.execution) job.execution = { policy: structuredClone(input.execution), generation: 0, deadlineAt: null, lease: null, receipt: null };
    const retained = new Set(this.state.jobs.filter(j => TERMINAL.has(j.state)).slice(-500).map(j => j.id));
    this.state.jobs = this.state.jobs.filter(j => !TERMINAL.has(j.state) || retained.has(j.id));
    this.state.jobs.push(job); if (!this.changed(job, 'org.job.queued')) throw new Error('The organization queue could not be saved; no job was started'); this.pump();
    return this.snapshot().jobs.find(j => j.id === job.id)!;
  }
  setExecutorAvailable(id: 'local' | 'vps', available: boolean, reason: 'executor_unavailable' | 'capacity_exhausted' = 'executor_unavailable') {
    this.requireOwner();
    if (available) this.online.add(id); else { this.online.delete(id); this.unavailableReasons.set(id, reason); }
    for (const j of this.state.jobs) if (j.executorId === id && j.state === 'blocked' && ['executor_unavailable','capacity_exhausted'].includes(j.blockedReason ?? '') && available) { j.state = 'queued'; j.blockedReason = null; this.changed(j, 'org.job.queued'); }
    this.pump();
  }
  pump() {
    if (!this.enabled || this.closed || this.pumping) return;
    this.pumping = true;
    try {
      this.expireLeases();
      const holdsSlot = (j: StoredJob) => j.state === 'running' || (j.state === 'waiting' && !j.coordinationWait);
      const room = (j: StoredJob) => { const active = this.state.jobs.filter(holdsSlot); return active.length < 8 && active.filter(x => x.teamId === j.teamId).length < j.maxParallel; };
      // A coordinator reacquires capacity before its MCP wait returns to the model.
      for (const job of this.state.jobs) if (job.state === 'waiting' && job.coordinationWait && job.resumeRequested && room(job)) { job.state = 'running'; job.coordinationWait = false; job.resumeRequested = false; this.changed(job, 'org.job.started'); }
      for (const [index, job] of this.state.jobs.entries()) {
        const predecessor = this.state.jobs.slice(0, index).some(j => j.teamId === job.teamId && j.botId === job.botId && !TERMINAL.has(j.state));
        if (job.state === 'blocked' && job.blockedReason === 'predecessor_unresolved' && !predecessor) { job.state = 'queued'; job.blockedReason = null; this.changed(job, 'org.job.queued'); }
        if (job.state !== 'queued' || job.retryAt > this.now()) continue;
        if (predecessor) { job.state = 'blocked'; job.blockedReason = 'predecessor_unresolved'; this.changed(job, 'org.job.blocked'); continue; }
        if (!this.online.has(job.executorId)) { job.state = 'blocked'; job.blockedReason = this.unavailableReasons.get(job.executorId) ?? 'executor_unavailable'; this.changed(job, 'org.job.blocked'); continue; }
        if (this.state.jobs.some(j => ACTIVE.has(j.state) && j.teamId === job.teamId && j.botId === job.botId)) continue;
        if (!room(job)) continue;
        // Lease workers pull only explicitly bound workflows. Existing BotManager jobs keep their dispatcher.
        if (job.execution) continue;
        job.state = 'running'; job.attempt++; job.blockedReason = null; if (!this.changed(job, 'org.job.started')) { job.state = 'blocked'; job.blockedReason = 'queue_persistence_failed'; return; }
        try { this.execute(this.snapshot().jobs.find(j => j.id === job.id)!, { ...job.payload, ...(job.checkpoint?.sessionId ? { resumeSessionId: job.checkpoint.sessionId } : {}) }); }
        catch { this.fail(job.id, 'executor_start_failed', false); }
      }
    } finally { this.pumping = false; }
  }
  conversationCheckpoint(teamId: string, botId: string): string | undefined { return [...this.state.jobs].reverse().find(j => j.teamId === teamId && j.botId === botId && j.checkpoint?.sessionId)?.checkpoint?.sessionId; }
  checkpoint(id: string, sessionId: string) { this.requireOwner(); const j = this.job(id); if (!j || TERMINAL.has(j.state)) return; j.checkpoint = { sessionId }; this.changed(j, 'org.job.checkpointed'); }
  waiting(id: string, waiting: boolean, coordination = false) { this.requireOwner(); const j = this.job(id); if (!j || !ACTIVE.has(j.state)) return; j.state = waiting ? 'waiting' : 'running'; j.coordinationWait = waiting && coordination; this.changed(j, waiting ? 'org.job.waiting' : 'org.job.started'); this.pump(); }
  resumeCoordinator(id: string): Promise<void> {
    const j = this.job(id); if (this.closed || !j || j.state !== 'waiting' || !j.coordinationWait) return Promise.resolve();
    j.resumeRequested = true;
    return new Promise(resolve => {
      const off = this.watch(() => { if (j.state !== 'waiting' || this.closed) { off(); resolve(); } });
      this.pump();
    });
  }
  interrupt(id: string, reason = 'result_reconciliation_required') { this.requireOwner(); const j = this.job(id); if (!j || !ACTIVE.has(j.state)) return; if (j.execution) j.execution.lease = null; j.state = 'interrupted'; j.blockedReason = reason; this.changed(j, 'org.job.interrupted'); }
  complete(id: string, verification: OrgJob['verification'] = 'reported') { this.requireOwner(); const j = this.job(id); if (j?.execution) throw new Error('Leased jobs require a fenced result receipt'); if (!j || !ACTIVE.has(j.state) || this.closed) return; j.state = 'completed'; j.verification = verification; this.changed(j, 'org.job.completed'); }
  fail(id: string, code: string, retryable = false) {
    this.requireOwner();
    const j = this.job(id); if (!j || !ACTIVE.has(j.state) || this.closed) return;
    if (j.execution) j.execution.lease = null;
    j.retrySafe = retryable;
    j.state = retryable && j.resumePreauthorized && j.attempt < j.maxAttempts ? 'queued' : 'failed';
    // Codes only: raw CLI output, prompts and secrets never enter Dashboard events.
    j.blockedReason = /^[a-z_]{1,80}$/.test(code) ? code : 'execution_failed';
    j.retryAt = j.state === 'queued' ? this.now() + Math.min(60_000, 1000 * 2 ** Math.max(0, j.attempt - 1)) : 0;
    this.changed(j, j.state === 'queued' ? 'org.job.retry_scheduled' : 'org.job.failed'); this.pump();
  }
  resume(id: string) {
    this.requireOwner();
    const j = this.job(id); if (!j || !this.resumable(j)) throw new Error('This job requires result reconciliation or a reviewed new follow-up before retrying');
    if (j.attempt >= j.maxAttempts) throw new Error('The job reached its attempt limit');
    j.state = 'queued'; j.retryAt = 0; j.blockedReason = null; this.changed(j, 'org.job.queued'); this.pump();
  }
  cancel(id: string) { this.requireOwner(); const j = this.job(id); if (!j || TERMINAL.has(j.state)) return; if (j.execution) j.execution.lease = null; j.state = 'cancelled'; j.blockedReason = null; this.changed(j, 'org.job.cancelled'); }

  private requireOwner() { if (!this.release || this.closed || this.error) throw new Error('queue_unavailable'); }
  private available() { this.requireOwner(); if (!this.enabled) throw new Error('queue_unavailable'); }
  private expireLeases() {
    for (const job of this.state.jobs) {
      const e = job.execution;
      if (!e?.lease || !ACTIVE.has(job.state) || e.lease.expiresAt > this.now()) continue;
      e.lease = null;
      const timedOut = e.deadlineAt !== null && e.deadlineAt <= this.now();
      const replay = !timedOut && e.policy.recovery === 'idempotent' && job.resumePreauthorized && job.attempt < job.maxAttempts;
      job.state = replay ? 'queued' : 'interrupted';
      job.blockedReason = timedOut ? 'execution_timeout' : replay ? 'lease_expired' : 'result_reconciliation_required';
      if (!this.changed(job, replay ? 'org.job.retry_scheduled' : 'org.job.interrupted')) return;
    }
  }
  claim(worker: WorkerCapabilities): LeaseAssignment | null {
    this.available();
    if (!validWorker(worker)) throw new Error('invalid_worker');
    this.pump(); this.available();
    const active = this.state.jobs.filter(j => ACTIVE.has(j.state));
    if (active.length >= 8 || active.filter(j => j.execution?.lease?.workerId === worker.workerId).length >= worker.maxParallel) return null;
    for (const [index, job] of this.state.jobs.entries()) {
      const e = job.execution;
      if (!e || job.state !== 'queued' || job.retryAt > this.now() || job.executorId !== worker.executorId || !this.online.has(job.executorId) || !worker.workflows.includes(e.policy.workflowId)) continue;
      if (job.attempt >= job.maxAttempts || active.filter(j => j.teamId === job.teamId).length >= job.maxParallel || this.state.jobs.slice(0,index).some(j => j.teamId === job.teamId && j.botId === job.botId && !TERMINAL.has(j.state))) continue;
      e.deadlineAt ??= this.now() + e.policy.maxRuntimeMs;
      if (e.deadlineAt <= this.now()) { job.state = 'interrupted'; job.blockedReason = 'execution_timeout'; this.changed(job,'org.job.interrupted'); continue; }
      const ref: LeaseRef = { taskId: job.id, workerId: worker.workerId, generation: ++e.generation, leaseId: randomUUID() };
      e.lease = { ...ref, expiresAt: Math.min(this.now()+e.policy.leaseMs,e.deadlineAt) };
      job.state = 'running'; job.attempt++; job.blockedReason = null;
      if (!this.changed(job,'org.job.started')) throw new Error('queue_unavailable');
      return { ref, expiresAt: e.lease.expiresAt, deadlineAt: e.deadlineAt, policy: structuredClone(e.policy), fingerprint: job.fingerprint, payload: structuredClone(job.payload) };
    }
    return null;
  }
  private owned(ref: LeaseRef): StoredJob & { execution: ExecutionRecord } {
    this.available(); this.expireLeases(); this.available();
    const j = validLeaseRef(ref) ? this.job(ref.taskId) : undefined, e = j?.execution, lease = e?.lease;
    if (!j || !e || !lease || !ACTIVE.has(j.state) || lease.leaseId !== ref.leaseId || lease.generation !== ref.generation || lease.workerId !== ref.workerId) throw new Error('stale_lease');
    return j as StoredJob & { execution: ExecutionRecord };
  }
  heartbeat(ref: LeaseRef): { expiresAt: number } {
    const j = this.owned(ref), e = j.execution;
    e.lease!.expiresAt = Math.min(this.now()+e.policy.leaseMs,e.deadlineAt!);
    if (!this.changed(j,'org.job.checkpointed')) throw new Error('queue_unavailable');
    return { expiresAt: e.lease!.expiresAt };
  }
  assignment(ref: LeaseRef): LeaseAssignment {
    const j = this.owned(ref), e = j.execution;
    return { ref: structuredClone(ref), expiresAt: e.lease!.expiresAt, deadlineAt: e.deadlineAt!, policy: structuredClone(e.policy), fingerprint: j.fingerprint, payload: structuredClone(j.payload) };
  }
  resultReceipt(ref: LeaseRef, result: ExecutionResult): ExecutionAck | null {
    this.available();
    if (!validLeaseRef(ref) || !validExecutionResult(result)) throw new Error('invalid_result');
    const prior = this.job(ref.taskId)?.execution?.receipt;
    if (!prior) return null;
    if (prior.ref.taskId !== ref.taskId || prior.ref.workerId !== ref.workerId || prior.ref.generation !== ref.generation || prior.ref.leaseId !== ref.leaseId || prior.ack.resultDigest !== executionResultDigest(result)) throw new Error('result_conflict');
    return structuredClone(prior.ack);
  }
  submitResult(ref: LeaseRef, result: ExecutionResult, verification: 'reported' | 'verified'): ExecutionAck {
    this.available();
    if (!validLeaseRef(ref) || !validExecutionResult(result)) throw new Error('invalid_result');
    if (!['reported','verified'].includes(verification)) throw new Error('invalid_verification');
    const prior = this.resultReceipt(ref,result), resultDigest = executionResultDigest(result);
    if (prior) return prior;
    const j = this.owned(ref);
    const ack: ExecutionAck = { version: 'ac.execution.v1', receiptId: randomUUID(), taskId: j.id, resultDigest, generation: ref.generation, verification, committedAt: this.now() };
    j.execution.receipt = { ref: structuredClone(ref), result: structuredClone(result), ack };
    j.execution.lease = null; j.state = 'completed'; j.verification = verification; j.blockedReason = null;
    if (!this.changed(j,'org.job.completed')) throw new Error('queue_unavailable');
    return structuredClone(ack);
  }
  failLease(ref: LeaseRef, code: string) { const j = this.owned(ref); j.execution.lease = null; this.fail(j.id,code,false); }
  leaseDisposition(ref: LeaseRef): LeaseDisposition {
    this.available(); this.expireLeases(); this.available(); const j = this.job(ref.taskId);
    return { state: j?.state ?? 'unknown', replayAllowed: !!j?.execution && j.state === 'queued' && j.execution.policy.recovery === 'idempotent' && j.resumePreauthorized };
  }
  private job(id: string) { return this.state.jobs.find(j => j.id === id); }
}
