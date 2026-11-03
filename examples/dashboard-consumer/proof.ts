/** Isolated fixture, never a production automation API. Real queue, leases, worker, HTTP and inbox. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalOrgExecutionBackend } from '../../apps/desktop/src/main/org-execution-local.ts';
import { FIXTURE_WORKFLOW, FixtureEffects, FixtureWorker, fixtureWorkflow } from '../../apps/desktop/src/main/org-fixture-worker.ts';
import { DashboardSync, dashboardDigest } from '../../apps/desktop/src/main/dashboard-sync.ts';
import { DashboardReceiver, dashboardReceiverServer } from '../../apps/desktop/src/main/dashboard-receiver.ts';
import type { ConnectionConfig } from '../../apps/desktop/src/shared/api.ts';

export async function createDashboardProof() {
  const dir = mkdtempSync(join(tmpdir(),'dashboard-visible-proof-'));
  const writer = 'fixture-visible-writer-no-real-grant', reader = 'fixture-visible-reader-no-real-grant';
  const hash = (s:string) => createHash('sha256').update(s).digest('hex');
  const grants = [{tokenHash:hash(writer),orgRef:'synthetic-org',projectRef:'synthetic-project',scope:'events:write' as const,expiresAt:Date.now()+3600_000},{tokenHash:hash(reader),orgRef:'synthetic-org',projectRef:'synthetic-project',scope:'projection:read' as const,expiresAt:Date.now()+3600_000}];
  let receiver = new DashboardReceiver(join(dir,'inbox.json'),grants), lost = false, clockOffset = 0, crash = false;
  const proxy = {accept:(v:unknown,t:string|null)=>receiver.accept(v,t),read:(o:string,p:string,t:string|null)=>receiver.read(o,p,t)} as DashboardReceiver;
  const server = dashboardReceiverServer(proxy);
  await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture address missing');
  const origin = 'http://127.0.0.1:'+address.port;
  const config: ConnectionConfig = {dashboardUrl:origin,vpsUrl:null,vpsCapacity:'unknown',dashboardSync:{enabled:true,orgRef:'synthetic-org',projectRef:'synthetic-project',projectCwd:dir}};
  const effects = new FixtureEffects(join(dir,'effects')), workflows = new Map([[FIXTURE_WORKFLOW,fixtureWorkflow(effects)]]);
  const authority = () => {const b = new LocalOrgExecutionBackend(join(dir,'queue.json'),workflows,()=>Date.now()+clockOffset);b.queue.setExecutorAvailable('vps',false);return b;};
  let backend = authority();
  const workerFor = () => new FixtureWorker(backend,effects,join(dir,'worker.json'),'fixture-worker',{
    afterEffect: async a => {if(crash && a.ref.taskId==='factory'){crash=false;worker.close();}},
  });
  let worker = workerFor();
  const senderFor = () => new DashboardSync(join(dir,'outbox'),{config:()=>config,source:()=>({queue:backend.queue.snapshot(),firstRetainedSequence:1,agents:[]}),secrets:{get:async()=>writer,set:async()=>{throw Error('No real credential storage in fixture');}},fetch:async(url,init)=>{const response=await fetch(url,init);if(lost){lost=false;await response.text();throw Error('Synthetic lost Dashboard ack');}return response;}});
  let sender = senderFor(); await sender.pump();
  const streamId = () => {const n=readdirSync(join(dir,'outbox')).find(n=>n.endsWith('.json'))!;return JSON.parse(readFileSync(join(dir,'outbox',n),'utf8')).streamId as string;};
  const labels = () => Object.fromEntries([['marketing','Marketing · cuenta ficticia de empresa'],['factory','App Factory · compilación simulada'],['monitor','Monitor · ejecutor no disponible']].map(([id,label])=>[dashboardDigest([streamId(),'task',id]),label]));
  const status = () => ({sender:sender.status(),executions:readdirSync(effects.root).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).length,labels:labels(),pendingResults:worker.pendingResults(),attempts:backend.queue.snapshot().jobs.map(j=>({id:j.id,attempt:j.attempt,state:j.state})),newInferences:0,externalRequests:0});
  const dispatch = async (interrupt: boolean) => {
    crash = interrupt;
    for (const [id,executorId] of [['marketing','local'],['factory','local'],['monitor','vps']] as const) backend.enqueue({id,executorId,payload:{teamId:'synthetic-team',botId:id,prompt:id==='marketing'?'A_OK':'B_OK',cwd:effects.root,kind:'start'},maxParallel:2,maxAttempts:3,resumePreauthorized:true},FIXTURE_WORKFLOW);
    await worker.step(); await worker.step(); lost=true; await sender.pump();
  };
  return {
    // Synthetic-only reader, for the isolated MCP integration proof; never a real user grant.
    readerConnection:()=>({origin,token:reader}),
    async load(){const response=await fetch(origin+'/api/coder-sync/v1/projects/synthetic-org/synthetic-project',{headers:{authorization:'Bearer '+reader}});if(!response.ok)throw Error('Projection read failed');return response.json();},
    labels, status,
    dispatch:()=>dispatch(false),
    dispatchCrash:()=>dispatch(true),
    async restart(){
      sender.close();worker.close();backend.close();receiver.close();
      // Advance the bounded fixture's authority clock, without sleeping through a lease timeout.
      clockOffset += workflows.get(FIXTURE_WORKFLOW)!.policy.leaseMs+1;
      backend=authority();worker=workerFor();await worker.step();
      receiver=new DashboardReceiver(join(dir,'inbox.json'),grants);sender=senderFor();await sender.retry();
      for(let i=0;i<5 && (sender.status().pending??0)>0;i++)await sender.pump();
    },
    async close(){worker.close();sender.close();backend.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));receiver.close();rmSync(dir,{recursive:true,force:true});},
  };
}
