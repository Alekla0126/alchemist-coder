import { afterAll, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
vi.mock('node:fs', async (importActual) => ({ ...await importActual<typeof import('node:fs')>(), watch: () => ({ close: () => {} }) }));
import { Indexer, IndexReader } from '../src/index';
import { buildFixtures, CODEX_ID } from './fixtures';
const fx = buildFixtures();
afterAll(() => rmSync(fx.root, { recursive: true, force: true }));
it('refreshes streaming Codex sessions and discovers new rollouts without filesystem notifications', async () => {
  const db = new Indexer({ dbPath: fx.dbPath, claudeRoot: fx.claudeRoot, codexRoot: fx.codexRoot, geminiRoot: fx.geminiRoot, grokRoot: fx.grokRoot });
  db.indexAll();
  const reader = new IndexReader(fx.dbPath);
  const changed: string[] = [];
  db.watch((ids) => changed.push(...ids), 10, 40);
  const path = join(fx.codexRoot, 'sessions/2026/09/02', `rollout-2026-09-02T10-00-00-${CODEX_ID}.jsonl`);
  const record = (type: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type } }) + '\n';
  try {
    appendFileSync(path, record('task_started'));
    await vi.waitFor(() => expect(reader.getSession(CODEX_ID)?.status).toBe('running'));
    expect(changed).toContain(CODEX_ID);
    appendFileSync(path, record('task_complete'));
    await vi.waitFor(() => expect(reader.getSession(CODEX_ID)?.status).toBe('idle'));
    const newId = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
    const folder = join(fx.codexRoot, 'sessions/2026/11/02');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `rollout-2026-11-02T00-00-00-${newId}.jsonl`), JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: newId, cwd: '/tmp/codex-poll-test' } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'A fresh conversation' } }) + '\n' + record('task_started'));
    await vi.waitFor(() => expect(reader.getSession(newId)).toMatchObject({ title: 'A fresh conversation', status: 'running' }));
  } finally { reader.close(); db.close(); }
});
