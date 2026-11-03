import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod/v4';

export const refSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
export const opaqueSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const scopes = ['health:read','organizations:read','jobs:read','results:read','proposals:write','approvals:write','jobs:execute','jobs:cancel'] as const;
export type Scope = typeof scopes[number];
const origin = z.string().url().refine(value=>{
  try { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && (u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(u.hostname)); }
  catch { return false; }
});
const project = z.object({orgRef:refSchema,projectRef:refSchema,connection:z.object({origin,tokenEnv:z.string().regex(/^TAC_[A-Z0-9_]{1,64}$/)}).strict().nullable()}).strict();
export const policySchema = z.object({version:z.literal('ac.mcp.v1'),scopes:z.array(z.enum(scopes)).max(scopes.length),projects:z.array(project).max(16)}).strict().refine(p=>new Set(p.projects.map(x=>x.orgRef+':'+x.projectRef)).size===p.projects.length);
export type Policy = z.infer<typeof policySchema>;
export type Project = Policy['projects'][number];
export const defaultPolicy = (): Policy => ({version:'ac.mcp.v1',scopes:['health:read','organizations:read','jobs:read','results:read'],projects:[]});
export function readPolicy(file: string | undefined): Policy {
  if (!file) return defaultPolicy();
  try {
    if (statSync(file).size > 32_768) throw Error();
    return policySchema.parse(JSON.parse(readFileSync(file,'utf8')));
  } catch { throw new PublicError('policy_unavailable'); }
}
export class PublicError extends Error { constructor(readonly code: string) { super(code); } }
export function authorize(policy: Policy, scope: Scope, target?: {orgRef:string;projectRef:string}): Project | undefined {
  if (!policy.scopes.includes(scope)) throw new PublicError('scope_denied');
  if (!target) return undefined;
  const project = policy.projects.find(p=>p.orgRef===target.orgRef&&p.projectRef===target.projectRef);
  if (!project) throw new PublicError('scope_denied');
  return project;
}
