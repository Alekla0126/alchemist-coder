import { afterAll, expect, it } from 'vitest';
import { appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Indexer, IndexReader } from '../src/index.ts';
import { buildFixtures, CODEX_ID, SESSION } from './fixtures.ts';

const fx = buildFixtures();
afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

it('re-indexes a conversation when its transcript grows', async () => {
  const indexer = new Indexer({ dbPath: fx.dbPath, claudeRoot: fx.claudeRoot, codexRoot: fx.codexRoot, geminiRoot: fx.geminiRoot, grokRoot: fx.grokRoot });
  indexer.indexAll();
  const changed = new Promise<string[]>((resolve) => indexer.watch(resolve, 50));
  const record = { type: 'user', uuid: 'u9', sessionId: SESSION, cwd: '/tmp/demo-proj', timestamp: '2026-09-01T11:00:00.000Z', message: { role: 'user', content: 'Now add watermark support' } };
  setTimeout(() => appendFileSync(join(fx.claudeRoot, '-tmp-demo-proj', `${SESSION}.jsonl`), JSON.stringify(record) + '\n'), 100);
  expect(await changed).toEqual([SESSION]);
  indexer.close();
  const reader = new IndexReader(fx.dbPath);
  expect(reader.search('watermark').map((h) => h.sessionId)).toEqual([SESSION]);
  reader.close();
}, 10_000);


it('detects a streaming ChatGPT/Codex session before its writes stop and marks completion', async () => {
  const fixture = buildFixtures();
  const options = { dbPath: fixture.dbPath, claudeRoot: fixture.claudeRoot, codexRoot: fixture.codexRoot, geminiRoot: fixture.geminiRoot, grokRoot: fixture.grokRoot };
  const indexer = new Indexer(options);
  const reader = new IndexReader(fixture.dbPath);
  const path = join(fixture.codexRoot, 'sessions/2026/09/02', `rollout-2026-09-02T10-00-00-${CODEX_ID}.jsonl`);
  const append = (payload: object) => appendFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\n');
  let stream: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    indexer.indexAll();
    let resolveUpdate: () => void = () => {};
    const update = new Promise<void>((resolve, reject) => { resolveUpdate = resolve; deadline = setTimeout(() => reject(new Error('Live indexing waited for the stream to stop')), 1500); });
    indexer.watch((ids, source) => { if (source === 'codex' && ids.includes(CODEX_ID)) resolveUpdate(); }, 80);
    append({ type: 'task_started' });
    stream = setInterval(() => append({ type: 'token_count' }), 15);
    await update;
    expect(reader.getSession(CODEX_ID)).toMatchObject({ source: 'codex', status: 'running', runningAgents: 1 });
    clearInterval(stream);
    append({ type: 'task_complete' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(reader.getSession(CODEX_ID)).toMatchObject({ status: 'idle', runningAgents: 0 });
  } finally {
    clearInterval(stream); clearTimeout(deadline); reader.close(); indexer.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, 5000);
