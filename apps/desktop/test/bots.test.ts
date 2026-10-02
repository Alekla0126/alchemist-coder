import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunnerEventMessage } from '../src/shared/api';
import { BotManager, MAX_BOTS, SERVER_NAME } from '../src/main/bots';
import { writeBridge } from '../src/main/bots-bridge';

const dir = mkdtempSync(join(tmpdir(), 'bots-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A runner that records what it was asked and lets the test play the agents. */
function fakeRunner() {
  let n = 0;
  const listeners: Array<(m: RunnerEventMessage) => void> = [];
  const started: Array<{ runId: string; prompt: string; model: string; permissionMode?: string; mcp: number; cwd?: string }> = [];
  const sent: Array<[string, string]> = [];
  const stopped: string[] = [];
  const runner = {
    start(req: { prompt: string; model: string; permissionMode?: string; cwd?: string }, internal: { mcpServers?: unknown[] } = {}) {
      const runId = `run-${++n}`;
      started.push({ runId, prompt: req.prompt, model: req.model, permissionMode: req.permissionMode, mcp: internal.mcpServers?.length ?? 0, cwd: req.cwd, resume: (req as { resumeSessionId?: string }).resumeSessionId } as never);
      return { runId };
    },
    send: (runId: string, text: string) => void sent.push([runId, text]),
    stop: (runId: string) => void stopped.push(runId),
    observe: (l: (m: RunnerEventMessage) => void) => (listeners.push(l), () => {}),
  };
  const play = (runId: string, text: string) => {
    for (const l of listeners) l({ runId, event: { type: 'text', text } });
    for (const l of listeners) l({ runId, event: { type: 'result', ok: true, sessionId: null, costUsd: 0.01 } });
  };
  return { runner, started, sent, stopped, play };
}

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };

function setup() {
  const fake = fakeRunner();
  const teams: string[] = [];
  const bots = new BotManager({ configs: join(dir, `c-${Math.random()}.json`), teams: join(dir, `t-${Math.random()}.json`) }, fake.runner as never, { command: process.execPath, script: writeBridge(dir) }, (cwd) => String(cwd), (t) => teams.push(t.id));
  return { fake, bots };
}

describe('bot teams', () => {
  it('starts a coordinator with the bot tools and lets it create bots from a configuration or directly', async () => {
    const { fake, bots } = setup();
    await bots.start();
    const tester = bots.saveConfig({ name: 'Tester', role: 'Write and run tests', agent: { ...agent, model: 'haiku' }, permissionMode: 'default', canSpawn: false });
    const team = bots.startTeam({ goal: 'Add a login page', cwd: '/p', coordinator: { name: 'Lead', role: 'Plan and delegate', agent, permissionMode: 'acceptEdits' } });
    expect(team.bots[0]).toMatchObject({ id: 'b1', name: 'Lead', depth: 0, canSpawn: true, status: 'working' });
    expect(fake.started[0]!.mcp).toBe(1);
    expect(fake.started[0]!.prompt).toContain('Add a login page');
    const lead = { teamId: team.id, botId: 'b1' };
    expect(await bots.callTool(lead, 'list_bot_configs', {})).toContain('Tester');

    // From a configuration: its own agent, model and permissions; no tools (it can't create bots).
    expect(await bots.callTool(lead, 'create_bot', { name: 'QA', task: 'Test the login page', config: 'tester' })).toContain('id b2');
    expect(fake.started[1]).toMatchObject({ model: 'haiku', permissionMode: 'default', mcp: 0 });
    // Defined directly: the creator's agent and permissions, and here allowed to create bots.
    await bots.callTool(lead, 'create_bot', { name: 'Builder', task: 'Build the page', role: 'Frontend', can_create_bots: true });
    expect(fake.started[2]).toMatchObject({ model: 'sonnet', permissionMode: 'acceptEdits', mcp: 1 });
    const builder = { teamId: team.id, botId: 'b3' };
    // Depth limit: the builder's own bots can't create more.
    await bots.callTool(builder, 'create_bot', { name: 'Helper', task: 'CSS', role: 'Styles', can_create_bots: true });
    expect(bots.listTeams()[0]!.bots.find((b) => b.id === 'b4')).toMatchObject({ depth: 2, canSpawn: false, parentId: 'b3' });
    expect(fake.started[3]!.mcp).toBe(0);

    // Waiting returns the bot's answer once its turn ends.
    const waiting = bots.callTool(lead, 'wait_for_bot', { bot_id: 'b2', timeout_seconds: 5 });
    fake.play('run-2', 'All 12 tests pass.');
    expect(await waiting).toContain('All 12 tests pass.');

    // Scope: a bot only controls the bots it created.
    await expect(bots.callTool(builder, 'message_bot', { bot_id: 'b2', text: 'hi' })).rejects.toThrow(/isn't one of your bots/);
    expect(await bots.callTool(builder, 'message_bot', { bot_id: 'b4', text: 'use flexbox' })).toContain('Sent to Helper');
    expect(fake.sent).toContainEqual(['run-4', 'use flexbox']);

    // Stopping a bot stops what it created too.
    await bots.callTool(lead, 'stop_bot', { bot_id: 'b3' });
    expect(fake.stopped).toEqual(expect.arrayContaining(['run-3', 'run-4']));
    bots.stopAll();
  });

  it('adds the starter configurations once, planner may create bots', () => {
    const { bots } = setup();
    const starters = { planner: { name: 'Planner', role: 'Plan' }, coder: { name: 'Programmer', role: 'Code' }, reviewer: { name: 'Reviewer', role: 'Review' } };
    const list = bots.addStarters(agent, starters);
    expect(list.map((c) => c.name)).toEqual(['Planner', 'Programmer', 'Reviewer']);
    expect(list.find((c) => c.name === 'Planner')).toMatchObject({ canSpawn: true, permissionMode: 'default' });
    expect(list.find((c) => c.name === 'Programmer')).toMatchObject({ canSpawn: false, permissionMode: 'acceptEdits' });
    expect(bots.addStarters(agent, starters)).toHaveLength(3);
  });

  it('remembers each bot\'s conversation id', () => {
    const { fake, bots } = setup();
    const team = bots.startTeam({ goal: 'x', cwd: '/p', coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    (bots as unknown as { onRunEvent(m: RunnerEventMessage): void }).onRunEvent({ runId: fake.started[0]!.runId, event: { type: 'started', sessionId: 'sess-1' } });
    expect(bots.listTeams().find((t) => t.id === team.id)!.bots[0]!.sessionId).toBe('sess-1');
  });

  it('a bot asking you a question waits for you until you answer', () => {
    const { fake, bots } = setup();
    const team = bots.startTeam({ goal: 'x', cwd: '/p', coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    const emit = (bots as unknown as { onRunEvent(m: RunnerEventMessage): void }).onRunEvent.bind(bots);
    const runId = fake.started[0]!.runId;
    emit({ runId, event: { type: 'status', status: 'running' } });
    emit({ runId, event: { type: 'question', requestId: 'form-1', message: 'Which color?', fields: [{ key: 'question_0', title: 'Color', description: '', kind: 'single', options: [] }] } });
    const lead = () => bots.listTeams().find((t) => t.id === team.id)!;
    expect(lead().bots[0]!.status).toBe('waiting');
    expect(lead().activity!.at(-1)).toMatchObject({ kind: 'waiting', detail: 'Color' });
    emit({ runId, event: { type: 'questionClosed', requestId: 'form-1', answered: true } });
    expect(lead().bots[0]!.status).toBe('working');
  });

  it('stops the whole team at its spending cap', async () => {
    const { fake, bots } = setup();
    const team = bots.startTeam({ goal: 'g', cwd: '/p', budgetUsd: 1, coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    const lead = { teamId: team.id, botId: 'b1' };
    await bots.callTool(lead, 'create_bot', { name: 'W', task: 't' });
    const emit = (bots as unknown as { onRunEvent(m: RunnerEventMessage): void }).onRunEvent.bind(bots);
    emit({ runId: 'run-1', event: { type: 'usage', usedTokens: 1, contextTokens: 10, costUsd: 0.6 } });
    expect(fake.stopped).toEqual([]);
    emit({ runId: 'run-2', event: { type: 'usage', usedTokens: 1, contextTokens: 10, costUsd: 0.5 } });
    expect(fake.stopped).toEqual(expect.arrayContaining(['run-1', 'run-2']));
    expect(bots.listTeams()[0]!.stoppedReason).toMatch(/^budget/);
    await expect(bots.callTool(lead, 'create_bot', { name: 'X', task: 't' })).rejects.toThrow(/spending cap/);
  });

  it('continues a finished bot in its saved conversation, and names teams from the goal', async () => {
    const { teamTitle } = await import('../src/main/bots');
    expect(teamTitle('Add a login page. Then test it.')).toBe('Add a login page.');
    const { fake, bots } = setup();
    const team = bots.startTeam({ goal: 'g', cwd: '/p', coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    const emit = (bots as unknown as { onRunEvent(m: RunnerEventMessage): void }).onRunEvent.bind(bots);
    emit({ runId: 'run-1', event: { type: 'started', sessionId: 'sess-lead-1' } });
    emit({ runId: 'run-1', event: { type: 'status', status: 'done' } });
    expect(bots.listTeams()[0]!.bots[0]!.status).toBe('done');
    bots.message(team.id, 'b1', 'one more thing');
    // A new run resumes the same conversation with your message.
    expect(fake.started[1]).toMatchObject({ prompt: 'one more thing' });
    expect((fake.started[1] as unknown as { resume?: string }).resume).toBe('sess-lead-1');
    bots.rename(team.id, 'Login');
    expect(bots.listTeams()[0]!.title).toBe('Login');
  });

  it('waits for your approval of the plan before creating bots, with your edits', async () => {
    const { fake, bots } = setup();
    const team = bots.startTeam({ goal: 'Add login', cwd: '/p', approvePlan: true, coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    expect(fake.started[0]!.prompt).toContain('propose_plan');
    const lead = { teamId: team.id, botId: 'b1' };
    await expect(bots.callTool(lead, 'create_bot', { name: 'X', task: 't' })).rejects.toThrow(/propose_plan/);
    expect(await bots.callTool(lead, 'propose_plan', { summary: 'Build then test', bots: [{ name: 'Builder', task: 'Build it' }, { name: 'Tester', task: 'Test it' }], estimate_usd: 0.5 })).toContain('wait_for_plan');
    expect(bots.listTeams()[0]!.plan).toMatchObject({ status: 'pending', revision: 1, estimateUsd: 0.5 });
    await expect(bots.callTool(lead, 'create_bot', { name: 'Builder', task: 't' })).rejects.toThrow(/not approved/);
    // You ask for changes: the coordinator hears why.
    const first = bots.callTool(lead, 'wait_for_plan', { timeout_seconds: 5 });
    bots.answerPlan(team.id, { approve: false, feedback: 'Add a reviewer' });
    expect(await first).toContain('Add a reviewer');
    await bots.callTool(lead, 'propose_plan', { summary: 'v2', bots: [{ name: 'Builder', task: 'Build it' }, { name: 'Reviewer', task: 'Review it' }] });
    expect(bots.listTeams()[0]!.plan).toMatchObject({ status: 'pending', revision: 2 });
    // You approve with an edited task.
    const second = bots.callTool(lead, 'wait_for_plan', { timeout_seconds: 5 });
    bots.answerPlan(team.id, { approve: true, bots: [{ name: 'Builder', task: 'Build it with tests', config: '', role: '', ownWorktree: true }] });
    const reply = await second;
    expect(reply).toContain('Build it with tests');
    expect(reply).toContain('[own_worktree]');
    expect(reply).not.toContain('Reviewer');
    expect(await bots.callTool(lead, 'create_bot', { name: 'Builder', task: 'Build it with tests' })).toContain('Created Builder');
    expect(() => bots.answerPlan(team.id, { approve: true })).toThrow(/No plan/);
  });

  it('records the team activity and what each bot is doing', async () => {
    const { fake, bots } = setup();
    const team = bots.startTeam({ goal: 'g', cwd: '/p', coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    const lead = { teamId: team.id, botId: 'b1' };
    await bots.callTool(lead, 'create_bot', { name: 'W', task: 'write docs' });
    const emit = (bots as unknown as { onRunEvent(m: RunnerEventMessage): void }).onRunEvent.bind(bots);
    emit({ runId: 'run-2', event: { type: 'tool', name: 'Bash', summary: 'npm test', id: 't1' } });
    expect(bots.listTeams()[0]!.bots[1]!.doing).toBe('Bash: npm test');
    emit({ runId: 'run-2', event: { type: 'permission', requestId: 'p1', toolId: null, title: 'Write docs/a.md', kind: 'edit', diffs: [], choices: [], content: null } });
    fake.play('run-2', 'done');
    bots.message(team.id, 'b2', 'thanks');
    const kinds = bots.listTeams()[0]!.activity!.map((e) => e.kind);
    expect(kinds).toEqual(['created', 'waiting', 'finished', 'message']);
    expect(bots.listTeams()[0]!.activity![0]!.detail).toBe('b2|write docs');
    expect(bots.listTeams()[0]!.bots[1]!.doing).toBeNull();
  });

  it('finishes only when the coordinator says so, and talking to it again reopens the team', async () => {
    const { fake, bots } = setup();
    const team = bots.startTeam({ goal: 'g', cwd: '/p', coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    const lead = { teamId: team.id, botId: 'b1' };
    expect(fake.started[0]!.prompt).toContain('finish_team');
    await bots.callTool(lead, 'create_bot', { name: 'W', task: 't' });
    await expect(bots.callTool({ teamId: team.id, botId: 'b2' }, 'finish_team', { summary: 'x' })).rejects.toThrow(/Only the coordinator/);
    expect(await bots.callTool(lead, 'finish_team', { summary: 'All done by W' })).toContain('finished');
    expect(bots.listTeams()[0]!.finished).toMatchObject({ summary: 'All done by W' });
    expect(bots.listTeams()[0]!.activity!.at(-1)).toMatchObject({ kind: 'done', botId: 'b1' });
    bots.message(team.id, 'b1', 'one more thing');
    expect(bots.listTeams()[0]!.finished).toBeNull();
  });

  it("keeps a turn's final message as its answer, and says what bots do in the app's words", async () => {
    const { bots } = setup();
    const team = bots.startTeam({ goal: 'g', cwd: '/p', coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    await bots.callTool({ teamId: team.id, botId: 'b1' }, 'create_bot', { name: 'W', task: 't' });
    const emit = (bots as unknown as { onRunEvent(m: RunnerEventMessage): void }).onRunEvent.bind(bots);
    const final = 'Done: I wrote docs/a.md with the setup steps and a troubleshooting section.';
    emit({ runId: 'run-2', event: { type: 'text', text: "I'll look at the files first. " } });
    emit({ runId: 'run-2', event: { type: 'tool', name: 'Read', summary: 'a.md', id: 't1' } });
    emit({ runId: 'run-2', event: { type: 'text', text: final } });
    emit({ runId: 'run-2', event: { type: 'result', ok: true, sessionId: null, costUsd: null } });
    expect(bots.listTeams()[0]!.bots[1]!.lastReply).toBe(final);
    // A short last line isn't the whole answer: everything is kept then.
    bots.message(team.id, 'b2', 'again');
    emit({ runId: 'run-2', event: { type: 'text', text: 'Here is the long report about everything I changed today. ' } });
    emit({ runId: 'run-2', event: { type: 'tool', name: 'TodoWrite', summary: '', id: 't2' } });
    emit({ runId: 'run-2', event: { type: 'text', text: 'Done.' } });
    emit({ runId: 'run-2', event: { type: 'result', ok: true, sessionId: null, costUsd: null } });
    expect(bots.listTeams()[0]!.bots[1]!.lastReply).toContain('long report');
    emit({ runId: 'run-1', event: { type: 'tool', name: 'mcp__alchemist_bots__wait_for_bot', summary: '', id: 't9', input: '{"bot_id":"b2"}' } });
    expect(bots.listTeams()[0]!.bots[0]!.doing).toBe('@wait_for_bot:W');
  });

  it('keeps saying what a bot does when a call\'s updates come without its name', async () => {
    const { bots } = setup();
    const team = bots.startTeam({ goal: 'g', cwd: '/p', coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    await bots.callTool({ teamId: team.id, botId: 'b1' }, 'create_bot', { name: 'W', task: 't' });
    const emit = (bots as unknown as { onRunEvent(m: RunnerEventMessage): void }).onRunEvent.bind(bots);
    const doing = (i: number) => bots.listTeams()[0]!.bots[i]!.doing;
    emit({ runId: 'run-2', event: { type: 'tool', name: 'Bash', summary: 'npm test', id: 't1', kind: 'execute' } });
    // Updates of the same call: named after its kind, or just "tool", with nothing new to say.
    emit({ runId: 'run-2', event: { type: 'tool', name: 'execute', summary: '', id: 't1', kind: 'execute', state: 'running' } });
    emit({ runId: 'run-2', event: { type: 'tool', name: 'tool', summary: '', id: 't1', state: 'done' } });
    expect(doing(1)).toBe('Bash: npm test');
    // One of the app's own tools that only ever arrives as an update: the title names it.
    emit({ runId: 'run-1', event: { type: 'tool', name: 'other', summary: 'mcp__alchemist_bots__wait_for_bot', id: 't2', kind: 'other', input: '{"bot_id":"b2"}' } });
    expect(doing(0)).toBe('@wait_for_bot:W');
    // A title that already starts with the tool isn't said twice.
    emit({ runId: 'run-2', event: { type: 'tool', name: 'Read', summary: 'Read notes.txt', id: 't3', kind: 'read' } });
    expect(doing(1)).toBe('Read notes.txt');
    emit({ runId: 'run-2', event: { type: 'tool', name: 'Bash', summary: 'npm test', id: 't4', kind: 'execute' } });
    // An unknown call with no name at all changes nothing.
    emit({ runId: 'run-2', event: { type: 'tool', name: 'tool', summary: '', id: 't7' } });
    expect(doing(1)).toBe('Bash: npm test');
  });

  it('marks teams cut off by a restart, and a plan answered later resumes the coordinator', async () => {
    const fake = fakeRunner();
    const files = { configs: join(dir, 'restart-c.json'), teams: join(dir, 'restart-t.json') };
    const make = () => new BotManager(files, fake.runner as never, { command: process.execPath, script: writeBridge(dir) }, (cwd) => String(cwd), () => {});
    const first = make();
    const team = first.startTeam({ goal: 'g', cwd: '/p', approvePlan: true, coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    (first as unknown as { onRunEvent(m: RunnerEventMessage): void }).onRunEvent({ runId: 'run-1', event: { type: 'started', sessionId: 'sess-lead' } });
    await first.callTool({ teamId: team.id, botId: 'b1' }, 'propose_plan', { summary: 's', bots: [{ name: 'Builder', task: 'build it' }] });
    first.flush();
    const second = make();
    const after = second.listTeams()[0]!;
    expect(after.stoppedReason).toBe('appClosed');
    expect(after.bots[0]!.status).toBe('stopped');
    expect(after.plan!.status).toBe('pending');
    second.answerPlan(team.id, { approve: true });
    const resumed = fake.started.at(-1) as unknown as { prompt: string; resume?: string };
    expect(resumed.resume).toBe('sess-lead');
    expect(resumed.prompt).toContain('Create exactly these bots');
    expect(second.listTeams()[0]!.stoppedReason).toBeNull();
  });

  it('keeps why a bot failed apart from its answer, tells its creator, and clears it on a retry', async () => {
    const { bots } = setup();
    const team = bots.startTeam({ goal: 'g', cwd: '/p', coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    const lead = { teamId: team.id, botId: 'b1' };
    await bots.callTool(lead, 'create_bot', { name: 'W', task: 't' });
    const emit = (bots as unknown as { onRunEvent(m: RunnerEventMessage): void }).onRunEvent.bind(bots);
    emit({ runId: 'run-2', event: { type: 'started', sessionId: 'sess-w' } });
    emit({ runId: 'run-2', event: { type: 'text', text: 'Half of the work is done here.' } });
    emit({ runId: 'run-2', event: { type: 'error', message: 'Rate limited' } });
    emit({ runId: 'run-2', event: { type: 'result', ok: false, sessionId: null, costUsd: null } });
    const w = () => bots.listTeams()[0]!.bots[1]!;
    expect(w()).toMatchObject({ status: 'error', error: 'Rate limited', lastReply: 'Half of the work is done here.' });
    expect(await bots.callTool(lead, 'wait_for_bot', { bot_id: 'b2', timeout_seconds: 5 })).toContain('Its turn failed: Rate limited');
    bots.message(team.id, 'b2', 'try again');
    expect(w().error).toBeNull();
  });

  it('runs an organization: one coordinator, its agents per project, its rules for everyone, and proposed agents', async () => {
    const { fake, bots } = setup();
    const starters = { coordinator: { name: 'Coordinator', role: 'Plan and delegate' }, coder: { name: 'Programmer', role: 'Writes code' }, uijudge: { name: 'UI Judge', role: 'Judges the interface' } };
    const list = bots.ensureOrg(agent, starters);
    expect(list.filter((c) => c.kind === 'coordinator').map((c) => c.name)).toEqual(['Coordinator']);
    expect(list.map((c) => c.name).sort()).toEqual(['Coordinator', 'Programmer', 'UI Judge']);
    // Idempotent, and the coordinator stays one.
    expect(bots.ensureOrg(agent, starters)).toHaveLength(3);
    const lead = list.find((c) => c.kind === 'coordinator')!;
    expect(() => bots.deleteConfig(lead.id)).toThrow(/coordinator/);
    const judge = list.find((c) => c.name === 'UI Judge')!;
    bots.saveConfig({ ...judge, projects: ['/other'] });
    bots.saveOrgSettings({ name: 'Acme', instructions: 'Always write tests.' });
    expect(bots.orgSettings()).toEqual({ name: 'Acme', instructions: 'Always write tests.' });
    const team = bots.startTeam({ goal: 'Add login', cwd: '/p', configId: lead.id, guidance: 'Keep it small' });
    const prompt = fake.started[0]!.prompt;
    expect(prompt).toContain('organization "Acme"');
    expect(prompt).toContain('Always write tests.');
    expect(prompt).toContain('For this assignment: Keep it small');
    expect(prompt).toContain('- Programmer: Writes code');
    // The UI Judge works in another project: not offered here.
    expect(prompt).not.toContain('UI Judge');
    const me = { teamId: team.id, botId: 'b1' };
    expect(await bots.callTool(me, 'list_bot_configs', {})).not.toContain('UI Judge');
    await expect(bots.callTool(me, 'create_bot', { name: 'Clone', task: 't', config: 'Coordinator' })).rejects.toThrow(/coordinator/);
    // An agent from the organization gets its rules too.
    await bots.callTool(me, 'create_bot', { name: 'P', task: 'code it', config: 'Programmer' });
    expect(fake.started[1]!.prompt).toContain('Always write tests.');
    // Defined on the spot: it joins as a proposed agent of this project, linked to the running one.
    await bots.callTool(me, 'create_bot', { name: 'Docs writer', task: 'write docs', role: 'Writes docs' });
    const proposed = bots.listConfigs().find((c) => c.name === 'Docs writer')!;
    expect(proposed).toMatchObject({ kind: 'member', proposed: true, projects: ['/p'], role: 'Writes docs' });
    expect(bots.listTeams()[0]!.bots.at(-1)!.configId).toBe(proposed.id);
    expect(await bots.callTool(me, 'list_bot_configs', {})).toContain('Docs writer');
  });

  it("lets a top-level agent lead a team: it hands work to its team, one level deep", async () => {
    const { fake, bots } = setup();
    const starters = { coordinator: { name: 'Chief', role: 'Plan and delegate' }, coder: { name: 'Dreammaker', role: 'Builds features' }, researcher: { name: 'Seeker', role: 'Researches' } };
    const list = bots.ensureOrg(agent, starters);
    const chief = list.find((c) => c.kind === 'coordinator')!;
    const dream = list.find((c) => c.name === 'Dreammaker')!;
    const seeker = list.find((c) => c.name === 'Seeker')!;
    const scribe = bots.saveConfig({ name: 'Scribe', role: 'Writes emails', agent, permissionMode: 'default', canSpawn: false, leadId: dream.id });
    expect(scribe.leadId).toBe(dream.id);
    // One level deep, and never your own team.
    expect(() => bots.saveConfig({ ...seeker, leadId: scribe.id })).toThrow(/top-level/);
    expect(() => bots.saveConfig({ ...dream, leadId: seeker.id })).toThrow(/leads a team/);
    expect(() => bots.saveConfig({ ...seeker, leadId: seeker.id })).toThrow(/own team/);
    expect(bots.saveConfig({ ...seeker, leadId: chief.id }).leadId).toBeNull();
    // Renaming keeps the team.
    expect(bots.saveConfig({ ...scribe, name: 'Quill' })).toMatchObject({ name: 'Quill', leadId: dream.id });

    const team = bots.startTeam({ goal: 'Launch', cwd: '/p', configId: chief.id });
    expect(fake.started[0]!.prompt).toContain('Dreammaker: Builds features');
    expect(fake.started[0]!.prompt).toContain('leads a team: Quill');
    expect(fake.started[0]!.prompt).toContain('hands work to its team itself');
    const me = { teamId: team.id, botId: 'b1' };
    expect(await bots.callTool(me, 'list_bot_configs', {})).toContain("on Dreammaker's team");
    // The lead may create bots and gets its team in its instructions.
    await bots.callTool(me, 'create_bot', { name: 'Dreammaker', task: 'build the launch page', config: 'Dreammaker' });
    expect(bots.listTeams()[0]!.bots[1]).toMatchObject({ canSpawn: true, depth: 1 });
    expect(fake.started[1]!.prompt).toContain('You lead a team');
    expect(fake.started[1]!.prompt).toContain('- Quill: Writes emails');
    const lead = { teamId: team.id, botId: 'b2' };
    expect((await bots.callTool(lead, 'list_bot_configs', {})).split('\n')[0]).toContain('Quill');
    expect(await bots.callTool(lead, 'create_bot', { name: 'Quill', task: 'write the launch email', config: 'Quill' })).toContain('id b3');
    // Deleting a lead: its team reports to the coordinator again.
    bots.deleteConfig(dream.id);
    expect(bots.listConfigs().find((c) => c.name === 'Quill')!.leadId).toBeNull();
  });

  it('caps the team size', async () => {
    const { bots } = setup();
    const team = bots.startTeam({ goal: 'Big job', cwd: '/p', coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    const lead = { teamId: team.id, botId: 'b1' };
    for (let i = 1; i < MAX_BOTS; i++) await bots.callTool(lead, 'create_bot', { name: `W${i}`, task: 'x', role: 'worker' });
    await expect(bots.callTool(lead, 'create_bot', { name: 'One more', task: 'x', role: 'worker' })).rejects.toThrow(/already has/);
  });

  it('serves the tools over MCP through the bridge, only with a valid token', async () => {
    const { bots } = setup();
    await bots.start();
    const team = bots.startTeam({ goal: 'Goal', cwd: '/p', coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    // The token the coordinator's bridge got.
    const started = (bots as unknown as { tokens: Map<string, { botId: string }> }).tokens;
    const [token] = [...started.entries()].find(([, v]) => v.botId === 'b1')!;
    const port = (bots as unknown as { port: number }).port;
    const talk = (tok: string, lines: object[]) =>
      new Promise<Array<Record<string, any>>>((resolve) => {
        const child = spawn(process.execPath, [join(dir, 'bots-mcp.cjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AC_BOTS_URL: `http://127.0.0.1:${port}`, AC_BOTS_TOKEN: tok } });
        const out: Array<Record<string, any>> = [];
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            out.push(JSON.parse(buf.slice(0, i)));
            buf = buf.slice(i + 1);
            if (out.length === lines.length) child.kill();
          }
        });
        child.on('exit', () => resolve(out));
        for (const l of lines) child.stdin.write(`${JSON.stringify(l)}\n`);
      });
    const replies = await talk(token, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_bots', arguments: {} } },
    ]);
    expect(replies[0]!.result.serverInfo.name).toBe(SERVER_NAME);
    expect(replies[1]!.result.tools.map((t: { name: string }) => t.name)).toContain('create_bot');
    expect(replies[2]!.result.content[0].text).toContain('b1 Lead');
    const denied = await talk('wrong-token', [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    expect(denied[0]!.result.tools).toEqual([]);
    expect(team.bots).toHaveLength(1);
    bots.stopAll();
  });
});

describe('bots with their own copy', { timeout: 30_000 }, () => {
  it('works in a worktree, lists its changes and applies them to the folder, only what is new', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'bots-repo-')));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    run('init', '-q');
    // Git for Windows turns LF into CRLF on checkout by default; these tests compare exact bytes.
    run('config', 'core.autocrlf', 'false');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 'T');
    writeFileSync(join(repo, 'app.txt'), 'one\n');
    run('add', '-A');
    run('commit', '-qm', 'base');
    const { fake, bots } = setup();
    const team = bots.startTeam({ goal: 'g', cwd: repo, coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    const lead = { teamId: team.id, botId: 'b1' };
    expect(await bots.callTool(lead, 'create_bot', { name: 'Solo', task: 'add a file', own_worktree: true })).toContain('own copy');
    const wt = bots.listTeams()[0]!.bots[1]!.worktree!;
    expect(fake.started[1]!.cwd).toBe(wt.path);
    // The bot writes in its copy; the folder stays untouched until applied.
    writeFileSync(join(wt.path, 'new.txt'), 'from the bot\n');
    fake.play('run-2', 'done');
    expect(await bots.callTool(lead, 'bot_changes', { bot_id: 'b2' })).toContain('A new.txt +1 −0');
    // You can read the patch before applying it.
    const patch = await bots.diffOf(team.id, 'b2');
    expect(patch).toContain('diff --git a/new.txt b/new.txt');
    expect(patch).toContain('+from the bot');
    expect(() => readFileSync(join(repo, 'new.txt'))).toThrow();
    expect(await bots.callTool(lead, 'apply_bot_work', { bot_id: 'b2' })).toContain('Applied');
    expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('from the bot\n');
    // Applying again brings nothing already there; later work comes on its own.
    expect(await bots.callTool(lead, 'apply_bot_work', { bot_id: 'b2' })).toContain('no new changes');
    writeFileSync(join(wt.path, 'app.txt'), 'one\ntwo\n');
    expect(await bots.callTool(lead, 'apply_bot_work', { bot_id: 'b2' })).toContain('Applied');
    expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toBe('one\ntwo\n');
    // A clash leaves the folder exactly as it was.
    writeFileSync(join(wt.path, 'app.txt'), 'one\ntwo\nbot\n');
    writeFileSync(join(repo, 'app.txt'), 'someone else\n');
    await expect(bots.callTool(lead, 'apply_bot_work', { bot_id: 'b2' })).rejects.toThrow(/Nothing was applied/);
    expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toBe('someone else\n');
    // Deleting the team removes the copy but keeps its branch, so unapplied work can be recovered.
    bots.deleteTeam(team.id);
    bots.stopAll();
    await new Promise((r) => setTimeout(r, 600));
    expect(() => readFileSync(join(wt.path, 'app.txt'))).toThrow();
    expect(run('branch', '--list', wt.branch)).toContain(wt.branch);
    rmSync(repo, { recursive: true, force: true });
  });

  it("says when a bot's copy is gone instead of failing quietly", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'bots-gone-')));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    run('init', '-q');
    // Git for Windows turns LF into CRLF on checkout by default; these tests compare exact bytes.
    run('config', 'core.autocrlf', 'false');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 'T');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    run('add', '-A');
    run('commit', '-qm', 'base');
    const { bots } = setup();
    const team = bots.startTeam({ goal: 'g', cwd: repo, coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    await bots.callTool({ teamId: team.id, botId: 'b1' }, 'create_bot', { name: 'Solo', task: 't', own_worktree: true });
    const wt = bots.listTeams()[0]!.bots[1]!.worktree!;
    rmSync(wt.path, { recursive: true, force: true });
    await expect(bots.changesOf(team.id, 'b2')).rejects.toThrow(/copy is gone/);
    bots.stopAll();
    rmSync(repo, { recursive: true, force: true });
  });

  it('falls back to the shared folder outside git', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'bots-plain-')));
    mkdirSync(join(plain, 'x'), { recursive: true });
    const { fake, bots } = setup();
    const team = bots.startTeam({ goal: 'g', cwd: plain, coordinator: { name: 'Lead', role: '', agent, permissionMode: 'acceptEdits' } });
    const reply = await bots.callTool({ teamId: team.id, botId: 'b1' }, 'create_bot', { name: 'Solo', task: 't', own_worktree: true });
    expect(reply).toContain("isn't a git repository");
    expect(fake.started[1]!.cwd).toBe(plain);
    bots.stopAll();
    rmSync(plain, { recursive: true, force: true });
  });
});
