import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionSummary } from '@alchemist-coder/core';
import { Indexer, IndexReader } from '@alchemist-coder/indexer';
import { buildFixtures, CODEX_ID, SESSION } from '../../indexer/test/fixtures.ts';
import { BACKUP_FOLDER, backupSize, commitBackup, flattenAgents, isBackupDir, mirror, prepareBackupDir, toHtml, toJson, toMarkdown, type ExportInput } from '../src/index.ts';

const fx = buildFixtures();
const backup = join(fx.root, 'backup');
// Windows can't delete a folder while a database in it is open: close every reader first.
const readers: IndexReader[] = [];
const openReader = () => {
  const r = new IndexReader(fx.dbPath);
  readers.push(r);
  return r;
};
afterAll(() => {
  for (const r of readers) r.close();
  rmSync(fx.root, { recursive: true, force: true });
});

function exportInput(reader: IndexReader, sessionId: string): ExportInput {
  const session = reader.getSession(sessionId)!;
  const tree = reader.getAgentTree(sessionId)!;
  const agents = flattenAgents(tree).map((node) => ({ node, entries: reader.getTranscript(sessionId, node.id, 0, 1000).entries }));
  return { session, project: { name: 'demo-proj', cwd: '/tmp/demo-proj' }, agents, exportedAt: Date.UTC(2026, 8, 27, 12, 0) };
}

describe('backup', () => {
  it('mirrors history into a git repo, only copying what changed', async () => {
    const src = { claudeRoot: fx.claudeRoot, codexRoot: fx.codexRoot };
    expect(prepareBackupDir(backup)).toBe(backup);
    const first = await mirror(src, backup);
    expect(first.copied).toBe(first.files);
    expect(first.files).toBeGreaterThanOrEqual(4);
    expect(existsSync(join(backup, 'claude', '-tmp-demo-proj', `${SESSION}.jsonl`))).toBe(true);
    const commit = await commitBackup(backup, 'Backup 1');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync('git', ['log', '--format=%s', '-1'], { cwd: backup, encoding: 'utf8' })).toBe('Backup 1\n');
    expect(execFileSync('git', ['show', 'HEAD:.gitattributes'], { cwd: backup, encoding: 'utf8' })).toContain('*.jsonl -diff');
    const again = await mirror(src, backup);
    expect(again.copied).toBe(0);
    expect(await commitBackup(backup, 'Backup 2')).toBeNull();
    expect(backupSize(backup).files).toBe(first.files);
    // Anything else dropped in the folder stays out of the repository.
    writeFileSync(join(backup, 'notes.txt'), 'private');
    expect(await commitBackup(backup, 'Backup 3')).toBeNull();
  });

  it('never takes over a folder with other files or a repository in it', async () => {
    const docs = join(fx.root, 'Documents');
    mkdirSync(join(docs, 'project', '.git'), { recursive: true });
    writeFileSync(join(docs, 'taxes.pdf'), 'x');
    // A non-empty folder gets its own backup folder inside.
    const dir = prepareBackupDir(docs);
    expect(dir).toBe(join(docs, BACKUP_FOLDER));
    expect(isBackupDir(dir)).toBe(true);
    expect(prepareBackupDir(docs)).toBe(dir);
    // Folders without the marker are refused, even when they hold a git repository.
    await expect(commitBackup(join(docs, 'project'), 'x')).rejects.toThrow(/not an Alchemist backup/);
    await expect(commitBackup(docs, 'x')).rejects.toThrow(/not an Alchemist backup/);
    // So are symlinks to a backup and folders whose backup name is taken.
    symlinkSync(dir, join(fx.root, 'link'));
    expect(isBackupDir(join(fx.root, 'link'))).toBe(false);
    const taken = join(fx.root, 'taken');
    mkdirSync(join(taken, BACKUP_FOLDER), { recursive: true });
    writeFileSync(join(taken, 'a'), 'x');
    writeFileSync(join(taken, BACKUP_FOLDER, 'b'), 'x');
    expect(() => prepareBackupDir(taken)).toThrow(/other files/);
  });

  it('adopts a backup made before the marker existed', () => {
    const old = join(fx.root, 'old-backup');
    mkdirSync(join(old, 'claude'), { recursive: true });
    writeFileSync(join(old, 'README.md'), '# Alchemist Coder backup\n\nCopies…');
    expect(prepareBackupDir(old)).toBe(old);
    expect(readFileSync(join(old, '.alchemist-backup'), 'utf8')).toContain('Alchemist');
  });

  it('keeps showing a conversation after Claude Code deletes it', () => {
    const indexer = new Indexer({ dbPath: fx.dbPath, claudeRoot: fx.claudeRoot, codexRoot: fx.codexRoot, geminiRoot: fx.geminiRoot, grokRoot: fx.grokRoot, backupRoot: backup, now: () => fx.liveNow });
    indexer.indexAll();
    const reader = openReader();
    const before = reader.getSession(SESSION)!;
    expect(before).toMatchObject({ archived: false, preserved: false });
    const agentsBefore = flattenAgents(reader.getAgentTree(SESSION)!).length;

    // What Claude Code's cleanupPeriodDays does to an old conversation.
    rmSync(join(fx.claudeRoot, '-tmp-demo-proj', `${SESSION}.jsonl`));
    rmSync(join(fx.claudeRoot, '-tmp-demo-proj', SESSION), { recursive: true, force: true });
    indexer.indexAll();

    const after = reader.getSession(SESSION)!;
    expect(after).toMatchObject({ archived: true, preserved: true, title: before.title, messageCount: before.messageCount });
    expect(flattenAgents(reader.getAgentTree(SESSION)!)).toHaveLength(agentsBefore);
    expect(reader.getTranscript(SESSION, 'main', 0, 50).entries.length).toBeGreaterThan(0);
    // Codex sessions still come from the live folder.
    expect(reader.getSession(CODEX_ID)!.archived).toBe(false);
    indexer.db.close();
  });
});

describe('export', () => {
  it('exports a conversation with its subagents to Markdown, HTML and JSON', () => {
    const reader = openReader();
    const input = exportInput(reader, SESSION);
    const md = toMarkdown(input);
    expect(md.startsWith(`# ${input.session.title}\n`)).toBe(true);
    expect(md).toContain('- **Source:** Claude Code');
    expect(md).toContain('## Main agent');
    expect(md).toContain('## Plan — Design architecture');
    expect(md).toContain('All done: fonts now load through loadFont().');
    expect(md).toContain('<summary>🔧 Agent');
    expect(md).toContain('### Tool result');
    expect(toMarkdown(input, { tools: false })).not.toContain('🔧');

    const html = toHtml(input);
    expect(html).toContain('<section id="agent-main">');
    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/<a href="#agent-[^"]+">→ subagent<\/a>/);

    const json = JSON.parse(toJson(input));
    expect(json).toMatchObject({ format: 'alchemist-coder/conversation', version: 1, session: { id: SESSION } });
    expect(json.agents[0].node.id).toBe('main');
  });

  it('escapes everything in HTML exports', () => {
    const session = { id: 'x', source: 'claude-code', title: '<img src=x onerror=alert(1)>', models: [], messageCount: 1, costUsd: null, firstTs: null, lastTs: null, gitBranch: null } as unknown as SessionSummary;
    const html = toHtml({
      session,
      project: null,
      exportedAt: 0,
      agents: [{ node: { id: 'main', type: 'main', description: '', depth: 0, model: null, status: 'done' } as never, entries: [{ key: 'k', ts: null, role: 'user', model: null, blocks: [{ kind: 'text', text: '<script>alert(1)</script> `<b>code</b>`' }] }] }],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<code>&lt;b&gt;code&lt;/b&gt;</code>');
    expect(toHtml({ session, project: null, exportedAt: 0, agents: [{ node: { id: 'main', type: 'main', description: '', depth: 0, model: null, status: 'done' } as never, entries: [{ key: 'k', ts: null, role: 'user', model: null, blocks: [{ kind: 'text', text: 'is *really* fine, 2*3*4' }] }] }] })).toContain('is <em>really</em> fine, 2*3*4');
  });
});
