import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Indexer, IndexReader, projectCwd, toFtsQuery } from '../src/index.ts';
import { buildFixtures, CODEX_ID, CWD, SESSION } from './fixtures.ts';

let fx: ReturnType<typeof buildFixtures>;
let reader: IndexReader;
let now: number;

beforeAll(() => {
  fx = buildFixtures();
  now = fx.liveNow;
  const indexer = new Indexer({ dbPath: fx.dbPath, claudeRoot: fx.claudeRoot, codexRoot: fx.codexRoot, geminiRoot: fx.geminiRoot, grokRoot: fx.grokRoot, now: () => now });
  const first = indexer.indexAll();
  expect(first).toEqual({ indexed: 4, skipped: 0, removed: 0 });
  expect(indexer.indexAll()).toEqual({ indexed: 0, skipped: 4, removed: 0 });
  indexer.close();
  reader = new IndexReader(fx.dbPath, () => now);
});

afterAll(() => {
  reader.close();
  rmSync(fx.root, { recursive: true, force: true });
});

describe('projects and sessions', () => {
  it('groups Claude Code and Codex sessions from the same folder into one project', () => {
    const projects = reader.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ cwd: CWD, name: 'demo-proj', sessionCount: 3 });
    expect(projects[0]!.sources.sort()).toEqual(['claude-code', 'codex']);
    expect(projects[0]!.runningAgents).toBe(1);
  });

  it('prefers the custom title and dedupes usage repeated across split records', () => {
    const s = reader.getSession(SESSION)!;
    expect(s.title).toBe('My export refactor');
    expect(s.messageCount).toBe(4); // 1 prompt + 3 assistant responses
    const main = reader.getAgentTree(SESSION)!;
    expect(main.inputTokens).toBe(100 + 1000 + 2000 + 1 + 10);
    expect(main.outputTokens).toBe(56);
    // m1: 100*5 + 1000*0.5 + 2000*10 + 50*25 = 22250 ; m2: 10*5 + 5*25 = 175 ; m3: 5 + 25 = 30 (per 1M tokens)
    expect(main.costUsd).toBeCloseTo(0.022455, 6);
    expect(s.models).toEqual(expect.arrayContaining(['claude-opus-5', 'claude-haiku-4-5']));
    // The last reply read 10 tokens: that's how full the context was.
    expect(s.contextTokens).toBe(10);
    // Files edited anywhere in the conversation, subagents included.
    expect(s.editedFiles).toEqual(['/tmp/wt/src/pdf.ts']);
  });

  it('hides sessions without a real prompt, titled by their first reply', () => {
    expect(reader.listProjects().map((p) => p.cwd)).toEqual([CWD]);
    expect(reader.listSessions().map((s) => s.id)).not.toContain('cccccccc-3333-4333-8333-cccccccccccc');
    const empty = reader.listSessions({ includeEmpty: true }).find((s) => s.id === 'cccccccc-3333-4333-8333-cccccccccccc');
    expect(empty?.title).toBe('Failed to authenticate: OAuth session expired');
  });

  it('parses Codex rollouts, skipping injected context', () => {
    const s = reader.getSession(CODEX_ID)!;
    expect(s).toMatchObject({ source: 'codex', title: 'Fix the OCR crash', inputTokens: 300, cacheReadTokens: 200, outputTokens: 40, costUsd: null, status: 'idle' });
  });
});

describe('agent tree', () => {
  it('rebuilds parents, depths and statuses', () => {
    const main = reader.getAgentTree(SESSION)!;
    expect(main.status).toBe('idle');
    const byId = Object.fromEntries(main.children.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(['aaa', 'bbb', 'ddd', 'eee']);
    expect(byId.eee).toMatchObject({ status: 'error' }); // failure reported only via queue-operation/attachment
    expect(byId.aaa).toMatchObject({ type: 'Plan', status: 'done', depth: 1 });
    expect(byId.bbb).toMatchObject({ type: 'general-purpose', status: 'done' }); // async, finished via notification
    expect(byId.ddd).toMatchObject({ type: 'workflow-subagent', status: 'done', worktreeBranch: 'feat/pdf-v2' });
    expect(byId.bbb!.children.map((c) => [c.id, c.depth, c.status])).toEqual([['ccc', 2, 'running']]);
  });

  it('marks a silent running agent as interrupted once its file goes stale', () => {
    now += 10 * 60_000;
    const ccc = reader.getAgentTree(SESSION)!.children.find((c) => c.id === 'bbb')!.children[0]!;
    expect(ccc.status).toBe('interrupted');
    now = fx.liveNow;
  });
});

describe('transcripts', () => {
  it('merges split assistant records and links spawned agents', () => {
    const page = reader.getTranscript(SESSION, 'main');
    const turn = page.entries.find((e) => e.key === 'm1')!;
    expect(turn.blocks.map((b) => b.kind)).toEqual(['text', 'tool_use', 'tool_use']);
    const spawns = turn.blocks.filter((b) => b.kind === 'tool_use').map((b) => (b.kind === 'tool_use' ? b.spawnsAgentId : null));
    expect(spawns).toEqual(['aaa', 'bbb']);
    const notices = page.entries.filter((e) => e.role === 'notice').map((e) => (e.blocks[0]?.kind === 'notice' ? e.blocks[0].text : ''));
    expect(notices).toEqual(['Agent "Migrate PDF renderer" finished', 'Agent "Benchmark renderers" failed']);
  });

  it('reads Codex prompts recorded as item_completed events', () => {
    const s = reader.getSession('dddddddd-4444-4444-8444-dddddddddddd')!;
    expect(s.title).toBe('Generate the weekly wallpapers');
    const page = reader.getTranscript(s.id, 'main');
    expect(page.entries.map((e) => e.role)).toEqual(['user', 'assistant']);
  });

  it('reads Codex tool calls', () => {
    const page = reader.getTranscript(CODEX_ID, 'main');
    expect(page.entries.map((e) => e.role)).toEqual(['meta', 'user', 'assistant', 'user', 'assistant']);
  });
});

describe('search', () => {
  it('finds sessions across sources, ignoring accents and punctuation', () => {
    expect(reader.search('export pipeline').map((h) => h.sessionId)).toEqual([SESSION]);
    expect(reader.search('tesseract')[0]).toMatchObject({ sessionId: CODEX_ID, source: 'codex' });
    expect(reader.search('loadFont')[0]!.snippet).toContain('\u0001');
    expect(toFtsQuery('  pdf-lib, ¿fuentes? ')).toBe('"pdf"* "lib"* "fuentes"*');
    expect(toFtsQuery('***')).toBeNull();
  });

  it('pages transcripts from the end, reporting where each page starts', () => {
    const all = reader.getTranscript(SESSION, 'main', 0, 1000);
    const last = reader.getTranscript(SESSION, 'main', -1, 2);
    expect(last.offset).toBe(Math.max(0, all.total - 2));
    expect(last.nextOffset).toBeNull();
    expect(last.entries.at(-1)).toEqual(all.entries.at(-1));
    expect(reader.getTranscript(SESSION, 'main', -1, 10_000).offset).toBe(0);
  });

  it('renames and hides conversations without touching the CLI files', () => {
    const original = reader.getSession(SESSION)!.title;
    reader.setTitle(SESSION, '  PDF export  ');
    expect(reader.getSession(SESSION)!.title).toBe('PDF export');
    expect(reader.search('export pipeline')[0]!.title).toBe('PDF export');
    reader.setHidden(SESSION, true);
    expect(reader.listSessions().map((s) => s.id)).not.toContain(SESSION);
    expect(reader.search('export pipeline')).toEqual([]);
    expect(reader.hiddenSessions().map((s) => s.id)).toEqual([SESSION]);
    expect(reader.sessionFile(SESSION)).toMatch(/\.jsonl$/);
    reader.setHidden(SESSION, false);
    reader.setTitle(SESSION, '');
    expect(reader.getSession(SESSION)!.title).toBe(original);
    expect(reader.listSessions().map((s) => s.id)).toContain(SESSION);
  });
});

describe('projectCwd', () => {
  it('files Arena worktree sessions under their project', () => {
    expect(projectCwd('/Users/me/app/.alchemist/worktrees/add-dark-mode-x1/1-claude-code')).toBe('/Users/me/app');
    expect(projectCwd('/Users/me/app/.alchemist/worktrees/t/2-codex/src')).toBe('/Users/me/app');
    expect(projectCwd('C:\\code\\app\\.alchemist\\worktrees\\t\\a')).toBe('C:\\code\\app');
    expect(projectCwd('/Users/me/app')).toBe('/Users/me/app');
    expect(projectCwd('/Users/me/.alchemist-notes')).toBe('/Users/me/.alchemist-notes');
  });
});


describe('pictures', () => {
  it('finds a picture again in the transcript file', () => {
    const page = reader.getTranscript(SESSION, 'ddd', 0, 10);
    const img = page.entries.flatMap((e) => e.blocks).find((b) => b.kind === 'image');
    expect(img && img.kind === 'image' ? img.ref : null).toMatchObject({ agentId: 'ddd', n: 0 });
    const ref = img && img.kind === 'image' ? img.ref! : null;
    expect(reader.image(SESSION, 'ddd', ref!.offset, 0)).toEqual({ mediaType: 'image/png', data: 'iVBORw0KGgo=' });
    expect(reader.image(SESSION, 'ddd', ref!.offset, 1)).toBeNull();
    expect(reader.image(SESSION, 'main', ref!.offset, 0)).toBeNull();
  });
});
