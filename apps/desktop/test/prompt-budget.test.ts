import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunnerEventMessage } from '../src/shared/api';
import { BotManager } from '../src/main/bots';
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
    console.log(rows.map(([k, c]) => `${k}: ${c} chars ≈ ${tok(c)} tok`).join('\n'));
    // The coordinator still knows everything the organization learned.
    for (const l of lessons) expect(s.coordinator).toContain(l.text);
    expect(s.coordinator).toContain('- Agent 19:');
  });
});
