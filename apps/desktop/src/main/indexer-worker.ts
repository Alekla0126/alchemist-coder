import { parentPort, workerData } from 'node:worker_threads';
import { Indexer } from '@alchemist-coder/indexer';

// Runs off the main thread: the first full index of a large history takes a while.
const { dbPath, backupRoot } = workerData as { dbPath: string; backupRoot: string | null };
const post = (message: unknown) => parentPort?.postMessage(message);

const indexer = new Indexer({ dbPath, backupRoot, onError: (error, context) => post({ type: 'error', message: `${context}: ${String(error)}` }) });
post({ type: 'db-ready' });
indexer.indexAll((progress) => post({ type: 'progress', progress }));
post({ type: 'ready' });
indexer.watch((ids) => post({ type: 'changed', ids }));

// Turning the backup on (or moving it) changes where preserved sessions are read from.
parentPort?.on('message', (m: { type: string; path?: string | null }) => {
  if (m.type !== 'backup-root') return;
  indexer.backupRoot = m.path ?? null;
  const { indexed, removed } = indexer.indexAll();
  if (indexed || removed) post({ type: 'changed', ids: [] });
});
