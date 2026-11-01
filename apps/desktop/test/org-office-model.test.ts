import { describe, expect, it } from 'vitest';
import type { BotConfig, BotMember, BotTeam } from '../src/shared/api';
import { agentsIn, channelOf, countsOf, departmentsOf, latestTeam, onFloor, projectOf, projectsOf, RECENT_MS } from '../src/renderer/src/org-office';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const config = (id: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name: id, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const team = (id: string, extra: Partial<BotTeam> = {}): BotTeam => ({ id, title: id, goal: id, cwd: '/p/castbook', createdAt: 0, updatedAt: 0, bots: [], ...extra });
const lead = (extra: Partial<BotMember> = {}) => bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, task: 'Plan it', ...extra });

const coord = config('coord', { name: 'Coordinator', kind: 'coordinator' });
const planner = config('planner', { name: 'Planner', avatar: 'emoji:🧭' });
const coder = config('coder', { name: 'Coder', leadId: 'planner' });
const tester = config('tester', { name: 'Tester', leadId: 'planner', projects: ['/p/other'] });
const finance = config('finance', { name: 'Finance' });
const scout = config('scout', { name: 'Scout', proposed: true });
const configs = [coord, planner, coder, tester, finance, scout];
const projects = [
  { cwd: '/p/castbook', name: 'Castbook' },
  { cwd: '/p/other', name: 'Other' },
];
const NOW = 10 * RECENT_MS;

describe('the floor', () => {
  it('keeps work in progress and what finished lately, not what stopped or is old', () => {
    expect(onFloor(team('a', { bots: [lead({ status: 'working' })] }), NOW)).toBe(true);
    expect(onFloor(team('a', { bots: [lead({ status: 'idle' })], updatedAt: NOW - 1000 }), NOW)).toBe(true);
    expect(onFloor(team('a', { bots: [lead({ status: 'idle' })], updatedAt: NOW - RECENT_MS - 1 }), NOW)).toBe(false);
    expect(onFloor(team('a', { bots: [lead({ status: 'stopped' })], updatedAt: NOW }), NOW)).toBe(false);
    // A plan waiting for you is on the floor however old it is.
    expect(onFloor(team('a', { bots: [lead({ status: 'idle' })], plan: { status: 'pending', bots: [], summary: '' } as never }), NOW)).toBe(true);
  });

  it('puts a folder in the deepest open project, else in a project of its own', () => {
    expect(projectOf('/p/castbook/.claude-worktrees/x', [...projects, { cwd: '/p/castbook/.claude-worktrees', name: 'Trees' }]).name).toBe('Trees');
    expect(projectOf('/p/castbook/src', projects)).toEqual({ cwd: '/p/castbook', name: 'Castbook' });
    expect(projectOf('/q/elsewhere', projects)).toEqual({ cwd: '/q/elsewhere', name: 'elsewhere' });
  });

  it('shows one agent per organization agent with its most telling bot, who needs you first', () => {
    const t = team('t1', {
      bots: [
        lead({ status: 'working', doing: 'Bash: npm test' }),
        bot('b2', { configId: 'coder', status: 'done', task: 'Write\n  the exporter', createdAt: 1 }),
        bot('b3', { configId: 'coder', status: 'waiting', task: 'Fix the header', createdAt: 2 }),
        bot('b4', { name: 'Helper', status: 'error' }),
        bot('b5', { configId: 'tester', status: 'stopped' }),
      ],
    });
    const agents = agentsIn(t, configs);
    expect(agents.map((a) => [a.name, a.state, a.botId])).toEqual([
      ['Coder', 'waiting', 'b3'],
      ['Coordinator', 'working', 'b1'],
      ['Helper', 'failed', 'b4'],
    ]);
    expect(agents[1]!.doing).toBe('Bash: npm test');
    expect(agents[1]!.coordinator).toBe(true);
    // One defined on the spot keeps its bot's name and has no configuration to open.
    expect(agents[2]!.configId).toBeNull();
    expect(agents[2]!.key).toBe('t1:bot:b4');
  });

  it('writes the task on one line and only says what it does while it works', () => {
    const [a] = agentsIn(team('t', { bots: [bot('b2', { configId: 'coder', status: 'done', task: 'Write\n  the exporter', doing: 'Edit: x.ts' })] }), configs);
    expect(a!.task).toBe('Write the exporter');
    expect(a!.doing).toBeNull();
    expect(a!.state).toBe('done');
  });

  it('groups the work by project, the one that needs you first, and counts each state', () => {
    const teams = [
      team('busy', { cwd: '/p/other', updatedAt: NOW - 10, bots: [lead({ status: 'working' }), bot('b2', { configId: 'tester', status: 'working' })] }),
      team('asks', { cwd: '/p/castbook/src', updatedAt: NOW - 50, bots: [lead({ status: 'idle' }), bot('b2', { configId: 'coder', status: 'waiting' })] }),
      team('done', { cwd: '/p/castbook', updatedAt: NOW - 20, bots: [lead({ status: 'idle' })] }),
      team('old', { cwd: '/p/castbook', updatedAt: 0, bots: [lead({ status: 'idle' })] }),
    ];
    const floor = projectsOf(teams, configs, projects, NOW);
    expect(floor.map((p) => [p.name, p.teams.map((x) => x.id)])).toEqual([
      ['Castbook', ['done', 'asks']],
      ['Other', ['busy']],
    ]);
    expect(floor[0]!.counts).toEqual({ working: 0, waiting: 1, done: 2, failed: 0 });
    expect(floor[0]!.agents[0]!.name).toBe('Coder');
    expect(countsOf(floor)).toEqual({ working: 2, waiting: 1, done: 2, failed: 0 });
    // Filtered to a project, only its assignments.
    expect(projectsOf(teams, configs, projects, NOW, '/p/other').map((p) => p.name)).toEqual(['Other']);
    expect(projectsOf([], configs, projects, NOW)).toEqual([]);
  });
});

describe('departments', () => {
  it('lists each lead with its team, the coordinator apart and the proposed ones last', () => {
    const t = team('t', { bots: [lead({ status: 'working' }), bot('b2', { configId: 'coder', status: 'waiting' })] });
    const { coordinator, departments, proposed } = departmentsOf(configs, [t]);
    expect(coordinator?.member.id).toBe('coord');
    expect(coordinator?.status).toBe('working');
    expect(departments.map((d) => [d.lead.name, d.members.map((m) => `${m.member.name}:${m.status}`)])).toEqual([
      ['Planner', ['Planner:idle', 'Coder:waiting', 'Tester:idle']],
      ['Finance', ['Finance:idle']],
    ]);
    expect(departments[0]!.waiting).toBe(1);
    expect(proposed.map((c) => c.id)).toEqual(['scout']);
  });

  it('keeps the agents of the project it is filtered to', () => {
    const { departments } = departmentsOf(configs, [], '/p/castbook');
    expect(departments[0]!.members.map((m) => m.member.name)).toEqual(['Planner', 'Coder']);
  });

  it('works with no organization yet', () => {
    expect(departmentsOf([], [])).toEqual({ coordinator: null, departments: [], proposed: [] });
  });
});

describe('writing to an agent', () => {
  it('goes to its bot in the latest assignment that can hear it, a running one first', () => {
    const old = team('old', { updatedAt: 5, bots: [lead({ status: 'idle' }), bot('b2', { configId: 'coder', status: 'working', runId: 'r1' })] });
    const late = team('late', { updatedAt: 9, bots: [lead({ status: 'idle' }), bot('b2', { configId: 'coder', status: 'done', sessionId: 's2' })] });
    expect(channelOf(coder, [old, late])).toMatchObject({ team: { id: 'old' }, bot: { id: 'b2' } });
    expect(channelOf(coder, [late])).toMatchObject({ team: { id: 'late' } });
  });

  it('has none when it never worked, can no longer hear, or the plan waits for you', () => {
    expect(channelOf(finance, [])).toBeNull();
    expect(channelOf(coder, [team('x', { bots: [bot('b2', { configId: 'coder', status: 'stopped' })] })])).toBeNull();
    const pending = team('p', { plan: { status: 'pending', bots: [], summary: '' } as never, bots: [bot('b2', { configId: 'coder', status: 'working', runId: 'r' })] });
    expect(channelOf(coder, [pending])).toBeNull();
  });

  it('talks with the coordinator in the assignment that moved last', () => {
    expect(latestTeam([team('a', { updatedAt: 1 }), team('b', { updatedAt: 3 }), team('c', { updatedAt: 2 })])?.id).toBe('b');
    expect(latestTeam([])).toBeUndefined();
  });
});

describe('the example office', () => {
  const text = { goalA: 'Goal A', goalB: 'Goal B', taskA: 'Task A', taskB: 'Task B', taskC: 'Task C' };
  it('puts the organization to work in two projects, one agent waiting for you, without new agents', async () => {
    const { demoTeams } = await import('../src/renderer/src/org-office');
    const teams = demoTeams(configs, projects, NOW, text);
    const floor = projectsOf(teams, configs, projects, NOW);
    expect(floor.map((p) => p.name)).toEqual(['Castbook', 'Other']);
    expect(floor[0]!.counts.waiting).toBe(1);
    expect(teams.flatMap((x) => x.bots).every((b) => configs.some((c) => c.id === b.configId))).toBe(true);
    expect(demoTeams([], projects, NOW, text)).toEqual([]);
  });

  it('builds the house staff when no organization is set up', async () => {
    const { demoConfigs } = await import('../src/renderer/src/org-office');
    const made = demoConfigs({ coordinator: { name: 'C', role: '' }, planner: { name: 'P', role: '' }, coder: { name: 'D', role: '', lead: 'planner', model: 'sonnet' } }, agent);
    expect(made.map((c) => [c.id, c.kind, c.leadId, c.agent.model])).toEqual([
      ['demo-coordinator', 'coordinator', null, 'sonnet'],
      ['demo-planner', 'member', null, 'sonnet'],
      ['demo-coder', 'member', 'demo-planner', 'sonnet'],
    ]);
  });
});
