import { describe, expect, it } from 'vitest';
import type { BotConfig, BotMember, BotTeam } from '../src/shared/api';
import { agentsIn, channelOf, countsOf, departmentsOf, NO_DEPARTMENT, projectsOf, RECENT_MS } from '../src/renderer/src/org-office';

// The cases the model tests leave out: same names, empty floors, plans, the day's window, errors, leadless agents.
const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const config = (id: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name: id, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const team = (id: string, extra: Partial<BotTeam> = {}): BotTeam => ({ id, title: id, goal: id, cwd: '/p/a', createdAt: 0, updatedAt: 0, bots: [], ...extra });
const lead = (extra: Partial<BotMember> = {}) => bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, task: 'Plan it', ...extra });
const pending = { status: 'pending', bots: [], summary: '' } as never;

const coord = config('coord', { name: 'Coordinator', kind: 'coordinator' });
// Two agents called the same, each in its own project.
const coderA = config('coder-a', { name: 'Coder', projects: ['/p/a'] });
const coderB = config('coder-b', { name: 'Coder', projects: ['/p/b'] });
const configs = [coord, coderA, coderB];
const projects = [
  { cwd: '/p/a', name: 'Alpha' },
  { cwd: '/p/b', name: 'Beta' },
];
const NOW = 10 * RECENT_MS;

describe('agents with the same name', () => {
  it('stay apart by their configuration, on the floor and in each project', () => {
    const both = team('t', { updatedAt: NOW, bots: [lead(), bot('b2', { name: 'Coder', configId: 'coder-a' }), bot('b3', { name: 'Coder', configId: 'coder-b', status: 'waiting' })] });
    const agents = agentsIn(both, configs);
    expect(agents.map((a) => [a.configId, a.state])).toEqual([
      ['coder-b', 'waiting'],
      ['coord', 'working'],
      ['coder-a', 'working'],
    ]);
    expect(new Set(agents.map((a) => a.key)).size).toBe(3);

    const floor = projectsOf([team('ta', { cwd: '/p/a', updatedAt: NOW, bots: [lead(), bot('b2', { name: 'Coder', configId: 'coder-a' })] }), team('tb', { cwd: '/p/b/src', updatedAt: NOW - 5, bots: [lead({ id: 'c1' }), bot('b3', { name: 'Coder', configId: 'coder-b' })] })], configs, projects, NOW);
    expect(floor.map((p) => [p.name, p.agents.filter((a) => !a.coordinator).map((a) => a.configId)])).toEqual([
      ['Alpha', ['coder-a']],
      ['Beta', ['coder-b']],
    ]);
  });

  it('each hears in its own assignment, not in the namesake’s', () => {
    const ta = team('ta', { updatedAt: 9, bots: [lead({ status: 'idle' }), bot('b2', { name: 'Coder', configId: 'coder-a', runId: 'r', status: 'working' })] });
    const tb = team('tb', { updatedAt: 5, bots: [lead({ status: 'idle' }), bot('b3', { name: 'Coder', configId: 'coder-b', sessionId: 's', status: 'done' })] });
    expect(channelOf(coderB, [ta, tb])).toMatchObject({ team: { id: 'tb' }, bot: { id: 'b3' } });
    expect(channelOf(coderA, [ta, tb])).toMatchObject({ team: { id: 'ta' }, bot: { id: 'b2' } });
    expect(channelOf(coderB, [ta])).toBeNull();
  });

  it('show in their own project’s departments when the office is filtered', () => {
    const ids = (cwd?: string) => departmentsOf(configs, [], cwd).departments.flatMap((d) => d.members.map((m) => m.member.id));
    expect(ids('/p/a')).toEqual(['coder-a']);
    expect(ids('/p/b')).toEqual(['coder-b']);
    expect(ids()).toEqual(['coder-a', 'coder-b']);
  });
});

describe('an empty floor', () => {
  it('has no project for an assignment with nobody on it, nor for an organization with no agents', () => {
    // A stopped bot has no desk; an assignment with no bots has no room.
    const quiet = team('q', { updatedAt: NOW, bots: [lead({ status: 'done' }), bot('b2', { configId: 'coder-a', status: 'stopped' })] });
    expect(projectsOf([quiet], configs, projects, NOW).flatMap((p) => p.agents.map((a) => a.configId))).toEqual(['coord']);
    expect(projectsOf([team('none', { updatedAt: NOW })], configs, projects, NOW)).toEqual([]);
    expect(countsOf([])).toEqual({ working: 0, waiting: 0, done: 0, failed: 0 });
    // With no organization, the bots still show by their own names, without a configuration.
    const floor = projectsOf([team('t', { updatedAt: NOW, bots: [lead(), bot('b2', { name: 'Helper', configId: 'gone' })] })], [], projects, NOW);
    expect(floor[0]!.agents.map((a) => [a.name, a.configId])).toEqual([
      ['Coordinator', null],
      ['Helper', null],
    ]);
  });

  it('keeps a project with no work off the floor while another has some', () => {
    const floor = projectsOf([team('t', { cwd: '/p/b', updatedAt: NOW, bots: [lead()] })], configs, projects, NOW);
    expect(floor.map((p) => p.name)).toEqual(['Beta']);
  });
});

describe('who can hear you', () => {
  it('skips a stopped assignment for an older one that still hears', () => {
    const older = team('older', { updatedAt: 1, bots: [lead({ status: 'idle' }), bot('b2', { configId: 'coder-a', status: 'done', sessionId: 's1' })] });
    const stopped = team('stopped', { updatedAt: 9, stoppedReason: 'user' as never, bots: [lead({ status: 'stopped' }), bot('b3', { configId: 'coder-a', status: 'idle', sessionId: 's2' })] });
    expect(channelOf(coderA, [older, stopped])?.team.id).toBe('older');
    expect(channelOf(coderA, [stopped])).toBeNull();
  });

  it('skips an automation’s step for an older assignment of yours', () => {
    const mine = team('mine', { updatedAt: 1, bots: [lead({ status: 'idle' }), bot('b2', { configId: 'coder-a', status: 'done', sessionId: 's1' })] });
    const auto = team('auto', { updatedAt: 9, origin: { label: 'Nightly' } as never, bots: [lead({ runId: 'r' }), bot('b3', { configId: 'coder-a', runId: 'r3' })] });
    expect(channelOf(coderA, [auto, mine])?.team.id).toBe('mine');
  });
});

describe('a plan waiting for you', () => {
  it('puts the coordinator on the floor as needing you, even stopped, and its project first', () => {
    const plan = team('plan', { cwd: '/p/b', updatedAt: 0, plan: pending, bots: [lead({ status: 'stopped' })] });
    const busy = team('busy', { cwd: '/p/a', updatedAt: NOW, bots: [lead({ id: 'c2' }), bot('b2', { configId: 'coder-a' })] });
    const floor = projectsOf([busy, plan], configs, projects, NOW);
    expect(floor.map((p) => p.name)).toEqual(['Beta', 'Alpha']);
    expect(floor[0]!.agents.map((a) => [a.name, a.state, a.coordinator])).toEqual([['Coordinator', 'waiting', true]]);
    expect(floor[0]!.counts.waiting).toBe(1);
    expect(departmentsOf(configs, [plan]).coordinator?.status).toBe('waiting');
  });

  it('keeps the coordinator failed when it failed, the plan notwithstanding', () => {
    const [a] = agentsIn(team('p', { plan: pending, updatedAt: NOW, bots: [lead({ status: 'error' })] }), configs);
    expect(a!.state).toBe('failed');
  });
});

describe('the day’s window', () => {
  const finished = (updatedAt: number) => team('f', { updatedAt, finished: true, bots: [lead({ status: 'idle' }), bot('b2', { configId: 'coder-a', status: 'done' })] });

  it('shows what finished within 24 h as done, and drops it after', () => {
    const recent = projectsOf([finished(NOW - RECENT_MS + 60_000)], configs, projects, NOW);
    expect(recent[0]!.agents.map((a) => a.state)).toEqual(['done', 'done']);
    expect(recent[0]!.counts).toEqual({ working: 0, waiting: 0, done: 2, failed: 0 });
    expect(projectsOf([finished(NOW - RECENT_MS)], configs, projects, NOW)).toHaveLength(1);
    expect(projectsOf([finished(NOW - RECENT_MS - 1)], configs, projects, NOW)).toEqual([]);
    // A window of your own.
    expect(projectsOf([finished(NOW - 2000)], configs, projects, NOW, '', 1000)).toEqual([]);
  });

  it('keeps work in progress however old its last change is', () => {
    const old = team('old', { updatedAt: 0, bots: [lead({ status: 'idle' }), bot('b2', { configId: 'coder-a', status: 'working' })] });
    expect(projectsOf([old], configs, projects, NOW)[0]!.counts.working).toBe(1);
  });
});

describe('an error', () => {
  it('shows on the floor as failed and is counted, within the day', () => {
    const t = team('e', { updatedAt: NOW - 1000, bots: [lead({ status: 'idle' }), bot('b2', { configId: 'coder-a', status: 'error' })] });
    const floor = projectsOf([t], configs, projects, NOW);
    expect(floor[0]!.agents.find((a) => a.configId === 'coder-a')?.state).toBe('failed');
    expect(floor[0]!.counts.failed).toBe(1);
    expect(countsOf(floor).failed).toBe(1);
  });

  it('shows when the coordinator itself failed', () => {
    const t = team('e', { updatedAt: NOW - 1000, bots: [lead({ status: 'error' })] });
    expect(projectsOf([t], configs, projects, NOW)[0]!.agents.map((a) => a.state)).toEqual(['failed']);
  });

  it('puts the one that needs you ahead of the failed one', () => {
    const t = team('e', { updatedAt: NOW, bots: [lead({ status: 'idle' }), bot('b2', { configId: 'coder-a', status: 'error' }), bot('b3', { configId: 'coder-b', status: 'waiting' })] });
    expect(agentsIn(t, configs).map((a) => a.state)).toEqual(['waiting', 'failed', 'done']);
  });
});

describe('departments of agents with no lead', () => {
  it('puts them all in one «No department», after the departments with a team (AC-012: it was one department each)', () => {
    const solo = [coord, config('x', { name: 'X' }), config('y', { name: 'Y' }), config('lead', { name: 'Lead' }), config('m', { name: 'M', leadId: 'lead' })];
    const { departments } = departmentsOf(solo, []);
    expect(departments.map((d) => [d.id, d.lead?.id ?? null, d.members.map((m) => m.member.id)])).toEqual([
      ['lead', 'lead', ['lead', 'm']],
      [NO_DEPARTMENT, null, ['x', 'y']],
    ]);
  });

  it('keeps an agent whose lead was deleted, or is the coordinator, with no department', () => {
    const orphans = [coord, config('o', { name: 'Orphan', leadId: 'deleted' }), config('c', { name: 'UnderCoord', leadId: 'coord' })];
    expect(departmentsOf(orphans, []).departments.map((d) => [d.id, d.members.map((m) => m.member.id)])).toEqual([[NO_DEPARTMENT, ['o', 'c']]]);
  });

  it('counts who works and who waits in «No department» too', () => {
    const org = [coord, config('a'), config('b')];
    const t = team('t', { bots: [lead(), bot('b2', { configId: 'a', status: 'working' }), bot('b3', { configId: 'b', status: 'waiting' })] });
    expect(departmentsOf(org, [t]).departments).toMatchObject([{ id: NO_DEPARTMENT, working: 1, waiting: 1 }]);
  });

  it('counts who works and who waits in each department', () => {
    const org = [coord, config('lead', { name: 'Lead' }), config('m', { name: 'M', leadId: 'lead' })];
    const t = team('t', { bots: [lead(), bot('b2', { configId: 'lead', status: 'working' }), bot('b3', { configId: 'm', status: 'waiting' })] });
    expect(departmentsOf(org, [t]).departments[0]).toMatchObject({ working: 1, waiting: 1 });
    expect(departmentsOf([config('lone')], []).coordinator).toBeNull();
  });
});
