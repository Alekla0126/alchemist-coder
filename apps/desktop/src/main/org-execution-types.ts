import type { OrgJob } from '../shared/api';
import type { OrgJobPayload } from './org-queue';
import { createHash } from 'node:crypto';

/** Internal executor port, not an authenticated remote API. No lease token enters Dashboard data. */
export interface LeasePolicy {
  workflowId: string;
  recovery: 'reconcile' | 'idempotent';
  leaseMs: number;
  maxRuntimeMs: number;
}
export interface WorkerCapabilities {
  workerId: string;
  executorId: 'local' | 'vps';
  workflows: string[];
  maxParallel: number;
}
export interface LeaseRef { taskId: string; workerId: string; generation: number; leaseId: string }
export interface LeaseAssignment {
  ref: LeaseRef; expiresAt: number; deadlineAt: number; policy: LeasePolicy;
  fingerprint: string; payload: OrgJobPayload;
}
export interface ExecutionResult { artifactRef: string; outputDigest: string }
export const executionResultDigest = (r: ExecutionResult) => createHash('sha256').update(JSON.stringify([r.artifactRef,r.outputDigest])).digest('hex');
export interface ExecutionAck {
  version: 'ac.execution.v1'; receiptId: string; taskId: string; resultDigest: string;
  generation: number; verification: 'reported' | 'verified'; committedAt: number;
}
export interface ExecutionRecord {
  policy: LeasePolicy; generation: number; deadlineAt: number | null;
  lease: (LeaseRef & { expiresAt: number }) | null;
  receipt: { ref: LeaseRef; result: ExecutionResult; ack: ExecutionAck } | null;
}
export interface LeaseDisposition { state: OrgJob['state'] | 'unknown'; replayAllowed: boolean }

/** A future GCP implementation must provide transactional fencing and server time for this port.
 * The local adapter serializes one queue owner; it does not claim distributed/cloud durability.
 */
export interface OrgExecutionBackend {
  register(worker: WorkerCapabilities): void;
  claim(workerId: string): Promise<LeaseAssignment | null>;
  heartbeat(ref: LeaseRef): Promise<{ expiresAt: number }>;
  /** Local adapter: fenced check + synchronous registered effect, one authority turn.
   * A remote implementation needs destination-side fencing/idempotency; a lease alone is insufficient.
   */
  perform(ref: LeaseRef): Promise<{ result: ExecutionResult; created: boolean }>;
  submit(ref: LeaseRef, result: ExecutionResult): Promise<ExecutionAck>;
  disposition(ref: LeaseRef): Promise<LeaseDisposition>;
  fail(ref: LeaseRef, code: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
}

const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][\w:.-]{0,159}$/.test(v);
const int = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
export const digestValue = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validLeasePolicy(v: unknown): v is LeasePolicy {
  if (!v || typeof v !== 'object') return false;
  const p = v as LeasePolicy;
  return id(p.workflowId) && ['reconcile','idempotent'].includes(p.recovery) && int(p.leaseMs,1000,60_000) && int(p.maxRuntimeMs,p.leaseMs,3_600_000);
}
export function validWorker(v: WorkerCapabilities): boolean {
  return id(v.workerId) && ['local','vps'].includes(v.executorId) && Array.isArray(v.workflows) && v.workflows.length > 0 && v.workflows.length <= 32 && v.workflows.every(id) && int(v.maxParallel,1,8);
}
export function validLeaseRef(v: unknown): v is LeaseRef {
  if (!v || typeof v !== 'object') return false;
  const r = v as LeaseRef;
  return id(r.taskId) && id(r.workerId) && id(r.leaseId) && int(r.generation,1);
}
export function validExecutionResult(v: unknown): v is ExecutionResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as ExecutionResult;
  return Object.keys(r).length === 2 && digestValue(r.artifactRef) && digestValue(r.outputDigest);
}
export function validExecutionRecord(v: ExecutionRecord): boolean {
  return !!v && validLeasePolicy(v.policy) && int(v.generation,0) && (v.deadlineAt === null || int(v.deadlineAt,0))
    && (v.lease === null || validLeaseRef(v.lease) && int(v.lease.expiresAt,0) && v.lease.generation === v.generation && v.deadlineAt !== null && v.lease.expiresAt <= v.deadlineAt)
    && (v.receipt === null || validLeaseRef(v.receipt.ref) && validExecutionResult(v.receipt.result) && !!v.receipt.ack && v.receipt.ack.version === 'ac.execution.v1' && id(v.receipt.ack.receiptId) && v.receipt.ack.resultDigest === executionResultDigest(v.receipt.result) && v.receipt.ack.generation === v.receipt.ref.generation && v.generation === v.receipt.ref.generation && v.receipt.ack.taskId === v.receipt.ref.taskId && v.lease === null && int(v.receipt.ack.committedAt,0) && ['reported','verified'].includes(v.receipt.ack.verification));
}
