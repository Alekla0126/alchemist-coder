import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunnerEventMessage } from '../src/shared/api';
import { BotManager, lessonsBlock, lessonsFor } from '../src/main/bots';
import { writeBridge } from '../src/main/bots-bridge';

const dir = mkdtempSync(join(tmpdir(), 'prompt-budget-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
/** Tokens, roughly: four characters each. */
const tok = (chars: number) => Math.round(chars / 4);

const TOPICS = ['Android', 'iOS', 'WordPress', 'React', 'the Mando panel', 'Play Console', 'App Store', 'the marketing site', 'Telegram', 'the emulator'];
/** 30 lessons as long as the real ones (≈280 characters). */
const lessons = Array.from({ length: 30 }, (_, i) => ({
  id: `l${i}`,
  text: `Before touching ${TOPICS[i % TOPICS.length]} (case ${i}), check the exact file, branch and folder with ls and git status, run the relevant build or tests, and write down the command and its output; never trust a summary from another bot without reading it yourself first, and say what was skipped.`,
  by: 'Coordinator',
  from: `Assignment ${i}`,
  at: 1_000 + i,
}));

function fakeRunner() {
  let n = 0;
  const listeners: Array<(m: RunnerEventMessage) => void> = [];
  const started: Array<{ runId: string; prompt: string }> = [];
  const runner = {
    start: (req: { prompt: string }) => (started.push({ runId: `run-${++n}`, prompt: req.prompt }), { runId: `run-${n}` }),
    send: () => {},
    stop: () => {},
    observe: (l: (m: RunnerEventMessage) => void) => (listeners.push(l), () => {}),
  };
  const play = (runId: string, text: string) => {
    for (const l of listeners) l({ runId, event: { type: 'text', text } });
    for (const l of listeners) l({ runId, event: { type: 'result', ok: true, sessionId: null, costUsd: 0.01 } });
  };
  return { runner, started, play };
}

/** An organization with 30 lessons and 20 agents, an assignment, and one agent working on it. */
async function sample() {
  const fake = fakeRunner();
  const bots = new BotManager({ configs: join(dir, `c-${Math.random()}.json`), teams: join(dir, `t-${Math.random()}.json`) }, fake.runner as never, { command: process.execPath, script: writeBridge(dir) }, (cwd) => String(cwd), () => {});
  const lead = bots.ensureOrg(agent, { coordinator: { name: 'Coordinator', role: 'Plan and delegate' } }).find((c) => c.kind === 'coordinator')!;
  for (let i = 0; i < 20; i++) {
    bots.saveConfig({
      name: `Agent ${i}`,
      role: `Owns ${TOPICS[i % TOPICS.length]} work number ${i}: implements the task with small focused changes in the project's style, runs the relevant build or tests before answering, lists the files it changed, and reports open problems with what went wrong and why, so the organization can learn.`,
      agent: i % 5 === 0 ? { ...agent, model: 'opus' } : agent,
      permissionMode: i % 4 === 0 ? 'default' : 'acceptEdits',
      canSpawn: false,
    });
  }
  bots.saveOrgSettings({ lessons });
  const team = bots.startTeam({ goal: 'Fix the Android build of the emulator app and ship it', cwd: '/p', configId: lead.id });
  const me = { teamId: team.id, botId: 'b1' };
  await bots.callTool(me, 'create_bot', { name: 'Builder', task: 'Fix the Android build so ./gradlew assembleDebug passes on the emulator', config: 'Agent 1' });
  const tools = (bots as unknown as { toolsFor: (c: { teamId: string; botId: string }) => unknown[] }).toolsFor.bind(bots);
  return { fake, bots, me, coordinator: fake.started[0]!.prompt, worker: fake.started[1]!.prompt, leadTools: JSON.stringify(tools(me)), workerTools: JSON.stringify(tools({ teamId: team.id, botId: 'b2' })) };
}

describe('what each prompt costs', () => {
  it('measures the coordinator, a bot and the tools with 30 lessons and 20 agents', async () => {
    const s = await sample();
    const rows = [
      ['coordinator prompt', s.coordinator.length],
      ['bot prompt', s.worker.length],
      ['coordinator tools', s.leadTools.length],
      ['bot tools', s.workerTools.length],
    ] as const;
    // A bot's 12,000-character answer, as wait_for_bot returns it.
    s.fake.play('run-2', 'x'.repeat(12_000));
    const waited = await s.bots.callTool(s.me, 'wait_for_bot', { bot_id: 'b2', timeout_seconds: 5 });
    console.log([...rows, ['wait_for_bot (12,000-char answer)', waited.length] as const].map(([k, c]) => `${k}: ${c} chars ≈ ${tok(c)} tok`).join('\n'));
    // The coordinator still knows everything the organization learned.
    for (const l of lessons) expect(s.coordinator).toContain(l.text);
    expect(s.coordinator).toContain('- Agent 19:');
    // Measured before AC-012 with this same sample: coordinator 15,090, bot 9,077, tools 5,186 each.
    // The coordinator keeps all 30 lessons (≈8,700 chars): its saving is the list of agents.
    expect(s.coordinator.length).toBeLessThan(13_500);
    expect(s.worker.length).toBeLessThan(4_500);
    expect(s.leadTools.length).toBeLessThan(4_900);
    expect(s.workerTools.length).toBeLessThan(s.leadTools.length - 800);
    expect(waited.length).toBeLessThan(4_300);
  });

  it('tells a bot the 8 lessons nearest its task and how many it was not told', async () => {
    const s = await sample();
    const told = lessons.filter((l) => s.worker.includes(l.text));
    expect(told).toHaveLength(8);
    // Its task is about Android and the emulator, its role about iOS: those lessons first, the newest on a tie.
    expect(told.every((l) => /Android|the emulator|iOS/.test(l.text))).toBe(true);
    expect(s.worker).toContain('(22 more lessons in the organization.)');
  });

  it('never leaves a bot without lessons, and tells all when there are few', async () => {
    const few = lessons.slice(0, 3);
    expect(lessonsFor(few, 'nothing in common')).toEqual(few);
    const none = lessonsFor(lessons, 'zzz qqq');
    expect(none).toHaveLength(8);
    // No word in common: the newest ones (the list comes newest first).
    expect(none).toEqual(lessons.slice(0, 8));
    expect(lessonsBlock(none, 22)).toContain('22 more lessons');
    expect(lessonsBlock([], 3)).toBe('');
  });

  it('lists each agent in one short line: no model or permissions unless they differ', async () => {
    const s = await sample();
    const line = (n: number) => s.coordinator.split('\n').find((l) => l.startsWith(`- Agent ${n}:`))!;
    expect(line(1)).not.toContain('sonnet');
    expect(line(1)).not.toContain('permissions');
    expect(line(5)).toContain('(opus)');
    expect(line(4)).toContain('permissions default');
    expect(line(0)).toContain('(opus; permissions default)');
    // The role, at most 120 characters.
    expect(line(1).replace(/^- Agent 1: /, '').length).toBeLessThanOrEqual(120);
    expect(line(1).endsWith('…')).toBe(true);
  });

  it('gives the plan and finish_team to the coordinator only, and the whole answer with bot_reply', async () => {
    const s = await sample();
    const names = (json: string) => (JSON.parse(json) as Array<{ name: string }>).map((t) => t.name);
    expect(names(s.leadTools)).toEqual(expect.arrayContaining(['propose_plan', 'wait_for_plan', 'finish_team', 'bot_reply']));
    for (const n of ['propose_plan', 'wait_for_plan', 'finish_team']) expect(names(s.workerTools)).not.toContain(n);
    expect(names(s.workerTools)).toContain('bot_reply');
    const answer = `${'a'.repeat(4_000)}THE END`;
    s.fake.play('run-2', answer);
    const waited = await s.bots.callTool(s.me, 'wait_for_bot', { bot_id: 'b2', timeout_seconds: 5 });
    expect(waited).not.toContain('THE END');
    expect(waited).toContain('… (cut: 7 chars more; call bot_reply with bot_id "b2" for the whole answer)');
    expect(await s.bots.callTool(s.me, 'bot_reply', { bot_id: 'b2' })).toContain('THE END');
    // A short answer comes whole, without the note.
    const t = await sample();
    t.fake.play('run-2', 'Done.');
    expect(await t.bots.callTool(t.me, 'wait_for_bot', { bot_id: 'b2', timeout_seconds: 5 })).toBe('Builder (idle):\nDone.');
    await expect(s.bots.callTool({ teamId: s.me.teamId, botId: 'b2' }, 'finish_team', { summary: 'x' })).rejects.toThrow(/Only the coordinator/);
  });
});
