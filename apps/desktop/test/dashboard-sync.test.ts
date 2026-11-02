import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DashboardSync, dashboardDigest, dashboardGrantKey } from '../src/main/dashboard-sync';
import type { DashboardSource } from '../src/main/dashboard-sync';
import { DashboardReceiver, dashboardReceiverServer } from '../src/main/dashboard-receiver';
import type { ConnectionConfig } from '../src/shared/api';
import { DASHBOARD_PROTOCOL, validDashboardAck, validDashboardBatch } from '../src/shared/dashboard-protocol';
import { OrgQueue } from '../src/main/org-queue';
import { BotManager } from '../src/main/bots';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const secret = 'fixture-writer-credential-only-12345', reader = 'fixture-reader-credential-only-12345';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function temp() { const p = mkdtempSync(join(tmpdir(),'dashboard-sync-')); cleanups.push(() => rmSync(p,{recursive:true,force:true})); return p; }
function fixture(origin = 'http://127.0.0.1:5182') {
  const dir = temp(); let now = 1000;
  const config: ConnectionConfig = { dashboardUrl: origin, vpsUrl: null, vpsCapacity:'unknown', dashboardSync:{enabled:true,orgRef:'fixture-org',projectRef:'fixture-project',projectCwd:dir} };
  const source: DashboardSource = { queue:{version:'ac.integration.v1',sequence:0,jobs:[],events:[]},firstRetainedSequence:1,agents:[] };
  const vault = new Map<string,string>(); const secrets = { get:async(k:string) => vault.get(k) ?? null, set:async(k:string,v:string|null) => { if(v) vault.set(k,v); else vault.delete(k); } };
  const make = (fetcher?: typeof fetch,maxPending?:number,maxBytes?:number) => { const s = new DashboardSync(join(dir,'outbox'),{config:()=>config,source:()=>source,secrets,fetch:fetcher,now:()=>now,maxPending,maxBytes});cleanups.push(()=>s.close());return s; };
  return {dir,config,source,vault,make,advance:()=>{now+=60_000;}};
}
function grants() { return [{tokenHash:hash(secret),orgRef:'fixture-org',projectRef:'fixture-project',scope:'events:write' as const,expiresAt:Date.now()+3600_000},{tokenHash:hash(reader),orgRef:'fixture-org',projectRef:'fixture-project',scope:'projection:read' as const,expiresAt:Date.now()+3600_000}]; }
async function serve(receiver: DashboardReceiver) {
  const server = dashboardReceiverServer(receiver);
  await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  cleanups.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const addr=server.address();if(!addr||typeof addr==='string')throw new Error('Missing fixture address');return 'http://127.0.0.1:'+addr.port;
}
function inbox(f:ReturnType<typeof fixture>, local=true) { const r = new DashboardReceiver(join(f.dir,'inbox.json'),grants(),local);cleanups.push(()=>r.close());return r; }
const ack = (batch: ReturnType<typeof JSON.parse>) => ({version:DASHBOARD_PROTOCOL,...Object.fromEntries(['orgRef','projectRef','streamId','sequence','messageId'].map(k=>[k,batch.message[k]])),digest:batch.digest});
const ok: typeof fetch = async (_url,init) => new Response(JSON.stringify(ack(JSON.parse(String(init?.body)))));

it('does not write an outbox, read a credential or connect until the project explicitly opts in',async()=>{
 const f=fixture();f.config.dashboardSync!.enabled=false;const fetcher=vi.fn(),sync=f.make(fetcher);await sync.pump();expect(fetcher).not.toHaveBeenCalled();expect(readdirSync(f.dir)).toEqual([]);expect(sync.status()).toMatchObject({enabled:false,connected:false,reason:'sync_disabled',lastSyncAt:null});
});

it('end to end: two actual queue jobs reach the durable Dashboard projection with acknowledgments and no private content',async()=>{
 const f=fixture(),q=new OrgQueue(join(f.dir,'queue.json'),job=>{const expected=job.id==='A-private'?'A_OK':'B_OK';const file=join(f.dir,job.id+'.txt');writeFileSync(file,expected);expect(readFileSync(file,'utf8')).toBe(expected);q.complete(job.id,'verified');});cleanups.push(()=>q.close());q.start();
 for(const id of ['A-private','B-private']){q.enqueue({id,payload:{teamId:'private-team',botId:id,prompt:'PRIVATE_PROMPT_SENTINEL',cwd:'/private/PATH_SENTINEL',kind:'start'},maxAttempts:1,maxParallel:2,resumePreauthorized:false});}
 f.source.queue=q.snapshot();f.source.agents=[{teamId:'private-team',botId:'private-bot',state:'idle',hasReply:true}];const r=inbox(f);f.config.dashboardUrl=await serve(r);const sync=f.make();await sync.pump();
 expect(sync.status()).toMatchObject({connected:true,reason:'synchronized',pending:0,lastAcknowledgedSequence:1,attempts:0});const get=await fetch(f.config.dashboardUrl+'/api/coder-sync/v1/projects/fixture-org/fixture-project',{headers:{authorization:'Bearer '+reader}});expect(get.status).toBe(200);const view=await get.json() as ReturnType<DashboardReceiver['read']>;expect(view.streams[0]?.data.jobs?.map(j=>[j.state,j.verification])).toEqual([['completed','verified'],['completed','verified']]);expect(view.streams[0]?.data.agents[0]?.verification).toBe('reported');
 const bytes=JSON.stringify(view);for(const sentinel of ['PRIVATE_PROMPT_SENTINEL','PATH_SENTINEL','private-team','private-bot','A-private','B-private'])expect(bytes).not.toContain(sentinel);expect(view.streams[0]?.data.events.length).toBe(6);
});

it('persists an unacknowledged delivery across both restarts and deduplicates an accepted response lost in transit',async()=>{
 const f=fixture();let r=inbox(f);const proxy={accept:(v:unknown,t:string|null)=>r.accept(v,t),read:(o:string,p:string,t:string|null)=>r.read(o,p,t)} as DashboardReceiver;f.config.dashboardUrl=await serve(proxy);const lost:typeof fetch=async(url,init)=>{await fetch(url,init);throw new Error('ACK was lost');};let sync=f.make(lost);await sync.pump();expect(sync.status()).toMatchObject({pending:1,reason:'network_error'});const persistedBatch=JSON.parse(readFileSync(join(f.dir,'outbox',readdirSync(join(f.dir,'outbox')).find(n=>n.endsWith('.json'))!),'utf8')).pending[0];sync.close();r.close();r=inbox(f);sync=f.make();f.advance();await sync.pump();expect(sync.status()).toMatchObject({pending:0,lastAcknowledgedSequence:1});expect(r.read('fixture-org','fixture-project',reader).streams).toHaveLength(1);expect(r.read('fixture-org','fixture-project',reader).streams[0]?.sequence).toBe(1);expect(validDashboardAck(r.accept(persistedBatch,null),persistedBatch)).toBe(true);
});

it('retries at most five deliveries, preserves that budget on restart and requires explicit retry',async()=>{
 const f=fixture(),fetcher=vi.fn(async()=>{throw new Error('offline');});let sync=f.make(fetcher);for(let n=0;n<5;n++){await sync.pump();f.advance();}expect(fetcher).toHaveBeenCalledTimes(5);expect(sync.status()).toMatchObject({reason:'retry_exhausted',attempts:5,pending:1});sync.close();sync=f.make(fetcher);await sync.pump();expect(fetcher).toHaveBeenCalledTimes(5);await sync.retry();expect(fetcher).toHaveBeenCalledTimes(6);
});

it.each([401,403,409,400])('does not automatically retry a terminal HTTP %s response',async status=>{
 const f=fixture(),fetcher=vi.fn(async()=>new Response('{}',{status})),sync=f.make(fetcher);await sync.pump();f.advance();await sync.pump();expect(fetcher).toHaveBeenCalledTimes(1);expect(sync.status().pending).toBe(1);expect(sync.status().reason).toBe(status===401||status===403?'authorization_required':'protocol_error');
});

it.each(['{"accepted":true}','not-json'])('never acknowledges an invalid response %s and retains the original message for reviewed retry',async body=>{
 const f=fixture(),fetcher=vi.fn(async()=>new Response(body)),sync=f.make(fetcher);await sync.pump();expect(sync.status()).toMatchObject({reason:'invalid_ack',pending:1,lastAcknowledgedSequence:null,lastSyncAt:null});f.advance();await sync.pump();expect(fetcher).toHaveBeenCalledTimes(1);
});

it('blocks remote export without a scoped credential and stores it only in the injected encrypted vault',async()=>{
 const f=fixture('https://fixture-dashboard.invalid'),fetcher=vi.fn(ok),sync=f.make(fetcher);await sync.pump();expect(sync.status().reason).toBe('authorization_required');expect(fetcher).not.toHaveBeenCalled();await sync.storeGrant(secret);expect(f.vault.get(dashboardGrantKey(f.config.dashboardUrl!,f.config.dashboardSync!))).toBe(secret);await sync.retry();expect(fetcher).toHaveBeenCalledTimes(1);const init=fetcher.mock.calls[0]?.[1];expect((init?.headers as Record<string,string>).authorization).toBe('Bearer '+secret);expect(JSON.stringify(sync.status())).not.toContain(secret);for(const n of readdirSync(join(f.dir,'outbox')).filter(n=>n.endsWith('.json')))expect(readFileSync(join(f.dir,'outbox',n),'utf8')).not.toContain(secret);
});

it('does not follow redirects to a different endpoint',async()=>{
 const f=fixture();const r=inbox(f);const destination=await serve(r);const fetcher=vi.fn(async(_url,init)=>{expect(init?.redirect).toBe('error');return new Response('',{status:302,headers:{location:destination}});});const sync=f.make(fetcher);await sync.pump();expect(sync.status()).toMatchObject({reason:'protocol_error',pending:1,lastSyncAt:null});
});

it('ignores a late ack after disabling export and keeps the pending checkpoint',async()=>{
 const f=fixture();let resolve!:(r:Response)=>void;let batch:unknown;const fetcher:typeof fetch=async(_url,init)=>{batch=JSON.parse(String(init?.body));return new Promise<Response>(r=>{resolve=r;});};const sync=f.make(fetcher);const running=sync.pump();await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));f.config.dashboardSync!.enabled=false;sync.refresh();resolve(new Response(JSON.stringify(ack(batch))));await running;await sync.pump();expect(sync.status()).toMatchObject({enabled:false,connected:false});const saved=JSON.parse(readFileSync(join(f.dir,'outbox',readdirSync(join(f.dir,'outbox')).find(n=>n.endsWith('.json'))!),'utf8'));expect(saved.pending).toHaveLength(1);expect(saved.acknowledged).toBeNull();
});

it('keeps unacknowledged batches when the outbox reaches capacity instead of dropping them',async()=>{
 const f=fixture(),sync=f.make(async()=>{throw new Error('offline');},2);for(const state of ['working','idle','stopped'] as const){f.source.agents=[{teamId:'t',botId:'b',state,hasReply:false}];await sync.pump();f.advance();}const saved=JSON.parse(readFileSync(join(f.dir,'outbox',readdirSync(join(f.dir,'outbox')).find(n=>n.endsWith('.json'))!),'utf8'));expect(saved.pending.map((b:any)=>b.message.sequence)).toEqual([1,2]);expect(saved.nextSequence).toBe(3);
});

it('does not send a new projection that failed to persist',async()=>{
 const f=fixture(),fetcher=vi.fn(ok),sync=f.make(fetcher);await sync.pump();const file=join(f.dir,'outbox',readdirSync(join(f.dir,'outbox')).find(n=>n.endsWith('.json'))!);rmSync(file);mkdirSync(file);f.source.agents=[{teamId:'t',botId:'b',state:'working',hasReply:false}];await sync.pump();expect(fetcher).toHaveBeenCalledTimes(1);expect(sync.status().reason).toBe('outbox_unavailable');
});

it('fails closed on corrupted outbox and prevents simultaneous writers',async()=>{
 const f=fixture(),first=f.make(ok);await first.pump();const second=f.make(ok);await second.pump();expect(second.status().reason).toBe('outbox_unavailable');first.close();second.close();const file=join(f.dir,'outbox',readdirSync(join(f.dir,'outbox')).find(n=>n.endsWith('.json'))!);writeFileSync(file,'BROKEN');const fetcher=vi.fn(ok),third=f.make(fetcher);await third.pump();expect(third.status().reason).toBe('outbox_unavailable');expect(readFileSync(file,'utf8')).toBe('BROKEN');expect(fetcher).not.toHaveBeenCalled();
});

it('sends an unknown queue as unknown and marks history coverage as partial without a global retention signal',async()=>{
 const f=fixture(),r=inbox(f);f.config.dashboardUrl=await serve(r);f.source.queue.error='queue_unreadable';const sync=f.make();await sync.pump();let view=r.read('fixture-org','fixture-project',reader).streams[0]!.data;expect(view).toMatchObject({available:false,jobs:null,sourceSequence:null});delete f.source.queue.error;f.source.queue.sequence=2000;f.source.firstRetainedSequence=1001;await sync.pump();view=r.read('fixture-org','fixture-project',reader).streams[0]!.data;expect(view).toMatchObject({available:true,historyCoverage:'partial',sourceSequence:2});
});

it('receiver enforces project and read/write scopes, rejects private extras and conflicting retries',async()=>{
 const f=fixture(),r=inbox(f,false);let batch:any;const sync=f.make(async(_url,init)=>{batch=JSON.parse(String(init?.body));return new Response(JSON.stringify(r.accept(batch,secret)));});await sync.pump();expect(sync.status().pending).toBe(0);expect(()=>r.read('fixture-org','fixture-project',secret)).toThrow('scope_denied');expect(()=>r.read('fixture-org','other-project',reader)).toThrow('scope_denied');const wrong=structuredClone(batch);wrong.message.projectRef='other-project';wrong.digest=dashboardDigest(wrong.message);expect(()=>r.accept(wrong,secret)).toThrow('scope_denied');const privateField=structuredClone(batch);privateField.message.data.prompt='DO_NOT_SEND';privateField.digest=dashboardDigest(privateField.message);expect(validDashboardBatch(privateField)).toBe(false);expect(()=>r.accept(privateField,secret)).toThrow('invalid_projection');const conflict=structuredClone(batch);conflict.message.createdAt++;conflict.digest=dashboardDigest(conflict.message);expect(()=>r.accept(conflict,secret)).toThrow('idempotency_conflict');expect(r.read('fixture-org','fixture-project',reader).streams[0]?.sequence).toBe(1);
});

it('receiver acknowledges only after committing and does not advance its projection on a failed write',async()=>{
 const f=fixture(),r=inbox(f);let batch:any;const sync=f.make(async(_url,init)=>{batch=JSON.parse(String(init?.body));return new Response(JSON.stringify(r.accept(batch,null)));});await sync.pump();const next=structuredClone(batch);next.message.sequence=2;next.message.messageId='next-message';next.digest=dashboardDigest(next.message);const file=join(f.dir,'inbox.json');const bytes=readFileSync(file);rmSync(file);mkdirSync(file);expect(()=>r.accept(next,null)).toThrow('inbox_persistence_failed');expect(r.read('fixture-org','fixture-project',reader).streams[0]?.sequence).toBe(1);rmSync(file,{recursive:true});writeFileSync(file,bytes);expect(r.accept(next,null).sequence).toBe(2);
});

it('uses only the selected project and includes legacy agents without exporting their task/reply content',()=>{
 const root=temp(),a=join(root,'a'),b=join(root,'b');mkdirSync(a);mkdirSync(b);const fake={start:()=>({runId:'fixture'}),stop:()=>{},send:()=>{},observe:()=>()=>{}};
 const bots=new BotManager({configs:join(root,'configs'),teams:join(root,'teams')},fake as never,{command:'never',script:'never'},v=>String(v),()=>{});cleanups.push(()=>bots.stopAll());const ceo=bots.saveConfig({name:'PRIVATE_NAME',kind:'coordinator',role:'PRIVATE_ROLE',agent:{harnessId:'codex',providerId:'openai',model:'fixture'},permissionMode:'plan',canSpawn:false});bots.startTeam({goal:'PRIVATE_GOAL_A',cwd:a,configId:ceo.id});bots.startTeam({goal:'PRIVATE_GOAL_B',cwd:b,configId:ceo.id});const source=bots.dashboardSource(a);expect(source.agents).toHaveLength(1);expect(JSON.stringify(source)).not.toMatch(/PRIVATE_|sessionId|prompt|cwd/);
});

it('explicit retry can reacquire the original locked stream without resetting its checkpoint',async()=>{
 const f=fixture(),first=f.make(ok);await first.pump();const second=f.make(ok);await second.pump();expect(second.status().reason).toBe('outbox_unavailable');first.close();await second.retry();expect(second.status()).toMatchObject({connected:true,lastAcknowledgedSequence:2,pending:0});
});

it('global activity outside the opted-in project creates no delivery and reveals no global event counter',async()=>{
 const f=fixture(),fetcher=vi.fn(ok),sync=f.make(fetcher);f.source.queue.sequence=987;f.source.firstRetainedSequence=800;await sync.pump();const first=JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));expect(first.message.data.sourceSequence).toBe(1);f.source.queue.sequence=12345;f.source.firstRetainedSequence=12000;await sync.pump();expect(fetcher).toHaveBeenCalledTimes(1);expect(JSON.stringify(first)).not.toContain('987');expect(sync.status().pending).toBe(0);
});

it('removing a remote grant disconnects immediately, preserving historical ack and requiring a fresh ack after replacement',async()=>{
 const f=fixture('https://fixture-dashboard.invalid'),fetcher=vi.fn(ok),sync=f.make(fetcher);await sync.storeGrant(secret);await sync.retry();expect(sync.status().connected).toBe(true);await sync.storeGrant(null);expect(sync.status()).toMatchObject({connected:false,reason:'authorization_required',lastAcknowledgedSequence:1});await sync.storeGrant(secret);expect(sync.status().connected).toBe(false);await sync.retry();expect(sync.status()).toMatchObject({connected:true,lastAcknowledgedSequence:2});
});

it('stops appending by total bytes before the persisted outbox can exceed its restart limit',async()=>{
 const f=fixture();let sync=f.make(async()=>{throw new Error('offline');},100,4000);for(let i=0;i<12;i++){f.source.agents=[{teamId:'t',botId:'b-'+i,state:'working',hasReply:false}];await sync.pump();f.advance();}const file=join(f.dir,'outbox',readdirSync(join(f.dir,'outbox')).find(n=>n.endsWith('.json'))!);const before=JSON.parse(readFileSync(file,'utf8'));expect(Buffer.byteLength(JSON.stringify(before))).toBeLessThan(4100);expect(before.pending.length).toBeLessThan(12);expect(before.pending.map((b:any)=>b.message.sequence)).toEqual(Array.from({length:before.pending.length},(_,i)=>i+1));sync.close();sync=f.make(async()=>{throw new Error('offline');},100,4000);await sync.pump();expect(sync.status().reason).not.toBe('outbox_unavailable');expect(JSON.parse(readFileSync(file,'utf8')).pending.map((b:any)=>b.message.messageId)).toEqual(before.pending.map((b:any)=>b.message.messageId));
});

it('refuses private or malformed persisted projections after receiver restart',async()=>{
 const f=fixture();let r=inbox(f);const sync=f.make(async(_url,init)=>new Response(JSON.stringify(r.accept(JSON.parse(String(init?.body)),null))));await sync.pump();r.close();const file=join(f.dir,'inbox.json'),raw=JSON.parse(readFileSync(file,'utf8'));Object.values(raw.streams).forEach((v:any)=>v.state.projection.privateReply='PRIVATE');writeFileSync(file,JSON.stringify(raw));expect(()=>new DashboardReceiver(file,grants(),true)).toThrow('Invalid inbox');expect(readFileSync(file,'utf8')).toContain('PRIVATE');
});

it('expired writer grants cannot ingest and writer credentials cannot authorize remote execution routes',async()=>{
 const f=fixture();const expired=grants().map(g=>({...g,expiresAt:1}));const r=new DashboardReceiver(join(f.dir,'expired.json'),expired);cleanups.push(()=>r.close());let batch:any;const sync=f.make(async(_url,init)=>{batch=JSON.parse(String(init?.body));return new Response('{}',{status:403});});await sync.pump();expect(()=>r.accept(batch,secret)).toThrow('scope_denied');const origin=await serve(r);const response=await fetch(origin+'/api/coder-sync/v1/tasks',{method:'POST',headers:{authorization:'Bearer '+secret}});expect(response.status).toBe(404);
});

it('does not advance past a checkpoint-only event when the byte limit prevents persisting its batch',async()=>{
 const f=fixture();f.source.queue.jobs=[{id:'j',teamId:'t',botId:'b',executorId:'local',state:'running',attempt:1,maxAttempts:2,maxParallel:1,verification:'not_run',blockedReason:null,createdAt:1,updatedAt:1}];let sync=f.make(async()=>{throw Error('offline');},100,1800);await sync.pump();f.source.queue.sequence=1;f.source.queue.events=[{version:'ac.integration.v1',eventId:'event-private',sequence:1,type:'org.job.checkpointed',occurredAt:2,taskId:'j',teamId:'t',botId:'b',executorId:'local',state:'running',attempt:1,verification:'not_run',reason:null}];await sync.pump();const file=join(f.dir,'outbox',readdirSync(join(f.dir,'outbox')).find(n=>n.endsWith('.json'))!);const blocked=JSON.parse(readFileSync(file,'utf8'));expect(blocked.pending).toHaveLength(1);expect(blocked.sourceSequence).toBe(0);sync.close();const fetcher=vi.fn(ok);sync=f.make(fetcher,100,1800);await sync.retry();await sync.pump();const delivered=fetcher.mock.calls.map(c=>JSON.parse(String(c[1]?.body)));expect(delivered.some(b=>b.message.data.events.some((e:any)=>e.type==='org.job.checkpointed'))).toBe(true);expect(sync.status().pending).toBe(0);
});

it('removing the new destination credential cannot alter the previous destination outbox while its ack is in flight',async()=>{
 const f=fixture('https://origin-a.invalid');let resolve!:(r:Response)=>void;let batch:any;const sync=f.make(async(_url,init)=>{batch=JSON.parse(String(init?.body));return new Promise<Response>(r=>{resolve=r;});});await sync.storeGrant(secret);const pending=sync.pump();await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));const file=join(f.dir,'outbox',readdirSync(join(f.dir,'outbox')).find(n=>n.endsWith('.json'))!);const original=readFileSync(file,'utf8');f.config.dashboardUrl='https://origin-b.invalid';sync.refresh();await sync.storeGrant(null);expect(readFileSync(file,'utf8')).toBe(original);resolve(new Response(JSON.stringify(ack(batch))));await pending;expect(sync.status().connected).toBe(false);await sync.pump();expect(sync.status().reason).toBe('authorization_required');expect(readFileSync(file,'utf8')).toBe(original);
});

it('pilot receiver rejects oversized batches and additional streams without consuming existing state',async()=>{
 const f=fixture(),r=new DashboardReceiver(join(f.dir,'pilot.json'),grants(),true,1);cleanups.push(()=>r.close());let batch:any;const sync=f.make(async(_url,init)=>{batch=JSON.parse(String(init?.body));return new Response(JSON.stringify(r.accept(batch,null)));});await sync.pump();const next=structuredClone(batch);next.message.streamId='another-stream';next.message.messageId='another-message';next.digest=dashboardDigest(next.message);expect(()=>r.accept(next,null)).toThrow('stream_capacity');const server=dashboardReceiverServer(r,1024);await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});cleanups.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));const address=server.address();if(!address||typeof address==='string')throw Error('No address');const response=await fetch('http://127.0.0.1:'+address.port+'/api/coder-sync/v1/batches',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(1025)});expect(response.status).toBe(413);expect(r.read('fixture-org','fixture-project',reader).streams).toHaveLength(1);
});

it('ships a strictly valid synthetic HTTP example with a matching digest and explicitly partial history',()=>{
 const batch=JSON.parse(readFileSync(new URL('../../../docs/contracts/dashboard-sync-v1.example.json',import.meta.url),'utf8'));expect(validDashboardBatch(batch)).toBe(true);expect(dashboardDigest(batch.message)).toBe(batch.digest);expect(batch.message.data.historyCoverage).toBe('partial');
});
