import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BotConfig, BotMember, BotTeam, OrgGroup, OrgSettings } from '../src/shared/api';
import { translate } from '../src/renderer/src/i18n';
import { groupOf, memberInGroup, newGroupId, teamInGroup, toggleFolder } from '../src/renderer/src/org-groups';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const config = (id: string, name: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const lead = (extra: Partial<BotMember> = {}) => bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, task: 'Plan it', ...extra });

const coder: OrgGroup = { id: 'claude-coder', name: 'Claude Coder', projects: ['/p/coder'] };
const linkedin: OrgGroup = { id: 'linkedin', name: 'LinkedIn', projects: [] };
const team = (id: string, cwd: string, bots: BotMember[] = [lead()]): BotTeam => ({ id, title: id, goal: id, cwd, createdAt: 0, updatedAt: Date.now(), bots });

describe('organizations as groups of folders', () => {
  it('shows an assignment under the organization its folder is in, and every one with none chosen', () => {
    expect(teamInGroup(team('a', '/p/coder/apps/desktop'), coder)).toBe(true);
    expect(teamInGroup(team('b', '/p/coder-other'), coder)).toBe(false);
    expect(teamInGroup(team('c', '/p/komodo'), null)).toBe(true);
    // One with no folders shows nothing.
    expect(teamInGroup(team('d', '/p/coder'), linkedin)).toBe(false);
  });

  it('shows an agent of one of its projects, and the coordinator and agents for every project always', () => {
    expect(memberInGroup(config('a', 'A', { projects: ['/p/coder'] }), coder)).toBe(true);
    expect(memberInGroup(config('b', 'B', { projects: ['/p/coder/sub'] }), coder)).toBe(true);
    expect(memberInGroup(config('c', 'C', { projects: ['/p/komodo'] }), coder)).toBe(false);
    expect(memberInGroup(config('d', 'D'), linkedin)).toBe(true);
    expect(memberInGroup(config('e', 'E', { kind: 'coordinator', projects: ['/x'] }), coder)).toBe(true);
  });

  it('names new ones apart and adds or takes out one folder at a time', () => {
    expect(newGroupId('Side projects', [coder])).toBe('side-projects');
    expect(newGroupId('LinkedIn', [linkedin])).toBe('linkedin-2');
    expect(newGroupId('¡¡!!', [])).toBe('org');
    const once = toggleFolder([coder, linkedin], 'linkedin', '/p/li');
    expect(once[1]!.projects).toEqual(['/p/li']);
    expect(toggleFolder(once, 'linkedin', '/p/li')[1]!.projects).toEqual([]);
    expect(once[0]).toBe(coder);
  });

  it('forgets a chosen organization that no longer exists', () => {
    const org = { name: 'x', instructions: '', autopilot: false, lessons: [], groups: [coder] } satisfies OrgSettings;
    expect(groupOf(org, 'claude-coder')).toBe(coder);
    expect(groupOf(org, 'gone')).toBeNull();
    expect(groupOf(org, '')).toBeNull();
    expect(groupOf(null, 'claude-coder')).toBeNull();
  });
});

const configs = [config('coord', 'Coordinator', { kind: 'coordinator' }), config('dev', 'Dev', { projects: ['/p/coder'] }), config('vpn', 'VpnGuy', { projects: ['/p/komodo'] }), config('any', 'Anyone')];
const state = {
  botConfigs: configs,
  botTeams: [team('Coder work', '/p/coder', [lead(), bot('b2', { configId: 'dev' })]), team('VPN work', '/p/komodo', [lead({ id: 'c1' }), bot('k2', { configId: 'vpn' })])] as BotTeam[],
  officeTeamId: null as string | null,
  orgProject: '',
  orgGroup: '',
  orgSettings: { name: 'My organization', instructions: '', autopilot: false, lessons: [], groups: [coder, linkedin] } as OrgSettings,
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
};
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) });
vi.mock('../src/renderer/src/store', () => {
  const useStore = Object.assign((pick: (s: unknown) => unknown) => pick(state), { getState: () => state, setState: () => {} });
  return { useStore, useT: () => (key: never, vars?: Record<string, string | number>) => translate('en', key, vars), useOpenProjects: () => state.projects };
});

const { OrgOffice } = await import('../src/renderer/src/components/OrgOffice');
const { OrgGroupPicker } = await import('../src/renderer/src/components/OrgGroups');
const render = () => renderToStaticMarkup(<OrgOffice title="Studio" editor={() => <form />} views={null} callout={null} />);
const depts = (html: string) => html.slice(html.indexOf('class="ofc-depts"'));

describe('the office filtered by organization', () => {
  it('shows everything with «All», then only that organization’s rooms and agents', () => {
    state.orgGroup = '';
    const all = render();
    expect(all).toContain('📁 Komodo');
    expect(all).toContain('📁 Coder');
    state.orgGroup = 'claude-coder';
    const one = render();
    expect(one).toContain('📁 Coder');
    expect(one).not.toContain('📁 Komodo');
    // Its departments: its agents and those for every project, not the other organization's.
    expect(all).toContain('>VpnGuy</option>');
    expect(one).not.toContain('>VpnGuy</option>');
    expect(one).toContain('>Dev</option>');
    expect(one).toContain('>Anyone</option>');
    expect(depts(all)).toContain('No department');
    state.orgGroup = '';
  });

  it('asks for folders when the organization has none, and shows its work once it has some', () => {
    state.orgGroup = 'linkedin';
    const empty = render();
    expect(empty).toContain('Assign folders to this organization');
    expect(empty).not.toContain('ofc-room');
    state.orgSettings = { ...state.orgSettings, groups: [coder, { ...linkedin, projects: ['/p/komodo'] }] };
    const after = render();
    expect(after).not.toContain('Assign folders to this organization');
    expect(after).toContain('📁 Komodo');
    state.orgSettings = { ...state.orgSettings, groups: [coder, linkedin] };
    state.orgGroup = '';
  });

  it('offers All, each organization and a new one beside the name, and the folders of the chosen one', () => {
    state.orgGroup = '';
    const picker = renderToStaticMarkup(<OrgGroupPicker />);
    expect(picker).toMatch(/<option value="" selected="">All<\/option><option value="claude-coder">Claude Coder<\/option><option value="linkedin">LinkedIn<\/option><option value="__new">\+ New…<\/option>/);
    expect(picker).not.toContain('Folders of');
    state.orgGroup = 'linkedin';
    expect(renderToStaticMarkup(<OrgGroupPicker />)).toContain('aria-label="Folders of LinkedIn"');
    // One deleted elsewhere: back to All.
    state.orgGroup = 'gone';
    expect(renderToStaticMarkup(<OrgGroupPicker />)).toContain('<option value="" selected="">All</option>');
    state.orgGroup = '';
  });

  it('has its texts in Spanish', () => {
    expect(translate('es', 'org.groups.all')).toBe('Todas');
    expect(translate('es', 'org.groups.new')).toBe('+ Nueva…');
    expect(translate('es', 'org.groups.empty')).toBe('Asigna carpetas a esta organización');
  });
});
