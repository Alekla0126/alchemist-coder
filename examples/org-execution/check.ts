/** Reproducible local check: fixtures and loopback only, no model/API/cloud credentials. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardProof } from '../dashboard-consumer/proof.ts';
import { LocalOrgExecutionBackend } from '../../apps/desktop/src/main/org-execution-local.ts';
import { FIXTURE_WORKFLOW, FixtureEffects, FixtureWorker, fixtureWorkflow } from '../../apps/desktop/src/main/org-fixture-worker.ts';
import type { DashboardProjection } from '../../apps/desktop/src/shared/dashboard-protocol.ts';

const proof = await createDashboardProof();
try {
  await proof.dispatchCrash();assert.equal(proof.status().executions,2);assert.equal(proof.status().pendingResults,1);
  await proof.restart();const view = await proof.load() as {streams:{data:DashboardProjection}[]};
  assert.equal(view.streams[0]!.data.jobs!.filter(j=>j.state==='completed'&&j.verification==='verified').length,2);
  assert.equal(view.streams[0]!.data.jobs!.filter(j=>j.state==='blocked').length,1);
  assert.equal(proof.status().executions,2);assert.equal(proof.status().pendingResults,0);assert.equal(proof.status().sender.pending,0);
  assert.equal(proof.status().attempts.find(j=>j.id==='factory')?.attempt,2);
  console.log(JSON.stringify({phase:'queue_lease_effect_result_ack_dashboard_restart',verified:2,blocked:1,publishedEffects:2,attempts:proof.status().attempts,acknowledgedSequence:proof.status().sender.lastAcknowledgedSequence,newInferences:0}));
} finally {await proof.close();}

const dir = mkdtempSync(join(tmpdir(),'ac-org-crash-proof-'));
const child = fork(new URL('./crash-worker.js',import.meta.url),[dir],{stdio:['ignore','ignore','pipe','ipc']});
let backend: LocalOrgExecutionBackend | undefined, worker: FixtureWorker | undefined;
try {
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Child fixture did not publish')),15_000);
    child.once('error',reject);child.once('exit',()=>{clearTimeout(timeout);reject(Error('Child fixture exited early'));});
    child.on('message',v=>{if(v&&typeof v==='object'&&(v as {phase?:string}).phase==='effect_published'){clearTimeout(timeout);resolve();}});
  });
  const exited = new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  child.kill('SIGKILL');await exited;
  const effects = new FixtureEffects(join(dir,'effects'));
  backend = new LocalOrgExecutionBackend(join(dir,'queue.json'),new Map([[FIXTURE_WORKFLOW,fixtureWorkflow(effects)]]),()=>Date.now()+4000);
  worker = new FixtureWorker(backend,effects,join(dir,'worker.json'),'crash-fixture-worker');
  assert.equal(await worker.step(),'completed');assert.equal(worker.publishedEffects,0);assert.equal(worker.pendingResults(),0);
  assert.equal(backend.queue.snapshot().jobs[0]?.verification,'verified');assert.equal(backend.queue.snapshot().jobs[0]?.attempt,2);
  assert.equal(readdirSync(effects.root).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).length,1);
  console.log(JSON.stringify({phase:'actual_child_sigkill_recovery',publishedEffects:1,recoveredAttempt:2,pendingResults:0,verification:'verified',newInferences:0}));
} finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');worker?.close();backend?.close();rmSync(dir,{recursive:true,force:true});}
