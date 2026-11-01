import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BotConfig, BotMember, BotTeam } from '../src/shared/api';
import { translate } from '../src/renderer/src/i18n';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const config = (id: string, name: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name, role: `${name} does its part.`, agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const configs = [
  config('coord', 'Coordinator', { kind: 'coordinator' }),
  config('planner', 'Planner'),
  config('coder', 'Coder', { leadId: 'planner', about: 'Writes the code.' }),
  config('finance', 'Finance'),
  config('sales', 'Sales', { proposed: true }),
];
const team: BotTeam = {
  id: 'team-1',
  title: 'Export to CSV',
  goal: 'Add a CSV export',
  cwd: '/p/castbook',
  createdAt: 0,
  updatedAt: Date.now(),
  bots: [
    bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, task: 'Add a CSV export', doing: 'Bash: npm test' }),
    bot('b2', { name: 'Coder', configId: 'coder', status: 'waiting', task: 'Write the exporter' }),
  ],
};

const state = {
  botConfigs: configs,
  botTeams: [team] as BotTeam[],
  orgProject: '',
  orgFocusTeamId: null,
  orgGoal: '',
  locale: 'en',
  info: null,
  catalog: null,
  projects: [{ id: 1, cwd: '/p/castbook', name: 'Castbook' }],
  settings: { openProjectIds: [1], activeProjectId: 1 },
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
const render = () => renderToStaticMarkup(<OrgOffice title="Studio" editor={() => <form className="editor-stub" />} views={<nav className="views-stub" />} callout={null} />);

describe('the office on one screen', () => {
  const html = render();

  it('shows the work by project, who needs you first, saying in words how each one is doing', () => {
    expect(html).toContain('📁 Castbook');
    expect(html).toContain('1 working · 1 needs you');
    expect(html.indexOf('of-desk ofc-desk st-waiting')).toBeLessThan(html.indexOf('of-desk ofc-desk st-working'));
    // The same word for it everywhere in the office.
    expect(html).toContain('>Needs you<');
    expect(html).not.toContain('Waiting for you');
    // What the coordinator is doing right now, and the agent's task otherwise.
    expect(html).toContain('Write the exporter');
    expect(html).toContain('Export to CSV');
  });

  it('lists the departments with their agents, the coordinator first and the proposed ones last', () => {
    const side = html.slice(html.indexOf('class="ofc-depts"'));
    expect(side.indexOf('Coordinator')).toBeLessThan(side.indexOf('Planner'));
    expect(side.indexOf('Planner')).toBeLessThan(side.indexOf('Coder'));
    expect(side.indexOf('Finance')).toBeLessThan(side.indexOf('Proposed agents'));
    expect(side).toContain('Sales');
    // A department with someone at work starts open; a quiet one starts folded, saying how many it has.
    expect(side).toMatch(/aria-expanded="true"[^>]*>.*Planner/);
    expect(side).toMatch(/aria-expanded="false"[^>]*>.*Finance.*1 agent/);
  });

  it('writes to the coordinator by default, with every agent to pick from by department', () => {
    expect(html).toMatch(/<select id="ofc-to">/);
    expect(html).toMatch(/<option value="" selected="">⚗ Coordinator<\/option>/);
    expect(html).toContain('<optgroup label="Planner">');
    expect(html).toContain('The coordinator hands the work out.');
    // The same box as the organization's home, to give it work.
    expect(html).toContain('class="org-composer"');
  });

  it('keeps everything on one screen: no sheet until you open an agent', () => {
    expect(html).not.toContain('ofc-sheet');
    expect(html).toContain('class="views-stub"');
  });

  it('says plainly when nobody works and there are no projects yet', () => {
    state.botTeams = [];
    const empty = render();
    state.botTeams = [team];
    expect(empty).toContain('Nobody is working right now');
    expect(empty).toContain('No projects with work yet');
    expect(empty).not.toContain('ofc-room');
  });

  it('has its texts in Spanish', () => {
    expect(translate('es', 'org.office.nobody')).toBe('Nadie trabaja ahora');
    expect(translate('es', 'org.office.doneN', { n: 1 })).toBe('1 listo');
    expect(translate('es', 'org.office.view')).toBe('Oficina');
  });
});
