import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { DASHBOARD_INGEST_PATH, DASHBOARD_PROTOCOL, dashboardRef, validDashboardBatch } from '../shared/dashboard-protocol.ts';
import type { DashboardAck, DashboardBatch, DashboardProjection } from '../shared/dashboard-protocol.ts';
import { claimDashboardState, writeDashboardState } from './dashboard-storage.ts';

export interface DashboardReceiverGrant { tokenHash: string; orgRef: string; projectRef: string; scope: 'events:write' | 'projection:read'; expiresAt: number }
interface Stream { sequence: number; receipts: { messageId: string; digest: string; sequence: number }[]; projection: DashboardProjection }
interface Inbox { version: 1; streams: Record<string, { orgRef: string; projectRef: string; streamId: string; state: Stream }> }
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export class DashboardReceiveError extends Error { status: number; code: string; constructor(status: number, code: string) { super(code); this.status=status; this.code=code; } }

/** Reference Dashboard adapter: transactional inbox + dedup + projection. No agent or OS commands. */
export class DashboardReceiver {
  private state: Inbox = { version: 1, streams: {} };
  private release: () => void;
  private file: string;
  private grants: DashboardReceiverGrant[];
  private localDevelopment: boolean;
  private maxStreams: number;
  constructor(file: string, grants: DashboardReceiverGrant[], localDevelopment = false, maxStreams = 4) {
    this.file=file; this.grants=grants; this.localDevelopment=localDevelopment; this.maxStreams=Math.min(4,Math.max(1,Math.floor(maxStreams)));
    if (!Number.isFinite(this.maxStreams)) throw new Error('Invalid stream limit');
    if (!Array.isArray(grants) || grants.length > 64 || grants.some(g => !Number.isSafeInteger(g.expiresAt) || g.expiresAt < 1 || !/^[a-f0-9]{64}$/.test(g.tokenHash) || !dashboardRef(g.orgRef) || !dashboardRef(g.projectRef) || !['events:write','projection:read'].includes(g.scope))) throw new Error('Invalid scoped grants');
    this.release = claimDashboardState(file);
    try {
      if (existsSync(file)) {
        if (statSync(file).size > 8_000_000) throw new Error('Inbox too large');
        const s = JSON.parse(readFileSync(file, 'utf8')) as Inbox;
        if (s.version !== 1 || Object.keys(s).length !== 2 || !s.streams || typeof s.streams !== 'object' || Array.isArray(s.streams) || Object.keys(s.streams).length > this.maxStreams) throw new Error('Invalid inbox');
        for (const [key,v] of Object.entries(s.streams)) {
          if (!v || Object.keys(v).length !== 4 || !dashboardRef(v.orgRef) || !dashboardRef(v.projectRef) || !dashboardRef(v.streamId) || key !== sha(JSON.stringify([v.orgRef,v.projectRef,v.streamId])) || !v.state || Object.keys(v.state).length !== 3 || !Number.isSafeInteger(v.state.sequence) || v.state.sequence < 1 || !Array.isArray(v.state.receipts) || v.state.receipts.length < 1 || v.state.receipts.length > 128 || v.state.receipts.some((r,i) => !r || Object.keys(r).length !== 3 || !dashboardRef(r.messageId) || !/^[a-f0-9]{64}$/.test(r.digest) || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || r.sequence > v.state.sequence || (i > 0 && r.sequence !== v.state.receipts[i-1]!.sequence+1)) || v.state.receipts.at(-1)!.sequence !== v.state.sequence || !validDashboardBatch({message:{version:DASHBOARD_PROTOCOL,orgRef:v.orgRef,projectRef:v.projectRef,streamId:v.streamId,sequence:v.state.sequence,messageId:'validation',createdAt:0,kind:'snapshot',data:v.state.projection},digest:'0'.repeat(64)})) throw new Error('Invalid inbox');
        }
        this.state = s;
      }
    } catch (e) { this.release(); throw e; }
  }
  close() { this.release(); }
  private authorized(token: string | null, orgRef: string, projectRef: string, scope: DashboardReceiverGrant['scope']) {
    if (this.localDevelopment && !token && scope === 'events:write') return true;
    if (!token || token.length > 4096) return false;
    const hash = Buffer.from(sha(token), 'hex');
    return this.grants.some(g => g.orgRef === orgRef && g.projectRef === projectRef && g.scope === scope && g.expiresAt > Date.now() && timingSafeEqual(hash, Buffer.from(g.tokenHash,'hex')));
  }
  accept(value: unknown, token: string | null): DashboardAck {
    if (!validDashboardBatch(value)) throw new DashboardReceiveError(400, 'invalid_projection');
    const { message: m, digest } = value;
    if (!this.authorized(token,m.orgRef,m.projectRef,'events:write')) throw new DashboardReceiveError(403, 'scope_denied');
    if (sha(JSON.stringify(m)) !== digest) throw new DashboardReceiveError(400, 'digest_mismatch');
    const key = sha(JSON.stringify([m.orgRef,m.projectRef,m.streamId]));
    const previous = this.state.streams[key]?.state;
    const receipt = previous?.receipts.find(r => r.messageId === m.messageId || r.sequence === m.sequence);
    const ack: DashboardAck = { version: DASHBOARD_PROTOCOL, orgRef: m.orgRef, projectRef: m.projectRef, streamId: m.streamId, sequence: m.sequence, messageId: m.messageId, digest };
    if (receipt) {
      if (receipt.messageId !== m.messageId || receipt.digest !== digest || receipt.sequence !== m.sequence) throw new DashboardReceiveError(409, 'idempotency_conflict');
      return ack;
    }
    if (m.sequence !== (previous?.sequence ?? 0)+1) throw new DashboardReceiveError(409, 'sequence_conflict');
    if (!previous && Object.keys(this.state.streams).length >= this.maxStreams) throw new DashboardReceiveError(409, 'stream_capacity');
    const next = structuredClone(this.state);
    next.streams[key] = { orgRef: m.orgRef, projectRef: m.projectRef, streamId: m.streamId, state: { sequence: m.sequence, receipts: [...(previous?.receipts ?? []), { messageId: m.messageId, digest, sequence: m.sequence }].slice(-128), projection: structuredClone(m.data) } };
    // Commit before acknowledging. Failed persistence does not advance the in-memory cursor.
    try { writeDashboardState(this.file,next); } catch { throw new DashboardReceiveError(503, 'inbox_persistence_failed'); }
    this.state = next;
    return ack;
  }
  read(orgRef: string, projectRef: string, token: string | null) {
    if (!dashboardRef(orgRef) || !dashboardRef(projectRef)) throw new DashboardReceiveError(400,'invalid_scope');
    if (!this.authorized(token,orgRef,projectRef,'projection:read')) throw new DashboardReceiveError(403,'scope_denied');
    return { version: DASHBOARD_PROTOCOL, orgRef, projectRef, streams: Object.values(this.state.streams).filter(v => v.orgRef === orgRef && v.projectRef === projectRef).map(v => ({ streamId: v.streamId, sequence: v.state.sequence, data: structuredClone(v.state.projection) })) };
  }
}

/** Standalone reference adapter binds loopback only. Production needs an approved TLS/auth deployment. */
export function dashboardReceiverServer(receiver: DashboardReceiver, maxBatchBytes = 1_000_000) {
  if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1024 || maxBatchBytes > 1_000_000) throw new Error('Invalid request bound');
  const server = createServer(async (req,res) => {
    res.setHeader('content-type','application/json'); res.setHeader('cache-control','no-store');
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    try {
      if (req.headers.origin) throw new DashboardReceiveError(403,'browser_origin_denied');
      if (req.method === 'POST' && req.url === DASHBOARD_INGEST_PATH) {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new DashboardReceiveError(415,'json_required');
        const body = await requestBody(req,maxBatchBytes);
        let value: unknown; try { value = JSON.parse(body); } catch { throw new DashboardReceiveError(400,'invalid_json'); }
        res.end(JSON.stringify(receiver.accept(value,token)));
      } else {
        const match = /^\/api\/coder-sync\/v1\/projects\/([A-Za-z0-9_-]{1,96})\/([A-Za-z0-9_-]{1,96})$/.exec(req.url ?? '');
        if (req.method !== 'GET' || !match) throw new DashboardReceiveError(404,'route_not_found');
        res.end(JSON.stringify(receiver.read(match[1]!,match[2]!,token)));
      }
    } catch (e) {
      res.statusCode = e instanceof DashboardReceiveError ? e.status : 500;
      res.end(JSON.stringify({ error: e instanceof DashboardReceiveError ? e.code : 'receiver_failed' }));
    }
  });
  server.maxConnections = 4; server.maxRequestsPerSocket = 100; server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  return server;
}
async function requestBody(req: IncomingMessage, maxBytes: number) {
  if (Number(req.headers['content-length']) > maxBytes) throw new DashboardReceiveError(413,'batch_too_large');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk); length += b.length; if (length > maxBytes) throw new DashboardReceiveError(413,'batch_too_large'); chunks.push(b); }
  return Buffer.concat(chunks).toString('utf8');
}
