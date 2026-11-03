import { afterEach, expect, it, vi } from 'vitest';
import { httpProjectionSource, MAX_PROJECTION_BYTES } from '../src/source';
import type { Project } from '../src/policy';
afterEach(()=>vi.unstubAllGlobals());
const project:Project={orgRef:'fixture-org',projectRef:'fixture-project',connection:{origin:'https://fixture.invalid',tokenEnv:'TAC_FIXTURE_READER'}};
it('accepts a valid four-stream response larger than 2 MB and keeps the GET bounded',async()=>{
  const job={taskRef:'1'.repeat(64),teamRef:'2'.repeat(64),botRef:'3'.repeat(64),executor:'local',state:'completed',attempt:1,verification:'verified',reason:null};
  const agent={teamRef:'2'.repeat(64),botRef:'3'.repeat(64),state:'idle',verification:'reported'};
  const view={version:'ac.dashboard.v1',orgRef:project.orgRef,projectRef:project.projectRef,streams:Array.from({length:4},(_,i)=>({streamId:'fixture-'+i,sequence:1,data:{available:true,sourceSequence:1,historyCoverage:'partial',jobs:Array(601).fill(job),agents:Array(2000).fill(agent),events:[]}}))};
  const text=JSON.stringify(view);expect(Buffer.byteLength(text)).toBeGreaterThan(2_000_000);expect(Buffer.byteLength(text)).toBeLessThan(MAX_PROJECTION_BYTES);
  const fetch=vi.fn(async(_input:unknown,_init?:RequestInit)=>new Response(text));vi.stubGlobal('fetch',fetch);
  expect((await httpProjectionSource({TAC_FIXTURE_READER:'synthetic-only'}).load(project) as any).streams).toHaveLength(4);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({redirect:'error'});
  fetch.mockImplementation(async()=>new Response(' '.repeat(MAX_PROJECTION_BYTES+1)));
  await expect(httpProjectionSource({TAC_FIXTURE_READER:'synthetic-only'}).load(project)).rejects.toThrow('projection_too_large');
});
it('does not request a backend without its existing credential or expose raw network errors',async()=>{
  const fetch=vi.fn(async()=>{throw Error('PRIVATE_TOKEN_VALUE');});vi.stubGlobal('fetch',fetch);
  await expect(httpProjectionSource({}).load(project)).rejects.toThrow('credential_unavailable');expect(fetch).not.toHaveBeenCalled();
  await expect(httpProjectionSource({TAC_FIXTURE_READER:'synthetic-only'}).load(project)).rejects.toThrow('backend_unavailable');
});
