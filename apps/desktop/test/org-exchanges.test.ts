import { describe, expect, it } from 'vitest';
import type { BotConfig, BotMember, BotTeam, TeamEvent } from '../src/shared/api';
import { exchangesOf, linksOf, newExchanges, partnersOf } from '../src/renderer/src/org-model';

const agent = { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' };
const bot = (id: string, extra: Partial<BotMember> = {}): BotMember => ({ id, name: id, configId: null, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, parentId: 'b1', depth: 1, runId: null, status: 'working', task: `task of ${id}`, lastReply: '', costUsd: null, createdAt: 1000, ...extra });
const lead = (extra: Partial<BotMember> = {}) => bot('b1', { name: 'Coordinator', parentId: null, depth: 0, ...extra });
const team = (extra: Partial<BotTeam> = {}): BotTeam => ({ id: 'team-1', title: 'Export to CSV', goal: 'Add a CSV export', cwd: '/p/castbook', createdAt: 0, updatedAt: 0, bots: [], ...extra });
const ev = (at: number, botId: string, kind: TeamEvent['kind'], detail = ''): TeamEvent => ({ at, botId, kind, detail });
/** Who → whom: what, the way the live view reads it. */
const lines = (t: BotTeam) => exchangesOf(t).map((x) => `${x.from} → ${x.to}: ${x.text}`);

describe('exchanges of an assignment', () => {
  it('is empty without activity', () => {
    expect(exchangesOf(team())).toEqual([]);
    expect(exchangesOf(team({ bots: [lead()], activity: [] }))).toEqual([]);
  });

  it('reads created and message as from the bot to the one in the detail', () => {
    const t = team({
      bots: [lead(), bot('b2')],
      activity: [ev(1, 'b1', 'created', 'b2|Write the exporter'), ev(2, 'b1', 'message', 'b2|Use commas | not tabs')],
    });
    // Only the first '|' splits: the rest of the message keeps its own.
    expect(lines(t)).toEqual(['b1 → b2: Write the exporter', 'b1 → b2: Use commas | not tabs']);
    expect(exchangesOf(t).map((x) => x.kind)).toEqual(['created', 'message']);
  });

  it('reads your messages, to the coordinator or to any agent', () => {
    const t = team({
      bots: [lead(), bot('b2')],
      activity: [ev(1, 'you', 'message', 'b1|Also export the totals'), ev(2, 'you', 'message', 'b2|Hurry up')],
    });
    expect(lines(t)).toEqual(['you → b1: Also export the totals', 'you → b2: Hurry up']);
  });

  it('sends a finished or failed turn to the parent, with its latest reply on the latest turn only', () => {
    const t = team({
      bots: [lead({ lastReply: 'All done' }), bot('b2', { lastReply: 'Exporter written' }), bot('b3', { parentId: 'b2', depth: 2, lastReply: 'partial', error: 'Out of budget' })],
      activity: [ev(1, 'b2', 'finished'), ev(2, 'b3', 'failed'), ev(3, 'b2', 'finished'), ev(4, 'b1', 'finished')],
    });
    expect(lines(t)).toEqual([
      // An earlier turn's reply is gone: no text rather than the wrong one.
      'b2 → b1: ',
      // A failure shows its error before the reply.
      'b3 → b2: Out of budget',
      'b2 → b1: Exporter written',
      // The coordinator reports to you.
      'b1 → you: All done',
    ]);
  });

  it('falls back to the reply when a failed bot has no error', () => {
    const t = team({ bots: [lead(), bot('b2', { lastReply: 'Gave up on the tests' })], activity: [ev(1, 'b2', 'failed')] });
    expect(lines(t)).toEqual(['b2 → b1: Gave up on the tests']);
  });

  it('keeps a message whose detail has no "|" as text for nobody in particular', () => {
    const t = team({ bots: [lead()], activity: [ev(1, 'b1', 'message', 'hello'), ev(2, 'b1', 'created', '')] });
    expect(exchangesOf(t).map((x) => [x.to, x.text])).toEqual([
      [null, 'hello'],
      [null, ''],
    ]);
  });

  it('still shows the lines of bots that are gone or never were in the team', () => {
    const t = team({
      bots: [lead()],
      activity: [ev(1, 'b1', 'created', 'gone|Old task'), ev(2, 'gone', 'finished'), ev(3, 'ghost', 'failed'), ev(4, 'gone', 'message', 'b1|still here')],
    });
    expect(lines(t)).toEqual([
      'b1 → gone: Old task',
      // Without the bot, its parent and reply are unknown: it goes to you, without text.
      'gone → you: ',
      'ghost → you: ',
      'gone → b1: still here',
    ]);
  });

  it('leaves out the lines that are nobody telling anybody (a stop)', () => {
    const t = team({ bots: [lead(), bot('b2')], activity: [ev(1, 'b2', 'stopped'), ev(2, 'b1', 'message', 'b2|go on')] });
    expect(exchangesOf(t).map((x) => x.kind)).toEqual(['message']);
  });

  it('keeps the order of the activity, oldest first, and same-time lines in the order they came', () => {
    const t = team({
      bots: [lead(), bot('b2'), bot('b3')],
      activity: [ev(10, 'b1', 'created', 'b2|one'), ev(20, 'b1', 'created', 'b3|two'), ev(20, 'b1', 'created', 'b3|three'), ev(30, 'b2', 'finished')],
    });
    const xs = exchangesOf(t);
    expect(xs.map((x) => x.at)).toEqual([10, 20, 20, 30]);
    expect(xs.map((x) => x.text)).toEqual(['one', 'two', 'three', '']);
    // Two lines of the same bot, kind and millisecond still get their own key.
    expect(new Set(xs.map((x) => x.key)).size).toBe(4);
  });

  it('reads all 200 lines the team keeps, with keys that hold as the oldest drop off', () => {
    const activity = Array.from({ length: 200 }, (_, i) => ev(1000 + i, 'b1', 'message', `b2|message ${i}`));
    const t = team({ bots: [lead(), bot('b2')], activity });
    const xs = exchangesOf(t);
    expect(xs).toHaveLength(200);
    expect(xs[0]!.text).toBe('message 0');
    expect(xs.at(-1)!.text).toBe('message 199');
    // The 201st line pushes the first out: the 199 lines in both keep their keys.
    const next = exchangesOf(team({ ...t, activity: [...activity.slice(1), ev(1200, 'b1', 'message', 'b2|message 200')] }));
    expect(next).toHaveLength(200);
    expect(next.slice(0, 199).map((x) => x.key)).toEqual(xs.slice(1).map((x) => x.key));
    expect(new Set(next.map((x) => x.key)).size).toBe(200);
  });

  it('reads plans, approvals, changes, nudges and the end between the coordinator, you and Autopilot', () => {
    const t = team({
      bots: [lead(), bot('b2')],
      plan: { summary: 'Two agents', estimateUsd: 1, status: 'approved', feedback: '', revision: 2, bots: [] },
      finished: { summary: 'CSV export shipped', at: 9 },
      activity: [
        ev(1, 'b1', 'plan', '3'),
        ev(2, 'you', 'changes', 'Fewer agents'),
        ev(3, 'b1', 'plan', '2'),
        ev(4, 'autopilot', 'approved', '2'),
        ev(5, 'b2', 'waiting', 'Overwrite the file?'),
        ev(6, 'autopilot', 'nudged', 'b2'),
        ev(7, 'b1', 'applied', 'b2|4'),
        ev(8, 'b1', 'learned', 'Run the tests first'),
        ev(9, 'b1', 'done'),
      ],
    });
    expect(exchangesOf(t).map((x) => [x.kind, x.from, x.to, x.text, x.n])).toEqual([
      ['plan', 'b1', 'you', '', 3],
      ['changes', 'you', 'b1', 'Fewer agents', null],
      ['plan', 'b1', 'you', 'Two agents', 2],
      ['approved', 'autopilot', 'b1', '', 2],
      ['waiting', 'b2', 'you', 'Overwrite the file?', null],
      ['nudged', 'autopilot', 'b1', '', null],
      ['applied', 'b1', 'b2', '', 4],
      ['learned', 'b1', null, 'Run the tests first', null],
      ['done', 'b1', 'you', 'CSV export shipped', null],
    ]);
  });
});

describe('free text in the activity', () => {
  it('keeps a "|" in questions, changes and lessons: only created, message and applied name the other one', () => {
    const t = team({
      bots: [lead(), bot('b2')],
      activity: [
        ev(1, 'b2', 'waiting', 'Bash: ls | grep foo'),
        ev(2, 'you', 'changes', 'Fewer agents | cheaper models'),
        ev(3, 'b1', 'learned', 'Pipe | carefully'),
        ev(4, 'b1', 'message', 'b2|a | b'),
      ],
    });
    expect(exchangesOf(t).map((x) => [x.kind, x.to, x.text])).toEqual([
      ['waiting', 'you', 'Bash: ls | grep foo'],
      ['changes', 'b1', 'Fewer agents | cheaper models'],
      ['learned', null, 'Pipe | carefully'],
      ['message', 'b2', 'a | b'],
    ]);
  });
});

describe('keys', () => {
  it('keep two lines of the same millisecond, bot and kind when the cap drops the first of them', () => {
    const filler = Array.from({ length: 198 }, (_, i) => ev(i, 'b1', 'message', `b2|filler ${i}`));
    const activity = [ev(500, 'b2', 'waiting', 'first?'), ev(500, 'b2', 'waiting', 'second?'), ...filler];
    const before = exchangesOf(team({ bots: [lead(), bot('b2')], activity }));
    const after = exchangesOf(team({ bots: [lead(), bot('b2')], activity: [...activity.slice(1), ev(900, 'b1', 'message', 'b2|new')] }));
    expect(after[0]!.key).toBe(before[1]!.key);
    // Only the line that came in is new.
    expect(newExchanges(new Set(before.map((x) => x.key)), after)).toEqual([after.at(-1)!.key]);
  });

  it('tell apart lines identical in every way, and keep them as the oldest drop off', () => {
    const same = [ev(5, 'b2', 'finished'), ev(5, 'b2', 'finished'), ev(6, 'b1', 'message', 'b2|x')];
    const before = exchangesOf(team({ bots: [lead(), bot('b2')], activity: same }));
    expect(new Set(before.map((x) => x.key)).size).toBe(3);
    const after = exchangesOf(team({ bots: [lead(), bot('b2')], activity: same.slice(1) }));
    expect(after.map((x) => x.key)).toEqual(before.slice(1).map((x) => x.key));
  });
});

describe('what just came in', () => {
  const t = team({ bots: [lead(), bot('b2')], activity: [ev(1, 'b1', 'created', 'b2|go'), ev(2, 'b2', 'finished')] });
  const xs = exchangesOf(t);

  it('is nothing when an assignment just opened, or nothing changed', () => {
    expect(newExchanges(null, xs)).toEqual([]);
    expect(newExchanges(new Set(xs.map((x) => x.key)), xs)).toEqual([]);
  });

  it('is each exchange not seen before, in order', () => {
    const more = exchangesOf({ ...t, activity: [...t.activity!, ev(3, 'you', 'message', 'b2|thanks'), ev(4, 'b2', 'finished')] });
    expect(newExchanges(new Set(xs.map((x) => x.key)), more)).toEqual(more.slice(2).map((x) => x.key));
  });
});

describe('who wrote to whom', () => {
  const config = (id: string, extra: Partial<BotConfig> = {}): BotConfig => ({ id, name: id, role: '', agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', ...extra });
  const configs = [config('coord', { kind: 'coordinator' }), config('coder')];

  it('counts the messages between two cards either way, and leaves out you and lessons', () => {
    const t = team({
      bots: [lead({ configId: 'coord' }), bot('b2', { configId: 'coder' }), bot('b3', { parentId: 'b2', depth: 2 })],
      activity: [
        ev(1, 'b1', 'created', 'b2|go'),
        ev(2, 'b2', 'finished'),
        ev(3, 'b2', 'created', 'b3|test'),
        ev(4, 'you', 'message', 'b2|hi'),
        ev(5, 'b1', 'learned', 'x'),
        ev(6, 'b2', 'waiting', 'ok?'),
      ],
    });
    expect(linksOf(t, exchangesOf(t), configs)).toEqual([
      { a: 'coder', b: 'coord', n: 2 },
      { a: 'bot:b3', b: 'coder', n: 1 },
    ]);
  });

  it("lists each card's partners, most messages first", () => {
    const links = [
      { a: 'coder', b: 'coord', n: 2 },
      { a: 'bot:b3', b: 'coder', n: 5 },
      { a: 'coord', b: 'reviewer', n: 1 },
    ];
    expect(partnersOf(links, 'coder')).toEqual([
      { id: 'bot:b3', n: 5 },
      { id: 'coord', n: 2 },
    ]);
    expect(partnersOf(links, 'coord')).toEqual([
      { id: 'coder', n: 2 },
      { id: 'reviewer', n: 1 },
    ]);
    expect(partnersOf(links, 'ui')).toEqual([]);
  });
});
