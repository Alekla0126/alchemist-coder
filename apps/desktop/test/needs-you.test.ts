import { describe, expect, it } from 'vitest';
import { nextPlace, waitingPlaces, type NeedsYouState } from '../src/renderer/src/needs-you';

const base = (): NeedsYouState => ({
  runs: {},
  projects: [{ id: 1, cwd: '/p/shop' }],
  botTeams: [],
  tasks: {},
  automations: [],
  settings: { mode: 'agents' },
  selection: null,
  composeProjectId: null,
  activeTeamId: null,
  activeBotId: null,
  activeTaskId: null,
  activeAutomationId: null,
});
const run = (runId: string, target: string, status = 'waiting', cwd = '') => ({ runId, target, status, cwd });

describe('where each thing that needs you is answered', () => {
  it('a conversation, a new one, a bot, an Arena task, Marketing, a plan and an automation', () => {
    const s = base();
    s.runs = {
      a: run('a', 's:sess-1'),
      b: run('b', 'p:1'),
      c: run('c', 'bg:c'),
      d: run('d', 'bg:d'),
      e: run('e', 'mk:piece-9'),
      f: run('f', 's:sess-2', 'running'),
    };
    s.botTeams = [{ id: 'team-1', plan: { status: 'pending' }, bots: [{ id: 'bot-1', runId: 'c' }] }];
    s.tasks = { 'task-1': { id: 'task-1', planner: { runId: null }, contestants: [{ runId: 'x' }, { runId: 'd' }] } };
    s.automations = [{ automation: { id: 'auto-1' }, runs: [{ asks: [{}] }] }];
    expect(waitingPlaces(s).map((p) => p.kind)).toEqual(['session', 'compose', 'bot', 'arena', 'marketing', 'plan', 'automation']);
    const arena = waitingPlaces(s).find((p) => p.kind === 'arena');
    expect(arena).toMatchObject({ taskId: 'task-1' });
  });

  it("a run started elsewhere in a project folder goes to that project's composer", () => {
    const s = base();
    s.runs = { z: run('z', 'bg:z', 'waiting', '/p/shop') };
    expect(waitingPlaces(s)).toEqual([{ kind: 'compose', key: 'run:z', projectId: 1 }]);
  });
});

describe('the button goes to the next one you are not on', () => {
  it("from a subagent's tab to the main agent's, where the approval card is", () => {
    const s = base();
    s.runs = { a: run('a', 's:sess-1') };
    s.selection = { sessionId: 'sess-1', agentId: 'sub-7' };
    expect(nextPlace(s)).toMatchObject({ kind: 'session', sessionId: 'sess-1' });
  });

  it('with two waiting, past the one already on screen', () => {
    const s = base();
    s.runs = { a: run('a', 's:sess-1'), b: run('b', 's:sess-2') };
    s.selection = { sessionId: 'sess-1', agentId: 'main' };
    expect(nextPlace(s)).toMatchObject({ sessionId: 'sess-2' });
    s.selection = { sessionId: 'sess-2', agentId: 'main' };
    expect(nextPlace(s)).toMatchObject({ sessionId: 'sess-1' });
  });

  it('to the Arena from another mode, and nowhere when nothing waits', () => {
    const s = base();
    s.runs = { d: run('d', 'bg:d') };
    s.tasks = { t: { id: 't', planner: { runId: 'd' }, contestants: [] } };
    s.settings = { mode: 'code' };
    expect(nextPlace(s)).toMatchObject({ kind: 'arena', taskId: 't' });
    expect(nextPlace(base())).toBeNull();
  });
});
