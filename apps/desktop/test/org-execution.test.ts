import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OrgQueue } from '../src/main/org-queue';
import { LocalOrgExecutionBackend } from '../src/main/org-execution-local';
import { FIXTURE_WORKFLOW, FixtureEffects, FixtureWorker, fixtureWorkflow } from '../src/main/org-fixture-worker';
import type { OrgWorkflow } from '../src/main/org-execution-local';
import type { LeaseRef, OrgExecutionBackend } from '../src/main/org-execution-types';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => f()); });
function fixture(custom?: (workflow: OrgWorkflow) => OrgWorkflow) {
  const dir = mkdtempSync(join(tmpdir(),'org-execution-')); cleanup.push(() => rmSync(dir,{recursive:true,force:true}));
  const effects = new FixtureEffects(join(dir,'effects')), file = join(dir,'queue.json'); let now = 1000;
  const workflows = new Map([[FIXTURE_WORKFLOW, custom?.(fixtureWorkflow(effects)) ?? fixtureWorkflow(effects)]]);
  const make = () => { const b = new LocalOrgExecutionBackend(file,workflows,() => now); cleanup.push(() => b.close()); return b; };
  let backend = make();
  const worker = (id: string, port: OrgExecutionBackend = backend, hooks?: ConstructorParameters<typeof FixtureWorker>[4]) => { const w = new FixtureWorker(port,effects,join(dir,id+'.json'),id,hooks); cleanup.push(() => w.close()); return w; };
  const register = (id: string, b = backend) => b.register({workerId:id,executorId:'local',workflows:[FIXTURE_WORKFLOW],maxParallel:1});
  const enqueue = (id: string, options = {}) => backend.enqueue({id,payload:{teamId:'team-fixture',botId:id,prompt:'PRIVATE_OUTPUT_'+id,cwd:effects.root,kind:'start'},maxParallel:2,maxAttempts:3,resumePreauthorized:true,...options},FIXTURE_WORKFLOW);
  return {dir,effects,file,make,worker,register,enqueue,get backend(){return backend;},restart:() => { backend.close(); backend = make(); return backend; },advance:(ms:number) => { now += ms; },artifacts:() => readdirSync(effects.root).filter(n => /^[a-f0-9]{64}\.json$/.test(n))};
}

it('claims once, fences stale owners and accepts results only after independent verification', async () => {
  const f = fixture(); f.enqueue('factory'); f.register('worker-a'); f.register('worker-b');
  const [a,b] = await Promise.all([f.backend.claim('worker-a'),f.backend.claim('worker-b')]);
  expect(a).not.toBeNull(); expect(b).toBeNull();
  await expect(f.backend.submit(a!.ref,{artifactRef:'0'.repeat(64),outputDigest:'0'.repeat(64)})).rejects.toThrow('result_verification_failed');
  expect(f.backend.queue.snapshot().jobs[0]?.state).toBe('running');
  expect(() => f.backend.queue.complete('factory','verified')).toThrow(/fenced result/);
  const output = await f.backend.perform(a!.ref), ack = await f.backend.submit(a!.ref,output.result);
  expect(ack.verification).toBe('verified');
  expect(await f.backend.submit(a!.ref,output.result)).toEqual(ack);
  await expect(f.backend.submit(a!.ref,{...output.result,outputDigest:'0'.repeat(64)})).rejects.toThrow('result_conflict');
  expect(f.backend.queue.snapshot().events.filter(e => e.type === 'org.job.completed')).toHaveLength(1);
  expect(JSON.stringify(f.backend.queue.snapshot())).not.toMatch(/PRIVATE_OUTPUT|leaseId|workerId|fingerprint|payload|outputDigest/);
});

it('renews soft leases within the hard deadline and isolates expired uncertain work', async () => {
  const f = fixture(w => ({...w,policy:{...w.policy,recovery:'reconcile',maxRuntimeMs:9000}}));
  f.enqueue('marketing'); f.register('worker-a'); const a = (await f.backend.claim('worker-a'))!;
  f.advance(2000); expect(await f.backend.heartbeat(a.ref)).toEqual({expiresAt:6000});
  f.advance(2000); expect(await f.backend.claim('worker-a')).toBeNull();
  f.advance(3000); await expect(f.backend.heartbeat(a.ref)).rejects.toThrow('stale_lease');
  expect(f.backend.queue.snapshot().jobs[0]).toMatchObject({state:'interrupted',blockedReason:'result_reconciliation_required'});
  f.enqueue('independent'); expect((await f.backend.claim('worker-a'))?.ref.taskId).toBe('independent');
});

it('recovers an idempotent lease after restart without repeating its published effect', async () => {
  const f = fixture(); f.enqueue('factory'); f.register('worker-a'); const old = (await f.backend.claim('worker-a'))!;
  const first = await f.backend.perform(old.ref); expect(first.created).toBe(true);
  f.restart(); f.register('worker-b'); expect(await f.backend.claim('worker-b')).toBeNull();
  f.advance(3001); const next = (await f.backend.claim('worker-b'))!;
  expect(next.ref.generation).toBe(old.ref.generation+1);
  await expect(f.backend.heartbeat(old.ref)).rejects.toThrow(/unregistered|stale_lease/);
  f.register('worker-a'); await expect(f.backend.submit(old.ref,first.result)).rejects.toThrow('stale_lease');
  const repeated = await f.backend.perform(next.ref); expect(repeated).toEqual({...first,created:false});
  await f.backend.submit(next.ref,repeated.result);
  expect(f.artifacts()).toHaveLength(1);
  expect(f.backend.queue.snapshot().jobs[0]).toMatchObject({state:'completed',attempt:2,verification:'verified'});
});

it('lost result acknowledgment survives both worker and authority restart without a second effect', async () => {
  const f = fixture(); f.enqueue('factory');
  const submit = vi.spyOn(f.backend,'submit'), realSubmit = submit.getMockImplementation()!;
  submit.mockImplementationOnce(async (ref,result) => { await realSubmit.call(f.backend,ref,result); throw new Error('synthetic_lost_ack'); });
  const w = f.worker('worker-a'); expect(await w.step()).toBe('ack_pending');
  expect(w.pendingResults()).toBe(1); expect(w.publishedEffects).toBe(1);
  w.close(); f.restart(); const recovered = f.worker('worker-a'); expect(await recovered.step()).toBe('idle');
  expect(recovered.pendingResults()).toBe(0); expect(recovered.publishedEffects).toBe(0); expect(f.artifacts()).toHaveLength(1);
  expect(f.backend.queue.snapshot().jobs[0]).toMatchObject({state:'completed',verification:'verified'});
});

it('a cancel confirmed while heartbeat returns cannot publish a fixture effect', async () => {
  const f = fixture(); f.enqueue('cancel'); const heartbeat = f.backend.heartbeat.bind(f.backend);
  vi.spyOn(f.backend,'heartbeat').mockImplementation(async ref => { const result = await heartbeat(ref); await f.backend.cancel(ref.taskId); return result; });
  const w = f.worker('worker-a'); expect(await w.step()).toBe('blocked'); expect(w.publishedEffects).toBe(0); expect(f.artifacts()).toHaveLength(0);
  expect(f.backend.queue.snapshot().jobs[0]?.state).toBe('cancelled');
});

it('a closed worker cannot overwrite a replacement outbox after a deferred perform returns', async () => {
  const f = fixture(); f.enqueue('factory');
  let entered!:()=>void, release!:()=>void;
  const started = new Promise<void>(r=>{entered=r;}), held = new Promise<void>(r=>{release=r;});
  const perform = f.backend.perform.bind(f.backend);
  vi.spyOn(f.backend,'perform').mockImplementationOnce(async ref=>{
    const output = await perform(ref); entered(); await held; return output;
  });
  const old = f.worker('worker-a'), pending = old.step(); await started; old.close();
  const next = f.worker('worker-a');
  const file = join(f.dir,'worker-a.json');
  // Replacement ownership, with its own distinguishable durable state.
  writeFileSync(file,JSON.stringify({version:1,pending:[],owner:'replacement'}));
  const bytes = readFileSync(file); release(); expect(await pending).toBe('ack_pending');
  expect(readFileSync(file)).toEqual(bytes); expect(f.artifacts()).toHaveLength(1);
  f.advance(3001); expect(await next.step()).toBe('completed');
  expect(next.publishedEffects).toBe(0); expect(f.artifacts()).toHaveLength(1);
});

it('cancelling during verification rejects late completion and leaves independent work runnable', async () => {
  let enter!:()=>void, release!:()=>void;
  const entered = new Promise<void>(r => {enter=r;}), held = new Promise<void>(r => {release=r;});
  const f = fixture(w => ({...w,verify:async(a,r) => {enter();await held;return w.verify(a,r);}}));
  f.enqueue('cancel'); f.register('worker-a'); const a = (await f.backend.claim('worker-a'))!;
  const output = await f.backend.perform(a.ref), pending = f.backend.submit(a.ref,output.result);
  await entered; await f.backend.cancel('cancel'); release(); await expect(pending).rejects.toThrow('stale_lease');
  expect(f.backend.queue.snapshot().jobs[0]).toMatchObject({state:'cancelled',verification:'not_run'});
  f.enqueue('independent'); expect((await f.backend.claim('worker-a'))?.ref.taskId).toBe('independent');
});

it('an old or legacy owner cannot overwrite a new lease, including repeated close', async () => {
  const f = fixture(); f.enqueue('factory'); const a = f.backend;
  const concurrent = new OrgQueue(f.file,() => {throw Error('must not execute');});
  expect(concurrent.snapshot().error).toBe('queue_persistence_failed'); concurrent.start(); concurrent.close();
  a.close(); const b = f.restart(); f.register('worker-b'); await b.claim('worker-b'); const bytes = readFileSync(f.file);
  await expect(a.cancel('factory')).rejects.toThrow('queue_unavailable');
  expect(() => a.queue.cancel('factory')).toThrow('queue_unavailable'); a.close(); a.queue.close();
  expect(readFileSync(f.file)).toEqual(bytes);
});

it('corrupt result receipts fail closed without resetting the queue', async () => {
  for (const corrupt of [(j:any) => {j.execution.receipt.ack.generation++;},(j:any) => {j.execution.receipt.ack.resultDigest='0'.repeat(64);},(j:any) => {j.state='running';},(j:any) => {j.execution.receipt=null;}]) {
    const f = fixture(); f.enqueue('factory'); const w = f.worker('worker-a'); await w.step(); w.close(); f.backend.close();
    const saved = JSON.parse(readFileSync(f.file,'utf8')); corrupt(saved.jobs[0]); writeFileSync(f.file,JSON.stringify(saved)); const bytes = readFileSync(f.file);
    expect(() => f.make()).toThrow('queue_unavailable'); expect(readFileSync(f.file)).toEqual(bytes);
  }
});

it('lease/deadline/attempt limits cannot be extended by a worker or an unavailable executor', async () => {
  const f = fixture(w => ({...w,policy:{...w.policy,maxRuntimeMs:6000}}));
  f.backend.queue.setExecutorAvailable('vps',false,'capacity_exhausted'); f.enqueue('remote',{executorId:'vps'});
  f.enqueue('factory',{maxAttempts:1}); f.register('worker-a'); const a = (await f.backend.claim('worker-a'))!;
  f.advance(2000); await f.backend.heartbeat(a.ref); f.advance(2000); expect(await f.backend.heartbeat(a.ref)).toEqual({expiresAt:7000});
  f.advance(2000); await expect(f.backend.heartbeat(a.ref)).rejects.toThrow('stale_lease');
  expect(f.backend.queue.snapshot().jobs.find(j => j.id==='factory')).toMatchObject({state:'interrupted',blockedReason:'execution_timeout'});
  expect(f.backend.queue.snapshot().jobs.find(j => j.id==='remote')).toMatchObject({state:'blocked',blockedReason:'capacity_exhausted',attempt:0});
  expect(() => f.enqueue('bad',{maxAttempts:100})).toThrow('Invalid leased execution request');
});

it('a failed durable claim never reaches a worker effect', async () => {
  const f = fixture(); f.enqueue('factory'); f.register('worker-a'); rmSync(f.file); mkdirSync(f.file);
  await expect(f.backend.claim('worker-a')).rejects.toThrow('queue_unavailable');
  expect(f.artifacts()).toHaveLength(0); expect(f.backend.queue.snapshot().error).toBe('queue_persistence_failed');
});
