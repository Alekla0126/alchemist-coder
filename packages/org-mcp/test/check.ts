/** Real stdio MCP client -> same local worker/queue -> real HTTP durable projection. No model. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createDashboardProof } from '../../../examples/dashboard-consumer/proof.ts';
const proof=await createDashboardProof(),dir=mkdtempSync(join(tmpdir(),'ac-mcp-stdio-'));
const client=new Client({name:'ac-local-proof',version:'1.0.0'});
try {
  await proof.dispatchCrash();await proof.restart();
  const connection=proof.readerConnection(),config=join(dir,'mcp.json');
  writeFileSync(config,JSON.stringify({version:'ac.mcp.v1',scopes:['health:read','organizations:read','jobs:read','results:read','jobs:execute'],projects:[{orgRef:'synthetic-org',projectRef:'synthetic-project',connection:{origin:connection.origin,tokenEnv:'TAC_FIXTURE_READER'}}]}),{mode:0o600});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/stdio.js',import.meta.url))],env:{TAC_MCP_CONFIG:config,TAC_FIXTURE_READER:connection.token},stderr:'pipe'});
  let audit='';transport.stderr?.on('data',v=>{audit+=v.toString();});
  await client.connect(transport);
  const call=async(name:string,args:Record<string,unknown>={})=>{
    const r=await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return r.structuredContent as any;
  };
  const health=await call('tac_health');assert.equal(health.state,'connected');assert.equal(health.writesEnabled,false);
  const target={orgRef:'synthetic-org',projectRef:'synthetic-project'},jobs=await call('tac_jobs',target);
  const stream=jobs.streams[0],done=stream.jobs.filter((j:any)=>j.state==='completed'&&j.verification==='verified');assert.equal(done.length,2);
  const result=await call('tac_result',{...target,streamId:stream.streamId,taskRef:done[0].taskRef});assert.equal(result.verification,'verified');assert.equal(result.details,'not_exported');
  const blocked=await client.callTool({name:'tac_command',arguments:{...target,version:'ac.command.v1',action:'dispatch',proposalRef:'fixture-proposal',approvalRef:'fixture-approval',idempotencyKey:'synthetic-command-001'}});
  assert.equal((blocked.structuredContent as any).code,'backend_not_authorized');
  assert.equal(proof.status().executions,2);assert(!audit.includes(connection.token));
  console.log(JSON.stringify({phase:'stdio_mcp_worker_http_dashboard_restart',verified:2,localEffects:2,writesEnabled:false,productionConnected:false,newInferences:0}));
} finally {await client.close();await proof.close();rmSync(dir,{recursive:true,force:true});}
