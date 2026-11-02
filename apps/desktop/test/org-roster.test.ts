import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BotManager } from '../src/main/bots';
import { writeBridge } from '../src/main/bots-bridge';
import { cleanStarters } from '../src/main/ipc';
import { ROSTER, ROSTER_DEPARTMENTS, rosterOf, tierModels } from '../src/renderer/src/org-roster';
import { translate } from '../src/renderer/src/i18n';

const dir = mkdtempSync(join(tmpdir(), 'roster-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const agent = { harnessId: 'claude-code', providerId: 'claude-login', model: 'default' };
const runner = { start: () => ({ runId: 'r' }), send() {}, stop() {}, observe: () => () => {} };
function setup() {
  const files = { configs: join(dir, `c-${Math.random()}.json`), teams: join(dir, `t-${Math.random()}.json`), org: join(dir, `o-${Math.random()}.json`) };
  return { files, bots: new BotManager(files, runner as never, { command: process.execPath, script: writeBridge(dir) }, (cwd) => String(cwd), () => {}) };
}
// A Claude login lists the tiers by name ("opus", "sonnet", "haiku").
const es = rosterOf((key) => translate('es', key), (tier) => tier);

describe("the house staff (The Alchemist Code's)", () => {
  it('has the company’s 17 agents in 6 departments, named like its org chart', () => {
    expect(ROSTER).toHaveLength(17);
    expect(ROSTER_DEPARTMENTS).toBe(6);
    expect(Object.values(es).map((a) => a.name)).toEqual([
      'Coordinador',
      'Tiendas y cumplimiento',
      'Fábrica de apps',
      'Estrategia',
      'ASO y crecimiento',
      'SEO y tiendas',
      'Redes sociales',
      'Redacción',
      'Análisis',
      'Planificador',
      'Programador',
      'Tester',
      'Revisor',
      'Juez de interfaz',
      'Investigador',
      'Finanzas y monetización',
      'Ventas del Estudio',
    ]);
    // Every agent has a role in every language the app speaks.
    for (const locale of ['en', 'es', 'pt-BR', 'fr', 'de', 'it', 'ru', 'ja', 'ko', 'zh-CN', 'hi'] as const)
      for (const a of Object.values(rosterOf((key) => translate(locale, key)))) expect(a.role, `${locale} ${a.name}`).not.toMatch(/^bots\.starter\./);
  });

  it('starts a new organization with it: each lead with its team, the model by tier on Claude Code', () => {
    const { bots } = setup();
    const list = bots.ensureOrg(agent, cleanStarters(es));
    const by = (name: string) => list.find((c) => c.name === name)!;
    expect(list).toHaveLength(17);
    expect(by('Coordinador')).toMatchObject({ kind: 'coordinator', canSpawn: true, agent: { model: 'opus' } });
    expect(by('Programador')).toMatchObject({ leadId: by('Planificador').id, agent: { model: 'sonnet' }, permissionMode: 'acceptEdits' });
    expect(by('Revisor')).toMatchObject({ leadId: by('Planificador').id, agent: { model: 'opus' }, permissionMode: 'default' });
    expect(by('Análisis')).toMatchObject({ leadId: by('Estrategia').id, agent: { model: 'haiku' } });
    expect(by('ASO y crecimiento')).toMatchObject({ ownWorktree: true });
    expect(by('Estrategia').leadId ?? null).toBeNull();
    // A vacancy shows as suggested.
    expect(by('Ventas del Estudio').proposed).toBe(true);
    // Another agent keeps its own model: tiers are Claude Code's names.
    const codexAgent = { harnessId: 'codex', providerId: 'openai', model: 'gpt-5.5' };
    const catalog = { harnesses: [], providers: [{ id: 'openai', models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }] }, { id: 'anthropic', models: [{ id: 'claude-opus-4-8' }, { id: 'claude-sonnet-5' }, { id: 'claude-haiku-4-5' }] }] } as never;
    const codex = setup().bots.ensureOrg(codexAgent, cleanStarters(rosterOf((key) => translate('es', key), tierModels(catalog, codexAgent))));
    expect(new Set(codex.map((c) => c.agent.model))).toEqual(new Set(['gpt-5.5']));
    // With an API key, a tier is the provider's model of that family.
    const api = rosterOf((key) => translate('es', key), tierModels(catalog, { harnessId: 'claude-code', providerId: 'anthropic', model: 'claude-sonnet-5' }));
    expect([api.coordinator!.model, api.coder!.model, api.analyst!.model]).toEqual(['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']);
  });

  it('renews an organization to it: says what it would do first, then adds, sets teams and models and drops copies', () => {
    const { bots, files } = setup();
    bots.ensureOrg(agent, { coordinator: { name: 'Coordinador', role: 'Reparte' } });
    const mine = bots.saveConfig({ name: 'Programador', role: 'Mi rol escrito a mano', agent, permissionMode: 'bypassPermissions', canSpawn: false, projects: ['/p'] });
    bots.saveConfig({ name: 'Estrategia', role: 'Elige acciones', agent, permissionMode: 'acceptEdits', canSpawn: false, projects: ['/marketing'] });
    bots.saveConfig({ name: 'Estrategia', role: 'Elige acciones', agent, permissionMode: 'acceptEdits', canSpawn: false, projects: ['/empresa'] });
    const before = readFileSync(files.configs, 'utf8');
    const house = 'Gasta pocos tokens.';

    const plan = bots.renewStaff(agent, cleanStarters(es), house, false);
    expect(plan.added).toHaveLength(14);
    expect(plan.updated.sort()).toEqual(['Coordinador', 'Estrategia', 'Programador']);
    expect(plan.removed).toEqual(['Estrategia']);
    expect(plan.instructions).toBe(true);
    // Trying it out wrote nothing and changed nothing.
    expect(readFileSync(files.configs, 'utf8')).toBe(before);
    expect(bots.listConfigs()).toHaveLength(4);
    expect(bots.orgSettings().instructions).toBe('');

    expect(bots.renewStaff(agent, cleanStarters(es), house, true)).toEqual(plan);
    const list = bots.listConfigs();
    const by = (name: string) => list.filter((c) => c.name === name);
    expect(list).toHaveLength(17);
    expect(by('Estrategia')).toHaveLength(1);
    // The copy that went handed its project to the one that stayed.
    expect(by('Estrategia')[0]!.projects).toEqual(['/marketing', '/empresa']);
    // What you wrote stays; its team, model and permissions are the staff's.
    expect(by('Programador')[0]).toMatchObject({ id: mine.id, role: 'Mi rol escrito a mano', projects: ['/p'], permissionMode: 'acceptEdits', agent: { model: 'sonnet' }, leadId: by('Planificador')[0]!.id });
    expect(by('Coordinador')[0]).toMatchObject({ kind: 'coordinator', agent: { model: 'opus' } });
    expect(bots.orgSettings().instructions).toBe(house);
    expect(JSON.parse(readFileSync(files.configs, 'utf8'))).toHaveLength(17);
    // Once it's there, renewing again changes nothing.
    expect(bots.renewStaff(agent, cleanStarters(es), house, false)).toEqual({ added: [], updated: [], removed: [], instructions: false });
  });

  it('takes from the window only what a staff template has', () => {
    expect(cleanStarters({ x: { name: 'A', role: 'r', tier: 'gpt', model: '$(rm -rf /)', permissionMode: 'yolo', lead: '../etc', canSpawn: 'yes', extra: 1 }, 'bad key!': { name: 'B' } })).toEqual({ x: { name: 'A', role: 'r' } });
    expect(cleanStarters({ x: { name: 'A', role: 'r', model: 'opus[1m]' } }).x!.model).toBe('opus[1m]');
  });
});
