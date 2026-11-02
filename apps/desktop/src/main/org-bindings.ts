import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { BotConfig, PortableOrgEntry, PortableOrgState } from '../shared/api';
import type { PortableTemplate } from './org-context';

type Roles = Record<string, string>;
interface Change { id: string; cwd: string; before: Roles | null; after: Roles }
interface Saved { version: 1; projects: Array<{ cwd: string; roles: Roles }>; changes: Change[] }
export const bindingDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validRole = (value: string) => /^[a-z][a-z0-9-]{0,39}$/.test(value);
const validConfig = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const validRoles = (value: unknown): value is Roles => !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).length <= 40 && Object.entries(value).every(([r, c]) => validRole(r) && validConfig(c)) && new Set(Object.values(value)).size === Object.keys(value).length;
const contains = (root: string, cwd: string) => { const rel = relative(canonicalProject(root), canonicalProject(cwd)); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
/** A binding never extends a saved profile into another project's scope. */
export const bindingApplies = (config: BotConfig, cwd: string) => !config.projects?.length || config.projects.some(root => contains(root, cwd));
const same = (a: unknown, b: unknown) => bindingDigest(a) === bindingDigest(b);
/** Compare physical project identities without rewriting a user's saved aliases. */
export function canonicalProject(cwd: string): string {
  let parent = resolve(cwd); const tail: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(parent), ...tail); }
    catch {
      const next = dirname(parent);
      if (next === parent) return resolve(parent, ...tail);
      tail.unshift(basename(parent)); parent = next;
    }
  }
}

/** Resolve only existing identities. Ambiguous names need configId in the local manifest. */
export function previewBindings(template: PortableTemplate, configs: BotConfig[], cwd: string, saved: Roles): PortableOrgEntry[] {
  const entries: PortableOrgEntry[] = template.roles.map(role => {
    const base = { roleId: role.id, name: role.name };
    const id = role.configId ?? (Object.hasOwn(saved, role.id) ? saved[role.id] : undefined);
    if (id) {
      const config = configs.find(c => c.id === id);
      if (!config) return { ...base, state: 'missing' as const, configId: id };
      if (!bindingApplies(config, cwd) || (role.id === 'coordinator') !== (config.kind === 'coordinator')) return { ...base, state: 'out_of_scope' as const, configId: id };
      return { ...base, state: 'ready' as const, configId: id, configName: config.name };
    }
    const scoped = configs.filter(c => bindingApplies(c, cwd) && (role.id === 'coordinator') === (c.kind === 'coordinator'));
    let matches = role.id === 'coordinator' ? scoped : scoped.filter(c => c.contextRole === role.id || c.name.trim().toLocaleLowerCase() === role.name.trim().toLocaleLowerCase());
    // An exact project binding outranks a global homonym, never a different project.
    const exact = matches.filter(c => c.projects?.some(root => canonicalProject(root) === canonicalProject(cwd)));
    if (exact.length) matches = exact;
    if (matches.length !== 1) return { ...base, state: matches.length ? 'ambiguous' as const : 'missing' as const };
    return { ...base, state: 'ready' as const, configId: matches[0]!.id, configName: matches[0]!.name };
  });
  for (const entry of entries) if (entry.configId && entries.some(other => other !== entry && other.configId === entry.configId)) entry.state = 'ambiguous';
  return entries;
}

/** Private, project-scoped context links; never edits profiles, models or permissions. */
export class OrgBindings {
  constructor(private readonly file: string) {}

  private read(): Saved {
    if (!existsSync(this.file)) return { version: 1, projects: [], changes: [] };
    try {
      if (statSync(this.file).size > 256_000) throw new Error('size');
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
      if (saved.version !== 1 || !Array.isArray(saved.projects) || saved.projects.length > 200 || !Array.isArray(saved.changes) || saved.changes.length > 30) throw new Error('format');
      if (saved.projects.some(p => !p || typeof p.cwd !== 'string' || !isAbsolute(p.cwd) || !validRoles(p.roles)) || new Set(saved.projects.map(p => p.cwd)).size !== saved.projects.length) throw new Error('projects');
      if (saved.changes.some(c => !c || typeof c.id !== 'string' || typeof c.cwd !== 'string' || !isAbsolute(c.cwd) || (c.before !== null && !validRoles(c.before)) || !validRoles(c.after))) throw new Error('history');
      return saved;
    } catch { throw new Error('Portable organization bindings are unreadable; restore or review the private bindings file before executing'); }
  }

  state(cwd: string): PortableOrgState {
    cwd = canonicalProject(cwd);
    const saved = this.read(), roles = saved.projects.find(p => p.cwd === cwd)?.roles ?? {};
    const latest = saved.changes.findLast(c => c.cwd === cwd);
    return { roles: { ...roles }, revision: bindingDigest(saved), ...(latest && same(roles, latest.after) ? { rollbackId: latest.id } : {}) };
  }

  role(cwd: string, configId: string | null): string | undefined {
    if (!configId) return undefined;
    return Object.entries(this.state(cwd).roles).find(([, id]) => id === configId)?.[0];
  }

  private mutate(cwd: string, revision: string, update: (saved: Saved) => boolean): PortableOrgState {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    let lock: number;
    try { lock = openSync(`${this.file}.lock`, 'wx', 0o600); }
    catch { throw new Error('Portable bindings are busy; refresh before retrying'); }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const saved = this.read();
      if (bindingDigest(saved) !== revision) throw new Error('Portable bindings changed; preview again');
      if (update(saved)) {
        const json = JSON.stringify(saved);
        if (Buffer.byteLength(json, 'utf8') > 256_000 || saved.projects.length > 200) throw new Error('Portable bindings limit reached');
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, json); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, this.file);
        if (process.platform !== 'win32') { const dir = openSync(dirname(this.file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      }
      return this.state(cwd);
    } finally { rmSync(temporary, { force: true }); closeSync(lock); rmSync(`${this.file}.lock`, { force: true }); }
  }

  apply(cwd: string, roles: Roles, revision: string): PortableOrgState {
    if (!isAbsolute(cwd) || !validRoles(roles)) throw new Error('Invalid project role bindings');
    cwd = canonicalProject(cwd);
    return this.mutate(cwd, revision, saved => {
      const project = saved.projects.find(p => p.cwd === cwd);
      // Merge additively: a smaller template does not silently remove existing links.
      const after = { ...project?.roles, ...roles };
      if (same(project?.roles ?? {}, after)) return false;
      if (!validRoles(after)) throw new Error('A saved profile is already linked to another role in this project');
      saved.changes.push({ id: randomUUID(), cwd, before: project ? { ...project.roles } : null, after });
      saved.changes = saved.changes.slice(-30);
      if (project) project.roles = after; else saved.projects.push({ cwd, roles: after });
      return true;
    });
  }

  rollback(cwd: string, changeId: string, revision: string): PortableOrgState {
    cwd = canonicalProject(cwd);
    return this.mutate(cwd, revision, saved => {
      const change = saved.changes.findLast(c => c.cwd === cwd), project = saved.projects.find(p => p.cwd === cwd);
      if (!change || change.id !== changeId || !project || !same(project.roles, change.after)) throw new Error('Portable bindings changed; review before rollback');
      if (change.before) project.roles = change.before; else saved.projects = saved.projects.filter(p => p !== project);
      saved.changes = saved.changes.filter(c => c !== change);
      return true;
    });
  }
}
