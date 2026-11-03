import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConnectionConfig, ConnectionState, DashboardSyncStatus, OrgQueueSnapshot } from '../shared/api';
import { dashboardRef } from '../shared/dashboard-protocol.ts';
import { isAbsolute } from 'node:path';

const defaults = (): ConnectionConfig => ({ dashboardUrl: null, vpsUrl: null, vpsCapacity: 'unknown' });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Metadata only. Saving an endpoint never opens a connection, grants access or sends events. */
function endpoint(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 500 || /[\x00-\x20\x7f]/.test(value.trim())) throw new Error('Invalid endpoint URL');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Invalid endpoint URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) throw new Error('Use HTTPS, or HTTP on loopback for local development');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use an origin URL without credentials, query, fragment or path');
  return url.origin;
}
function config(input: unknown): ConnectionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid connection configuration');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(k => !['dashboardUrl', 'vpsUrl', 'vpsCapacity','dashboardSync'].includes(k))) throw new Error('Only endpoint metadata is accepted; credentials and grants are not stored here');
  if (value.vpsCapacity !== 'unknown' && value.vpsCapacity !== 'exhausted') throw new Error('Invalid capacity status');
  let binding: ConnectionConfig['dashboardSync'];
  if (value.dashboardSync !== undefined) {
    const b = value.dashboardSync as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Object.keys(b).length !== 4 || Object.keys(b).some(k => !['enabled','orgRef','projectRef','projectCwd'].includes(k)) || typeof b.enabled !== 'boolean' || !dashboardRef(b.orgRef) || !dashboardRef(b.projectRef) || typeof b.projectCwd !== 'string' || b.projectCwd.length > 2000 || !isAbsolute(b.projectCwd) || /[\x00-\x1f]/.test(b.projectCwd)) throw new Error('Invalid project synchronization scope');
    binding = { enabled: b.enabled, orgRef: b.orgRef, projectRef: b.projectRef, projectCwd: b.projectCwd };
  }
  return { dashboardUrl: endpoint(value.dashboardUrl), vpsUrl: endpoint(value.vpsUrl), vpsCapacity: value.vpsCapacity, ...(binding ? { dashboardSync: binding } : {}) };
}

export class RuntimeConnections {
  constructor(private readonly file: string, private readonly blockVps: (reason: 'executor_unavailable' | 'capacity_exhausted') => void = () => {}, private readonly sync?: { status(): DashboardSyncStatus; refresh(): void }) {}
  configuration(): ConnectionConfig { return this.read().config; }
  assertRevision(revision: string) { if (this.read().revision !== revision) throw new Error('Connection configuration changed; refresh before storing a credential'); }
  private read() {
    const present = existsSync(this.file);
    if (present && (!statSync(this.file).isFile() || statSync(this.file).size > 8192)) throw new Error('Connection configuration is unreadable');
    const raw = present ? readFileSync(this.file, 'utf8') : '';
    if (Buffer.byteLength(raw, 'utf8') > 8192) throw new Error('Connection configuration is unreadable');
    const saved = raw ? JSON.parse(raw) as { version: number; config: unknown } : null;
    if (present && (!saved || typeof saved !== 'object' || saved.version !== 1)) throw new Error('Unsupported connection configuration');
    return { config: saved ? config(saved.config) : defaults(), revision: hash(raw) };
  }
  /** The remote executor remains unavailable until a real authorized adapter is implemented. */
  refreshGate() {
    try { const c = this.read().config; this.blockVps(c.vpsUrl && c.vpsCapacity === 'exhausted' ? 'capacity_exhausted' : 'executor_unavailable'); }
    catch { this.blockVps('executor_unavailable'); }
  }
  state(queue: OrgQueueSnapshot): ConnectionState {
    let saved: ReturnType<RuntimeConnections['read']> | null = null;
    try { saved = this.read(); } catch { /* An unreadable config is unknown, never connected or silently reset. */ }
    const c = saved?.config;
    const sync = this.sync?.status();
    return {
      config: c ?? null, revision: saved?.revision ?? null, error: saved ? null : 'config_unreadable',
      dashboard: { connected: sync?.connected ?? false, transportSupported: !!this.sync, reason: !saved ? 'config_unreadable' : !c?.dashboardUrl ? 'endpoint_required' : sync?.reason ?? 'transport_unavailable', lastAcknowledgedSequence: sync?.lastAcknowledgedSequence ?? null, lastSyncAt: sync?.lastSyncAt ?? null },
      ...(sync ? { sync } : {}),
      vps: { connected: false, executionSupported: false, reason: !saved ? 'config_unreadable' : !c?.vpsUrl ? 'host_required' : c.vpsCapacity === 'exhausted' ? 'capacity_exhausted' : 'adapter_unavailable', checkedAt: null },
      outbox: { contract: 'ac.integration.v1', sequence: queue.error ? null : queue.sequence, retainedEvents: queue.error ? null : queue.events.length, error: queue.error ?? null },
    };
  }
  save(input: unknown, revision: string, queue: OrgQueueSnapshot): ConnectionState {
    const next = config(input);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    let lock: number;
    try { lock = openSync(`${this.file}.lock`, 'wx', 0o600); } catch { throw new Error('Connection configuration is busy; refresh before saving'); }
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const current = this.read();
      if (current.revision !== revision) throw new Error('Connection configuration changed; refresh before saving');
      if (JSON.stringify(current.config) !== JSON.stringify(next)) {
        const fd = openSync(temp, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ version: 1, config: next })); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temp, this.file);
        if (process.platform !== 'win32') { const dir = openSync(dirname(this.file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      }
    } finally { rmSync(temp, { force: true }); closeSync(lock); rmSync(`${this.file}.lock`, { force: true }); }
    this.refreshGate();
    this.sync?.refresh();
    return this.state(queue);
  }
}

/** Optional marker injected by a verified local package; source/dev builds keep their normal version. */
export function packagedBuildLabel(packageFile: string): string | undefined {
  try {
    if (statSync(packageFile).size > 100_000) return;
    const label = (JSON.parse(readFileSync(packageFile, 'utf8')) as { alchemistBuild?: unknown }).alchemistBuild;
    if (typeof label === 'string' && /^AC-\d{2,4} [a-f0-9]{7,40}(?: \([A-Za-z0-9 -]{1,70}\))?$/.test(label)) return label;
  } catch { /* Normal packages do not carry a private build marker. */ }
}
