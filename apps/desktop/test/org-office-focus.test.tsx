import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BotConfig, BotMember, BotTeam } from '../src/shared/api';
import { translate } from '../src/renderer/src/i18n';
import { departmentOf, departmentsIn, NO_DEPARTMENT, runningElsewhere } from '../src/renderer/src/org-office';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const config = (id: string, name: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const lead = (extra: Partial<BotMember> = {}) => bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, task: 'Plan it', ...extra });
const configs = [
  config('coord', 'Coordinator', { kind: 'coordinator' }),
  config('planner', 'Planner'),
  config('coder', 'Coder', { leadId: 'planner' }),
  config('finance', 'Finance'),
  config('writer', 'Writer', { leadId: 'gone' }),
];
const projects = [
  { cwd: '/p/castbook', name: 'Castbook' },
  { cwd: '/p/komodo', name: 'Komodo' },
];
const now = Date.now();
const here: BotTeam = {
  id: 'team-here',
  title: 'Export to CSV',
  goal: 'Add a CSV export',
  cwd: '/p/castbook',
  createdAt: 0,
  updatedAt: now,
  bots: [lead(), bot('b2', { configId: 'coder', status: 'waiting' }), bot('b3', { configId: 'planner', status: 'done' }), bot('b4', { configId: 'finance' }), bot('b5', { name: 'Helper' }), bot('b6', { configId: 'writer' })],
};
const there: BotTeam = { id: 'team-there', title: 'Fix the VPN', goal: 'Fix the VPN', cwd: '/p/komodo/app', createdAt: 0, updatedAt: now - 10, bots: [lead({ id: 'c1' }), bot('k2', { configId: 'coder' }), bot('k3', { configId: 'finance', status: 'stopped' })] };
const sameProject: BotTeam = { ...there, id: 'team-same', title: 'Docs', cwd: '/p/castbook/docs' };
const finished: BotTeam = { ...there, id: 'team-done', title: 'Old', bots: [lead({ id: 'c1', status: 'done' })] };

describe('the office focused on one assignment', () => {
  it('puts each agent in its department: its lead’s, its own when it leads, else none', () => {
    expect(departmentOf('coder', configs)).toBe('planner');
    expect(departmentOf('planner', configs)).toBe('planner');
    expect(departmentOf('finance', configs)).toBe(NO_DEPARTMENT);
    // Its lead was deleted: no department.
    expect(departmentOf('writer', configs)).toBe(NO_DEPARTMENT);
    expect(departmentOf(null, configs)).toBe(NO_DEPARTMENT);
  });

  it('groups the assignment’s agents by department, the coordinator apart and «No department» last', () => {
    const { coordinator, groups } = departmentsIn(here, configs);
    expect(coordinator.map((a) => a.name)).toEqual(['Coordinator']);
    expect(groups.map((g) => [g.id, g.lead?.name ?? null, g.agents.map((a) => a.name)])).toEqual([
      ['planner', 'Planner', ['Coder', 'Planner']],
      [NO_DEPARTMENT, null, ['Finance', 'Helper', 'Writer']],
    ]);
  });

  it('lists what runs in other projects, not in its own, nor what is finished, with the agents at work', () => {
    const list = runningElsewhere([here, there, sameProject, finished], here, projects);
    expect(list.map((x) => [x.team.id, x.project, x.active])).toEqual([['team-there', 'Komodo', 2]]);
    expect(runningElsewhere([here], here, projects)).toEqual([]);
  });
});

const state = {
  botConfigs: configs,
  botTeams: [here, there] as BotTeam[],
  officeTeamId: null as string | null,
  orgProject: '',
  orgGroup: '',
  orgSettings: null,
  orgFocusTeamId: null,
  orgGoal: '',
  locale: 'en',
  info: null,
  catalog: null,
  projects: [
    { id: 1, cwd: '/p/castbook', name: 'Castbook' },
    { id: 2, cwd: '/p/komodo', name: 'Komodo' },
  ],
  settings: { openProjectIds: [1, 2], activeProjectId: 1 },
  messageBot: async () => {},
  automations: [],
  orgDrafts: {},
};
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) });
vi.mock('../src/renderer/src/store', () => {
  const useStore = Object.assign((pick: (s: unknown) => unknown) => pick(state), { getState: () => state, setState: () => {} });
  return { useStore, useT: () => (key: never, vars?: Record<string, string | number>) => translate('en', key, vars), useOpenProjects: () => state.projects };
});

const { OrgOffice } = await import('../src/renderer/src/components/OrgOffice');
const render = () => renderToStaticMarkup(<OrgOffice title="Studio" editor={() => <form />} views={null} callout={null} />);

describe('the focused office, rendered', () => {
  it('shows the whole office with nothing in focus, then only that assignment, live, by department', () => {
    state.officeTeamId = null;
    const whole = render();
    expect(whole).toContain('📁 Komodo');
    expect(whole).not.toContain('ofc-focus');

    state.officeTeamId = 'team-here';
    const focused = render();
    state.officeTeamId = null;
    expect(focused).toContain('← Whole office');
    expect(focused).toContain('Open the detail →');
    expect(focused).toContain('Export to CSV');
    const stage = focused.slice(focused.indexOf('class="ofc-focus"'), focused.indexOf('class="ofc-talk"'));
    expect(stage.indexOf('<h5>Planner</h5>')).toBeLessThan(stage.indexOf('<h5>Reports to the coordinator</h5>'));
    expect(stage).toContain('Helper');
    // The other project's assignment is a chip on the strip, not a room.
    expect(stage).toContain('Also running in other projects: 1');
    expect(stage).toMatch(/ofc-chip[^>]*>.*Komodo.*Fix the VPN.*org-dot st-working.*2 working/);
    expect(stage).not.toContain('<h4 title="/p/komodo">');
  });

  it('goes from an empty focus to one with agents without breaking (hooks stay in order)', () => {
    const empty: BotTeam = { ...here, id: 'team-empty', bots: [lead({ status: 'stopped' })] };
    state.botTeams = [empty, there];
    state.officeTeamId = 'team-empty';
    const before = render();
    expect(before).toContain('Nobody is working right now');
    expect(before).not.toContain('<h5>');
    state.botTeams = [{ ...empty, bots: [lead(), bot('b2', { configId: 'coder' })] }, there];
    const after = render();
    expect(after).toContain('<h5>Planner</h5>');
    // A focus on an assignment that's gone shows the whole office.
    state.botTeams = [there];
    expect(render()).not.toContain('ofc-focus');
    state.botTeams = [here, there];
    state.officeTeamId = null;
  });

  it('leaves the project menu to the sidebar while it shows', () => {
    const html = render();
    expect(html.slice(html.indexOf('class="ofc-head"'), html.indexOf('class="ofc-main"'))).not.toContain('All projects');
  });

  it('has its texts in Spanish', () => {
    expect(translate('es', 'org.office.allOffice')).toBe('Toda la oficina');
    expect(translate('es', 'org.office.noDepartment')).toBe('Directo al Coordinador');
    expect(translate('es', 'org.office.alsoRunning', { n: 2 })).toBe('También en curso en otros proyectos: 2');
  });
});
