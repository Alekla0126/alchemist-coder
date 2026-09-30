import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '@alchemist-coder/core';
import { cleanBoard, createActions, listActions, loadBoard, parseActions, saveBoard } from '../src/main/board';
import { buildCards, byUrgency, moveCard, phaseOf, RECENT_MS } from '../src/renderer/src/board-model';

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ac-board-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = 1_800_000_000_000;
const session = (id: string, lastTs: number, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, source: 'claude-code', projectId: 1, title: id, firstTs: lastTs, lastTs, messageCount: 4, models: [], gitBranch: null, cliVersion: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0, contextWindow: null, editedFiles: [], costUsd: null, agentCount: 1, runningAgents: 0, status: 'idle', archived: false, preserved: false, favorite: false, ...extra }) as SessionSummary;
const projects = [{ id: 1, name: 'castbook', cwd: '/p/castbook' }] as never[];

describe('board storage', () => {
  it('keeps only valid tasks and placements', () => {
    const b = cleanBoard({
      tasks: [
        { id: 't1', cwd: '/p/castbook', title: 'Export CSV', notes: 'n', phase: 'planning', sessionId: 'abc-123' },
        { id: 't1', cwd: '/p/castbook', title: 'dupe' },
        { id: '../x', cwd: '/p' },
        { id: 't2', cwd: 'relative/path' },
        { id: 't3', cwd: '/p/castbook', phase: 'weird', sessionId: '../../etc' },
      ],
      placed: { 'abc-123': { phase: 'done', at: 5 }, 'bad id!': { phase: 'done' } },
    });
    expect(b.tasks.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(b.tasks[1]).toMatchObject({ phase: 'backlog', sessionId: null });
    expect(Object.keys(b.placed)).toEqual(['abc-123']);
  });

  it('saves and loads board.json', () => {
    const d = dir();
    expect(loadBoard(d)).toEqual({ tasks: [], placed: {} });
    saveBoard(d, { tasks: [{ id: 't1', cwd: '/p/a', title: 'x', phase: 'done' }], placed: {} });
    expect(loadBoard(d).tasks[0]).toMatchObject({ id: 't1', phase: 'done' });
    writeFileSync(join(d, 'board.json'), '{nope');
    expect(loadBoard(d)).toEqual({ tasks: [], placed: {} });
  });
});

describe('ai-actions.md', () => {
  it('reads each ## section as a prompt, ignoring headings inside code', () => {
    const actions = parseActions('# Actions\nintro\n\n## Review\nLook at the diff.\n\n```md\n## not a heading\n```\n## Empty\n\n## Tests ##\nWrite tests.\n');
    expect(actions).toEqual([
      { label: 'Review', body: 'Look at the diff.\n\n```md\n## not a heading\n```' },
      { label: 'Tests', body: 'Write tests.' },
    ]);
  });

  it('creates the example once and never follows a link', () => {
    const root = dir();
    expect(listActions(root).exists).toBe(false);
    const path = createActions(root, '## A\nDo a.\n');
    expect(listActions(root).actions).toEqual([{ label: 'A', body: 'Do a.' }]);
    createActions(root, '## B\nDo b.\n');
    expect(readFileSync(path, 'utf8')).toContain('## A');
    const other = dir();
    const target = join(other, 'secret.md');
    writeFileSync(target, '## S\nsecret\n');
    const linked = dir();
    symlinkSync(target, join(linked, 'ai-actions.md'));
    expect(listActions(linked)).toMatchObject({ exists: true, actions: [] });
  });
});

describe('board model', () => {
  it('puts a card where its agent is, else where you left it, else up for review', () => {
    expect(phaseOf(session('a', NOW), 'planning', null)).toBe('planning');
    expect(phaseOf(session('a', NOW), 'waiting', { phase: 'done', at: NOW })).toBe('implementing');
    expect(phaseOf(session('a', NOW - 10_000), null, { phase: 'done', at: NOW })).toBe('done');
    // The agent worked on it after you closed it: back to review.
    expect(phaseOf(session('a', NOW + 60_000), null, { phase: 'done', at: NOW })).toBe('validating');
    expect(phaseOf(null, null, { phase: 'planning', at: NOW })).toBe('planning');
  });

  it('shows recent and placed conversations, tasks, and links a task to its conversation', () => {
    const data = cleanBoard({
      tasks: [{ id: 't1', cwd: '/p/castbook', title: 'Export CSV', phase: 'implementing', sessionId: 'linked', updatedAt: NOW - 1000 }],
      placed: { old: { phase: 'done', at: NOW - RECENT_MS * 3 } },
    });
    const sessions = [session('recent', NOW - 1000), session('stale', NOW - RECENT_MS * 2), session('old', NOW - RECENT_MS * 4), session('linked', NOW - 500)];
    const cards = buildCards({ data, sessions, projects, live: { recent: 'running' }, now: NOW });
    expect(cards.map((c) => c.key).sort()).toEqual(['s:old', 's:recent', 't:t1']);
    expect(cards.find((c) => c.key === 't:t1')).toMatchObject({ title: 'Export CSV', projectId: 1, phase: 'implementing' });
    expect(cards.find((c) => c.key === 's:recent')!.phase).toBe('implementing');
    expect([...cards].sort(byUrgency)[0]!.key).toBe('s:recent');
  });

  it('moves tasks by their column and conversations by a placement', () => {
    const data = cleanBoard({ tasks: [{ id: 't1', cwd: '/p/castbook', title: 'x' }], placed: {} });
    const task = data.tasks[0]!;
    expect(moveCard(data, { key: 't:t1', task, session: null }, 'done', NOW).tasks[0]).toMatchObject({ phase: 'done', updatedAt: NOW });
    expect(moveCard(data, { key: 's:a', task: null, session: session('a', NOW) }, 'planning', NOW).placed.a).toEqual({ phase: 'planning', at: NOW });
  });
});
