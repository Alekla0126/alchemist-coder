/** Synthetic local benchmark. Not a measurement of the production host or VPN under load. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardReceiver, dashboardReceiverServer } from '../../apps/desktop/src/main/dashboard-receiver.ts';
import { DASHBOARD_PROTOCOL } from '../../apps/desktop/src/shared/dashboard-protocol.ts';
import type { DashboardBatch, DashboardJob } from '../../apps/desktop/src/shared/dashboard-protocol.ts';

const bounded = process.argv.includes('--bounded'), dir=mkdtempSync(join(tmpdir(),'dashboard-bench-')),file=join(dir,'inbox.json');
let receiver=new DashboardReceiver(file,[],true);
const proxy={accept:(value:unknown,token:string|null)=>receiver.accept(value,token),read:()=>{throw Error('No read needed');}} as unknown as DashboardReceiver;
const server=dashboardReceiverServer(proxy);await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const address=server.address();if(!address||typeof address==='string')throw Error('Missing address');
let peak=process.memoryUsage().rss;const sample=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},5);
let requests=0,bytes=0;const started=Date.now();
try {
 const job:DashboardJob={taskRef:'a'.repeat(64),teamRef:'b'.repeat(64),botRef:'c'.repeat(64),executor:'local',state:'completed',attempt:1,verification:'verified',reason:null};
 const streams=Array.from({length:bounded?4:1},()=>randomUUID());
 for(let sequence=1;sequence<=3;sequence++) for(const streamId of streams){
  const message:DashboardBatch['message']={version:DASHBOARD_PROTOCOL,orgRef:'synthetic-org',projectRef:'synthetic-project',streamId,sequence,messageId:randomUUID(),createdAt:Date.now(),kind:'snapshot',data:{available:true,sourceSequence:sequence,historyCoverage:'partial',jobs:Array.from({length:bounded?600:2},()=>job),agents:Array.from({length:bounded?300:2},()=>({teamRef:'b'.repeat(64),botRef:'c'.repeat(64),state:'idle' as const,verification:'reported' as const})),events:Array.from({length:bounded?1000:6},(_,i)=>({...job,eventRef:createHash('sha256').update(String(i)).digest('hex'),sourceSequence:i+1,type:'org.job.completed',occurredAt:Date.now()}))}};
  const body=JSON.stringify({message,digest:createHash('sha256').update(JSON.stringify(message)).digest('hex')});bytes+=Buffer.byteLength(body);const response=await fetch('http://127.0.0.1:'+address.port+'/api/coder-sync/v1/batches',{method:'POST',headers:{'content-type':'application/json'},body});if(response.status!==200)throw Error('Unexpected benchmark response '+response.status);await response.text();requests++;peak=Math.max(peak,process.memoryUsage().rss);
  if(sequence===2){receiver.close();receiver=new DashboardReceiver(file,[],true);}
 }
 process.stdout.write(JSON.stringify({mode:bounded?'bounded-4-streams':'pilot-2-jobs',platform:process.platform,arch:process.arch,node:process.version,requests,totalBytes:bytes,inboxBytes:statSync(file).size,elapsedMs:Date.now()-started,peakSampledRssMiB:Math.round(peak/1048576*10)/10,reportedMaxRssKiB:process.resourceUsage().maxRSS,reopened:true,externalRequests:0,inferences:0})+'\n');
} finally {clearInterval(sample);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));receiver.close();rmSync(dir,{recursive:true,force:true});}
