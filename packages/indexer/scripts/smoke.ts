/**
 * Indexes the real ~/.claude and ~/.codex history into a throwaway database (read-only on the
 * originals) and prints what the app would see. Usage: pnpm index:smoke
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Indexer, IndexReader } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'ac-smoke-'));
const dbPath = join(dir, 'index.db');
const errors: string[] = [];
const t0 = performance.now();
const indexer = new Indexer({ dbPath, onError: (e, ctx) => errors.push(`${ctx}: ${String(e)}`) });
const result = indexer.indexAll();
const firstMs = performance.now() - t0;
const t1 = performance.now();
const again = indexer.indexAll();
const secondMs = performance.now() - t1;
indexer.close();

const reader = new IndexReader(dbPath);
const stats = reader.stats();
console.log(`first index: ${(firstMs / 1000).toFixed(1)} s`, result);
console.log(`second (incremental): ${secondMs.toFixed(0)} ms`, again);
console.log('stats:', stats, errors.length ? `errors: ${errors.length}` : 'no errors');
errors.slice(0, 5).forEach((e) => console.log('  !', e));
console.log('\ntop projects:');
for (const p of reader.listProjects().slice(0, 6)) console.log(`  ${p.name.padEnd(34)} ${String(p.sessionCount).padStart(4)} sessions  [${p.sources.join(', ')}]`);
const withAgents = reader.listSessions({ limit: 5000 }).sort((a, b) => b.agentCount - a.agentCount)[0];
if (withAgents) {
  const tree = reader.getAgentTree(withAgents.id)!;
  const counts: Record<string, number> = {};
  const walk = (n: typeof tree, d = 0): void => { counts[n.status] = (counts[n.status] ?? 0) + 1; n.children.forEach((c) => walk(c, d + 1)); };
  walk(tree);
  console.log(`\nwidest tree: "${withAgents.title}" · ${withAgents.agentCount} agents · statuses`, counts, `· cost ≈ $${(withAgents.costUsd ?? 0).toFixed(2)}`);
  const page = reader.getTranscript(withAgents.id, 'main', 0, 50);
  console.log(`transcript sample: ${page.entries.length} entries of ${page.total} rows`);
}
const t2 = performance.now();
const hits = reader.search('vpn servidor');
console.log(`\nsearch "vpn servidor": ${hits.length} sessions in ${(performance.now() - t2).toFixed(0)} ms`, hits[0] ? `→ ${hits[0].projectName}: ${hits[0].title}` : '');
reader.close();
rmSync(dir, { recursive: true, force: true });
