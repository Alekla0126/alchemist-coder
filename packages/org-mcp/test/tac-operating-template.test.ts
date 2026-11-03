import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { portableTemplate, roleContext } from '../../../apps/desktop/src/main/org-context';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=resolve(repo,'templates/tac'),org=resolve(root,'.alchemist/organization');
const json=(file:string)=>JSON.parse(readFileSync(resolve(org,file),'utf8'));
const schema=json('portfolio/backlog.schema.json');
const validate=new AjvJsonSchemaValidator().getValidator<Record<string,any>>(schema);
const sample=()=>json('portfolio/backlog.example.json');
const existingRoles=['coordinator','compliance','factory','strategy','aso','seo','social','writer','analyst','planner','coder','tester','reviewer','uijudge','researcher','finance','sales'];

it('keeps one coordinator and the existing 17 profiles, without engine/model/account identifiers',()=>{
  const manifest=portableTemplate(root);expect(manifest.roles.map(r=>r.id)).toEqual(existingRoles);
  for(const role of manifest.roles){expect(role.permissionMode).toBe('plan');for(const key of ['configId','agent','model','providerId','harnessId'])expect(role).not.toHaveProperty(key);}
  const mandate=json('manifest.json').operatingMandates[0];expect(mandate.coordinatorRole).toBe('coordinator');
  expect(mandate.participatingRoles.every((id:string)=>existingRoles.includes(id))).toBe(true);
  for(const key of ['context','agentContract','briefTemplate','registryExample','registrySchema'])expect(readFileSync(resolve(org,mandate[key]),'utf8').length).toBeGreaterThan(10);
});
it('provides bounded role context with mission, inputs, receipts, sources/scopes and escalation',()=>{
  expect(readdirSync(resolve(org,'roles')).filter(n=>n.endsWith('.md'))).toHaveLength(17);
  for(const id of existingRoles){
    const text=roleContext(root,id);expect(text.length).toBeLessThan(6000);
    for(const label of ['Inputs mínimos:','Salida/recibo:','Éxito:','Fuentes y scopes:','Parada/escalamiento:','Coste y contexto:'])expect(text,`${id}: ${label}`).toContain(label);
    expect(text).toContain('../agent-contract.md');
  }
});
it('validates the synthetic registry and keeps missing evidence/cost/targets unknown and execution disabled',()=>{
  const v=sample(),result=validate(v);expect(result.valid,result.errorMessage).toBe(true);expect(v.synthetic).toBe(true);
  expect(v.readiness).toEqual({phase:'reconcile_private_sources',selectedAppRef:null,commercialExecutionAuthorized:false,knownComputeShare:null});
  expect(v.policy.executable).toBe(false);expect(v.policy.firstExperimentLimit).toBe(1);
  for(const i of v.initiatives){expect(existingRoles).toContain(i.ownerRole);expect(v.apps.some((a:any)=>a.appRef===i.appRef)).toBe(true);expect(i.approvedCost.approvalRef).toBeNull();expect(i.metric.targetDeltaMinor).toBeNull();}
  expect(new Set(v.apps.map((a:any)=>a.appRef)).size).toBe(v.apps.length);expect(new Set(v.initiatives.map((i:any)=>i.id)).size).toBe(v.initiatives.length);
  for(const lesson of v.learning.records){expect(existingRoles).toContain(lesson.reviewerRole);expect(v.initiatives.some((i:any)=>i.id===lesson.initiativeRef)).toBe(true);}
});
it('rejects fabricated zero baselines, unsupported numeric targets and unknown compute treated as measured',()=>{
  for(const edit of [(v:any)=>{v.apps[0].economics.netRevenueMinor=0;},(v:any)=>{v.initiatives[1].metric.targetDeltaMinor=100;},(v:any)=>{v.readiness.knownComputeShare=0;},(v:any)=>{v.readiness.selectedAppRef=v.apps[0].appRef;}]){const v=sample();edit(v);expect(validate(v).valid).toBe(false);}
});
it('requires source references and valid economics types, without treating booleans as amounts',()=>{
  const v=sample();v.apps[0].economics={status:'verified',currency:'USD',periodStart:'2026-10-01',periodEnd:'2026-10-31',basisRef:'fixture-basis',netRevenueMinor:100,attributableCostMinor:30,sourceRefs:['fixture-ledger']};
  expect(validate(v).valid).toBe(true);
  for(const edit of [(x:any)=>{x.sourceRefs=[];},(x:any)=>{x.currency=null;},(x:any)=>{x.netRevenueMinor=true;},(x:any)=>{x.periodStart='2026-02-30';}]){const copy=structuredClone(v);edit(copy.apps[0].economics);expect(validate(copy).valid).toBe(false);}
});
it('requires cost/window references for active proposals and evidence for exceptions or reviewed results',()=>{
  const v=sample();v.initiatives[1].status='running';expect(validate(v).valid).toBe(false);
  for(const edit of [(x:any)=>{x.exception.kind='deadline';},(x:any)=>{x.result.state='reviewed';},(x:any)=>{x.result.costMinor=0;}]){const copy=sample();edit(copy.initiatives[1]);expect(validate(copy).valid).toBe(false);}
});
it('does not promote an unreviewed lesson without sources, dates, receipt and a retention policy',()=>{
  const v=sample();v.learning.records[0].state='reviewed';expect(validate(v).valid).toBe(false);
  Object.assign(v.learning.records[0],{sourceRefs:['fixture-result'],observedAt:'2026-10-31T10:00:00Z',reviewReceiptRef:'fixture-review',reviewedAt:'2026-10-31T11:00:00Z',expiresAt:'2026-12-01T00:00:00Z'});
  expect(validate(v).valid).toBe(false);v.learning.retentionPolicyRef='fixture-retention';expect(validate(v).valid).toBe(true);
});
it('rejects extra credentials, session history and mixed-scope lesson fields from the public contract',()=>{
  for(const edit of [(v:any)=>{v.credentials='DO_NOT_STORE';},(v:any)=>{v.apps[0].session='PRIVATE';},(v:any)=>{v.learning.records[0].orgRef='another-org';}]){const v=sample();edit(v);expect(validate(v).valid).toBe(false);}
});
it('resolves the new canonical index and local operating-document links',()=>{
  const files=['docs/ecosystem/README.md','docs/profitability-growth.md','templates/tac/.alchemist/organization/agent-contract.md','templates/tac/.alchemist/organization/mandates/profitability-growth.md',...existingRoles.map(id=>`templates/tac/.alchemist/organization/roles/${id}.md`)];
  for(const file of files){const absolute=resolve(repo,file),text=readFileSync(absolute,'utf8');for(const match of text.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/g)){const target=match[1]!;if(/^[a-z]+:/i.test(target))continue;expect(()=>readFileSync(resolve(dirname(absolute),target))).not.toThrow();}}
});
