import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig, BotMember, BotTeam } from '../src/shared/api';
import { translate } from '../src/renderer/src/i18n';

/**
 * The office's «To» box across renders. There is no DOM here, so the office's own hooks run on a small
 * stand-in: state and refs kept by call order between renders, effects run when their deps change.
 */
const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  let at = 0;
  let dirty = false;
  return {
    slots,
    begin: () => {
      at = 0;
      dirty = false;
    },
    changed: () => dirty,
    reset: () => void slots.splice(0),
    next: () => at++,
    mark: () => void (dirty = true),
  };
});
vi.mock('react', async (importActual) => {
  const React = await importActual<typeof import('react')>();
  const useState = <S,>(init: S | (() => S)) => {
    const i = hooks.next();
    if (!(i in hooks.slots)) hooks.slots[i] = { value: typeof init === 'function' ? (init as () => S)() : init };
    const slot = hooks.slots[i] as { value: S };
    const set = (v: S | ((s: S) => S)) => {
      const value = typeof v === 'function' ? (v as (s: S) => S)(slot.value) : v;
      if (!Object.is(value, slot.value)) (slot.value = value), hooks.mark();
    };
    return [slot.value, set] as const;
  };
  const useRef = <V,>(init: V) => {
    const i = hooks.next();
    if (!(i in hooks.slots)) hooks.slots[i] = { current: init };
    return hooks.slots[i] as { current: V };
  };
  const useEffect = (run: () => void | (() => void), deps?: unknown[]) => {
    const i = hooks.next();
    const slot = hooks.slots[i] as { deps?: unknown[] } | undefined;
    if (slot && deps && slot.deps && deps.length === slot.deps.length && deps.every((d, k) => Object.is(d, slot.deps![k]))) return;
    hooks.slots[i] = { deps };
    run();
  };
  return { ...React, default: React, useState, useRef, useEffect };
});

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const config = (id: string, name: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const coord = config('coord', 'Coordinator', { kind: 'coordinator' });
const planner = config('planner', 'Planner');
const writer = config('writer', 'Writer', { leadId: 'planner' });
const analyst = config('analyst', 'Analyst');
// Coder is on an assignment it can still hear in: the box writes there, without a start of its own.
const coder = config('coder', 'Coder', { leadId: 'planner' });
const live: BotTeam = {
  id: 'team-1',
  title: 'Export to CSV',
  goal: 'Add a CSV export',
  cwd: '/p/castbook',
  createdAt: 0,
  updatedAt: Date.now(),
  bots: [bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, runId: 'r1' }), bot('b2', { name: 'Coder', configId: 'coder', runId: 'r2' })],
};

const state = {
  botConfigs: [coord, planner, writer, analyst, coder] as BotConfig[],
  botTeams: [live] as BotTeam[],
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
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
vi.mock('../src/renderer/src/store', () => {
  const useStore = Object.assign((pick: (s: unknown) => unknown) => pick(state), { getState: () => state, setState: (patch: Partial<typeof state>) => void Object.assign(state, patch) });
  return { useStore, useT: () => (key: never, vars?: Record<string, string | number>) => translate('en', key, vars), useOpenProjects: () => state.projects };
});
// The boxes themselves have tests of their own; here only which one shows.
vi.mock('../src/renderer/src/components/OrgComposer', () => ({ OrgComposer: () => <div className="composer-stub" /> }));
vi.mock('../src/renderer/src/components/OrgChat', () => ({ OrgChat: () => <div className="chat-stub" /> }));
vi.mock('../src/renderer/src/components/OrgLive', () => ({ CardWrite: ({ bot: b }: { bot: BotMember }) => <div className={`card-write-stub to-${b.id}`} /> }));

vi.useFakeTimers();
afterAll(() => vi.useRealTimers());
const { OrgOffice } = await import('../src/renderer/src/components/OrgOffice');

/** Renders until the effects settle, as React would. */
function render() {
  let html = '';
  for (let i = 0; i < 5; i++) {
    hooks.begin();
    html = renderToStaticMarkup(<OrgOffice title="Studio" editor={() => null} views={null} callout={null} />);
    if (!hooks.changed()) return html;
  }
  throw new Error('the office kept changing its own state');
}
/** The «To» recipient: the office's state that starts as the coordinator (''). */
function pick(id: string) {
  const slot = hooks.slots.find((s) => typeof s === 'object' && s !== null && 'value' in s && typeof (s as { value: unknown }).value === 'string') as { value: string };
  slot.value = id;
  return render();
}
const selected = (html: string) => html.match(/<option value="([^"]*)" selected="">/)?.[1];

beforeEach(() => {
  hooks.reset();
  state.orgGoal = '';
  state.botConfigs = [coord, planner, writer, analyst, coder];
  render();
});

describe('the box’s «To»', () => {
  it('starts on the coordinator with an empty box', () => {
    expect(selected(render())).toBe('');
    expect(state.orgGoal).toBe('');
  });

  it('starts an assignment for an agent with nothing open: «Ask X to…»', () => {
    const html = pick('writer');
    expect(selected(html)).toBe('writer');
    expect(state.orgGoal).toBe('Ask Writer to ');
    expect(html).toContain('composer-stub');
  });

  it('changes only its own start when you pick someone else, keeping what you added', () => {
    pick('writer');
    state.orgGoal = 'Ask Writer to fix the header';
    pick('analyst');
    expect(state.orgGoal).toBe('Ask Analyst to fix the header');
  });

  it('empties an untouched start when you go back to the coordinator', () => {
    pick('writer');
    pick('');
    expect(state.orgGoal).toBe('');
  });

  it('drops only its start, going back to the coordinator, from what you added', () => {
    pick('writer');
    state.orgGoal = 'Ask Writer to fix the header';
    pick('');
    expect(state.orgGoal).toBe('fix the header');
  });

  it('leaves your own words alone, before and after you rewrote its start', () => {
    state.orgGoal = 'My own draft';
    pick('writer');
    expect(state.orgGoal).toBe('My own draft');
    pick('');
    expect(state.orgGoal).toBe('My own draft');
    // Rewritten: the box is yours from then on.
    state.orgGoal = '';
    pick('analyst');
    expect(state.orgGoal).toBe('Ask Analyst to ');
    state.orgGoal = 'Please, Analyst, fix it';
    pick('writer');
    expect(state.orgGoal).toBe('Please, Analyst, fix it');
    pick('');
    expect(state.orgGoal).toBe('Please, Analyst, fix it');
  });

  it('fills a box you emptied again for the next one', () => {
    pick('writer');
    state.orgGoal = '';
    pick('analyst');
    expect(state.orgGoal).toBe('Ask Analyst to ');
  });

  it('writes to an agent in the assignment it is in, without a start', () => {
    pick('writer');
    const html = pick('coder');
    expect(state.orgGoal).toBe('');
    expect(html).toContain('card-write-stub to-b2');
    expect(html).toContain('Export to CSV');
  });

  it('goes back to the coordinator when the agent it writes to is deleted', () => {
    pick('writer');
    state.botConfigs = [coord, planner, analyst, coder];
    const html = render();
    expect(selected(html)).toBe('');
    expect(html).not.toContain('>Writer<');
    expect(state.orgGoal).toBe('');
  });
});
