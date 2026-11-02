import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BotConfig, BotMember, BotTeam, OrgGroup, OrgSettings } from '../src/shared/api';
import { translate } from '../src/renderer/src/i18n';
import { groupOf, hiddenWhere, memberInGroup, needsYouText, newGroupId, teamInGroup, toggleFolder } from '../src/renderer/src/org-groups';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const config = (id: string, name: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const lead = (extra: Partial<BotMember> = {}) => bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, task: 'Plan it', ...extra });

const coder: OrgGroup = { id: 'mobile', name: 'Mobile', projects: ['/p/coder'] };
const clients: OrgGroup = { id: 'clients', name: 'Clients', projects: [] };
const team = (id: string, cwd: string, bots: BotMember[] = [lead()]): BotTeam => ({ id, title: id, goal: id, cwd, createdAt: 0, updatedAt: Date.now(), bots });

describe('organizations as groups of folders', () => {
  it('shows an assignment under the organization its folder is in, and every one with none chosen', () => {
    expect(teamInGroup(team('a', '/p/coder/apps/desktop'), coder)).toBe(true);
    expect(teamInGroup(team('b', '/p/coder-other'), coder)).toBe(false);
    expect(teamInGroup(team('c', '/p/komodo'), null)).toBe(true);
    // One with no folders shows nothing.
    expect(teamInGroup(team('d', '/p/coder'), clients)).toBe(false);
  });

  it('shows an agent of one of its projects, and the coordinator and agents for every project always', () => {
    expect(memberInGroup(config('a', 'A', { projects: ['/p/coder'] }), coder)).toBe(true);
    expect(memberInGroup(config('b', 'B', { projects: ['/p/coder/sub'] }), coder)).toBe(true);
    expect(memberInGroup(config('c', 'C', { projects: ['/p/komodo'] }), coder)).toBe(false);
    expect(memberInGroup(config('d', 'D'), clients)).toBe(true);
    expect(memberInGroup(config('e', 'E', { kind: 'coordinator', projects: ['/x'] }), coder)).toBe(true);
  });

  it('names new ones apart and adds or takes out one folder at a time', () => {
    expect(newGroupId('Side projects', [coder])).toBe('side-projects');
    expect(newGroupId('Clients', [clients])).toBe('clients-2');
    expect(newGroupId('¡¡!!', [])).toBe('org');
    const once = toggleFolder([coder, clients], 'clients', '/p/li');
    expect(once[1]!.projects).toEqual(['/p/li']);
    expect(toggleFolder(once, 'clients', '/p/li')[1]!.projects).toEqual([]);
    expect(once[0]).toBe(coder);
  });

  it('says where what needs you is when the filters hide it', () => {
    const li = { ...clients, projects: ['/p/li'] };
    expect(hiddenWhere(team('a', '/p/coder/x'), coder, '', [coder, li])).toBeNull();
    expect(hiddenWhere(team('b', '/p/li/app'), coder, '', [coder, li])).toBe('Clients');
    // In no organization: its folder's name.
    expect(hiddenWhere(team('c', '/home/u'), coder, '', [coder, li])).toBe('u');
    // Hidden by the project filter: its folder.
    expect(hiddenWhere(team('d', '/p/coder/web'), null, '/p/coder/app', [coder])).toBe('web');
    const es = (key: never, vars?: Record<string, string | number>) => translate('es', key, vars);
    expect(needsYouText(es, 1, ['Mobile'])).toBe('1 te necesita (en Mobile)');
    expect(needsYouText(es, 3, ['Mobile'])).toBe('3 te necesitan (1 en Mobile)');
    expect(needsYouText(es, 2, [])).toBe('2 te necesitan');
    expect(needsYouText(es, 0, [])).toBe('');
  });

  it('forgets a chosen organization that no longer exists', () => {
    const org = { name: 'x', instructions: '', autopilot: false, lessons: [], groups: [coder] } satisfies OrgSettings;
    expect(groupOf(org, 'mobile')).toBe(coder);
    expect(groupOf(org, 'gone')).toBeNull();
    expect(groupOf(org, '')).toBeNull();
    expect(groupOf(null, 'mobile')).toBeNull();
  });
});

const configs = [config('coord', 'Coordinator', { kind: 'coordinator' }), config('dev', 'Dev', { projects: ['/p/coder'] }), config('vpn', 'VpnGuy', { projects: ['/p/komodo'] }), config('any', 'Anyone')];
const state = {
  botConfigs: configs,
  botTeams: [team('Coder work', '/p/coder', [lead(), bot('b2', { configId: 'dev' })]), team('VPN work', '/p/komodo', [lead({ id: 'c1' }), bot('k2', { configId: 'vpn' })])] as BotTeam[],
  officeTeamId: null as string | null,
  orgProject: '',
  orgGroup: '',
  orgSettings: { name: 'My organization', instructions: '', autopilot: false, lessons: [], groups: [coder, clients] } as OrgSettings,
  orgFocusTeamId: null,
  orgGoal: '',
  locale: 'en',
  info: null,
  catalog: null,
  projects: [
    { id: 1, cwd: '/p/coder', name: 'Coder' },
    { id: 2, cwd: '/p/komodo', name: 'Komodo' },
  ],
  settings: { openProjectIds: [1, 2], activeProjectId: 1 },
  messageBot: async () => {},
  automations: [],
  orgDrafts: {},
  activeTeamId: null,
  activeMemberId: null,
  activeAutomationId: null,
  orgOffice: true,
  runs: {},
};
// The sidebar folded (the office then has its own project menu); SSR reads the stores' first state.
const memory = new Map<string, string>([['alchemist.layout', JSON.stringify({ sideHidden: true })]]);
vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) });
vi.mock('../src/renderer/src/store', () => {
  const useStore = Object.assign((pick: (s: unknown) => unknown) => pick(state), { getState: () => state, setState: () => {} });
  return { useStore, useT: () => (key: never, vars?: Record<string, string | number>) => translate('en', key, vars), useOpenProjects: () => state.projects };
});

const { OrgOffice } = await import('../src/renderer/src/components/OrgOffice');
const { OrgSidebar } = await import('../src/renderer/src/components/Org');
const { OrgGroupPicker } = await import('../src/renderer/src/components/OrgGroups');
const { OrgComposer } = await import('../src/renderer/src/components/OrgComposer');
const render = () => renderToStaticMarkup(<OrgOffice title="Studio" editor={() => <form />} views={null} callout={null} />);
const depts = (html: string) => html.slice(html.indexOf('class="ofc-depts"'));

describe('the office filtered by organization', () => {
  it('shows everything with «All», then only that organization’s rooms and agents', () => {
    state.orgGroup = '';
    const all = render();
    expect(all).toContain('📁 Komodo');
    expect(all).toContain('📁 Coder');
    state.orgGroup = 'mobile';
    const one = render();
    expect(one).toContain('📁 Coder');
    expect(one).not.toContain('📁 Komodo');
    // Its departments: its agents and those for every project, not the other organization's.
    expect(all).toContain('>VpnGuy</option>');
    expect(one).not.toContain('>VpnGuy</option>');
    expect(one).toContain('>Dev</option>');
    expect(one).toContain('>Anyone</option>');
    expect(depts(all)).toContain('Reports to the coordinator');
    state.orgGroup = '';
  });

  it('keeps what runs in another organization on the focused office’s strip', () => {
    state.orgGroup = 'mobile';
    state.officeTeamId = 'Coder work';
    const html = render();
    state.officeTeamId = null;
    state.orgGroup = '';
    expect(html).toContain('Also running in other projects: 1');
    expect(html).toMatch(/ofc-chip[^>]*>.*Komodo.*VPN work/);
  });

  it('asks for folders when the organization has none, and shows its work once it has some', () => {
    state.orgGroup = 'clients';
    const empty = render();
    expect(empty).toContain('Assign folders to this organization');
    expect(empty).not.toContain('ofc-room');
    state.orgSettings = { ...state.orgSettings, groups: [coder, { ...clients, projects: ['/p/komodo'] }] };
    const after = render();
    expect(after).not.toContain('Assign folders to this organization');
    expect(after).toContain('📁 Komodo');
    state.orgSettings = { ...state.orgSettings, groups: [coder, clients] };
    state.orgGroup = '';
  });

  it('offers All, each organization and a new one beside the name, and the folders of the chosen one', () => {
    state.orgGroup = '';
    const picker = renderToStaticMarkup(<OrgGroupPicker />);
    expect(picker).toMatch(/<option value="" selected="">All organizations<\/option><option value="mobile">Mobile<\/option><option value="clients">Clients<\/option><option value="__new">\+ New…<\/option>/);
    expect(picker).not.toContain('Folders of');
    state.orgGroup = 'clients';
    expect(renderToStaticMarkup(<OrgGroupPicker />)).toContain('aria-label="Folders of Clients"');
    // One deleted elsewhere: back to All.
    state.orgGroup = 'gone';
    expect(renderToStaticMarkup(<OrgGroupPicker />)).toContain('<option value="" selected="">All organizations</option>');
    state.orgGroup = '';
  });

  it('with the sidebar folded, has the project menu on the office, with the organization’s folders only', () => {
    const header = (html: string) => html.slice(html.indexOf('class="ofc-head"'), html.indexOf('class="ofc-main"'));
    expect(header(render())).toContain('<option value="/p/komodo">Komodo</option>');
    state.orgSettings = { ...state.orgSettings, groups: [{ ...coder, projects: ['/p/coder', '/p/coder2'] }, clients] };
    state.projects = [...state.projects, { id: 3, cwd: '/p/coder2', name: 'Coder 2' }];
    state.orgGroup = 'mobile';
    const mine = header(render());
    expect(mine).toContain('Coder 2');
    expect(mine).not.toContain('Komodo');
    state.projects = state.projects.slice(0, 2);
    state.orgSettings = { ...state.orgSettings, groups: [coder, clients] };
    state.orgGroup = '';
  });

  it('starts the box on the focused assignment’s folder, else on the organization’s first', () => {
    const chip = (html: string) => /title="Project"[^>]*>(?:<[^>]+>)*([^<]+)</.exec(html.slice(html.indexOf('class="ofc-talk"')))?.[1];
    state.officeTeamId = 'VPN work';
    expect(chip(render())).toBe('Komodo');
    state.officeTeamId = null;
    state.orgSettings = { ...state.orgSettings, groups: [coder, { ...clients, projects: ['/p/komodo'] }] };
    state.orgGroup = 'clients';
    expect(chip(render())).toBe('Komodo');
    state.orgSettings = { ...state.orgSettings, groups: [coder, clients] };
    state.orgGroup = '';
    expect(chip(render())).toBe('Coder');
  });

  it('starts the box on the project you filtered to, over a focus, and on a focus only while the office shows', () => {
    const chipOf = () => /title="Project"[^>]*>(?:<[^>]+>)*([^<]+)</.exec(renderToStaticMarkup(<OrgComposer coordinator={configs[0]} examples={false} />))?.[1];
    state.officeTeamId = 'VPN work';
    // Filter on Coder + an old focus on Komodo + the chart: Coder.
    state.orgProject = '/p/coder';
    state.orgOffice = false;
    expect(chipOf()).toBe('Coder');
    // The same on the office: your filter still wins.
    state.orgOffice = true;
    expect(chipOf()).toBe('Coder');
    // No filter: the focus on the office, but not on the chart (the project you're in, Coder).
    state.orgProject = '';
    expect(chipOf()).toBe('Komodo');
    state.orgOffice = false;
    expect(chipOf()).toBe('Coder');
    state.orgOffice = true;
    state.officeTeamId = null;
  });

  it('says so when the organization and the project leave the sidebar empty', () => {
    state.orgSettings = { ...state.orgSettings, groups: [{ ...coder, projects: ['/p/coder', '/p/komodo'] }, clients] };
    state.orgGroup = 'mobile';
    state.orgProject = '/p/empty';
    const side = renderToStaticMarkup(<OrgSidebar />);
    expect(side).toContain('No assignments of empty in Mobile.');
    state.orgProject = '/p/coder';
    expect(renderToStaticMarkup(<OrgSidebar />)).not.toContain('No assignments of');
    state.orgProject = '';
    state.orgGroup = '';
    state.orgSettings = { ...state.orgSettings, groups: [coder, clients] };
  });

  it('names the folders button in words, says «no folders» on the floor only while on the office, and counts the organization’s automations', () => {
    state.orgGroup = 'clients';
    expect(renderToStaticMarkup(<OrgGroupPicker />)).toContain('📁 Folders</button>');
    expect(renderToStaticMarkup(<OrgSidebar />)).not.toContain('Assign folders to this organization');
    state.orgOffice = false;
    expect(renderToStaticMarkup(<OrgSidebar />)).toContain('Assign folders to this organization');
    state.orgOffice = true;
    state.automations = [{ automation: { cwd: '/p/coder' } }, { automation: { cwd: '/p/komodo/app' } }] as never;
    state.orgGroup = 'mobile';
    expect(render()).toContain('⚡ Automations · 1');
    state.orgGroup = '';
    expect(render()).toContain('⚡ Automations · 2');
    state.automations = [];
  });

  it('offers only «+ New…» in the Community edition, with no organizations saved', () => {
    const saved = state.orgSettings;
    state.orgSettings = { ...saved, groups: undefined };
    const picker = renderToStaticMarkup(<OrgGroupPicker />);
    state.orgSettings = saved;
    expect(picker).toMatch(/<select[^>]*><option value="" selected="">All organizations<\/option><option value="__new">\+ New…<\/option><\/select>/);
  });

  it('has its texts in Spanish', () => {
    expect(translate('es', 'org.groups.all')).toBe('Todas las organizaciones');
    expect(translate('es', 'org.groups.new')).toBe('+ Nueva…');
    expect(translate('es', 'org.groups.empty')).toBe('Asigna carpetas a esta organización');
  });
});
