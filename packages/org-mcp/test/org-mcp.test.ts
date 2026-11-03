import { afterEach, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createOrgMcp } from '../src/server';
import { defaultPolicy, policySchema } from '../src/policy';
import type { Policy } from '../src/policy';
import type { AuditRecord } from '../src/server';
import type { ProjectProjection } from '../../../apps/desktop/src/shared/dashboard-protocol';

const clean:Array<()=>Promise<void>>=[];afterEach(async()=>{vi.useRealTimers();for(const f of clean.splice(0).reverse())await f();});
const target={orgRef:'org-a',projectRef:'project-a'},streamId='stream-a',taskRef='1'.repeat(64);
const policy=():Policy=>({...defaultPolicy(),projects:[{...target,connection:{origin:'https://fixture.invalid',tokenEnv:'TAC_FAKE_READER'}}]});
const projection=():ProjectProjection=>({version:'ac.dashboard.v1',...target,streams:[{streamId,sequence:1,data:{available:true,sourceSequence:4,historyCoverage:'partial',agents:[],events:[],jobs:[{taskRef,teamRef:'2'.repeat(64),botRef:'3'.repeat(64),executor:'local',state:'completed',attempt:2,verification:'verified',reason:null}]}}]});
async function client(current:()=>Policy=policy,load:ReturnType<typeof vi.fn<(p:unknown,signal?:AbortSignal)=>Promise<unknown>>>=vi.fn(async()=>projection() as unknown),audit:AuditRecord[]=[]){
  const handler=createMcpHandler(()=>createOrgMcp({policy:current,source:{load},audit:r=>audit.push(r)}));
  const c=new Client({name:'isolated-org-test',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{fetch:async(input,init)=>handler.fetch(new Request(input,init))});
  clean.push(async()=>{await c.close();await handler.close();});await c.connect(transport);
  const call=async(name:string,args:Record<string,unknown>={})=>{const r=await c.callTool({name,arguments:args});return {raw:r,data:(r as any).structuredContent};};
  return {c,call,load,audit};
}
it('real SDK client lists the contract and reads verified status without private result contents',async()=>{
  const c=await client();expect((await c.c.listTools()).tools.map(t=>t.name).sort()).toEqual(['tac_command','tac_health','tac_job','tac_jobs','tac_organizations','tac_result']);
  expect((await c.call('tac_health')).data).toMatchObject({state:'connected',writesEnabled:false});
  expect((await c.call('tac_jobs',target)).data.streams[0].jobs[0]).toMatchObject({taskRef,attempt:2});
  const r=await c.call('tac_result',{...target,streamId,taskRef});expect(r.data).toMatchObject({state:'completed',verification:'verified',details:'not_exported',artifactRef:null});
  expect(JSON.stringify(r)).not.toMatch(/TAC_FAKE|fixture.invalid|leaseId|prompt|cwd/);expect(c.audit.some(a=>a.decision==='ok')).toBe(true);
});
it('denies cross-project, absent scope and unknown jobs without leaking another project',async()=>{
  let p=policy();const c=await client(()=>p);
  expect((await c.call('tac_jobs',{...target,projectRef:'other'})).data.code).toBe('scope_denied');expect(c.load).not.toHaveBeenCalled();
  p={...p,scopes:['health:read']};expect((await c.call('tac_jobs',target)).data.code).toBe('scope_denied');expect(c.load).not.toHaveBeenCalled();
  p=policy();expect((await c.call('tac_job',{...target,streamId,taskRef:'f'.repeat(64)})).data.code).toBe('job_not_found');
});
it('rejects private fields and wrong backend scope instead of forwarding them',async()=>{
  const load=vi.fn(async()=>({...projection(),secret:'PRIVATE_SENTINEL'}));const c=await client(policy,load);
  const r=await c.call('tac_jobs',target);expect(r.data.code).toBe('projection_invalid');expect(JSON.stringify(r)).not.toContain('PRIVATE_SENTINEL');
  load.mockImplementation(async()=>({...projection(),orgRef:'other',secret:'PRIVATE_SENTINEL'}));expect((await c.call('tac_jobs',target)).data.code).toBe('projection_invalid');
});
it('rejects coerced enum values in jobs, events and agents',async()=>{
  let view:any=projection();const c=await client(policy,vi.fn(async()=>view));
  for(const field of ['executor','state','verification']){
    view=projection();view.streams[0].data.jobs[0][field]=[view.streams[0].data.jobs[0][field]];
    expect((await c.call('tac_jobs',target)).data.code).toBe('projection_invalid');
    view=projection();const event={...view.streams[0].data.jobs[0],eventRef:'4'.repeat(64),sourceSequence:1,type:'org.job.completed',occurredAt:0};event[field]=[event[field]];
    view.streams[0].data.events=[event];expect((await c.call('tac_jobs',target)).data.code).toBe('projection_invalid');
  }
  for(const field of ['state','verification']){
    view=projection();const agent:any={teamRef:'2'.repeat(64),botRef:'3'.repeat(64),state:'working',verification:'reported'};agent[field]=[agent[field]];
    view.streams[0].data.agents=[agent];expect((await c.call('tac_jobs',target)).data.code).toBe('projection_invalid');
  }
});
it('revocation while a read is in flight prevents the old result from returning',async()=>{
  let p=policy(),release!:(value:unknown)=>void,entered!:()=>void;
  const held=new Promise<unknown>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const c=await client(()=>p,vi.fn(async()=>{entered();return held;}));const result=c.call('tac_jobs',target);await started;p={...p,projects:[]};release(projection());
  expect((await result).data.code).toBe('scope_denied');
});
it('write scopes and client approval references cannot turn on an unauthorized backend',async()=>{
  const p=policy();p.scopes.push('jobs:execute');const c=await client(()=>p);
  const command={...target,version:'ac.command.v1',action:'dispatch',idempotencyKey:'fixture-unique-command-001',proposalRef:'fixture-proposal',approvalRef:'client-asserted'};
  for(let i=0;i<2;i++)expect((await c.call('tac_command',command)).data.code).toBe('backend_not_authorized');
  expect(c.load).not.toHaveBeenCalled();expect(c.audit.filter(r=>r.decision==='backend_not_authorized')).toHaveLength(2);
  const invalid=await c.call('tac_command',{...command,approval:true});expect(invalid.raw.isError).toBe(true);expect(c.load).not.toHaveBeenCalled();
});
it('bounds job context and requires the target references for reserved commands',async()=>{
  const view=projection(),first=view.streams[0]!.data.jobs![0]!;
  view.streams[0]!.data.jobs=Array.from({length:40},(_,i)=>({...first,taskRef:i.toString(16).padStart(64,'0')}));
  const c=await client(policy,vi.fn(async()=>view));
  const initial=(await c.call('tac_jobs',target)).data;expect(initial.streams[0].jobs).toHaveLength(20);expect(initial.page.nextOffset).toBe(20);
  const next=(await c.call('tac_jobs',{...target,offset:20,limit:5})).data;expect(next.streams[0].jobs).toHaveLength(5);expect(next.streams[0].jobs[0].taskRef).toBe((20).toString(16).padStart(64,'0'));
  expect((await c.call('tac_jobs',{...target,limit:1000})).raw.isError).toBe(true);
  for(const action of ['propose','approve','dispatch','cancel','continue'])expect((await c.call('tac_command',{...target,version:'ac.command.v1',action,idempotencyKey:'fixture-missing-references'})).raw.isError).toBe(true);
});
it('has honest prepared and unavailable states, bounded errors and strict input policy',async()=>{
  const c=await client(defaultPolicy);expect((await c.call('tac_health')).data).toMatchObject({state:'prepared',projects:[],writesEnabled:false});
  const broken=await client(policy,vi.fn(async()=>{throw Error('PRIVATE_TOKEN=/private/data');}));
  const health=await broken.call('tac_health');expect(health.data.projects[0]).toMatchObject({state:'unavailable',queueAvailable:null});expect(JSON.stringify(health)).not.toContain('PRIVATE_TOKEN');
  expect((await broken.call('tac_jobs',{...target,projectRef:'../private'})).raw.isError).toBe(true);
  for(const connection of [{origin:'http://public.example',tokenEnv:'TAC_TEST'},{origin:'https://user:password@example.test',tokenEnv:'TAC_TEST'},{origin:'https://example.test/path',tokenEnv:'TAC_TEST'}])expect(policySchema.safeParse({...policy(),projects:[{...target,connection}]}).success).toBe(false);
});
it('returns honest health within ten seconds even with sixteen stalled backends',async()=>{
  const p=policy();p.projects=Array.from({length:16},(_,i)=>({...p.projects[0]!,projectRef:'project-'+i}));
  let aborted=0;
  const c=await client(()=>p,vi.fn(async(_project,signal)=>new Promise((_resolve,reject)=>{
    signal!.addEventListener('abort',()=>{aborted++;reject(Error('synthetic_slow_endpoint'));},{once:true});
  })));
  vi.useFakeTimers();const began=Date.now(),pending=c.call('tac_health');
  await vi.advanceTimersByTimeAsync(10_001);const response=await pending;
  expect(Date.now()-began).toBeLessThan(11_000);expect(response.data.projects).toHaveLength(16);expect(aborted).toBe(16);
  expect(response.data.projects.every((x:any)=>x.state==='unavailable'&&x.queueAvailable===null)).toBe(true);
});
