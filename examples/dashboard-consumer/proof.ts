/** Isolated fixture, never a production automation API. Uses the real queue, sender, HTTP and inbox. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrgQueue } from '../../apps/desktop/src/main/org-queue.ts';
import { DashboardSync, dashboardDigest } from '../../apps/desktop/src/main/dashboard-sync.ts';
import { DashboardReceiver, dashboardReceiverServer } from '../../apps/desktop/src/main/dashboard-receiver.ts';
import type { ConnectionConfig } from '../../apps/desktop/src/shared/api.ts';

export async function createDashboardProof() {
  const dir=mkdtempSync(join(tmpdir(),'dashboard-visible-proof-')),writer='fixture-visible-writer-no-real-grant',reader='fixture-visible-reader-no-real-grant';
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  const grants=[{tokenHash:hash(writer),orgRef:'synthetic-org',projectRef:'synthetic-project',scope:'events:write' as const,expiresAt:Date.now()+3600_000},{tokenHash:hash(reader),orgRef:'synthetic-org',projectRef:'synthetic-project',scope:'projection:read' as const,expiresAt:Date.now()+3600_000}];
  let receiver=new DashboardReceiver(join(dir,'inbox.json'),grants),lost=false,executions=0;
  const proxy={accept:(v:unknown,t:string|null)=>receiver.accept(v,t),read:(o:string,p:string,t:string|null)=>receiver.read(o,p,t)} as DashboardReceiver;
  const server=dashboardReceiverServer(proxy);await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw Error('Fixture address missing');const origin='http://127.0.0.1:'+address.port;
  const config:ConnectionConfig={dashboardUrl:origin,vpsUrl:null,vpsCapacity:'unknown',dashboardSync:{enabled:true,orgRef:'synthetic-org',projectRef:'synthetic-project',projectCwd:dir}};
  const queue=new OrgQueue(join(dir,'queue.json'),j=>{const text=j.id==='marketing'?'A_OK':'B_OK';const file=join(dir,j.id+'.txt');writeFileSync(file,text);if(readFileSync(file,'utf8')!==text)throw Error('Synthetic output mismatch');executions++;queue.complete(j.id,'verified');});queue.start();queue.setExecutorAvailable('vps',false,'executor_unavailable');
  const make=()=>new DashboardSync(join(dir,'outbox'),{config:()=>config,source:()=>({queue:queue.snapshot(),firstRetainedSequence:1,agents:[]}),secrets:{get:async()=>writer,set:async()=>{throw Error('No real credential storage in fixture');}},fetch:async(url,init)=>{const response=await fetch(url,init);if(lost){lost=false;await response.text();throw Error('Synthetic lost ack');}return response;}});
  let sender=make();await sender.pump();
  const labels=()=>{const n=readdirSync(join(dir,'outbox')).find(n=>n.endsWith('.json'))!;const stream=JSON.parse(readFileSync(join(dir,'outbox',n),'utf8')).streamId;return Object.fromEntries([['marketing','Marketing · cuenta ficticia de empresa'],['factory','App Factory · compilación simulada'],['monitor','Monitor · ejecutor no disponible']].map(([id,label])=>[dashboardDigest([stream,'task',id]),label]));};
  return {
    async load(){const response=await fetch(origin+'/api/coder-sync/v1/projects/synthetic-org/synthetic-project',{headers:{authorization:'Bearer '+reader}});if(!response.ok)throw Error('Projection read failed');return response.json();},
    labels,
    status:()=>({sender:sender.status(),executions,labels:labels(),newInferences:0,externalRequests:0}),
    async dispatch(){for(const [id,executorId] of [['marketing','local'],['factory','local'],['monitor','vps']] as const)queue.enqueue({id,executorId,payload:{teamId:'synthetic-team',botId:id,prompt:'Synthetic only',cwd:dir,kind:'start'},maxParallel:2,maxAttempts:1,resumePreauthorized:false});lost=true;await sender.pump();},
    async restart(){sender.close();receiver.close();receiver=new DashboardReceiver(join(dir,'inbox.json'),grants);sender=make();await sender.retry();},
    async close(){sender.close();queue.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));receiver.close();rmSync(dir,{recursive:true,force:true});},
  };
}
