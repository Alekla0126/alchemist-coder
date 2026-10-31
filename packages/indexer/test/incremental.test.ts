import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Indexer, IndexReader } from '../src/index.ts';
import { readClaudeFile, type ClaudeProgress } from '../src/claude.ts';

const ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const root = mkdtempSync(join(tmpdir(), 'ac-incr-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const base = { sessionId: ID, cwd: '/tmp/incr-proj', version: '2.1.308' };
const at = (s: number) => new Date(Date.UTC(2026, 9, 30, 10, 0, s)).toISOString();
const assistant = (uuid: string, id: string, s: number, input: number, output: number, content: object[], stop = 'tool_use') => ({
  ...base, type: 'assistant', uuid, timestamp: at(s),
  message: { id, model: 'claude-sonnet-5', stop_reason: stop, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 10 }, content },
});
const records = [
  { ...base, type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'Ship the fix' } },
  assistant('a1', 'm1', 1, 100, 4, [{ type: 'text', text: 'Looking.' }]),
  assistant('a2', 'm1', 2, 100, 40, [{ type: 'tool_use', id: 'E1', name: 'Edit', input: { file_path: '/tmp/incr-proj/a.ts', old_string: 'a', new_string: 'b' } }]),
  { ...base, type: 'user', uuid: 'u2', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'E1', content: 'ok' }] } },
  assistant('a3', 'm2', 4, 300, 7, [{ type: 'tool_use', id: 'T1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Find tests', prompt: 'Find' } }]),
  assistant('a4', 'm2', 5, 300, 70, [{ type: 'text', text: 'Spawned.' }]),
  { ...base, type: 'user', uuid: 'u3', timestamp: at(6), message: { role: 'user', content: 'Thanks, now the docs' } },
  assistant('a5', 'm3', 7, 50, 25, [{ type: 'text', text: 'Done.' }], 'end_turn'),
  { type: 'ai-title', aiTitle: 'Ship the fix', sessionId: ID },
];
const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Everything a transcript's summary says, rows by where they are. */
const shape = (p: ClaudeProgress, rows: number[]) => ({
  rows,
  usage: p.summary.usage,
  cost: p.summary.costUsd,
  replies: p.summary.assistantMessages,
  prompts: p.summary.userTurns,
  context: p.summary.contextTokens,
  stop: p.summary.lastStopReason,
  title: p.summary.aiTitle,
  first: p.summary.firstPrompt,
  edited: [...p.summary.editedFiles],
  spawns: Object.keys(p.summary.spawns),
});

describe('a transcript read as it grows', () => {
  it('gives the same totals and rows as reading it whole, wherever the writes stop', () => {
    const path = join(root, 'whole.jsonl');
    writeFileSync(path, text);
    const whole = readClaudeFile(path);
    const expected = shape(whole, whole.summary.rows.map((r) => r.offset));

    const bytes = Buffer.from(text);
    // Cuts inside lines too: a half-written last line waits for the rest.
    for (const cuts of [[1], [137, 900], [50, 51, 400, 401, 1200], Array.from({ length: 40 }, (_, i) => Math.round(((i + 1) * bytes.length) / 41))]) {
      const live = join(root, `live-${cuts.length}.jsonl`);
      writeFileSync(live, '');
      let p: ClaudeProgress | undefined;
      const rows: number[] = [];
      let from = 0;
      for (const cut of [...cuts, bytes.length]) {
        appendFileSync(live, bytes.subarray(from, cut));
        from = cut;
        p = readClaudeFile(live, p);
        rows.push(...p.summary.rows.map((r) => r.offset));
      }
      expect(shape(p!, rows)).toEqual(expected);
    }
  });

  it('keeps the largest count of a reply whose records arrive in different reads', () => {
    const path = join(root, 'split.jsonl');
    const [first, second] = [JSON.stringify(records[1]), JSON.stringify(records[2])];
    writeFileSync(path, `${first}\n`);
    const p = readClaudeFile(path);
    expect(p.summary.usage.output).toBe(4);
    appendFileSync(path, `${second}\n`);
    readClaudeFile(path, p);
    expect(p.summary.usage.output).toBe(40);
    expect(p.summary.assistantMessages).toBe(1);
  });
});

describe('the index of a live conversation', () => {
  it('stores only the appended rows, the same as indexing it from scratch', () => {
    const claudeRoot = join(root, 'projects');
    const project = join(claudeRoot, '-tmp-incr-proj');
    mkdirSync(project, { recursive: true });
    const file = join(project, `${ID}.jsonl`);
    const half = records.slice(0, 5).map((r) => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(file, half);
    const opts = { claudeRoot, codexRoot: join(root, 'codex'), geminiRoot: join(root, 'gemini'), grokRoot: join(root, 'grok') };

    const live = new Indexer({ ...opts, dbPath: join(root, 'live.db') });
    live.indexAll();
    appendFileSync(file, text.slice(half.length));
    live.indexAll();
    live.close();
    const fresh = new Indexer({ ...opts, dbPath: join(root, 'fresh.db') });
    fresh.indexAll();
    fresh.close();

    const [a, b] = [new IndexReader(join(root, 'live.db')), new IndexReader(join(root, 'fresh.db'))];
    const view = (r: IndexReader) => ({
      session: { ...r.getSession(ID)!, lastActivity: 0 },
      rows: r.getTranscript(ID, 'main', 0, 1000).entries.map((e) => [e.role, e.ts]),
      stats: r.stats(),
    });
    expect(view(a)).toEqual(view(b));
    expect(a.search('docs').length).toBe(1);
    a.close();
    b.close();
  });
});
