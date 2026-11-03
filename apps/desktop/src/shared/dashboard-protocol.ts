/** Public, content-free projection contract. Does not expose a command/execution API. */
export const DASHBOARD_PROTOCOL = 'ac.dashboard.v1' as const;
export const DASHBOARD_INGEST_PATH = '/api/coder-sync/v1/batches';
export type DashboardJobState = 'queued' | 'running' | 'waiting' | 'blocked' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
export interface DashboardJob {
  taskRef: string; teamRef: string; botRef: string; executor: 'local' | 'vps';
  state: DashboardJobState; attempt: number; verification: 'not_run' | 'reported' | 'verified'; reason: string | null;
}
export interface DashboardAgent {
  teamRef: string; botRef: string; state: 'starting' | 'working' | 'waiting' | 'idle' | 'done' | 'stopped' | 'error';
  verification: 'not_run' | 'reported';
}
export interface DashboardEvent extends DashboardJob { eventRef: string; sourceSequence: number; type: string; occurredAt: number }
export interface DashboardProjection {
  available: boolean; sourceSequence: number | null; historyCoverage: 'partial';
  jobs: DashboardJob[] | null; agents: DashboardAgent[]; events: DashboardEvent[];
}
export interface ProjectProjection { version: 'ac.dashboard.v1'; orgRef: string; projectRef: string; streams: { streamId: string; sequence: number; data: DashboardProjection }[] }
/** Shared by Dashboard and MCP, so a reader never forwards fields the public contract rejects. */
export function validProjectProjection(value: unknown): value is ProjectProjection {
  if (!object(value) || !exact(value,['version','orgRef','projectRef','streams'])) return false;
  const v = value as unknown as ProjectProjection;
  return v.version === DASHBOARD_PROTOCOL && dashboardRef(v.orgRef) && dashboardRef(v.projectRef) && Array.isArray(v.streams) && v.streams.length <= 4 && v.streams.every(s => object(s) && exact(s,['streamId','sequence','data']) && validDashboardBatch({message:{version:DASHBOARD_PROTOCOL,orgRef:v.orgRef,projectRef:v.projectRef,streamId:s.streamId,sequence:s.sequence,messageId:'read-validation',createdAt:0,kind:'snapshot',data:s.data},digest:'0'.repeat(64)}));
}
export interface DashboardMessage {
  version: typeof DASHBOARD_PROTOCOL; orgRef: string; projectRef: string; streamId: string;
  sequence: number; messageId: string; createdAt: number; kind: 'snapshot'; data: DashboardProjection;
}
export interface DashboardBatch { message: DashboardMessage; digest: string }
export interface DashboardAck {
  version: typeof DASHBOARD_PROTOCOL; orgRef: string; projectRef: string; streamId: string;
  sequence: number; messageId: string; digest: string;
}
export const dashboardRef = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(v);
const opaque = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const states = ['queued','running','waiting','blocked','interrupted','completed','failed','cancelled'];
function job(v: unknown): boolean {
  return object(v) && exact(v, ['taskRef','teamRef','botRef','executor','state','attempt','verification','reason']) && jobFields(v);
}
function jobFields(v: Record<string, unknown>): boolean {
  return opaque(v.taskRef) && opaque(v.teamRef) && opaque(v.botRef) && typeof v.executor === 'string' && ['local','vps'].includes(v.executor) && typeof v.state === 'string' && states.includes(v.state) && integer(v.attempt, 0, 5) && typeof v.verification === 'string' && ['not_run','reported','verified'].includes(v.verification) && (v.reason === null || typeof v.reason === 'string' && /^[a-z_]{1,80}$/.test(v.reason));
}
/** Strict allowlist; reject extra private fields instead of forwarding them. */
export function validDashboardBatch(v: unknown): v is DashboardBatch {
  if (!object(v) || !exact(v, ['message','digest']) || !opaque(v.digest) || !object(v.message)) return false;
  const m = v.message;
  if (!exact(m, ['version','orgRef','projectRef','streamId','sequence','messageId','createdAt','kind','data']) || m.version !== DASHBOARD_PROTOCOL || !dashboardRef(m.orgRef) || !dashboardRef(m.projectRef) || !dashboardRef(m.streamId) || !dashboardRef(m.messageId) || !integer(m.sequence, 1) || !integer(m.createdAt, 0) || m.kind !== 'snapshot' || !object(m.data)) return false;
  const d = m.data;
  if (!exact(d, ['available','sourceSequence','historyCoverage','jobs','agents','events']) || typeof d.available !== 'boolean' || d.historyCoverage !== 'partial' || !(d.sourceSequence === null || integer(d.sourceSequence, 0)) || !Array.isArray(d.agents) || d.agents.length > 2000 || !Array.isArray(d.events) || d.events.length > 1000) return false;
  if (d.available ? !Array.isArray(d.jobs) || d.jobs.length > 601 || !d.jobs.every(job) || d.sourceSequence === null : d.jobs !== null || d.sourceSequence !== null || d.events.length !== 0) return false;
  if (!d.agents.every(a => object(a) && exact(a,['teamRef','botRef','state','verification']) && opaque(a.teamRef) && opaque(a.botRef) && typeof a.state === 'string' && ['starting','working','waiting','idle','done','stopped','error'].includes(a.state) && typeof a.verification === 'string' && ['not_run','reported'].includes(a.verification))) return false;
  return d.events.every(e => object(e) && exact(e,['taskRef','teamRef','botRef','executor','state','attempt','verification','reason','eventRef','sourceSequence','type','occurredAt']) && jobFields(e) && opaque(e.eventRef) && integer(e.sourceSequence,1) && integer(e.occurredAt,0) && typeof e.type === 'string' && /^org\.job\.(queued|started|waiting|blocked|interrupted|checkpointed|completed|failed|retry_scheduled|cancelled)$/.test(e.type));
}
export function validDashboardAck(v: unknown, batch: DashboardBatch): v is DashboardAck {
  if (!object(v) || !exact(v, ['version','orgRef','projectRef','streamId','sequence','messageId','digest'])) return false;
  return v.version === DASHBOARD_PROTOCOL && ['orgRef','projectRef','streamId','sequence','messageId'].every(k => v[k] === batch.message[k as keyof DashboardMessage]) && v.digest === batch.digest;
}
