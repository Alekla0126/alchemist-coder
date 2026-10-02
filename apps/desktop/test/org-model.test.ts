import { describe, expect, it } from 'vitest';
import type { ProjectSummary, SessionSummary } from '@alchemist-coder/core';
import type { BotConfig, BotMember, BotTeam } from '../src/shared/api';
import { activityTotals, buildActivity, doingOf, type ActivityRun } from '../src/renderer/src/activity-model';
import { canMove, chartOf, extrasIn, workIn } from '../src/renderer/src/org-model';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const config = (id: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name: id, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const team = (extra: Partial<BotTeam> = {}): BotTeam => ({ id: 'team-1', title: 'Export to CSV', goal: 'Add a CSV export', cwd: '/p/castbook', createdAt: 0, updatedAt: 0, bots: [], ...extra });
const lead = (extra: Partial<BotMember> = {}) => bot('b1', { name: 'Coordinator', configId: 'coord', parentId: null, depth: 0, task: 'Add a CSV export', ...extra });

const coord = config('coord', { name: 'Coordinator', kind: 'coordinator' });
const coder = config('coder', { name: 'Coder' });
const tester = config('tester', { name: 'Tester', leadId: 'coder' });
const reviewer = config('reviewer', { name: 'Reviewer' });
const scout = config('scout', { name: 'Scout', proposed: true });
const configs = [coord, coder, tester, reviewer, scout];

describe('organization chart', () => {
  it('puts each team under its lead and keeps proposed agents apart', () => {
    const chart = chartOf(configs);
    expect(chart.coordinator?.id).toBe('coord');
    expect(chart.leads.map((l) => [l.member.id, l.team.map((m) => m.id)])).toEqual([
      ['coder', ['tester']],
      ['reviewer', []],
    ]);
    expect(chart.proposed.map((m) => m.id)).toEqual(['scout']);
  });

  it('shows only the agents of a project, and an agent whose lead is elsewhere on its own', () => {
    const elsewhere = [coord, config('coder', { projects: ['/p/other'] }), tester, reviewer];
    expect(chartOf(elsewhere, '/p/castbook').leads.map((l) => l.member.id)).toEqual(['tester', 'reviewer']);
  });

  it('only moves agents where a team can take them', () => {
    expect(canMove(reviewer, coder, configs)).toBe(true);
    // Already there, itself, a team member as lead, a proposed agent, the coordinator.
    expect(canMove(tester, coder, configs)).toBe(false);
    expect(canMove(coder, coder, configs)).toBe(false);
    expect(canMove(reviewer, tester, configs)).toBe(false);
    expect(canMove(scout, coder, configs)).toBe(false);
    expect(canMove(coord, coder, configs)).toBe(false);
    // A lead with a team can't join another one.
    expect(canMove(coder, reviewer, configs)).toBe(false);
    // Onto the coordinator: back under it, for those on a team.
    expect(canMove(tester, coord, configs)).toBe(true);
    expect(canMove(tester, null, configs)).toBe(true);
    expect(canMove(reviewer, coord, configs)).toBe(false);
  });
});

describe('who does what in an assignment', () => {
  const plan = { summary: 's', estimateUsd: 1, status: 'pending' as const, feedback: '', revision: 1, bots: [
    { name: 'Coder', task: 'Write the exporter', config: 'Coder', role: '', ownWorktree: false },
    { name: 'Docs writer', task: 'Document it', config: '', role: 'Writes docs', ownWorktree: false },
  ] };

  it('reads the plan while nothing has started', () => {
    const t = team({ bots: [lead({ status: 'working' })], plan });
    expect(workIn(t, coder)).toMatchObject({ state: 'planned', task: 'Write the exporter', botId: null });
    expect(workIn(t, reviewer)).toBeNull();
    // The coordinator waits for you while its plan does.
    expect(workIn(t, coord)).toMatchObject({ state: 'waiting', botId: 'b1' });
    expect(extrasIn(t, configs)).toEqual([expect.objectContaining({ name: 'Docs writer', work: expect.objectContaining({ state: 'planned', task: 'Document it' }) })]);
  });

  it('follows the bots once they exist', () => {
    const t = team({
      plan: { ...plan, status: 'approved' },
      bots: [lead(), bot('b2', { name: 'Coder', configId: 'coder', task: 'Write the exporter', doing: 'Bash: npm test', costUsd: 0.2 }), bot('b3', { name: 'Coder 2', configId: 'coder', status: 'done', costUsd: 0.1 }), bot('b4', { name: 'Docs writer', status: 'done' })],
    });
    expect(workIn(t, coder)).toMatchObject({ state: 'working', task: 'Write the exporter', doing: 'Bash: npm test', botId: 'b2', more: 1 });
    expect(workIn(t, coder)!.costUsd).toBeCloseTo(0.3);
    // Created on the spot: shown once, as the bot (not again as planned).
    expect(extrasIn(t, configs).map((x) => [x.name, x.work.state])).toEqual([['Docs writer', 'done']]);
  });
});

const project = (id: number, name: string, runningAgents = 0): ProjectSummary => ({ id, cwd: `/p/${name}`, name, sessionCount: 1, lastTs: 0, sources: [], runningAgents });
const session = (id: string, projectId: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({ id, projectId, title: `Session ${id}`, runningAgents: 0, status: 'idle', ...extra }) as SessionSummary;
const run = (runId: string, target: string, extra: Partial<ActivityRun> = {}): ActivityRun => ({ runId, target, status: 'running', sessionId: null, turns: [], usage: null, permissions: [], ...extra });
const base = { runs: {}, runByTarget: {}, botTeams: [], tasks: {}, projects: [project(1, 'castbook')], sessions: [] };

describe('activity bar', () => {
  it('says what a run is doing from its open turn', () => {
    const turn = (blocks: unknown[]) => [{ prompt: 'go', startedAt: 5, endedAt: null, blocks }] as never;
    expect(doingOf(run('r', 's:a', { turns: turn([{ kind: 'thinking', text: '…' }]) }))).toEqual({ kind: 'thinking' });
    expect(doingOf(run('r', 's:a', { turns: turn([{ kind: 'tool', tool: { name: 'Bash', summary: '', state: 'running' } }]) }))).toEqual({ kind: 'tool', tool: 'Bash' });
    expect(doingOf(run('r', 's:a', { turns: turn([{ kind: 'tool', tool: { name: 'Bash', summary: '', state: 'done' } }]) }))).toEqual({ kind: 'running' });
    expect(doingOf(run('r', 's:a', { status: 'waiting', permissions: [{ title: 'Run npm test' }] }))).toEqual({ kind: 'text', text: 'Run npm test' });
  });

  it('lists the organization’s agents, those waiting for you first', () => {
    const t = team({ bots: [lead({ doing: '@wait_for_bot:Coder', runId: 'r1' }), bot('b2', { name: 'Coder', doing: 'Edit: export.ts', costUsd: 0.25 }), bot('b3', { name: 'Tester', status: 'waiting' }), bot('b4', { status: 'done' })] });
    const items = buildActivity({ ...base, botTeams: [t], projects: [project(1, 'castbook', 3)] });
    expect(items.map((x) => [x.name, x.state])).toEqual([
      ['Tester', 'waiting'],
      ['Coordinator', 'working'],
      ['Coder', 'working'],
    ]);
    expect(items[2]).toMatchObject({ where: 'Export to CSV', doing: { kind: 'text', text: 'Edit: export.ts' }, since: 1000, target: { kind: 'bot', teamId: 'team-1', botId: 'b2' } });
    // Its three agents are the project's three: no extra line for the project.
    expect(activityTotals(items)).toEqual({ waiting: 1, working: 2, costUsd: 0.25 });
  });

  it('counts a plan to review as the coordinator waiting, even after it stopped', () => {
    const t = team({ bots: [lead({ status: 'stopped' })], plan: { summary: '', bots: [], estimateUsd: null, status: 'pending', feedback: '', revision: 1 } });
    expect(buildActivity({ ...base, botTeams: [t] })).toEqual([expect.objectContaining({ name: 'Coordinator', state: 'waiting', doing: { kind: 'plan' } })]);
  });

  it('names the app’s conversations and the ones working outside it once', () => {
    const sessions = [session('a', 1, { title: 'Fix login', runningAgents: 3, status: 'running' }), session('b', 1, { title: 'Terminal work', runningAgents: 1, status: 'running' }), session('c', 1)];
    const runs = { r1: run('r1', 's:a', { sessionId: 'a', usage: { costUsd: 0.5 }, turns: [{ prompt: 'go', startedAt: 42, endedAt: null, blocks: [{ kind: 'text', text: 'ok' }] }] }), old: run('old', 's:a', { sessionId: 'a' }), done: run('done', 's:c', { sessionId: 'c', status: 'idle' }) };
    const items = buildActivity({ ...base, runs, runByTarget: { 's:a': 'r1', 's:c': 'done' }, sessions, projects: [project(1, 'castbook', 4), project(2, 'other', 2)] });
    expect(items.map((x) => [x.key, x.name, x.agents])).toEqual([
      ['run:r1', 'Fix login', 3],
      ['session:b', 'Terminal work', 1],
      ['project:2', 'other', 2],
    ]);
    expect(items[0]).toMatchObject({ doing: { kind: 'writing' }, since: 42, where: 'castbook', target: { kind: 'session', sessionId: 'a' } });
    expect(items[1]!.doing).toEqual({ kind: 'elsewhere' });
    expect(activityTotals(items)).toEqual({ waiting: 0, working: 6, costUsd: 0.5 });
  });

  it('is empty when nobody works', () => {
    expect(buildActivity({ ...base, sessions: [session('a', 1)] })).toEqual([]);
  });
});
