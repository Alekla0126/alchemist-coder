import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BotManager } from '../src/main/bots';
import { OrgBindings, bindingApplies } from '../src/main/org-bindings';
import type { AgentChoice, BotConfig, RunnerEventMessage } from '../src/shared/api';

const dirs: string[] = [];
const managers: BotManager[] = [];
afterEach(() => { managers.splice(0).forEach(b => b.stopAll()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const agent: AgentChoice = { harnessId: 'codex', providerId: 'openai', model: 'fixture-model', effort: 'low' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'org-bindings-')); dirs.push(root);
  const a = join(root, 'Company'), b = join(root, 'MarketingEngine'); mkdirSync(a); mkdirSync(b);
  const files = { configs: join(root, 'configs.json'), teams: join(root, 'teams.json'), org: join(root, 'org.json') };
  const calls: Array<Record<string, unknown>> = [], listeners: Array<(m: RunnerEventMessage) => void> = [];
  const runner = { start: (r: Record<string, unknown>) => { calls.push(r); return { runId: `mock-${calls.length}` }; }, stop: () => {}, send: () => {}, observe: (f: (m: RunnerEventMessage) => void) => { listeners.push(f); return () => {}; } };
  const make = () => { const bot = new BotManager(files, runner as never, { command: 'never', script: 'never' }, p => resolve(String(p)), () => {}); managers.push(bot); return bot; };
  const bots = make();
  const ceo = bots.saveConfig({ name: 'CEO', kind: 'coordinator', role: 'Preserve coordinator instructions', agent, permissionMode: 'default', canSpawn: true });
  const save = (fields: Partial<BotConfig> = {}) => bots.saveConfig({ name: 'Redacción', role: 'Preserve existing role', agent, permissionMode: 'acceptEdits', canSpawn: false, ...fields });
  const manifest = (cwd = a, roles: Array<Record<string, unknown>> = [{ id: 'writer', name: 'Redacción' }]) => {
    const dir = join(cwd, '.alchemist/organization'); mkdirSync(join(dir, 'roles'), { recursive: true });
    const all = [{ id: 'coordinator', name: 'Coordinador', configId: ceo.id }, ...roles].map(r => ({ role: 'Template must not replace saved instructions', permissionMode: 'plan', ...r }));
    for (const role of all) writeFileSync(join(dir, 'roles', `${role.id}.md`), `CONTEXT_${cwd === a ? 'A' : 'B'}_${role.id}`);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, id: 'tac', roles: all }));
  };
  const apply = (cwd = a) => { const p = bots.portableOrg(cwd, agent, false); return bots.portableOrg(cwd, agent, true, p.revision); };
  return { root, a, b, files, bots, ceo, calls, save, manifest, apply, make };
}

it('reuses legacy IDs without contextRole and preserves all saved fields and other-project homonyms', () => {
  const f = fixture(), global = f.save(), company = f.save({ projects: [f.a], about: 'Existing description', ownWorktree: true }), marketing = f.save({ projects: [f.b] });
  f.manifest(); const before = readFileSync(f.files.configs, 'utf8'), preview = f.bots.portableOrg(f.a, agent, false);
  expect(preview.entries.find(e => e.roleId === 'writer')).toMatchObject({ state: 'ready', configId: company.id });
  const applied = f.apply(); expect(applied.state.roles).toEqual({ coordinator: f.ceo.id, writer: company.id });
  expect(f.bots.listConfigs().map(c => c.id)).toEqual([f.ceo.id, global.id, company.id, marketing.id]);
  expect(readFileSync(f.files.configs, 'utf8')).toBe(before);
  expect(f.bots.listConfigs().every(c => c.contextRole === undefined)).toBe(true);
  expect(f.apply().state.rollbackId).toBe(applied.state.rollbackId);
  expect(f.calls).toHaveLength(0);
});

it('requires an explicit in-scope ID for ambiguous names and never falls back from a missing explicit ID', () => {
  const f = fixture(), first = f.save({ projects: [f.a] }); f.save({ projects: [f.a] }); f.manifest();
  let p = f.bots.portableOrg(f.a, agent, false); expect(p.entries[1]?.state).toBe('ambiguous');
  expect(() => f.bots.portableOrg(f.a, agent, true, p.revision)).toThrow(/existing/);
  f.manifest(f.a, [{ id: 'writer', name: 'Redacción', configId: first.id }]); expect(f.apply().state.roles.writer).toBe(first.id);
  f.manifest(f.a, [{ id: 'writer', name: 'Redacción', configId: 'cfg-removed' }]); p = f.bots.portableOrg(f.a, agent, false);
  expect(p.entries[1]).toMatchObject({ state: 'missing', configId: 'cfg-removed' });
  expect(() => f.bots.portableOrg(f.a, agent, true, p.revision)).toThrow(/existing/);
});

it('does not bind another project, a child project to its parent, or one profile to two roles', () => {
  const f = fixture(), other = f.save({ projects: [f.b] });
  f.manifest(f.a, [{ id: 'writer', name: 'Redacción', configId: other.id }]); expect(f.bots.portableOrg(f.a, agent, false).entries[1]?.state).toBe('out_of_scope');
  expect(bindingApplies(other, f.root)).toBe(false); expect(bindingApplies(other, join(f.b, 'child'))).toBe(true);
  const own = f.save({ projects: [f.a] }); f.manifest(f.a, [{ id: 'writer', name: 'Writer', configId: own.id }, { id: 'social', name: 'Social', configId: own.id }]);
  expect(f.bots.portableOrg(f.a, agent, false).entries.slice(1).every(e => e.state === 'ambiguous')).toBe(true);
  expect(f.bots.portableOrgState(f.a).roles).toEqual({});
});

it('links an existing legacy contextRole with a different display name', () => {
  const f = fixture(), writer = f.save({ name: 'Company editor', contextRole: 'writer' }); f.manifest();
  expect(f.apply().state.roles.writer).toBe(writer.id);
  expect(f.bots.listConfigs().find(c => c.id === writer.id)).toEqual(writer);
});

it('retains the existing CEO when old export vocabulary says Coordinador and ignores old model and permission fields', () => {
  const f = fixture(); f.save(); f.manifest();
  const file = join(f.a, '.alchemist/organization/manifest.json'), raw = JSON.parse(readFileSync(file, 'utf8'));
  delete raw.roles[0].configId; raw.roles[0].model = 'opus'; raw.roles[1].model = 'sonnet'; writeFileSync(file, JSON.stringify(raw));
  const before = f.bots.listConfigs(), p = f.bots.portableOrg(f.a, { harnessId: 'claude-code', providerId: 'claude-login', model: 'opus' }, false);
  expect(p.entries[0]).toMatchObject({ configId: f.ceo.id, configName: 'CEO' });
  f.bots.portableOrg(f.a, agent, true, p.revision); expect(f.bots.listConfigs()).toEqual(before);
  expect(f.bots.listConfigs().filter(c => c.kind === 'coordinator')).toHaveLength(1);
});

it('loads a global profile MD only in its linked project and uses its saved Codex selection unchanged', async () => {
  const f = fixture(), writer = f.save(); f.manifest(); f.apply();
  const team = f.bots.startTeam({ cwd: f.a, goal: 'Mock coordinator', configId: f.ceo.id });
  await f.bots.callTool({ teamId: team.id, botId: 'b1' }, 'create_bot', { name: writer.name, config: writer.id, task: 'Mock only' });
  expect(f.calls[0]?.prompt).toContain('CONTEXT_A_coordinator'); expect(f.calls[1]?.prompt).toContain('CONTEXT_A_writer');
  expect(f.calls[1]).toMatchObject({ harnessId: 'codex', model: 'fixture-model', effort: 'low', permissionMode: 'acceptEdits' });
  await f.bots.startSolo({ cwd: f.b, configId: writer.id, task: 'Another project mock' });
  expect(f.calls[2]?.prompt).not.toContain('CONTEXT_A'); expect(f.bots.listConfigs().find(c => c.id === writer.id)?.contextRole).toBeUndefined();
});

it('recovers links across restart without modifying stored profiles or requiring a manifest for rollback', () => {
  const f = fixture(); f.save(); f.manifest(); const applied = f.apply(); f.bots.stopAll();
  const restarted = f.make(); expect(restarted.portableOrgState(f.a).roles).toEqual(applied.state.roles);
  rmSync(join(f.a, '.alchemist'), { recursive: true });
  const state = restarted.portableOrgState(f.a); restarted.rollbackPortableOrg(f.a, state.rollbackId!, state.revision);
  expect(restarted.portableOrgState(f.a).roles).toEqual({}); expect(restarted.listConfigs()).toEqual(f.bots.listConfigs());
});

it('blocks apply and rollback while the project is running without stopping that work', () => {
  const f = fixture(); f.save(); f.manifest(); const applied = f.apply();
  const team = f.bots.startTeam({ cwd: f.a, goal: 'Existing user work', configId: f.ceo.id });
  const p = f.bots.portableOrg(f.a, agent, false);
  expect(() => f.bots.portableOrg(f.a, agent, true, p.revision)).toThrow(/pending organization work/);
  expect(() => f.bots.rollbackPortableOrg(f.a, applied.state.rollbackId!, applied.state.revision)).toThrow(/pending organization work/);
  expect(f.bots.listTeams().find(t => t.id === team.id)?.bots[0]?.status).toBe('working'); expect(f.calls).toHaveLength(1);
});

it('blocks linking a pending plan or a durable job interrupted at restart', async () => {
  const f = fixture(); f.save(); f.manifest();
  const t = f.bots.startTeam({ cwd: f.a, goal: 'Pending', configId: f.ceo.id, durable: { maxParallel: 1, maxAttempts: 2, resumePreauthorized: false }, approvePlan: true });
  await f.bots.callTool({ teamId: t.id, botId: 'b1' }, 'propose_plan', { summary: 'Mock', bots: [{ name: 'Redacción', task: 'Mock only', config: 'Redacción' }] }); f.bots.flush(); f.bots.stopAll();
  const restarted = f.make(), p = restarted.portableOrg(f.a, agent, false);
  expect(() => restarted.portableOrg(f.a, agent, true, p.revision)).toThrow(/pending organization work/); expect(f.calls).toHaveLength(1);
});

it('rejects stale previews after models, instructions, MD or manifest edits', () => {
  const f = fixture(), member = f.save(); f.manifest();
  let p = f.bots.portableOrg(f.a, agent, false); f.bots.saveConfig({ ...member, agent: { ...agent, model: 'new-preference' } });
  expect(() => f.bots.portableOrg(f.a, agent, true, p.revision)).toThrow(/preview again/);
  p = f.bots.portableOrg(f.a, agent, false); writeFileSync(join(f.a, '.alchemist/organization/roles/writer.md'), 'Changed context');
  expect(() => f.bots.portableOrg(f.a, agent, true, p.revision)).toThrow(/preview again/);
  p = f.bots.portableOrg(f.a, agent, false); f.manifest(f.a, [{ id: 'writer', name: 'New label', configId: member.id }]);
  expect(() => f.bots.portableOrg(f.a, agent, true, p.revision)).toThrow(/preview again/);
  expect(f.bots.portableOrgState(f.a).roles).toEqual({});
});

it('detects external exporter writes instead of overwriting profiles from a stale open window', () => {
  const f = fixture(); f.save(); f.manifest(); const before = f.bots.portableOrg(f.a, agent, false);
  const external = f.bots.listConfigs(); external[0]!.name = 'Changed outside this window'; writeFileSync(f.files.configs, JSON.stringify(external));
  expect(() => f.bots.portableOrg(f.a, agent, true, before.revision)).toThrow(/outside this window/);
  expect(JSON.parse(readFileSync(f.files.configs, 'utf8'))).toEqual(external); expect(f.bots.portableOrgState(f.a).roles).toEqual({});
});

it('rolls back only the selected project and refuses a stale receipt after a later project edit', () => {
  const f = fixture(), writer = f.save(); f.manifest(); f.manifest(f.b); const first = f.apply(); const other = f.apply(f.b);
  let current = f.bots.portableOrgState(f.a); f.bots.rollbackPortableOrg(f.a, first.state.rollbackId!, current.revision);
  expect(f.bots.portableOrgState(f.a).roles).toEqual({}); expect(f.bots.portableOrgState(f.b).roles).toEqual(other.state.roles);
  const old = f.apply(), alternative = f.save({ name: 'Alternative' }); f.manifest(f.a, [{ id: 'writer', name: 'Redacción', configId: alternative.id }]); f.apply();
  current = f.bots.portableOrgState(f.a);
  expect(() => f.bots.rollbackPortableOrg(f.a, old.state.rollbackId!, current.revision)).toThrow(/review before rollback/);
  expect(f.bots.portableOrgState(f.a).roles.writer).toBe(alternative.id); expect(f.bots.listConfigs().find(c => c.id === writer.id)?.agent).toEqual(agent);
});

it('fails closed on corrupt bindings and keeps the original file without executing a model', async () => {
  const f = fixture(), member = f.save(); f.manifest(); const file = join(f.root, 'org-bindings.json'); writeFileSync(file, 'broken');
  expect(() => f.bots.portableOrgState(f.a)).toThrow(/unreadable/);
  await expect(f.bots.startSolo({ cwd: f.a, configId: member.id, task: 'Must not run' })).rejects.toThrow(/unreadable/);
  expect(f.calls).toHaveLength(0); expect(readFileSync(file, 'utf8')).toBe('broken');
});

it('keeps bindings unchanged if another writer holds the lock', () => {
  const f = fixture(); f.save(); f.manifest(); const applied = f.apply(), file = join(f.root, 'org-bindings.json'), before = readFileSync(file, 'utf8');
  writeFileSync(`${file}.lock`, 'other writer');
  expect(() => f.bots.rollbackPortableOrg(f.a, applied.state.rollbackId!, applied.state.revision)).toThrow(/busy/);
  expect(readFileSync(file, 'utf8')).toBe(before); expect(readFileSync(`${file}.lock`, 'utf8')).toBe('other writer');
});

it('merges links additively and rolls them back without removing earlier links or creating repeated receipts', () => {
  const f = fixture(), store = new OrgBindings(join(f.root, 'direct-bindings.json'));
  const first = store.apply(f.a, { coordinator: f.ceo.id }, store.state(f.a).revision);
  const second = store.apply(f.a, { writer: 'cfg-writer' }, first.revision);
  const same = store.apply(f.a, { coordinator: f.ceo.id }, second.revision); expect(same).toEqual(second);
  expect(() => store.apply(f.a, { social: 'cfg-writer' }, same.revision)).toThrow(/already linked/);
  store.rollback(f.a, same.rollbackId!, same.revision); expect(store.state(f.a).roles).toEqual(first.roles);
});

it('enforces the storage limit in UTF-8 bytes before a Unicode path can make the saved file unreadable', () => {
  const f = fixture(), file = join(f.root, 'unicode-bindings.json'), store = new OrgBindings(file);
  const before = store.apply(f.a, { coordinator: f.ceo.id }, store.state(f.a).revision), bytes = readFileSync(file, 'utf8');
  expect(() => store.apply(join(f.root, '界'.repeat(85_000)), { coordinator: f.ceo.id }, before.revision)).toThrow(/limit reached/);
  expect(readFileSync(file, 'utf8')).toBe(bytes); expect(store.state(f.a)).toEqual(before);
});

it('recognizes physical project aliases without rewriting scope strings or choosing another project', async () => {
  const f = fixture(), alias = join(f.root, 'CompanyAlias'); symlinkSync(f.a, alias, 'junction');
  f.save(); const scoped = f.save({ projects: [alias] }), other = f.save({ projects: [f.b] }); f.manifest();
  expect(f.bots.portableOrg(f.a, agent, false).entries[1]?.configId).toBe(scoped.id);
  const applied = f.apply(); expect(f.bots.portableOrgState(alias)).toEqual(applied.state);
  await f.bots.startSolo({ cwd: f.a, configId: scoped.id, task: 'Alias fixture' }); expect(f.calls[0]?.prompt).toContain('CONTEXT_A_writer');
  expect(f.bots.listConfigs().find(c => c.id === scoped.id)?.projects).toEqual([alias]); expect(bindingApplies(other, alias)).toBe(false);
});

it('does not inject a linked role through a different legacy profile fallback', async () => {
  const f = fixture(), owner = f.save(), other = f.save({ name: 'Another writer', contextRole: 'writer' });
  f.manifest(f.a, [{ id: 'writer', name: owner.name, configId: owner.id }]); f.manifest(f.b); f.apply();
  await expect(f.bots.startSolo({ cwd: f.a, configId: other.id, task: 'Wrong role owner' })).rejects.toThrow(/different profile/);
  expect(f.calls).toHaveLength(0);
  await f.bots.startSolo({ cwd: f.b, configId: other.id, task: 'Legacy context in other project' }); expect(f.calls[0]?.prompt).toContain('CONTEXT_B_writer');
});

it('does not give a replacement coordinator the previously linked coordinator context implicitly', () => {
  const f = fixture(); f.save(); f.manifest(); f.apply();
  const replacement = f.save({ name: 'New CEO', kind: 'coordinator', canSpawn: true });
  expect(() => f.bots.startTeam({ cwd: f.a, configId: replacement.id, goal: 'New coordinator mock' })).toThrow(/different profile/);
  expect(f.calls).toHaveLength(0);
});
