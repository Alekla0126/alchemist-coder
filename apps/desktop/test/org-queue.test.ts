import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, parse } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OrgQueue, type OrgJobPayload } from '../src/main/org-queue';
import { roleContext } from '../src/main/org-context';
import { BotManager } from '../src/main/bots';
import type { RunnerEventMessage } from '../src/shared/api';
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(),'org-portable-')); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach(d => rmSync(d,{recursive:true,force:true})); });
const payload = (n: string): OrgJobPayload => ({teamId:'team-fixture',botId:n,prompt:'PRIVATE TASK',cwd:'/fixture',kind:'start'});
const input = (n: string) => ({id:n,payload:payload(n),maxParallel:2,maxAttempts:2,resumePreauthorized:true});
it('deduplicates persisted jobs, rejects changed payload and exports only safe ordered events',()=>{
 const file=join(temp(),'queue.json'), calls:string[]=[];
 const q=new OrgQueue(file,j=>calls.push(j.id));q.start();q.enqueue(input('one'));q.enqueue(input('one'));
 expect(calls).toEqual(['one']);expect(()=>q.enqueue({...input('one'),payload:{...payload('one'),prompt:'different'}})).toThrow(/idempotency/);
 q.checkpoint('one','PRIVATE-SESSION');q.complete('one','verified');q.close();
 const snapshot=q.snapshot();expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|\/fixture/);expect(snapshot.events.map(e=>e.sequence)).toEqual([1,2,3,4]);expect(snapshot.jobs[0]?.verification).toBe('verified');
 const restarted=new OrgQueue(file,()=>{throw new Error('duplicate execution')});restarted.start();expect(restarted.snapshot().jobs[0]?.state).toBe('completed');restarted.close();
});
it('blocks an unavailable executor without stopping independent local jobs, and resumes when available',()=>{
 const calls:string[]=[];const q=new OrgQueue(join(temp(),'q'),j=>calls.push(j.id));q.start();q.enqueue({...input('remote'),executorId:'vps'});q.enqueue(input('local'));
 expect(q.snapshot().jobs[0]).toMatchObject({state:'blocked',blockedReason:'executor_unavailable'});expect(calls).toEqual(['local']);q.setExecutorAvailable('vps',true);expect(calls).toEqual(['local','remote']);q.close();
});
it('recovers queued preauthorized work but isolates interrupted jobs until explicit resume with checkpoint',()=>{
 const file=join(temp(),'q');const q=new OrgQueue(file,()=>{});q.start();q.enqueue({...input('first'),maxParallel:1});q.checkpoint('first','session-fixture');q.enqueue({...input('second'),maxParallel:1});q.close();
 const calls:Array<[string,string|undefined]>=[];const r=new OrgQueue(file,(j,p)=>calls.push([j.id,p.resumeSessionId]));r.start();expect(calls).toEqual([['second',undefined]]);expect(r.snapshot().jobs[0]).toMatchObject({state:'interrupted',blockedReason:'resume_confirmation_required'});
 r.complete('second');expect(()=>r.resume('first')).toThrow(/reconciliation/);expect(calls).toEqual([['second',undefined]]);expect(readFileSync(file,'utf8')).toContain('session-fixture');r.close();
});
it('does not automatically resume a queued job without its task-scoped authorization',()=>{
 const file=join(temp(),'q');const q=new OrgQueue(file,()=>{});q.enqueue({...input('manual'),resumePreauthorized:false});q.close();const calls:string[]=[];const r=new OrgQueue(file,j=>calls.push(j.id));r.start();expect(calls).toEqual([]);expect(r.snapshot().jobs[0]?.state).toBe('blocked');r.resume('manual');expect(calls).toEqual(['manual']);r.close();
});
it('retries only explicitly retryable preauthorized failures within attempt and backoff limits',()=>{
 let now=1000;const calls:string[]=[];const q=new OrgQueue(join(temp(),'q'),j=>calls.push(j.id),()=>now);q.start();q.enqueue(input('retry'));q.fail('retry','temporary_fixture_failure',true);q.pump();expect(calls).toHaveLength(1);now+=1000;q.pump();expect(calls).toHaveLength(2);q.fail('retry','temporary_fixture_failure',true);expect(q.snapshot().jobs[0]?.state).toBe('failed');expect(()=>q.resume('retry')).toThrow(/reconciliation|attempt limit/);q.close();
});
it('isolates permanent failures and cancellation, leaving independent jobs runnable',()=>{
 const calls:string[]=[];const q=new OrgQueue(join(temp(),'q'),j=>calls.push(j.id));q.start();q.enqueue({...input('cancel'),maxParallel:1});q.enqueue({...input('other'),maxParallel:1});q.cancel('cancel');q.pump();q.fail('other','account_unavailable');q.enqueue(input('last'));expect(calls).toEqual(['cancel','other','last']);expect(q.snapshot().jobs.map(j=>j.state)).toEqual(['cancelled','failed','running']);q.close();
});
it('selectively reads one role and rejects traversal, external symlinks and oversized context',()=>{
 const root=temp(),roles=join(root,'.alchemist/organization/roles');mkdirSync(roles,{recursive:true});writeFileSync(join(roles,'coder.md'),'CODER ONLY');writeFileSync(join(roles,'tester.md'),'TESTER ONLY');expect(roleContext(root,'coder')).toContain('CODER ONLY');expect(roleContext(root,'coder')).not.toContain('TESTER');expect(()=>roleContext(root,'../secret')).toThrow(/Invalid/);const out=temp();writeFileSync(join(out,'outside.md'),'no');symlinkSync(out,join(roles,'escape.md'),'junction');expect(()=>roleContext(root,'escape')).toThrow(/outside/);writeFileSync(join(roles,'large.md'),'x'.repeat(16001));expect(()=>roleContext(root,'large')).toThrow(/16 KB/);
});
it('the existing coordinator dispatches two independent Codex tasks through the durable queue and verifies synthetic outputs',async()=>{
 const root=temp(),roles=join(root,'.alchemist/organization/roles');mkdirSync(roles,{recursive:true});for(const r of ['coordinator','coder','tester'])writeFileSync(join(roles,`${r}.md`),`CONTEXT_${r}`);
 const listeners:Array<(m:RunnerEventMessage)=>void>=[],started:Array<{runId:string;model:string;effort?:string;permissionMode?:string;prompt:string}>=[];
 const fake={start:(r:{model:string;effort?:string;permissionMode?:string;prompt:string})=>{const runId=`fixture-${started.length+1}`;started.push({...r,runId});return{runId}},stop:()=>{},send:()=>{},observe:(f:(m:RunnerEventMessage)=>void)=>(listeners.push(f),()=>{})};
 const files={configs:join(root,'configs.json'),teams:join(root,'teams.json')};
 const bots=new BotManager(files,fake as never,{command:'never-executed',script:'never-executed'},v=>String(v),()=>{});
 const agent={harnessId:'codex',providerId:'openai',model:'fixture-codex',effort:'low'};
 const ceo=bots.saveConfig({name:'Coordinator',role:'Dispatch and verify',agent,permissionMode:'plan',canSpawn:true,kind:'coordinator',contextRole:'coordinator'});
 for(const name of ['coder','tester'])bots.saveConfig({name,role:'Fixture only',agent,permissionMode:'plan',canSpawn:false,contextRole:name});
 const t=bots.startTeam({goal:'Verify two independent local fixtures',cwd:root,configId:ceo.id,durable:{maxParallel:3,maxAttempts:2,resumePreauthorized:false},approvePlan:true});
 const who={teamId:t.id,botId:'b1'};await bots.callTool(who,'propose_plan',{summary:'Two local fixtures',bots:[{name:'coder',task:'CODE_OK',config:'coder'},{name:'tester',task:'TEST_OK',config:'tester'}]});
 bots.answerPlan(t.id,{approve:true});await Promise.all(['coder','tester'].map(name=>bots.callTool(who,'create_bot',{name,task:name==='coder'?'CODE_OK':'TEST_OK',config:name})));
 expect(started).toHaveLength(3);expect(started.every(s=>s.model==='fixture-codex'&&s.effort==='low'&&s.permissionMode==='plan')).toBe(true);expect(started[1]!.prompt).toContain('CONTEXT_coder');expect(started[1]!.prompt).not.toContain('CONTEXT_tester');
 for(const [n,text] of [[1,'CODE_OK'],[2,'TEST_OK']] as const){const file=join(root,`${n}.txt`);writeFileSync(file,text);expect(readFileSync(file,'utf8')).toBe(text);for(const l of listeners){l({runId:started[n]!.runId,event:{type:'text',text}});l({runId:started[n]!.runId,event:{type:'result',ok:true,sessionId:null,costUsd:null}});}}
 await bots.callTool(who,'finish_team',{summary:'Both fixture outputs were independently read and checked by the test harness.'});for(const l of listeners)l({runId:started[0]!.runId,event:{type:'result',ok:true,sessionId:null,costUsd:null}});
 const snapshot=bots.queueSnapshot();expect(snapshot.jobs).toHaveLength(3);expect(snapshot.jobs.every(j=>j.state==='completed')).toBe(true);expect(snapshot.jobs.every(j=>j.verification==='reported')).toBe(true);expect(snapshot.events.some(e=>e.type==='org.job.completed')).toBe(true);expect(JSON.stringify(snapshot)).not.toContain(root);bots.flush();bots.stopAll();
});

it('an interrupted or failed predecessor blocks same-bot successors while independent work continues',()=>{
 const file=join(temp(),'q'),q=new OrgQueue(file,()=>{});q.start();q.enqueue(input('old'));q.enqueue({...input('followup'),payload:{...payload('old'),prompt:'FOLLOWUP'}});q.close();
 const calls:string[]=[];const r=new OrgQueue(file,j=>calls.push(j.id));r.start();r.enqueue(input('independent'));expect(calls).toEqual(['independent']);expect(r.snapshot().jobs.find(j=>j.id==='followup')).toMatchObject({state:'blocked',blockedReason:'predecessor_unresolved'});r.cancel('old');r.pump();expect(calls).toContain('followup');r.close();
});
it('human waits hold their slots and coordination waits reacquire capacity before returning',async()=>{
 const calls:string[]=[];const q=new OrgQueue(join(temp(),'q'),j=>calls.push(j.id));q.start();q.enqueue({...input('parent'),maxParallel:1});q.waiting('parent',true);q.enqueue({...input('child'),maxParallel:1});expect(calls).toEqual(['parent']);q.waiting('parent',false);q.waiting('parent',true,true);expect(calls).toEqual(['parent','child']);let resumed=false;const waiting=q.resumeCoordinator('parent').then(()=>{resumed=true});await Promise.resolve();expect(resumed).toBe(false);q.complete('child');q.pump();await waiting;expect(q.snapshot().jobs.find(j=>j.id==='parent')?.state).toBe('running');q.close();
});
it('capacity exhaustion is explicit and does not redirect work or affect independent jobs',()=>{
 const calls:string[]=[];const q=new OrgQueue(join(temp(),'q'),j=>calls.push(j.id));q.setExecutorAvailable('vps',false,'capacity_exhausted');q.start();q.enqueue({...input('remote'),executorId:'vps'});q.enqueue(input('local'));expect(q.snapshot().jobs[0]?.blockedReason).toBe('capacity_exhausted');expect(calls).toEqual(['local']);q.close();
});
function botFixture() {
 const root=temp(), listeners:Array<(m:RunnerEventMessage)=>void>=[], calls:Array<Record<string,unknown>>=[];
 const fake={start:(r:Record<string,unknown>)=>{const runId=`run-fixture-${calls.length+1}`;calls.push({...r,runId});return{runId}},stop:()=>{},send:()=>{},observe:(fn:(m:RunnerEventMessage)=>void)=>(listeners.push(fn),()=>{})};
 const files={configs:join(root,'configs.json'),teams:join(root,'teams.json')};
 const make=()=>new BotManager(files,fake as never,{command:'never',script:'never'},v=>String(v),()=>{});
 const bots=make(), agent={harnessId:'codex',providerId:'openai',model:'fixture-codex',effort:'low'};
 const ceo=bots.saveConfig({name:'CEO',kind:'coordinator',role:'Fixture',agent,permissionMode:'plan',canSpawn:true});
 const member=bots.saveConfig({name:'Worker',role:'Fixture',agent,permissionMode:'plan',canSpawn:false});
 const emit=(runId:string,event:RunnerEventMessage['event'])=>listeners.forEach(fn=>fn({runId,event}));
 return {root,bots,files,make,ceo,member,calls,emit};
}
it('status errors without a result release the durable slot and keep failures visible',async()=>{
 const f=botFixture();const t=f.bots.startTeam({goal:'Fixture',cwd:f.root,configId:f.ceo.id,durable:{maxParallel:1,maxAttempts:2,resumePreauthorized:true}});
 await f.bots.callTool({teamId:t.id,botId:'b1'},'create_bot',{name:'Worker',task:'Independent',config:f.member.id});expect(f.calls).toHaveLength(1);
 f.emit(String(f.calls[0]!.runId),{type:'error',message:'Model unavailable'});f.emit(String(f.calls[0]!.runId),{type:'status',status:'error'});expect(f.bots.queueSnapshot().jobs[0]?.state).toBe('failed');expect(f.calls).toHaveLength(2);expect(f.bots.listTeams()[0]?.bots[0]?.error).toBe('Model unavailable');f.bots.stopAll();
});
it('a queued independent child survives a simulated BotManager restart while interrupted runs stay isolated',async()=>{
 const f=botFixture();const t=f.bots.startTeam({goal:'Fixture',cwd:f.root,configId:f.ceo.id,durable:{maxParallel:2,maxAttempts:2,resumePreauthorized:true}});
 for(const name of ['A','B']) await f.bots.callTool({teamId:t.id,botId:'b1'},'create_bot',{name,task:name,config:f.member.id});expect(f.calls).toHaveLength(2);f.bots.stopAll();const before=f.calls.length;const restarted=f.make();await restarted.start();expect(f.calls).toHaveLength(before+1);expect(f.calls.at(-1)?.prompt).toContain('Your task: B');expect(restarted.queueSnapshot().jobs.filter(j=>j.state==='interrupted')).toHaveLength(2);restarted.stopAll();
});
it('cancel or shutdown during asynchronous preparation cannot launch the pending bot or reopen the queue',async()=>{
 for(const shutdown of [false,true]){
  const f=botFixture();const t=f.bots.startTeam({goal:'Fixture',cwd:f.root,configId:f.ceo.id,durable:{maxParallel:3,maxAttempts:2,resumePreauthorized:true}});
  let release!:(cwd:string)=>void;(f.bots as unknown as {makeWorktree:()=>Promise<string>}).makeWorktree=()=>new Promise(resolve=>{release=resolve});
  f.bots.saveConfig({...f.member,ownWorktree:true});
  const pending=f.bots.callTool({teamId:t.id,botId:'b1'},'create_bot',{name:'Pending',task:'Fixture',config:f.member.id,own_worktree:true});
  expect(release).toBeTypeOf('function');
  if(shutdown)f.bots.stopAll();else f.bots.stop(t.id);release(f.root);await expect(pending).rejects.toThrow(/stopped/);expect(f.calls).toHaveLength(1);f.bots.stopAll();
 }
});
it('VPS preference never falls back to local, including normal assignments and direct tasks',async()=>{
 const f=botFixture();const remote=f.bots.saveConfig({...f.member,executorId:'vps'});expect((await f.bots.startSolo({configId:remote.id,cwd:f.root,task:'No local fallback'})).bots[0]?.status).toBe('error');const ceo=f.bots.saveConfig({...f.ceo,executorId:'vps'});expect(f.bots.startTeam({goal:'No fallback',cwd:f.root,configId:ceo.id}).bots[0]?.status).toBe('error');expect(f.calls).toHaveLength(0);f.bots.stopAll();
});
it('reconciles a durable queue counter when a simulated crash left the teams checkpoint behind',()=>{
 const f=botFixture();const t=f.bots.startTeam({goal:'Fixture',cwd:f.root,configId:f.ceo.id,durable:{maxParallel:2,maxAttempts:2,resumePreauthorized:true}});
 const run=String(f.calls[0]!.runId);f.emit(run,{type:'started',sessionId:'session-fixture-root'});f.emit(run,{type:'result',ok:true,sessionId:'session-fixture-root',costUsd:null});f.bots.flush();f.bots.stopAll();
 const saved=JSON.parse(readFileSync(f.files.teams,'utf8'));saved[0].bots[0].queueTurn=0;writeFileSync(f.files.teams,JSON.stringify(saved));
 const r=f.make();r.message(t.id,'b1','Reviewed new follow-up');expect(r.queueSnapshot().jobs.at(-1)?.id).toMatch(/:2$/);expect(f.calls).toHaveLength(2);r.stopAll();
});
it('imports a project-scoped TAC template idempotently without changing the saved coordinator or existing model choices',()=>{
 const f=botFixture();cpSync(resolve(__dirname,'../../../templates/tac/.alchemist'),join(f.root,'.alchemist'),{recursive:true});const agent={harnessId:'codex',providerId:'openai',model:'fixture-codex',effort:'low'};
 const before=f.bots.listConfigs();expect(f.bots.portableOrg(f.root,agent,false).names).toHaveLength(16);expect(f.bots.listConfigs()).toEqual(before);f.bots.portableOrg(f.root,agent,true);
 const first=f.bots.listConfigs();expect(first.find(c=>c.id===f.ceo.id)).toEqual(f.ceo);const coder=first.find(c=>c.contextRole==='coder')!;expect(coder).toMatchObject({agent,permissionMode:'plan',projects:[f.root]});expect(coder.leadId).toBeTruthy();
 f.bots.saveConfig({...coder,agent:{harnessId:'gemini',providerId:'other',model:'fixture-other'}});f.bots.portableOrg(f.root,agent,true);expect(f.bots.listConfigs()).toHaveLength(first.length);expect(f.bots.listConfigs().find(c=>c.id===coder.id)?.agent.model).toBe('fixture-other');f.bots.stopAll();
});
it('a late event from a replaced run cannot overwrite the new job or checkpoint',()=>{
 const f=botFixture();const t=f.bots.startTeam({goal:'Fixture',cwd:f.root,configId:f.ceo.id,durable:{maxParallel:2,maxAttempts:2,resumePreauthorized:true}});const old=String(f.calls[0]!.runId);f.emit(old,{type:'started',sessionId:'session-fixture-root'});f.bots.stop(t.id);f.bots.message(t.id,'b1','Reviewed new intent');expect(f.calls).toHaveLength(2);const job=f.bots.queueSnapshot().jobs.at(-1)!.id;f.emit(old,{type:'started',sessionId:'wrong-late-session'});f.emit(old,{type:'status',status:'interrupted'});expect(f.bots.queueSnapshot().jobs.find(j=>j.id===job)?.state).toBe('running');expect(f.bots.listTeams()[0]?.bots[0]?.sessionId).toBe('session-fixture-root');f.bots.stopAll();
});
it('a timed-out coordination wait must reacquire a slot before returning to the model',async()=>{
 vi.useFakeTimers();const f=botFixture();const t=f.bots.startTeam({goal:'Fixture',cwd:f.root,configId:f.ceo.id,durable:{maxParallel:1,maxAttempts:2,resumePreauthorized:true}});await f.bots.callTool({teamId:t.id,botId:'b1'},'create_bot',{name:'Worker',task:'Slow fixture',config:f.member.id});let returned=false;const wait=f.bots.callTool({teamId:t.id,botId:'b1'},'wait_for_bot',{bot_id:'b2',timeout_seconds:5}).then(()=>{returned=true});await vi.advanceTimersByTimeAsync(5000);expect(returned).toBe(false);f.emit(String(f.calls[1]!.runId),{type:'result',ok:true,sessionId:null,costUsd:null});await wait;expect(f.bots.queueSnapshot().jobs[0]?.state).toBe('running');f.bots.stopAll();
});
it('failure to persist the teams checkpoint prevents durable dispatch',()=>{
 const f=botFixture();mkdirSync(`${f.files.teams}.tmp`);expect(()=>f.bots.startTeam({goal:'Fixture',cwd:f.root,configId:f.ceo.id,durable:{maxParallel:2,maxAttempts:2,resumePreauthorized:true}})).toThrow(/checkpoint could not be saved/);expect(f.calls).toHaveLength(0);expect(f.bots.queueSnapshot().jobs).toHaveLength(0);f.bots.stopAll();
});
it('an unreadable queue remains unknown and cannot silently reset or execute jobs',()=>{
 const file=join(temp(),'q');writeFileSync(file,'invalid json');const calls:string[]=[];const q=new OrgQueue(file,j=>calls.push(j.id));q.start();expect(q.snapshot().error).toBe('queue_unreadable');expect(()=>q.enqueue(input('no'))).toThrow(/queue is unavailable/);expect(calls).toHaveLength(0);q.close();expect(readFileSync(file,'utf8')).toBe('invalid json');
});
it('a queue persistence failure cannot start work later through its timer',()=>{
 const root=temp(),file=join(root,'q'),calls:string[]=[];const q=new OrgQueue(file,j=>calls.push(j.id));q.start();mkdirSync(`${file}.tmp`);expect(()=>q.enqueue(input('no'))).toThrow(/could not be saved/);q.pump();q.ensureStarted();expect(calls).toHaveLength(0);expect(q.snapshot().error).toBe('queue_persistence_failed');q.close();
});
it('deduplicates a repeated coordinator request before it can launch another organization run',()=>{
 const f=botFixture(),request={requestId:'request-fixture',goal:'Fixture',cwd:f.root,configId:f.ceo.id,durable:{maxParallel:2,maxAttempts:2,resumePreauthorized:true}};const a=f.bots.startTeam(request);expect(f.bots.startTeam({...request}).id).toBe(a.id);expect(f.calls).toHaveLength(1);expect(()=>f.bots.startTeam({...request,goal:'Changed intent'})).toThrow(/idempotency/);f.bots.stopAll();
});
it('snapshot allowlists fields even if a stored record contains an unexpected private field',()=>{
 const file=join(temp(),'q');const q=new OrgQueue(file,()=>{});q.enqueue(input('fixture'));q.close();const saved=JSON.parse(readFileSync(file,'utf8'));saved.jobs[0].token='PRIVATE';saved.events[0].prompt='PRIVATE';writeFileSync(file,JSON.stringify(saved));const r=new OrgQueue(file,()=>{});expect(JSON.stringify(r.snapshot())).not.toContain('PRIVATE');r.close();
});
it('a queued follow-up resolves its conversation checkpoint at execution time after restart',async()=>{
 const f=botFixture();const t=f.bots.startTeam({goal:'Fixture',cwd:f.root,configId:f.ceo.id,durable:{maxParallel:1,maxAttempts:2,resumePreauthorized:true}});f.bots.message(t.id,'b1','Follow-up before started');const q=(f.bots as unknown as {queue:OrgQueue}).queue;f.emit(String(f.calls[0]!.runId),{type:'started',sessionId:'session-late-checkpoint'});q.complete(q.snapshot().jobs[0]!.id);f.bots.stopAll();const saved=JSON.parse(readFileSync(f.files.teams,'utf8'));expect(saved[0].bots[0].sessionId).toBeUndefined();const r=f.make();await r.start();expect(f.calls).toHaveLength(2);expect(f.calls.at(-1)?.resumeSessionId).toBe('session-late-checkpoint');r.stopAll();
});
it('a follow-up without any conversation checkpoint cannot silently become a new conversation',async()=>{
 const f=botFixture();const t=f.bots.startTeam({goal:'Fixture',cwd:f.root,configId:f.ceo.id,durable:{maxParallel:1,maxAttempts:2,resumePreauthorized:true}});f.bots.message(t.id,'b1','Follow-up');const q=(f.bots as unknown as {queue:OrgQueue}).queue;q.complete(q.snapshot().jobs[0]!.id);f.bots.stopAll();const r=f.make();await r.start();expect(f.calls).toHaveLength(1);expect(r.queueSnapshot().jobs.at(-1)?.state).toBe('failed');r.stopAll();
});
it('preserves a native project root instead of turning a Windows drive root into a relative path',()=>{
 const f=botFixture(),root=parse(f.root).root;const scoped=f.bots.saveConfig({...f.member,projects:[root]});expect(scoped.projects).toEqual([root]);f.bots.stopAll();
});
