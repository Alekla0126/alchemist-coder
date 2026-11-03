import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { authorize, opaqueSchema, PublicError, refSchema } from './policy.ts';
import type { Policy, Project, Scope } from './policy.ts';
import { checkedProjection } from './source.ts';
import type { ProjectionSource } from './source.ts';

export interface AuditRecord { version:'ac.mcp.audit.v1';requestRef:string;tool:string;scope:Scope;decision:string;at:number }
export interface McpDependencies { policy:()=>Policy;source:ProjectionSource;audit:(record:AuditRecord)=>void }
type Target = {orgRef:string;projectRef:string};
const targetSchema = z.object({orgRef:refSchema,projectRef:refSchema}).strict();
const jobsSchema = targetSchema.extend({limit:z.number().int().min(1).max(50).optional(),offset:z.number().int().min(0).max(2404).optional()}).strict();
const jobSchema = targetSchema.extend({streamId:refSchema,taskRef:opaqueSchema}).strict();
const commandScopes = {propose:'proposals:write',approve:'approvals:write',dispatch:'jobs:execute',cancel:'jobs:cancel',continue:'jobs:execute'} as const;
const commandSchema = targetSchema.extend({version:z.literal('ac.command.v1'),action:z.enum(['propose','approve','dispatch','cancel','continue']),idempotencyKey:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{15,119}$/),intentRef:refSchema.optional(),proposalRef:refSchema.optional(),approvalRef:refSchema.optional(),parentResultRef:refSchema.optional(),taskRef:opaqueSchema.optional()}).strict().superRefine((value,ctx)=>{
  const required={propose:['intentRef'],approve:['proposalRef'],dispatch:['proposalRef','approvalRef'],cancel:['taskRef'],continue:['proposalRef','approvalRef','parentResultRef']} as const;
  for(const key of required[value.action])if(!value[key])ctx.addIssue({code:'custom',path:[key],message:'Required reference for this operation'});
});
const result = (data:Record<string,unknown>,error=false): CallToolResult => ({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,...(error?{isError:true}:{})});

/** Public read facade for the existing projection. It neither owns nor clones the organization. */
export function createOrgMcp(deps:McpDependencies): McpServer {
  const server = new McpServer({name:'alchemist-organization',version:'0.1.0'});
  const readAnnotations = {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  const run = async (tool:string,scope:Scope,target:Target|undefined,read:(policy:Policy,project:Project|undefined)=>Promise<Record<string,unknown>>): Promise<CallToolResult> => {
    const requestRef=randomUUID();let decision='backend_unavailable';
    try {
      const policy=deps.policy(), revision=JSON.stringify(policy), project=authorize(policy,scope,target);
      // Audit admission before reading; failure to record it fails closed.
      deps.audit({version:'ac.mcp.audit.v1',requestRef,tool,scope,decision:'authorized',at:Date.now()});
      const data=await read(policy,project);
      const current=deps.policy();authorize(current,scope,target);
      if(JSON.stringify(current)!==revision)throw new PublicError('policy_changed');
      decision='ok';
      deps.audit({version:'ac.mcp.audit.v1',requestRef,tool,scope,decision,at:Date.now()});
      return result({version:'ac.mcp.v1',requestRef,...data});
    } catch(e) {
      decision=e instanceof PublicError?e.code:'backend_unavailable';
      try {deps.audit({version:'ac.mcp.audit.v1',requestRef,tool,scope,decision,at:Date.now()});}catch{decision='audit_unavailable';}
      return result({version:'ac.mcp.v1',requestRef,code:decision},true);
    }
  };
  const projection = async (p:Project,signal?:AbortSignal) => checkedProjection(await deps.source.load(p,signal),p);
  const probe = async (p:Project,budgetMs:number)=>{
    const abort=new AbortController();let timer:NodeJS.Timeout|undefined;
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new PublicError('probe_timeout'));},budgetMs);});
    try{return await Promise.race([projection(p,abort.signal),timeout]);}
    finally{if(timer)clearTimeout(timer);abort.abort();}
  };
  server.registerTool('tac_health',{description:'Read scoped connection status. Prepared/configured is not a successful live connection; execution commands are disabled.',inputSchema:z.object({}).strict(),annotations:readAnnotations},()=>run('tac_health','health:read',undefined,async policy=>{
    const projects:Array<Record<string,unknown>>=[];
    // Probe sequentially: four large streams per project must not multiply peak memory by 16.
    // A global budget also stays below the host's request timeout for 16 slow endpoints.
    const deadline=Date.now()+10_000;
    for(const [index,p] of policy.projects.entries()){
      if(!p.connection){projects.push({orgRef:p.orgRef,projectRef:p.projectRef,state:'prepared',queueAvailable:null});continue;}
      const remaining=deadline-Date.now();
      if(remaining<=0){projects.push({orgRef:p.orgRef,projectRef:p.projectRef,state:'not_probed',queueAvailable:null,reason:'probe_budget_exhausted'});continue;}
      const budget=Math.min(5000,Math.max(1,Math.floor(remaining/(policy.projects.length-index))));
      try {const view=await probe(p,budget);projects.push({orgRef:p.orgRef,projectRef:p.projectRef,state:'connected',queueAvailable:view.streams.length?view.streams.every(s=>s.data.available):null});}
      catch(e){projects.push({orgRef:p.orgRef,projectRef:p.projectRef,state:'unavailable',queueAvailable:null,reason:e instanceof PublicError?e.code:'backend_unavailable'});}
    }
    return {state:projects.length&&projects.every(p=>p.state==='connected')?'connected':'prepared',writesEnabled:false,projects,historyCoverage:'partial',resultDetails:'not_exported'};
  }));
  server.registerTool('tac_organizations',{description:'List only operator-authorized organization/project references. This allowlist does not certify a live connection.',inputSchema:z.object({}).strict(),annotations:readAnnotations},()=>run('tac_organizations','organizations:read',undefined,async policy=>({source:'operator_allowlist',projects:policy.projects.map(p=>({orgRef:p.orgRef,projectRef:p.projectRef,configured:!!p.connection}))})));
  server.registerTool('tac_jobs',{description:'Read scoped jobs from the Dashboard projection, 20 by default and at most 50 per page; no prompts, paths or lease tokens.',inputSchema:jobsSchema,annotations:readAnnotations},args=>run('tac_jobs','jobs:read',args,async(_policy,p)=>{
    const view=await projection(p!);
    const offset=args.offset??0,limit=args.limit??20,knownJobCount=view.streams.reduce((n,s)=>n+(s.data.jobs?.length??0),0);let skip=offset,left=limit;
    const streams=view.streams.map(s=>{
      const all=s.data.jobs,start=all?Math.min(skip,all.length):0;skip-=start;
      const jobs=all?all.slice(start,start+left):null;left-=jobs?.length??0;
      return {streamId:s.streamId,sequence:s.sequence,available:s.data.available,sourceSequence:s.data.sourceSequence,totalJobs:all?.length??null,jobs};
    });
    const next=offset+limit-left;
    return {orgRef:view.orgRef,projectRef:view.projectRef,historyCoverage:'partial',page:{offset,limit,knownJobCount,nextOffset:next<knownJobCount?next:null,unavailableStreams:view.streams.filter(s=>!s.data.available).length},streams};
  }));
  const find = async (p:Project,args:z.infer<typeof jobSchema>)=>{
    const view=await projection(p),stream=view.streams.find(s=>s.streamId===args.streamId);
    if(!stream || !stream.data.available)throw new PublicError(stream?'queue_unavailable':'job_not_found');
    const job=stream.data.jobs!.find(j=>j.taskRef===args.taskRef);if(!job)throw new PublicError('job_not_found');
    return {job,streamId:stream.streamId,sequence:stream.sequence};
  };
  server.registerTool('tac_job',{description:'Read one authorized job by stream and opaque task reference. Missing or unavailable state stays explicit.',inputSchema:jobSchema,annotations:readAnnotations},args=>run('tac_job','jobs:read',args,async(_policy,p)=>find(p!,args)));
  server.registerTool('tac_result',{description:'Read result verification status. Artifact contents, hashes and conversation text are not exported by the current projection.',inputSchema:jobSchema,annotations:readAnnotations},args=>run('tac_result','results:read',args,async(_policy,p)=>{
    const found=await find(p!,args);
    return {taskRef:found.job.taskRef,streamId:found.streamId,sequence:found.sequence,state:found.job.state,verification:found.job.verification,details:'not_exported',artifactRef:null,outputDigest:null};
  }));
  server.registerTool('tac_command',{description:'Reserved versioned command contract. Always disabled until an authorized execution backend implements scopes, approval, audit and idempotency; creates no job.',inputSchema:commandSchema,annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}},args=>run('tac_command',commandScopes[args.action],args,async()=>{throw new PublicError('backend_not_authorized');}));
  return server;
}
