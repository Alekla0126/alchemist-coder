import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeConnections, packagedBuildLabel } from '../src/main/runtime-connections';
import { OrgQueue } from '../src/main/org-queue';
import type { OrgQueueSnapshot } from '../src/shared/api';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.unstubAllGlobals(); });
const queue: OrgQueueSnapshot = { version: 'ac.integration.v1', sequence: 9, jobs: [], events: [] };
const blank = { dashboardUrl: null, vpsUrl: null, vpsCapacity: 'unknown' as const };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-connections-')); dirs.push(dir);
  const file = join(dir, 'connections.json'), gates: string[] = [];
  const service = new RuntimeConnections(file, reason => gates.push(reason));
  return { dir, file, gates, service };
}

it('reports actual local outbox readiness without inventing remote acknowledgments or a connected executor', () => {
  const f = fixture(), state = f.service.state(queue);
  expect(state.config).toEqual(blank); expect(state.dashboard).toMatchObject({ connected: false, transportSupported: false, reason: 'endpoint_required', lastSyncAt: null, lastAcknowledgedSequence: null });
  expect(state.vps).toMatchObject({ connected: false, executionSupported: false, reason: 'host_required', checkedAt: null });
  expect(state.outbox).toEqual({ contract: 'ac.integration.v1', sequence: 9, retainedEvents: 0, error: null });
});

it('persists metadata across restart without a network request, credential or provider change', () => {
  const f = fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const state = f.service.save({ dashboardUrl: 'https://dashboard.example/', vpsUrl: 'https://vps.example:8443/', vpsCapacity: 'unknown' }, f.service.state(queue).revision!, queue);
  expect(new RuntimeConnections(f.file).state(queue)).toEqual(state);
  expect(state.config).toEqual({ dashboardUrl: 'https://dashboard.example', vpsUrl: 'https://vps.example:8443', vpsCapacity: 'unknown' });
  expect(state.dashboard.reason).toBe('transport_unavailable'); expect(state.vps.reason).toBe('adapter_unavailable'); expect(fetch).not.toHaveBeenCalled(); expect(f.gates).toEqual(['executor_unavailable']);
});

it.each(['https://user:pass@example.test','https://host.example/?token=secret','https://host.example/#key','https://host.example/api','http://remote.example','ssh://host.example','file:///tmp/fixture','not-a-url'])('rejects unsafe or ambiguous endpoint metadata: %s', endpoint => {
  const f = fixture(), before = f.service.state(queue);
  expect(() => f.service.save({ ...blank, vpsUrl: endpoint }, before.revision!, queue)).toThrow();
  expect(f.service.state(queue)).toEqual(before); expect(f.gates).toEqual([]);
});

it('accepts local development origins without treating them as a connection or transport implementation', () => {
  const f = fixture(), next = f.service.save({ ...blank, vpsUrl: 'http://127.0.0.1:5181' }, f.service.state(queue).revision!, queue);
  expect(next.vps.connected).toBe(false); expect(next.vps.checkedAt).toBeNull(); expect(next.vps.reason).toBe('adapter_unavailable');
});

it('does not accept injected credentials, grants or caller-supplied connected status', () => {
  const f = fixture();
  for (const field of ['token','password','sshKey','connected','executionSupported','autopilot']) expect(() => f.service.save({ ...blank, [field]: true }, f.service.state(queue).revision!, queue)).toThrow(/Only endpoint metadata/);
});

it('marks capacity exhaustion without enabling VPS or blocking independent local jobs', () => {
  const f = fixture(), calls: string[] = [], q = new OrgQueue(join(f.dir, 'queue.json'), job => calls.push(job.id)); q.start();
  const service = new RuntimeConnections(f.file, reason => q.setExecutorAvailable('vps', false, reason));
  service.save({ ...blank, vpsUrl: 'https://vps.example', vpsCapacity: 'exhausted' }, service.state(queue).revision!, queue);
  for (const [id, executorId] of [['remote','vps'],['local','local']] as const) q.enqueue({ id, executorId, payload: { teamId: 'fixture', botId: id, prompt: 'Mock only', cwd: f.dir, kind: 'start' }, maxParallel: 2, maxAttempts: 1, resumePreauthorized: false });
  expect(q.snapshot().jobs.find(j => j.id === 'remote')?.blockedReason).toBe('capacity_exhausted'); expect(calls).toEqual(['local']); q.close();
});

it('does not fabricate a zero sequence when the local queue is unknown', () => {
  const f = fixture(), state = f.service.state({ ...queue, error: 'queue_unreadable' });
  expect(state.outbox).toMatchObject({ sequence: null, retainedEvents: null, error: 'queue_unreadable' }); expect(state.dashboard.lastAcknowledgedSequence).toBeNull();
});

it('rejects concurrent changes and preserves the newer configuration exactly', () => {
  const f = fixture(), before = f.service.state(queue);
  const latest = new RuntimeConnections(f.file).save({ ...blank, dashboardUrl: 'https://new.example' }, before.revision!, queue), bytes = readFileSync(f.file, 'utf8');
  expect(() => f.service.save({ ...blank, vpsUrl: 'https://old.example' }, before.revision!, queue)).toThrow(/changed/);
  expect(readFileSync(f.file, 'utf8')).toBe(bytes); expect(f.service.state(queue)).toEqual(latest);
});

it.each(['','null','false','broken','{"version":2,"config":{}}'])('keeps unreadable stored settings unknown and never overwrites them: %s', raw => {
  const f = fixture(); writeFileSync(f.file, raw);
  const state = f.service.state(queue); expect(state.error).toBe('config_unreadable'); expect(state.config).toBeNull(); expect(state.revision).toBeNull();
  expect(() => f.service.save(blank, 'not-a-valid-revision', queue)).toThrow(); expect(readFileSync(f.file, 'utf8')).toBe(raw); f.service.refreshGate(); expect(f.gates).toEqual(['executor_unavailable']);
});

it('preserves an existing lock and data when a writer is busy', () => {
  const f = fixture(), current = f.service.save({ ...blank, vpsUrl: 'https://vps.example' }, f.service.state(queue).revision!, queue), before = readFileSync(f.file, 'utf8');
  writeFileSync(`${f.file}.lock`, 'writer'); expect(() => f.service.save(blank, current.revision!, queue)).toThrow(/busy/);
  expect(readFileSync(f.file, 'utf8')).toBe(before); expect(readFileSync(`${f.file}.lock`, 'utf8')).toBe('writer');
});

it('shows only a bounded verified-package marker and tolerates normal packages without one', () => {
  const f = fixture(), packageFile = join(f.dir, 'package.json');
  expect(packagedBuildLabel(packageFile)).toBeUndefined(); writeFileSync(packageFile, '{}'); expect(packagedBuildLabel(packageFile)).toBeUndefined();
  writeFileSync(packageFile, JSON.stringify({ alchemistBuild: 'AC-019 abc1234 (VPS configuration draft)' })); expect(packagedBuildLabel(packageFile)).toBe('AC-019 abc1234 (VPS configuration draft)');
  writeFileSync(packageFile, JSON.stringify({ alchemistBuild: 'token=PRIVATE' })); expect(packagedBuildLabel(packageFile)).toBeUndefined();
});
