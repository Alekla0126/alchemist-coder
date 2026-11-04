import { beforeEach, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/shared/api';
const state = { locale: 'en', orgGoal: 'Keep this draft', orgPage: 'work', orgOffice: true, orgLive: false, orgMap: false, officeTeamId: 'focused', orgSettingsMemberId: null as string | null, activeTeamId: null as string | null, activeBotId: null as string | null, activeMemberId: null as string | null, activeAutomationId: null as string | null, officeTalkOpen: false };
vi.mock('../src/renderer/src/store', () => ({ useStore: { getState: () => state, setState: (patch: object) => Object.assign(state, patch) } }));
const focus = vi.fn();
vi.stubGlobal('document', { querySelector: () => ({ focus, value: 'draft', setSelectionRange: () => {} }) });
vi.stubGlobal('requestAnimationFrame', (fn: () => void) => fn());
const { openOrgSettings, showOnChart, giveTask, openAssignment, openMember } = await import('../src/renderer/src/actions/org');
beforeEach(() => { Object.assign(state, { orgGoal: 'Keep this draft', orgPage: 'work', officeTeamId: 'focused', activeTeamId: null, activeMemberId: null, officeTalkOpen: false }); vi.clearAllMocks(); });
it('visits configuration and returns without losing the working view, focus or draft', () => {
  openOrgSettings('tester');
  expect(state).toMatchObject({ orgPage: 'settings', orgSettingsMemberId: 'tester', activeMemberId: null, orgOffice: true, officeTeamId: 'focused', orgGoal: 'Keep this draft' });
  showOnChart();
  expect(state).toMatchObject({ orgPage: 'work', orgOffice: true, officeTeamId: 'focused', orgGoal: 'Keep this draft' });
});
it('opens the office composer before giving an agent a task', () => {
  giveTask({ id: 'tester', name: 'Tester', kind: 'member' } as BotConfig);
  expect(state.officeTalkOpen).toBe(true);
  expect(state.orgGoal).toContain('Tester');
  expect(focus).toHaveBeenCalledOnce();
});
it('opens assignments from configuration in the working area', () => {
  openOrgSettings();
  openAssignment({ id: 't', bots: [{ id: 'b' }] } as never);
  expect(state).toMatchObject({ orgPage: 'work', activeTeamId: 't', activeBotId: 'b' });
});
it('repeatedly opens exact tasks, clears stale automation selection, and returns to the same assignment', () => {
  for (const id of ['a', 'b', 'a']) {
    state.activeAutomationId = 'old-automation';
    openAssignment({ id, bots: [{ id: 'lead' }, { id: 'worker' }] } as never, 'worker');
    expect(state).toMatchObject({ orgPage: 'work', activeTeamId: id, activeBotId: 'worker', activeMemberId: null, activeAutomationId: null, officeTeamId: id });
    showOnChart();
    expect(state).toMatchObject({ activeTeamId: null, officeTeamId: id, orgGoal: 'Keep this draft' });
  }
});
it('switches from automation to a profile without leaving both destinations selected', () => {
  state.activeAutomationId = 'automation';
  openMember({ id: 'coder' } as BotConfig);
  expect(state).toMatchObject({ activeMemberId: 'coder', activeTeamId: null, activeBotId: null, activeAutomationId: null });
});
