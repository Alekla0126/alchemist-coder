import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OrgLesson, RunnerEventMessage } from '../src/shared/api';
import { Channels } from '../src/shared/api';
import { BotManager } from '../src/main/bots';
import { writeBridge } from '../src/main/bots-bridge';

// registerIpc only needs ipcMain.handle / on here: the handlers are kept to call them directly.
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => {
  const ipcMain = { handle: (ch: string, fn: (...args: unknown[]) => unknown) => void handlers.set(ch, fn), on: () => {}, removeHandler: () => {} };
  return { ipcMain, BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null }, clipboard: {}, dialog: {}, shell: {}, app: { getPath: () => tmpdir() } };
});

const dir = mkdtempSync(join(tmpdir(), 'org-groups-main-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };

function fakeRunner() {
  let n = 0;
  const listeners: Array<(m: RunnerEventMessage) => void> = [];
  const started: Array<{ runId: string; prompt: string; cwd: string }> = [];
  const sent: Array<{ runId: string; text: string }> = [];
  const runner = {
    start: (req: { prompt: string; cwd: string }) => (started.push({ runId: `run-${++n}`, prompt: req.prompt, cwd: req.cwd }), { runId: `run-${n}` }),
    send: (runId: string, text: string) => void sent.push({ runId, text }),
    stop: () => {},
    observe: (l: (m: RunnerEventMessage) => void) => (listeners.push(l), () => {}),
  };
  const play = (runId: string, text: string) => {
    for (const l of listeners) l({ runId, event: { type: 'text', text } });
    for (const l of listeners) l({ runId, event: { type: 'result', ok: true, sessionId: null, costUsd: 0.01 } });
  };
  return { runner, started, sent, play };
}

function manager(files = { configs: join(dir, `c-${Math.random()}.json`), teams: join(dir, `t-${Math.random()}.json`) }) {
  const fake = fakeRunner();
  const bots = new BotManager(files, fake.runner as never, { command: process.execPath, script: writeBridge(dir) }, (cwd) => String(cwd), () => {});
  const lead = bots.ensureOrg(agent, { coordinator: { name: 'Coordinator', role: 'Plan and delegate' } }).find((c) => c.kind === 'coordinator')!;
  return { fake, bots, lead, files };
}

const runOf = (fake: ReturnType<typeof fakeRunner>, prompt: string) => fake.started.find((s) => s.prompt.includes(prompt))!.runId;

describe('organizations only filter the view: agents still talk across them', () => {
  it('lets a coordinator message, wait for and read its bots in a folder of another organization, or of none', async () => {
    const { fake, bots, lead } = manager();
    // Two organizations; the assignment runs in a folder of the second, and one in no organization.
    bots.saveOrgSettings({ groups: [{ id: 'mobile', name: 'Mobile', projects: ['/p/app'] }, { id: 'clients', name: 'Clients', projects: ['/p/client'] }] });
    for (const cwd of ['/p/client/web', '/elsewhere']) {
      const team = bots.startTeam({ goal: `Work in ${cwd}`, cwd, configId: lead.id });
      const me = { teamId: team.id, botId: 'b1' };
      await bots.callTool(me, 'create_bot', { name: 'Builder', task: `Build ${cwd}`, role: 'Builds' });
      const run = runOf(fake, `Build ${cwd}`);
      fake.play(run, 'first answer');
      expect(await bots.callTool(me, 'message_bot', { bot_id: 'b2', text: 'One more thing' })).toContain('Sent to Builder');
      expect(fake.sent.at(-1)).toEqual({ runId: run, text: expect.stringContaining('One more thing') });
      fake.play(run, `second answer from ${cwd}`);
      expect(await bots.callTool(me, 'wait_for_bot', { bot_id: 'b2', timeout_seconds: 5 })).toBe(`Builder (idle):\nsecond answer from ${cwd}`);
      expect(await bots.callTool(me, 'bot_reply', { bot_id: 'b2' })).toBe(`Builder (idle):\nsecond answer from ${cwd}`);
    }
    // The organizations saved stay as they were: callTool never reads or changes them.
    expect(bots.orgSettings().groups!.map((g) => g.id)).toEqual(['mobile', 'clients']);
  });
});

describe('bot_reply and org_lessons stay within their assignment', () => {
  it('reads the bot of its own assignment, never the one with the same id in another', async () => {
    const { fake, bots, lead } = manager();
    const a = bots.startTeam({ goal: 'Assignment A', cwd: '/p/a', configId: lead.id });
    const b = bots.startTeam({ goal: 'Assignment B', cwd: '/p/b', configId: lead.id });
    await bots.callTool({ teamId: a.id, botId: 'b1' }, 'create_bot', { name: 'Alpha', task: 'Task of A', role: 'r' });
    await bots.callTool({ teamId: b.id, botId: 'b1' }, 'create_bot', { name: 'Beta', task: 'Task of B', role: 'r' });
    fake.play(runOf(fake, 'Task of A'), 'ANSWER-A');
    fake.play(runOf(fake, 'Task of B'), 'SECRET-B');
    const reply = await bots.callTool({ teamId: a.id, botId: 'b1' }, 'bot_reply', { bot_id: 'b2' });
    expect(reply).toBe('Alpha (idle):\nANSWER-A');
    expect(reply).not.toContain('SECRET-B');
    // An id only the other assignment has, or its team id, finds nothing.
    await bots.callTool({ teamId: b.id, botId: 'b1' }, 'create_bot', { name: 'Gamma', task: 'Second task of B', role: 'r' });
    await expect(bots.callTool({ teamId: a.id, botId: 'b1' }, 'bot_reply', { bot_id: 'b3' })).rejects.toThrow(/No bot "b3" in this team/);
    await expect(bots.callTool({ teamId: a.id, botId: 'b1' }, 'bot_reply', { bot_id: b.id })).rejects.toThrow(/No bot/);
    // A bot reads only the bots it created, not a sibling nor its coordinator.
    await bots.callTool({ teamId: a.id, botId: 'b1' }, 'create_bot', { name: 'Sibling', task: 'Sibling task', role: 'r' });
    await expect(bots.callTool({ teamId: a.id, botId: 'b2' }, 'bot_reply', { bot_id: 'b3' })).rejects.toThrow(/isn't one of your bots/);
    await expect(bots.callTool({ teamId: a.id, botId: 'b2' }, 'bot_reply', { bot_id: 'b1' })).rejects.toThrow(/isn't one of your bots/);
  });

  it('hands over the lessons alone: not who wrote them nor the assignment they came from', async () => {
    const { bots, lead } = manager();
    const lessons: OrgLesson[] = [
      { id: 'l1', text: 'Run the tests with a cap on workers.', by: 'Tester-Writer', from: 'Private client launch', at: 2 },
      { id: 'l2', text: 'Check the branch before a commit.', by: 'Reviewer-Writer', from: 'Secret migration', at: 1 },
    ];
    bots.saveOrgSettings({ lessons });
    const team = bots.startTeam({ goal: 'Something else', cwd: '/p/x', configId: lead.id });
    await bots.callTool({ teamId: team.id, botId: 'b1' }, 'create_bot', { name: 'Bot', task: 'Do it', role: 'r' });
    for (const caller of ['b1', 'b2']) {
      const all = await bots.callTool({ teamId: team.id, botId: caller }, 'org_lessons', {});
      for (const l of lessons) {
        expect(all).toContain(l.text);
        expect(all).not.toContain(l.from);
        expect(all).not.toContain(l.by);
      }
    }
  });
});

describe('a pinned lesson', () => {
  it('survives the 31st lesson and reaches a bot whose task shares no word with it', async () => {
    const { fake, bots, lead } = manager();
    const pinned: OrgLesson = { id: 'pin', text: 'Escribe los mensajes de commit en minúsculas.', by: 'Owner', from: '', at: 0, pinned: true };
    // 29 lessons about other things, newer than the pinned one (it is the oldest: the first to go unpinned).
    const others: OrgLesson[] = Array.from({ length: 29 }, (_, i) => ({ id: `o${i}`, text: `Lesson ${i} about the emulator and the gradle build number ${i}.`, by: 'X', from: 'Y', at: 100 + i }));
    bots.saveOrgSettings({ lessons: [...others, pinned] });
    expect(bots.orgSettings().lessons).toHaveLength(30);
    const team = bots.startTeam({ goal: 'Iconos', cwd: '/p/x', configId: lead.id });
    const me = { teamId: team.id, botId: 'b1' };
    await bots.callTool(me, 'record_lesson', { lesson: 'Lesson 31: the newest one, about the emulator.' });
    const kept = bots.orgSettings().lessons;
    expect(kept).toHaveLength(30);
    expect(kept.find((l) => l.id === 'pin')?.pinned).toBe(true);
    // The oldest unpinned went instead.
    expect(kept.some((l) => l.id === 'o0')).toBe(false);
    await bots.callTool(me, 'create_bot', { name: 'Painter', task: 'Dibuja iconos vectoriales', role: 'Diseña' });
    const prompt = fake.started.at(-1)!.prompt;
    expect(prompt).toContain(pinned.text);
    // It was cut to the nearest (8 + the pinned one): the pin is not just everything being told.
    expect(prompt).toMatch(/\(\d+ more lessons: call org_lessons\)/);
  });
});

describe('seeding the starting organizations', () => {
  it('does nothing once groups were saved, [] included, also after a restart', () => {
    const { files } = manager();
    const seed = [{ id: 'mobile', name: 'Mobile', projects: ['/p/app'] }];
    for (const saved of [[], [{ id: 'mine', name: 'Mine', projects: ['/p/x'] }]]) {
      const { bots } = manager(files);
      bots.saveOrgSettings({ groups: saved });
      // A new manager reading the same org.json: what you saved, untouched by a seed.
      const again = manager(files).bots;
      expect(again.seedOrgGroups(seed).groups).toEqual(saved);
      expect(JSON.parse(readFileSync(`${files.configs}.org.json`, 'utf8')).groups).toEqual(saved);
    }
  });

  it('writes nothing to disk when no folder matched, and keeps the seed after a restart when one did', () => {
    const { bots, files } = manager();
    writeFileSync(`${files.configs}.org.json`, JSON.stringify({ name: 'Org', instructions: '', autopilot: false, lessons: [] }));
    const before = readFileSync(`${files.configs}.org.json`, 'utf8');
    const fresh = manager(files).bots;
    expect(fresh.seedOrgGroups([{ id: 'mobile', name: 'Mobile', projects: [] }]).groups).toBeUndefined();
    expect(fresh.seedOrgGroups([]).groups).toBeUndefined();
    expect(readFileSync(`${files.configs}.org.json`, 'utf8')).toBe(before);
    expect(bots.orgSettings().groups).toBeUndefined();
    fresh.seedOrgGroups([{ id: 'mobile', name: 'Mobile', projects: ['/p/app'] }]);
    expect(manager(files).bots.orgSettings().groups).toEqual([{ id: 'mobile', name: 'Mobile', projects: ['/p/app'] }]);
  });

  it('seeds through IPC from the owner’s module only, with the open folders it was given', async () => {
    const { registerIpc } = await import('../src/main/ipc');
    const { bots } = manager();
    const asked: unknown[] = [];
    const deps = new Proxy(
      { bots, starterGroups: (folders: string[]) => (asked.push(folders), folders.includes('/p/app') ? [{ id: 'mobile', name: 'Mobile', projects: ['/p/app'] }] : []) },
      { get: (t, k) => (k in t ? t[k as keyof typeof t] : () => null) },
    );
    registerIpc(deps as never);
    const seed = handlers.get(Channels.seedOrgGroups)!;
    // Not a list of folders, or none of the module's: nothing saved.
    expect(((await seed({}, 'nope')) as { groups?: unknown }).groups).toBeUndefined();
    expect(((await seed({}, ['/p/other', 7])) as { groups?: unknown }).groups).toBeUndefined();
    expect(asked).toEqual([[], ['/p/other']]);
    expect(((await seed({}, ['/p/app'])) as { groups?: unknown }).groups).toEqual([{ id: 'mobile', name: 'Mobile', projects: ['/p/app'] }]);
    // Without the owner's module (the Community edition) nothing is ever seeded.
    const other = manager().bots;
    registerIpc(new Proxy({ bots: other }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : () => null) }) as never);
    expect(((await handlers.get(Channels.seedOrgGroups)!({}, ['/p/app'])) as { groups?: unknown }).groups).toBeUndefined();
  });
});
