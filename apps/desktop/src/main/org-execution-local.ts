import { createHash } from 'node:crypto';
import { OrgQueue } from './org-queue.ts';
import type { OrgJobPayload } from './org-queue.ts';
import { validWorker } from './org-execution-types.ts';
import type { ExecutionAck, ExecutionResult, LeaseAssignment, LeasePolicy, LeaseRef, OrgExecutionBackend, WorkerCapabilities } from './org-execution-types.ts';

export interface OrgWorkflow {
  policy: LeasePolicy;
  /** Trusted, synchronous destination effect; cannot be supplied by a worker or task prompt. */
  perform(assignment: LeaseAssignment): { result: ExecutionResult; created: boolean };
  /** Controller-owned verification; a worker's assertion alone never marks a result verified. */
  verify(assignment: LeaseAssignment, result: ExecutionResult): boolean | Promise<boolean>;
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** One local authority around OrgQueue, with no network listener or new credential/grant. */
export class LocalOrgExecutionBackend implements OrgExecutionBackend {
  readonly queue: OrgQueue;
  private workers = new Map<string, WorkerCapabilities>();
  private closed = false;
  constructor(file: string, private workflows: ReadonlyMap<string, OrgWorkflow>, now = Date.now) {
    this.queue = new OrgQueue(file, () => { throw new Error('Workflow jobs must be claimed, never sent to a model'); }, now);
    this.queue.start();
    if (this.queue.snapshot().error) { this.queue.close(); throw new Error('queue_unavailable'); }
  }
  enqueue(input: { id: string; payload: OrgJobPayload; executorId?: 'local' | 'vps'; maxParallel: number; maxAttempts: number; resumePreauthorized: boolean }, workflowId: string) {
    this.open();
    const workflow = this.workflows.get(workflowId);
    if (!workflow || workflow.policy.workflowId !== workflowId) throw new Error('workflow_not_allowed');
    return this.queue.enqueue({ ...input, execution: workflow.policy });
  }
  register(worker: WorkerCapabilities) {
    this.open();
    if (!validWorker(worker) || worker.workflows.some(id => !this.workflows.has(id))) throw new Error('invalid_worker');
    const prior = this.workers.get(worker.workerId);
    if (prior && digest(prior) !== digest(worker)) throw new Error('worker_identity_conflict');
    this.workers.set(worker.workerId,structuredClone(worker));
  }
  private open() { if (this.closed) throw new Error('queue_unavailable'); }
  private worker(id: string) { this.open(); const worker = this.workers.get(id); if (!worker) throw new Error('worker_unregistered'); return worker; }
  async claim(workerId: string) { return this.queue.claim(this.worker(workerId)); }
  async heartbeat(ref: LeaseRef) { this.worker(ref.workerId); return this.queue.heartbeat(ref); }
  async perform(ref: LeaseRef) {
    const worker = this.worker(ref.workerId), a = this.queue.assignment(ref);
    if (!worker.workflows.includes(a.policy.workflowId) || worker.executorId !== this.queue.snapshot().jobs.find(j => j.id === ref.taskId)?.executorId) throw new Error('workflow_not_allowed');
    const workflow = this.workflows.get(a.policy.workflowId);
    if (!workflow) throw new Error('workflow_not_allowed');
    // No await between the fence and this local publish: cancel and reclaim cannot interleave.
    return workflow.perform(a);
  }
  async submit(ref: LeaseRef, result: ExecutionResult): Promise<ExecutionAck> {
    const worker = this.worker(ref.workerId), prior = this.queue.resultReceipt(ref,result);
    if (prior) return prior;
    const assignment = this.queue.assignment(ref);
    if (assignment.payload.teamId === '' || !worker.workflows.includes(assignment.policy.workflowId) || worker.executorId !== this.queue.snapshot().jobs.find(j => j.id === ref.taskId)?.executorId) throw new Error('workflow_not_allowed');
    const verifier = this.workflows.get(assignment.policy.workflowId);
    if (!verifier || !await verifier.verify(assignment,result)) throw new Error('result_verification_failed');
    // Cancellation, lease expiry and fencing are checked again after an asynchronous verifier.
    return this.queue.submitResult(ref,result,'verified');
  }
  async disposition(ref: LeaseRef) { this.worker(ref.workerId); return this.queue.leaseDisposition(ref); }
  async fail(ref: LeaseRef, code: string) { this.worker(ref.workerId); this.queue.failLease(ref,code); }
  async cancel(taskId: string) { this.open(); if (this.queue.snapshot().error) throw new Error('queue_unavailable'); this.queue.cancel(taskId); }
  close() { if (this.closed) return; this.closed = true; this.queue.close(); this.workers.clear(); }
}
