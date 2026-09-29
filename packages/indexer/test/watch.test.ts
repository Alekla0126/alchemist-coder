import { afterAll, expect, it } from 'vitest';
import { appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Indexer, IndexReader } from '../src/index.ts';
import { buildFixtures, SESSION } from './fixtures.ts';

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
