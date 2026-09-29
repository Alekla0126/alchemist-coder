import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Indexer, IndexReader } from '../src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'ac-acp-src-'));
afterAll(() => {
  // Windows can't delete a folder while a database in it is open.
  indexer.close();
  reader.close();
  rmSync(root, { recursive: true, force: true });
});
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const old = new Date('2026-09-01T00:00:00Z');

// Gemini CLI: metadata, messages (a repeated id replaces), $set of all messages, then a $rewindTo.
const geminiRoot = join(root, 'gemini-tmp');
const chats = join(geminiRoot, 'webapp', 'chats');
mkdirSync(chats, { recursive: true });
writeFileSync(join(geminiRoot, 'webapp', '.project_root'), '/work/webapp\n');
const geminiFile = join(chats, 'session-2026-09-20T10-00-abc123.jsonl');
writeFileSync(
  geminiFile,
  jsonl([
    { sessionId: 'gem-1', projectHash: 'h', startTime: '2026-09-20T10:00:00Z', lastUpdated: '2026-09-20T10:00:00Z', kind: 'main' },
    { $set: { messages: [{ id: 'm0', timestamp: '2026-09-20T10:00:01Z', type: 'user', content: [{ text: 'old prompt that gets replaced' }] }] } },
    { $set: { messages: [] } },
    { id: 'u1', timestamp: '2026-09-20T10:00:02Z', type: 'user', content: [{ text: 'Add a dark mode toggle' }] },
    { id: 'g1', timestamp: '2026-09-20T10:00:05Z', type: 'gemini', model: 'gemini-3-pro', content: 'Working…' },
    {
      id: 'g1',
      timestamp: '2026-09-20T10:00:09Z',
      type: 'gemini',
      model: 'gemini-3-pro',
      content: 'Added the toggle in **Settings**.',
      thoughts: [{ subject: 'Plan', description: 'edit settings.tsx' }],
      toolCalls: [{ id: 'c1', name: 'replace', args: { file_path: 'src/settings.tsx' }, status: 'success', resultDisplay: 'Edited src/settings.tsx' }],
      tokens: { input: 1200, output: 80, cached: 300 },
    },
    { id: 'u2', timestamp: '2026-09-20T10:01:00Z', type: 'user', content: [{ text: 'a message the user rewound' }] },
    { $rewindTo: 'u2' },
  ]),
);
utimesSync(geminiFile, old, old);

// Grok Build: summary.json + updates.jsonl with one ACP session update per line.
const grokRoot = join(root, 'grok-sessions');
const grokDir = join(grokRoot, encodeURIComponent('/work/api'), '01k0-grok-session');
mkdirSync(grokDir, { recursive: true });
writeFileSync(join(grokDir, 'summary.json'), JSON.stringify({ info: { id: '01k0-grok-session', cwd: '/work/api' }, generated_title: 'Fix the flaky login test', created_at: '2026-09-21T09:00:00Z', updated_at: '2026-09-21T09:05:00Z', current_model_id: 'grok-4.7' }));
const u = (update: object, ts: string) => ({ timestamp: ts, sessionId: '01k0-grok-session', update });
writeFileSync(
  join(grokDir, 'updates.jsonl'),
  jsonl([
    u({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'The login test is flaky, ' } }, '2026-09-21T09:00:01Z'),
    u({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'please fix it' } }, '2026-09-21T09:00:01Z'),
    u({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Probably a race.' } }, '2026-09-21T09:00:03Z'),
    u({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking at ' } }, '2026-09-21T09:00:04Z'),
    u({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the test.' } }, '2026-09-21T09:00:04Z'),
    u({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } }, '2026-09-21T09:00:05Z'),
    u({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '12 passing' } }] }, '2026-09-21T09:00:30Z'),
    u({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixed: awaited the session cookie.' } }, '2026-09-21T09:00:40Z'),
  ]),
);
utimesSync(join(grokDir, 'updates.jsonl'), old, old);

const dbPath = join(root, 'index.db');
const indexer = new Indexer({ dbPath, claudeRoot: join(root, 'none-claude'), codexRoot: join(root, 'none-codex'), geminiRoot, grokRoot });
indexer.indexAll();
const reader = new IndexReader(dbPath);

describe('Gemini CLI sessions', () => {
  it('shows the conversation as Gemini last saved it', () => {
    const s = reader.getSession('gem-1')!;
    expect(s).toMatchObject({ source: 'gemini', title: 'Add a dark mode toggle', models: ['gemini-3-pro'], status: 'idle' });
    expect(reader.listProjects().find((p) => p.cwd === '/work/webapp')).toBeTruthy();
    const { entries } = reader.getTranscript('gem-1', 'main');
    expect(entries.map((e) => e.role)).toEqual(['user', 'assistant']);
    expect(entries[1]!.blocks).toEqual([
      { kind: 'thinking', text: 'Plan: edit settings.tsx' },
      { kind: 'text', text: 'Added the toggle in **Settings**.' },
      expect.objectContaining({ kind: 'tool_use', id: 'c1', name: 'replace' }),
      { kind: 'tool_result', toolUseId: 'c1', isError: false, preview: 'Edited src/settings.tsx' },
    ]);
    expect(reader.getAgentTree('gem-1')).toMatchObject({ type: 'gemini', toolCalls: 1 });
  });
});

describe('Grok Build sessions', () => {
  it('joins streamed ACP updates back into messages', () => {
    const s = reader.getSession('01k0-grok-session')!;
    expect(s).toMatchObject({ source: 'grok', title: 'Fix the flaky login test', models: ['grok-4.7'] });
    expect(reader.listProjects().find((p) => p.cwd === '/work/api')).toBeTruthy();
    const { entries, total } = reader.getTranscript('01k0-grok-session', 'main');
    expect(total).toBe(2);
    expect(entries[0]).toMatchObject({ role: 'user', blocks: [{ kind: 'text', text: 'The login test is flaky, please fix it' }] });
    expect(entries[1]!.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool_use', 'tool_result', 'text']);
    expect(entries[1]!.blocks[3]).toMatchObject({ kind: 'tool_result', preview: '12 passing' });
  });

  it('makes both searchable', () => {
    expect(reader.search('dark mode').map((h) => h.sessionId)).toContain('gem-1');
    expect(reader.search('session cookie').map((h) => h.sessionId)).toContain('01k0-grok-session');
  });

  it('keeps showing them from the backup after the CLIs delete them', () => {
    // The backup mirrors both folders as gemini/ and grok/ (see @alchemist-coder/archive).
    const backup = join(root, 'backup');
    cpSync(geminiRoot, join(backup, 'gemini'), { recursive: true });
    cpSync(grokRoot, join(backup, 'grok'), { recursive: true });
    const withBackup = new Indexer({ dbPath, claudeRoot: join(root, 'none-claude'), codexRoot: join(root, 'none-codex'), geminiRoot, grokRoot, backupRoot: backup });
    rmSync(geminiFile);
    rmSync(grokDir, { recursive: true });
    withBackup.indexAll();
    expect(reader.getSession('gem-1')).toMatchObject({ preserved: true, archived: true, title: 'Add a dark mode toggle' });
    // Still filed under its project: .project_root is backed up with the chats.
    const webapp = reader.listProjects().find((p) => p.cwd === '/work/webapp');
    expect(reader.getSession('gem-1')!.projectId).toBe(webapp?.id);
    expect(reader.getSession('01k0-grok-session')).toMatchObject({ preserved: true, title: 'Fix the flaky login test' });
    expect(reader.getTranscript('01k0-grok-session', 'main', 0, 50).entries.length).toBeGreaterThan(0);
    withBackup.db.close();
  });
});
