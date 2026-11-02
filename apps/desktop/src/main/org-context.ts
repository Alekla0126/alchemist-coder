import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
/** Role files are local project context, never account credentials or this assistant's identity. */
export function roleContext(cwd: string, roleId: string | undefined): string {
  if (!roleId) return '';
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(roleId)) throw new Error('Invalid portable organization role');
  const file = join(cwd, '.alchemist', 'organization', 'roles', `${roleId}.md`);
  if (!existsSync(file)) throw new Error(`Portable role context is missing: ${roleId}.md`);
  const root = realpathSync(cwd), real = realpathSync(file), rel = relative(root, real);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Portable role context is outside the project');
  if (statSync(real).size > 16_000) throw new Error('Portable role context exceeds 16 KB');
  const text = readFileSync(real, 'utf8');
  return `\nPortable role context (${roleId}.md):\n${text.slice(0, 6000)}`;
}

export interface PortableRole { id: string; name: string; role: string; configId?: string; lead?: string; permissionMode: 'plan' | 'default' | 'acceptEdits'; canSpawn?: boolean; executorId?: 'local' | 'vps' }
export interface PortableTemplate { version: 1; id: string; roles: PortableRole[] }
/** Preview/import uses the same project boundary and bounded role files as execution. */
export function portableTemplate(cwd: string): PortableTemplate {
  const file = join(cwd, '.alchemist', 'organization', 'manifest.json');
  const root = realpathSync(cwd), real = realpathSync(file), rel = relative(root, real);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || statSync(real).size > 32_000) throw new Error('Invalid portable organization manifest');
  const raw = JSON.parse(readFileSync(real, 'utf8')) as PortableTemplate;
  if (raw.version !== 1 || raw.id !== 'tac' || !Array.isArray(raw.roles) || !raw.roles.length || raw.roles.length > 40) throw new Error('Unsupported portable organization template');
  const ids = new Set<string>();
  for (const r of raw.roles) {
    if (!r || typeof r.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(r.id) || ids.has(r.id) || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 60 || typeof r.role !== 'string' || r.role.length > 1000 || !['plan','default','acceptEdits'].includes(r.permissionMode) || (r.executorId !== undefined && !['local','vps'].includes(r.executorId))) throw new Error('Invalid portable organization role');
    ids.add(r.id); roleContext(cwd, r.id);
    if (r.configId !== undefined && (typeof r.configId !== 'string' || !/^[\w-]{1,100}$/.test(r.configId))) throw new Error('Invalid existing profile ID');
  }
  if (!ids.has('coordinator')) throw new Error('The portable template needs a coordinator');
  for (const r of raw.roles) if (r.lead && (!ids.has(r.lead) || r.lead === r.id || raw.roles.find(p => p.id === r.lead)?.lead)) throw new Error('Portable departments may be one level deep');
  return raw;
}
