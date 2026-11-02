import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/shared/api';
import { translate } from '../src/renderer/src/i18n';

// A mid-size window (1100 px) with the sidebar beside the office: the stores read it when they load.
vi.stubGlobal('window', { innerWidth: 1100, innerHeight: 800, addEventListener: () => {} });
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) });
const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const configs: BotConfig[] = [{ id: 'coord', name: 'Coordinator', role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'coordinator' }];
const state = { botConfigs: configs, botTeams: [], officeTeamId: null, orgProject: '', orgGroup: '', orgSettings: null, orgFocusTeamId: null, orgGoal: '', locale: 'en', info: null, catalog: null, projects: [], settings: { openProjectIds: [], activeProjectId: null }, automations: [], orgDrafts: {} };
vi.mock('../src/renderer/src/store', () => {
  const useStore = Object.assign((pick: (s: unknown) => unknown) => pick(state), { getState: () => state, setState: () => {} });
  return { useStore, useT: () => (key: never, vars?: Record<string, string | number>) => translate('en', key, vars), useOpenProjects: () => state.projects };
});
const { OrgOffice } = await import('../src/renderer/src/components/OrgOffice');

describe('the office on a mid-size window', () => {
  it('starts with its departments folded, the tab on the edge to bring them back, instead of stacking them', () => {
    const html = renderToStaticMarkup(<OrgOffice title="Studio" views={null} callout={null} />);
    expect(html).toMatch(/class="ofc[^"]*depts-off/);
    expect(html).toContain('class="ofc-depts-tab"');
  });
});
