import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BotConfig, BotMember, BotTeam, OrgGroup, OrgSettings } from '../src/shared/api';
import { translate } from '../src/renderer/src/i18n';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const config = (id: string, name: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const lead = (extra: Partial<BotMember> = {}) => bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, task: 'Plan it', ...extra });
const team = (id: string, cwd: string, bots: BotMember[] = [lead()]): BotTeam => ({ id, title: id, goal: id, cwd, createdAt: 0, updatedAt: Date.now(), bots });

const mobile: OrgGroup = { id: 'mobile', name: 'Mobile', projects: ['/p/coder'] };
const clients: OrgGroup = { id: 'clients', name: 'Clients', projects: ['/p/komodo', '/p/shop'] };
const configs = [config('coord', 'Coordinator', { kind: 'coordinator' }), config('dev', 'Dev', { projects: ['/p/coder'] })];
const coderWork = team('Coder work', '/p/coder', [lead(), bot('b2', { configId: 'dev' })]);
// An agent of the other organization waiting for you.
const vpnWaiting = team('VPN work', '/p/komodo', [lead({ id: 'c1' }), bot('k2', { status: 'waiting' })]);

const state = {
  botConfigs: configs,
  botTeams: [coderWork, vpnWaiting] as BotTeam[],
  officeTeamId: null as string | null,
  orgProject: '',
  orgGroup: '',
  orgSettings: { name: 'My organization', instructions: '', autopilot: false, lessons: [], groups: [mobile, clients] } as OrgSettings,
  orgFocusTeamId: null,
  orgGoal: '',
  locale: 'en',
  info: null,
  catalog: null,
  projects: [
    { id: 1, cwd: '/p/coder', name: 'Coder' },
    { id: 2, cwd: '/p/komodo', name: 'Komodo' },
    { id: 3, cwd: '/p/shop', name: 'Shop' },
  ],
  settings: { openProjectIds: [1, 2, 3], activeProjectId: 1 },
  messageBot: async () => {},
  automations: [],
  orgDrafts: {},
  activeTeamId: null as string | null,
  activeMemberId: null,
  activeAutomationId: null,
  orgOffice: true,
  runs: {},
};
const memory = new Map<string, string>([['alchemist.layout', JSON.stringify({ sideHidden: true })]]);
vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) });
vi.mock('../src/renderer/src/store', () => {
  const useStore = Object.assign((pick: (s: unknown) => unknown) => pick(state), { getState: () => state, setState: () => {} });
  return { useStore, useT: () => (key: never, vars?: Record<string, string | number>) => translate('en', key, vars), useOpenProjects: () => state.projects };
});

const { OrgSidebar } = await import('../src/renderer/src/components/Org');
const { OrgOffice } = await import('../src/renderer/src/components/OrgOffice');
const { OrgComposer } = await import('../src/renderer/src/components/OrgComposer');
const side = () => renderToStaticMarkup(<OrgSidebar />);
const callout = (html: string) => /class="org-callout-text">([^<]*)</.exec(html)?.[1];
const rows = (html: string) => [...html.matchAll(/role="listitem"[^>]*aria-current="(true|false)"[^>]*>/g)].map((m) => m[1]);

describe('what needs you, whatever the organization you look at', () => {
  it('counts an assignment of another organization and says where it is', () => {
    state.orgGroup = 'mobile';
    const html = side();
    expect(callout(html)).toBe('1 needs you (in Clients)');
    // Its row is not in the list: the organization hides it, «needs you» doesn't.
    expect(html).not.toContain('VPN work');
    expect(html).toContain('Coder work');
    state.orgGroup = '';
  });

  it('says nothing about where with every organization in sight', () => {
    state.orgGroup = '';
    expect(callout(side())).toBe('1 needs you');
  });

  it('says how many of them are elsewhere when some are in sight', () => {
    state.botTeams = [team('Coder work', '/p/coder', [lead(), bot('b2', { configId: 'dev', status: 'waiting' })]), vpnWaiting];
    state.orgGroup = 'mobile';
    expect(callout(side())).toBe('2 need you (1 in Clients)');
    state.orgGroup = 'clients';
    expect(callout(side())).toBe('2 need you (1 in Mobile)');
    state.orgGroup = '';
    state.botTeams = [coderWork, vpnWaiting];
  });

  it('names the folder when the hidden one is in no organization', () => {
    state.botTeams = [coderWork, team('Loose work', '/home/u/side', [lead({ id: 'z1' }), bot('z2', { status: 'waiting' })])];
    state.orgGroup = 'mobile';
    expect(callout(side())).toBe('1 needs you (in side)');
    state.orgGroup = '';
    state.botTeams = [coderWork, vpnWaiting];
  });

  it('has the words in Spanish', () => {
    expect(translate('es', 'org.inboxIn', { where: 'Clients' })).toBe('(en Clients)');
  });
});

describe('a focused assignment that is deleted', () => {
  it('leaves the office whole and no row marked as current in the sidebar', () => {
    state.officeTeamId = 'Coder work';
    const focused = renderToStaticMarkup(<OrgOffice title="Studio" editor={() => <form />} views={null} callout={null} />);
    expect(focused).toContain('ofc-focus');
    expect(rows(side())).toContain('true');
    // Deleted (it's gone from the list), the id still in the store.
    state.botTeams = [vpnWaiting];
    const office = renderToStaticMarkup(<OrgOffice title="Studio" editor={() => <form />} views={null} callout={null} />);
    expect(office).not.toContain('ofc-focus');
    expect(office).not.toContain('← Whole office');
    expect(office).toContain('📁 Komodo');
    const html = side();
    expect(rows(html)).not.toContain('true');
    expect(html).not.toContain('Coder work');
    state.botTeams = [coderWork, vpnWaiting];
    state.officeTeamId = null;
  });
});

describe('the folder the assignment box starts on', () => {
  const chipOf = () => /title="Project"[^>]*>(?:<[^>]+>)*([^<]+)</.exec(renderToStaticMarkup(<OrgComposer coordinator={configs[0]} examples={false} />))?.[1];
  const reset = () => {
    state.orgProject = '';
    state.orgGroup = '';
    state.officeTeamId = null;
    state.orgOffice = true;
    state.activeTeamId = null;
  };

  it('takes the project filter over the organization’s first folder', () => {
    reset();
    state.orgGroup = 'clients';
    expect(chipOf()).toBe('Komodo');
    state.orgProject = '/p/shop';
    expect(chipOf()).toBe('Shop');
    reset();
  });

  it('takes the office’s focus over the organization’s first folder, only while the office shows', () => {
    reset();
    state.botTeams = [coderWork, vpnWaiting, team('Shop work', '/p/shop/site')];
    state.orgGroup = 'clients';
    state.officeTeamId = 'Shop work';
    expect(chipOf()).toBe('Shop');
    // The chart instead of the office: the focus no longer counts, the organization's first does.
    state.orgOffice = false;
    expect(chipOf()).toBe('Komodo');
    // An assignment open in detail is not the office either.
    state.orgOffice = true;
    state.activeTeamId = 'Coder work';
    expect(chipOf()).toBe('Komodo');
    state.botTeams = [coderWork, vpnWaiting];
    reset();
  });

  it('falls back to the organization’s first folder when the focus was deleted', () => {
    reset();
    state.orgGroup = 'clients';
    state.officeTeamId = 'gone';
    expect(chipOf()).toBe('Komodo');
    reset();
  });

  it('starts on the project you are in with no organization chosen, over another organization’s folder', () => {
    reset();
    expect(chipOf()).toBe('Coder');
  });
});
