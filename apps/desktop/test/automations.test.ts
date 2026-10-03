import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AutomationState, BoardData, BotConfig, BotTeam } from '../src/shared/api';
import { AutomationManager, cleanFlow, nextNode, nextRunAt, parseCards, parseDecision, templateFlow, type AutomationDeps } from '../src/main/automations';
import { mergeBoard } from '../src/main/board';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'haiku' };
const cfg = (id: string, name: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
const configs = [cfg('coord', 'Coordinador', { kind: 'coordinator' }), cfg('dev', 'Programador'), cfg('qa', 'Tester'), cfg('res', 'Investigador')];

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('automation diagrams', () => {
  it('cleans what an agent drew into a diagram that can run', () => {
    const { nodes, edges } = cleanFlow(
      [
        { id: 'a', kind: 'agent', title: 'Read reviews', agent: 'investigador', text: 'Read them' },
        { id: 'a', kind: 'decision', title: 'Kind?', agent: 'Nobody', branches: ['Bug'] },
        { id: 'x', kind: 'weird' },
        { id: 'h', kind: 'human', title: 'Approve?' },
      ],
      [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'h' },
        { from: 'a', to: 'h' },
        { from: 'h', to: 'a', branch: 'aprobar' },
        { from: 'h', to: 'nowhere', branch: 'Rechazar' },
        { from: 'a', to: 'start' },
      ],
      configs,
      'es',
    );
    expect(nodes.map((n) => [n.kind, n.title])).toEqual([
      ['trigger', 'Empezar'],
      ['agent', 'Read reviews'],
      ['decision', 'Kind?'],
      ['human', 'Approve?'],
    ]);
    // Agents by name; unknown ones fall back to the coordinator (null); a decision gets two branches.
    expect(nodes[1]!.agentId).toBe('res');
    expect(nodes[2]!.agentId).toBeNull();
    expect(nodes[2]!.id).not.toBe('a');
    expect(nodes[2]!.branches).toEqual(['Sí', 'No']);
    expect(nodes[3]!.branches).toEqual(['Aprobar', 'Rechazar']);
    // No edge into the trigger, none to a missing step, one per branch, branch names as written on the step.
    expect(edges).toEqual([
      { from: 'start', to: 'a' },
      { from: 'a', to: 'h' },
      { from: 'h', to: 'a', branch: 'Aprobar' },
    ]);
  });

  it('takes a step\'s branches from its arrows when the agent forgot them', () => {
    const { nodes, edges } = cleanFlow([{ id: 'd', kind: 'decision', title: '¿Vale?' }, { id: 'y', kind: 'agent', title: 'Y' }], [{ from: 'start', to: 'd' }, { from: 'd', to: 'y', branch: 'Sí' }, { from: 'd', to: 'start', branch: 'No' }, { from: 'd', to: 'y', branch: 'Quizá' }], configs, 'en');
    expect(nodes[1]!.branches).toEqual(['Sí', 'No', 'Quizá']);
    expect(edges.filter((e) => e.from === 'd').map((e) => e.branch)).toEqual(['Sí', 'Quizá']);
  });

  it('keeps the arrows an agent named loosely, or not at all', () => {
    const { nodes, edges } = cleanFlow(
      [
        { id: 'd', kind: 'decision', title: '¿Vale?', branches: ['Sí', 'No'] },
        { id: 'h', kind: 'human', title: '¿Lo llevo?', branches: ['Aprobar', 'Rechazar'] },
        { id: 'y', kind: 'agent', title: 'Y' },
      ],
      [
        { from: 'd', to: 'h', branch: 'si' },
        { from: 'd', to: 'y' },
        { from: 'h', to: 'y', branch: 'Más tarde' },
        { from: 'h', to: 'y', branch: 'APROBAR' },
      ],
      configs,
      'es',
    );
    expect(edges.filter((e) => e.from === 'd')).toEqual([{ from: 'd', to: 'h', branch: 'Sí' }, { from: 'd', to: 'y', branch: 'No' }]);
    expect(nodes.find((n) => n.id === 'h')!.branches).toEqual(['Aprobar', 'Rechazar', 'Más tarde']);
    expect(edges.filter((e) => e.from === 'h').map((e) => e.branch)).toEqual(['Más tarde', 'Aprobar']);
    expect(parseDecision('Lo pensé.\nDECISIÓN: **si**', ['Sí', 'No'])).toBe('Sí');
  });

  it('follows branches, and reads what an agent decided', () => {
    const t = templateFlow('office', 'Ship the CSV export', configs, 'es');
    expect(nextNode(t, 'check', 'Más tarjetas')?.id).toBe('plan');
    expect(nextNode(t, 'check', 'cumplido')?.id).toBe('tell');
    expect(nextNode(t, 'work', null)?.id).toBe('check');
    expect(parseDecision('It is all done.\nDECISION: Cumplido', ['Más tarjetas', 'Cumplido'])).toBe('Cumplido');
    expect(parseDecision('Hay que seguir.\n**DECISIÓN: más tarjetas.**', ['Más tarjetas', 'Cumplido'])).toBe('Más tarjetas');
    expect(parseDecision('No idea', ['A', 'B'])).toBeNull();
    // The measuring step of a goal cycle goes to the organization's researcher.
    expect(templateFlow('goal', 'Más descargas', configs, 'es').nodes.find((n) => n.id === 'measure')!.agentId).toBe('res');
  });

  it('speaks the app\'s language', () => {
    expect(templateFlow('office', 'Ship it', configs, 'en').nodes.find((n) => n.id === 'check')!.branches).toEqual(['More cards', 'Reached']);
    expect(cleanFlow([{ id: 'h', kind: 'human', title: 'OK?' }], [], configs).nodes.map((n) => [n.title, n.branches])).toEqual([['Start', undefined], ['OK?', ['Approve', 'Reject']]]);
  });

  it('reads the cards a manager wrote down', () => {
    expect(parseCards('Plan:\n```json\n{"cards":[{"title":"Export","assignee":"Programador","detail":"CSV"},{"title":""}]}\n```')).toEqual([{ title: 'Export', assignee: 'Programador', detail: 'CSV', after: [] }]);
    expect(parseCards('[{"title":"Tests","assignee":"Tester"}]')).toEqual([{ title: 'Tests', assignee: 'Tester', detail: '', after: [] }]);
    expect(parseCards('nothing to do')).toEqual([]);
  });

  it('knows when an automation starts next', () => {
    const base = { enabled: true, updatedAt: new Date(2026, 9, 3, 10, 0).getTime() };
    const now = new Date(2026, 9, 3, 10, 30).getTime();
    expect(nextRunAt({ ...base, trigger: { kind: 'manual' } }, null, now)).toBeNull();
    expect(nextRunAt({ ...base, enabled: false, trigger: { kind: 'every', minutes: 60 } }, null, now)).toBeNull();
    expect(nextRunAt({ ...base, trigger: { kind: 'every', minutes: 60 } }, null, now)).toBe(now);
    expect(nextRunAt({ ...base, trigger: { kind: 'every', minutes: 60 } }, { startedAt: now - 30 * 60_000, endedAt: null }, now)).toBe(now + 30 * 60_000);
    // Daily at 08:00, turned on at 10:00: tomorrow at 08:00; after a run at 08:00 today, tomorrow too.
    expect(nextRunAt({ ...base, trigger: { kind: 'daily', at: '08:00' } }, null, now)).toBe(new Date(2026, 9, 4, 8, 0).getTime());
    expect(nextRunAt({ ...base, trigger: { kind: 'daily', at: '12:00' } }, null, now)).toBe(new Date(2026, 9, 3, 12, 0).getTime());
    // Missed while the app was closed: due as soon as it opens.
    expect(nextRunAt({ ...base, trigger: { kind: 'daily', at: '08:00' } }, { startedAt: new Date(2026, 9, 2, 8, 0).getTime(), endedAt: null }, now)).toBe(new Date(2026, 9, 3, 8, 0).getTime());
    // Mondays at 09:00 (3 Oct 2026 is a Saturday): next Monday.
    expect(nextRunAt({ ...base, trigger: { kind: 'daily', at: '09:00', days: [1] } }, null, now)).toBe(new Date(2026, 9, 5, 9, 0).getTime());
    expect(nextRunAt({ ...base, trigger: { kind: 'continuous', pauseMinutes: 5 } }, { startedAt: now - 60_000, endedAt: now - 60_000 }, now)).toBe(now + 4 * 60_000);
  });
});

/** Agents that answer at once: `reply` decides what each task gets back. */
function harness(reply: (task: string, configId: string) => { text: string; changes?: number; error?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-auto-'));
  dirs.push(dir);
  const teams = new Map<string, BotTeam>();
  const watchers = new Set<(t: BotTeam) => void>();
  let board: BoardData = { tasks: [], placed: {} };
  const notes: Array<{ title: string; body: string; ask?: { key: string; choices: string[]; question: string } }> = [];
  const started: Array<{ configId: string; task: string; ownWorktree?: boolean; readOnly?: boolean; permissionMode?: string; noCopyPermission?: string }> = [];
  const applied: string[] = [];
  const states: AutomationState[] = [];
  let n = 0;
  const clone = <T>(v: T) => structuredClone(v);
  const deps: AutomationDeps = {
    configs: () => configs,
    async startSolo(input) {
      started.push(input);
      const id = `team-${++n}`;
      const r = reply(input.task, input.configId);
      const team = {
        id,
        title: input.title ?? '',
        goal: input.task,
        cwd: input.cwd,
        createdAt: 0,
        updatedAt: 0,
        bots: [{ id: 'b1', name: configs.find((c) => c.id === input.configId)!.name, configId: input.configId, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: null, depth: 0, runId: null, status: 'working', task: input.task, lastReply: '', costUsd: null, createdAt: 0, worktree: input.ownWorktree ? { path: '/wt', branch: `bots/${id}`, base: 'x', root: '/p' } : null }],
        origin: input.origin,
      } as BotTeam;
      teams.set(id, team);
      setTimeout(() => {
        team.bots[0]!.status = r.error ? 'error' : 'idle';
        team.bots[0]!.error = r.error ?? null;
        team.bots[0]!.lastReply = r.text;
        team.bots[0]!.costUsd = 0.05;
        (team as BotTeam & { changes: number }).changes = r.changes ?? 0;
        for (const w of watchers) w(clone(team));
      }, 1);
      return clone(team);
    },
    team: (id) => (teams.has(id) ? clone(teams.get(id)!) : undefined),
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    stopTeam(id) {
      const t = teams.get(id);
      if (t) t.bots[0]!.status = 'stopped';
    },
    changes: async (teamId) => Array.from({ length: (teams.get(teamId) as BotTeam & { changes?: number }).changes ?? 0 }, (_, i) => ({ path: `f${i}.ts` })),
    async apply(teamId) {
      applied.push(teamId);
      return 'Applied 1 file';
    },
    board: {
      get: () => clone(board),
      patch(fn) {
        const next = clone(board);
        fn(next);
        board = next;
        return clone(board);
      },
    },
    notify: (m) => notes.push(clone(m)),
    oneShot: async () => '```json\n{"name":"Reseñas","trigger":{"kind":"daily","at":"08:00"},"nodes":[{"id":"start","kind":"trigger","title":"Cada mañana"},{"id":"read","kind":"agent","title":"Leer reseñas","agent":"Investigador","text":"Lee las reseñas"},{"id":"end","kind":"end","title":"Fin"}],"edges":[{"from":"start","to":"read"},{"from":"read","to":"end"}]}\n```',
    emit: (s) => states.push(clone(s)),
    lang: () => 'es',
  };
  const manager = new AutomationManager({ automations: join(dir, 'automations.json'), runs: join(dir, 'runs.json') }, deps);
  const settled = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const run = manager.list().find((s) => s.automation.id === id)?.runs[0];
      if (run && run.status !== 'running' && run.status !== 'waiting') return run;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('the run never ended');
  };
  const waitingAsk = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const run = manager.list().find((s) => s.automation.id === id)?.runs[0];
      if (run?.asks.length) return { run, ask: run.asks[0]! };
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('no question came');
  };
  return { manager, deps, started, notes, applied, states, settled, waitingAsk, board: () => board };
}

describe('running automations', () => {
  it('runs the office: cards for the employees, their work, the manager deciding it is done', async () => {
    const h = harness((task) => {
      if (task.startsWith('Split this into cards')) return { text: 'Plan\n```json\n{"cards":[{"title":"Export CSV","assignee":"Programador","detail":"Button in settings"},{"title":"Test CSV","assignee":"Tester"},{"title":"Ghost","assignee":"Nobody"}]}\n```' };
      if (task.startsWith('Your card on the Board')) return { text: 'Done' };
      return { text: 'Everything is there.\nDECISION: Cumplido' };
    });
    const { automation } = await h.manager.create({ prompt: 'Exportar el historial a CSV', cwd: '/p', template: 'office' });
    expect(automation.enabled).toBe(false);
    await h.manager.runNow(automation.id);
    const run = await h.settled(automation.id);
    expect(run.status).toBe('done');
    expect(run.steps.map((s) => s.nodeId)).toEqual(['start', 'plan', 'work', 'check', 'tell', 'end']);
    // Two cards (the unknown assignee is dropped), each done by its employee, in its own copy.
    expect(h.board().tasks.map((t) => [t.title, t.assignee, t.phase, t.automationId])).toEqual([
      ['Test CSV', 'qa', 'done', automation.id],
      ['Export CSV', 'dev', 'done', automation.id],
    ]);
    const cardRuns = h.started.filter((s) => s.task.startsWith('Your card'));
    expect(cardRuns.map((s) => [s.configId, s.ownWorktree, s.noCopyPermission])).toEqual([
      ['dev', true, 'default'],
      ['qa', true, 'default'],
    ]);
    // Planning and deciding only read.
    expect(h.started.filter((s) => !s.task.startsWith('Your card')).every((s) => s.readOnly)).toBe(true);
    expect(run.costUsd).toBeGreaterThan(0);
    expect(h.notes.at(-1)!.title).toContain('Te aviso del resultado');
  });

  it('starts a card that comes after another once that one is done', async () => {
    const order: string[] = [];
    const h = harness((task) => {
      if (task.startsWith('Split this into cards')) return { text: '```json\n{"cards":[{"title":"Write tests","assignee":"Tester","after":["Write the exporter"]},{"title":"Write the exporter","assignee":"Programador"}]}\n```' };
      order.push(task.includes('Write tests') ? 'tests' : 'exporter');
      return { text: 'done' };
    });
    const state = h.manager.save({ name: 'Deps', prompt: 'p', cwd: '/p', nodes: [{ id: 'start', kind: 'trigger', title: 'Go' }, { id: 'plan', kind: 'cards', title: 'Plan' }, { id: 'work', kind: 'work', title: 'Work' }], edges: [{ from: 'start', to: 'plan' }, { from: 'plan', to: 'work' }] });
    await h.manager.runNow(state.automation.id);
    expect((await h.settled(state.automation.id)).status).toBe('done');
    // Tests were planned first but waited for the exporter.
    expect(order).toEqual(['exporter', 'tests']);
    const tests = h.board().tasks.find((t) => t.title === 'Write tests')!;
    expect(tests.after).toEqual([h.board().tasks.find((t) => t.title === 'Write the exporter')!.id]);
  });

  it('asks before bringing changes into the project, and goes on with your answer', async () => {
    const h = harness(() => ({ text: 'Changed two files', changes: 2 }));
    const state = h.manager.save({ name: 'Fix', prompt: 'Fix the bug', cwd: '/p', nodes: [{ id: 'start', kind: 'trigger', title: 'Go' }, { id: 'fix', kind: 'agent', title: 'Fix it', agentId: 'dev', text: 'Fix the bug' }], edges: [{ from: 'start', to: 'fix' }] });
    await h.manager.runNow(state.automation.id);
    const { run, ask } = await h.waitingAsk(state.automation.id);
    expect(run.status).toBe('waiting');
    expect(ask.choices).toEqual(['Aplicar', 'Descartar']);
    expect(ask.detail).toContain('2 archivos');
    // The question reached you, with a key to answer it from the phone.
    expect(h.notes.at(-1)!.ask!.key).toBe(`${run.id}:${ask.id}`);
    expect(h.manager.answer(run.id, ask.id, 'Aplicar', true)).toBe(true);
    expect(h.manager.answer(run.id, ask.id, 'Aplicar', true)).toBe(false);
    const done = await h.settled(state.automation.id);
    expect(done.status).toBe('done');
    expect(h.applied).toHaveLength(1);
    expect(done.steps[1]!.output).toContain('Applied 1 file');
  });

  it('brings changes in on its own when autonomous, and asks every change when careful', async () => {
    const h = harness(() => ({ text: 'ok', changes: 1 }));
    const flow = { nodes: [{ id: 'start', kind: 'trigger', title: 'Go' }, { id: 'fix', kind: 'agent', title: 'Fix', agentId: 'dev', text: 'x' }], edges: [{ from: 'start', to: 'fix' }] };
    const auto = h.manager.save({ name: 'A', prompt: 'p', cwd: '/p', autonomy: 'autonomous', ...flow });
    await h.manager.runNow(auto.automation.id);
    expect((await h.settled(auto.automation.id)).status).toBe('done');
    expect(h.applied).toHaveLength(1);
    const careful = h.manager.save({ name: 'C', prompt: 'p', cwd: '/p', autonomy: 'careful', ...flow });
    await h.manager.runNow(careful.automation.id);
    await h.waitingAsk(careful.automation.id);
    expect(h.started.at(-1)!.permissionMode).toBe('default');
    h.manager.stopRun(h.manager.list().find((s) => s.automation.id === careful.automation.id)!.runs[0]!.id);
    expect((await h.settled(careful.automation.id)).status).toBe('stopped');
  });

  it('lets you decide when the agent does not, and stops a loop that never ends', async () => {
    const h = harness(() => ({ text: 'Hmm, hard to say.' }));
    const state = h.manager.save({
      name: 'Loop',
      prompt: 'p',
      cwd: '/p',
      nodes: [{ id: 'start', kind: 'trigger', title: 'Go' }, { id: 'd', kind: 'decision', title: 'Again?', branches: ['Again', 'Stop'] }],
      edges: [{ from: 'start', to: 'd' }, { from: 'd', to: 'd', branch: 'Again' }],
    });
    await h.manager.runNow(state.automation.id);
    for (let i = 0; i < 6; i++) {
      const { run, ask } = await h.waitingAsk(state.automation.id);
      expect(ask.choices).toEqual(['Again', 'Stop']);
      h.manager.answer(run.id, ask.id, 'Again');
    }
    const run = await h.settled(state.automation.id);
    expect(run.status).toBe('failed');
    expect(run.why).toContain('6 veces');
    expect(h.notes.at(-1)!.title).toContain('se detuvo');
  });

  it('pauses at the daily cap', async () => {
    const h = harness(() => ({ text: 'ok' }));
    const state = h.manager.save({ name: 'Cap', prompt: 'p', cwd: '/p', budgetUsdPerDay: 0.05, nodes: [{ id: 'start', kind: 'trigger', title: 'Go' }, { id: 'a', kind: 'agent', title: 'A', text: 'x' }, { id: 'b', kind: 'agent', title: 'B', text: 'y' }], edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }] });
    // Every 5 minutes: turning it on starts it at once.
    h.manager.save({ ...state.automation, trigger: { kind: 'every', minutes: 5 } });
    h.manager.setEnabled(state.automation.id, true);
    const run = await h.settled(state.automation.id);
    expect(run.status).toBe('failed');
    expect(run.why).toContain('tope');
    expect(h.manager.list()[0]!.automation.enabled).toBe(false);
    expect(h.manager.list()[0]!.nextAt).toBeNull();
    expect(h.started).toHaveLength(1);
  });

  it('draws a diagram from your words, off until you turn it on', async () => {
    const h = harness(() => ({ text: 'ok' }));
    const { automation, nextAt } = await h.manager.create({ prompt: 'Cada mañana lee las reseñas', cwd: '/p', template: 'agent' });
    expect(automation.name).toBe('Reseñas');
    expect(automation.trigger).toEqual({ kind: 'daily', at: '08:00' });
    expect(automation.nodes.find((n) => n.id === 'read')!.agentId).toBe('res');
    expect(automation.enabled).toBe(false);
    expect(nextAt).toBeNull();
  });
});

describe('board merge', () => {
  const task = (id: string, updatedAt: number, title = id) => ({ id, cwd: '/p', title, notes: '', phase: 'backlog' as const, sessionId: null, createdAt: 1, updatedAt });
  it("keeps the app's newer cards and the window's edits", () => {
    const app = { tasks: [task('a', 50, 'app moved'), task('b', 5), task('new', 60), task('gone', 5)], placed: { s1: { phase: 'done' as const, at: 70 } } };
    const win = { tasks: [task('a', 20, 'window'), task('b', 30, 'window edit'), task('mine', 40)], placed: { s1: { phase: 'planning' as const, at: 10 } } };
    const merged = mergeBoard(app, win, 25);
    expect(merged.tasks.map((t) => [t.id, t.title])).toEqual([
      ['a', 'app moved'],
      ['b', 'window edit'],
      ['mine', 'mine'],
      ['new', 'new'],
    ]);
    expect(merged.placed.s1!.phase).toBe('done');
  });
});
