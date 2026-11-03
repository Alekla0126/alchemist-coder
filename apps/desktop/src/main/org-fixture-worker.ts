/** Local synthetic file workflow only. Never spawns a CLI, evaluates a prompt or calls a model/API. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimDashboardState, writeDashboardState } from './dashboard-storage.ts';
import type { OrgWorkflow } from './org-execution-local.ts';
import { validExecutionResult, validLeaseRef } from './org-execution-types.ts';
import type { ExecutionResult, LeaseAssignment, LeaseRef, OrgExecutionBackend } from './org-execution-types.ts';

export const FIXTURE_WORKFLOW = 'ac.fixture.output.v1';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const errorCode = (e: unknown) => e instanceof Error ? e.message : 'execution_failed';
interface Pending { ref: LeaseRef; result: ExecutionResult }

/** The artifact itself is an atomic idempotency receipt for this one local effect. */
export class FixtureEffects {
  readonly root: string;
  constructor(root: string) { mkdirSync(root,{recursive:true,mode:0o700}); this.root = realpathSync(root); }
  private expected(a: LeaseAssignment) {
    if (a.policy.workflowId !== FIXTURE_WORKFLOW || realpathSync(a.payload.cwd) !== this.root || a.payload.prompt.length > 4096) throw new Error('workflow_not_allowed');
    const artifactRef = digest([FIXTURE_WORKFLOW,a.ref.taskId]);
    const record = { version: 1, taskId: a.ref.taskId, fingerprint: a.fingerprint, output: a.payload.prompt };
    return { file: join(this.root,artifactRef+'.json'), record, result: { artifactRef, outputDigest: digest(record) } };
  }
  private read(file: string): unknown {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('fixture_effect_conflict');
    return JSON.parse(readFileSync(file,'utf8')) as unknown;
  }
  publish(a: LeaseAssignment): { result: ExecutionResult; created: boolean } {
    const expected = this.expected(a);
    let created = false;
    if (!existsSync(expected.file)) {
      const temp = expected.file+'.'+randomUUID()+'.tmp';
      try {
        const fd = openSync(temp,'wx',0o600);
        try { writeFileSync(fd,JSON.stringify(expected.record)); fsyncSync(fd); } finally { closeSync(fd); }
        try { linkSync(temp,expected.file); created = true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        if (process.platform !== 'win32') { const dir = openSync(this.root,'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      } finally { rmSync(temp,{force:true}); }
    }
    if (digest(this.read(expected.file)) !== expected.result.outputDigest) throw new Error('fixture_effect_conflict');
    return { result: expected.result, created };
  }
  verify(a: LeaseAssignment, result: ExecutionResult): boolean {
    try { const expected = this.expected(a); return digest(result) === digest(expected.result) && digest(this.read(expected.file)) === result.outputDigest; }
    catch { return false; }
  }
}
export function fixtureWorkflow(effects: FixtureEffects): OrgWorkflow {
  return { policy: { workflowId: FIXTURE_WORKFLOW, recovery: 'idempotent', leaseMs: 3000, maxRuntimeMs: 60_000 }, perform: a => effects.publish(a), verify: (a,r) => effects.verify(a,r) };
}

export class FixtureWorker {
  private pending: Pending[] = [];
  private release: () => void;
  private busy = false;
  private closed = false;
  private signal: AbortController | null = null;
  publishedEffects = 0;
  constructor(private backend: OrgExecutionBackend, private effects: FixtureEffects, private file: string, private workerId: string, private hooks: {
    beforeEffect?: (a: LeaseAssignment) => Promise<void>;
    afterEffect?: (a: LeaseAssignment) => Promise<void>;
  } = {}) {
    this.release = claimDashboardState(file);
    try {
      if (existsSync(file)) {
        if (lstatSync(file).size > 128_000) throw new Error('worker_outbox_unavailable');
        const v = JSON.parse(readFileSync(file,'utf8')) as { version?: number; pending?: Pending[] };
        if (v.version !== 1 || !Array.isArray(v.pending) || v.pending.length > 16 || v.pending.some(p => !validLeaseRef(p.ref) || p.ref.workerId !== workerId || !validExecutionResult(p.result))) throw new Error('worker_outbox_unavailable');
        this.pending = v.pending;
      }
      backend.register({ workerId, executorId:'local', workflows:[FIXTURE_WORKFLOW], maxParallel:1 });
    } catch (e) { this.release(); throw e; }
  }
  private persist() {
    if (this.closed) throw new Error('worker_closed');
    writeDashboardState(this.file,{version:1,pending:this.pending});
  }
  pendingResults() { return this.pending.length; }
  private async flushPending() {
    for (const p of [...this.pending]) {
      if (this.closed) return;
      let remove = false;
      try { await this.backend.submit(p.ref,p.result); remove = true; }
      catch (e) {
        if (!['stale_lease','result_conflict'].includes(errorCode(e))) continue;
        const state = await this.backend.disposition(p.ref);
        remove = state.replayAllowed || ['completed','cancelled'].includes(state.state);
      }
      if (remove && !this.closed) { this.pending = this.pending.filter(x => x !== p); this.persist(); }
    }
  }
  async step(): Promise<'idle' | 'completed' | 'ack_pending' | 'blocked' | 'closed'> {
    if (this.closed) return 'closed';
    if (this.busy) return 'blocked';
    this.busy = true;
    let timer: NodeJS.Timeout | undefined;
    let assignment: LeaseAssignment | null = null;
    try {
      await this.flushPending();
      if (this.closed) return 'closed';
      if (this.pending.length >= 16) return 'blocked';
      assignment = await this.backend.claim(this.workerId);
      if (this.closed) return 'closed';
      if (!assignment) return this.pending.length ? 'ack_pending' : 'idle';
      const a = assignment, abort = new AbortController(); this.signal = abort;
      let renewing = false;
      timer = setInterval(() => {
        if (renewing || this.closed) return;
        renewing = true;
        void this.backend.heartbeat(a.ref).catch(() => abort.abort()).finally(() => { renewing = false; });
      }, Math.max(100,Math.floor(a.policy.leaseMs/3))); timer.unref();
      await this.hooks.beforeEffect?.(a);
      if (abort.signal.aborted || this.closed) return 'blocked';
      await this.backend.heartbeat(a.ref);
      if (abort.signal.aborted || this.closed) return 'blocked';
      const output = await this.backend.perform(a.ref);
      // perform may have committed its idempotent effect before close released our outbox lock.
      // Recovery uses that artifact; a former owner must never persist over its replacement.
      if (abort.signal.aborted || this.closed) return 'ack_pending';
      if (!this.effects.verify(a,output.result)) throw new Error('result_verification_failed');
      if (output.created) this.publishedEffects++;
      this.pending.push({ref:a.ref,result:output.result}); this.persist();
      await this.hooks.afterEffect?.(a);
      if (abort.signal.aborted || this.closed) return 'ack_pending';
      try {
        await this.backend.submit(a.ref,output.result);
        if (!this.closed) { this.pending = this.pending.filter(p => p.ref.leaseId !== a.ref.leaseId); this.persist(); }
        return 'completed';
      } catch { return 'ack_pending'; }
    } catch (e) {
      if (assignment && !this.closed && !this.pending.some(p => p.ref.leaseId === assignment!.ref.leaseId)) {
        await this.backend.fail(assignment.ref, ['fixture_effect_conflict','workflow_not_allowed'].includes(errorCode(e)) ? errorCode(e) : 'execution_failed').catch(() => {});
      }
      return 'blocked';
    } finally { if (timer) clearInterval(timer); this.signal = null; this.busy = false; }
  }
  close() { if (this.closed) return; this.closed = true; this.signal?.abort(); this.release(); }
}
