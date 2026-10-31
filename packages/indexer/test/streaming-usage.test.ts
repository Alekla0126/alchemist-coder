import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Indexer, IndexReader } from '../src/index.ts';

const ID = 'dddddddd-4444-4444-8444-dddddddddddd';
const root = mkdtempSync(join(tmpdir(), 'ac-stream-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const base = { sessionId: ID, cwd: '/tmp/stream-proj', version: '2.1.308' };
const reply = (uuid: string, id: string, input: number, output: number, ts = '2026-10-30T10:00:05.000Z') => ({
  ...base,
  type: 'assistant',
  uuid,
  timestamp: ts,
  message: { id, model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: input, output_tokens: output }, content: [{ type: 'text', text: 'ok' }] },
});

describe('usage written while a reply streams', () => {
  const claudeRoot = join(root, 'projects');
  const project = join(claudeRoot, '-tmp-stream-proj');
  const subDir = join(project, ID, 'subagents');
  const run = join(subDir, 'workflows', 'wf_1');
  mkdirSync(run, { recursive: true });
  writeFileSync(
    join(project, `${ID}.jsonl`),
    jsonl([
      { ...base, type: 'user', uuid: 'u1', timestamp: '2026-10-30T10:00:00.000Z', message: { role: 'user', content: 'Count it right' } },
      reply('a1', 'm1', 100, 8),
      reply('a2', 'm1', 100, 258),
      reply('a3', 'm1', 0, 0), // a record that carries no counts
    ]),
  );
  writeFileSync(join(subDir, 'agent-sub.jsonl'), jsonl([reply('s1', 'p1', 50, 3), reply('s2', 'p1', 50, 90)]));
  writeFileSync(join(subDir, 'agent-sub.meta.json'), JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }));
  writeFileSync(join(run, 'agent-wf.jsonl'), jsonl([reply('w1', 'q1', 20, 40)]));
  writeFileSync(join(run, 'agent-wf.meta.json'), JSON.stringify({ agentType: 'general-purpose', spawnDepth: 1 }));

  const dbPath = join(root, 'index.db');
  const indexer = new Indexer({ dbPath, claudeRoot, codexRoot: join(root, 'codex'), geminiRoot: join(root, 'gemini'), grokRoot: join(root, 'grok') });
  indexer.indexAll();
  indexer.close();
  const reader = new IndexReader(dbPath);
  afterAll(() => reader.close());

  it('keeps the largest count of each reply, not its first record', () => {
    const tree = reader.getAgentTree(ID)!;
    expect(tree.outputTokens).toBe(258);
    expect(tree.inputTokens).toBe(100);
    expect(reader.getSession(ID)!.contextTokens).toBe(100);
    expect(tree.children.find((c) => c.id === 'sub')!.outputTokens).toBe(90);
  });

  it('counts the agents a workflow ran with the conversation that ran it', () => {
    const tree = reader.getAgentTree(ID)!;
    expect(tree.children.find((c) => c.id === 'wf')).toMatchObject({ type: 'general-purpose', outputTokens: 40 });
    expect(reader.getSession(ID)!.outputTokens).toBe(258 + 90 + 40);
  });
});
