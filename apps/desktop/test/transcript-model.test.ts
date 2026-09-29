import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@alchemist-coder/core';
import { buildTurns, toolSummary } from '../src/renderer/src/transcript-model';

const entry = (key: string, role: TranscriptEntry['role'], blocks: TranscriptEntry['blocks'], model: string | null = null): TranscriptEntry => ({ key, role, ts: 1, model, blocks });
const call = (id: string, name = 'Bash') => ({ kind: 'tool_use' as const, id, name, summary: `${name} ${id}`, input: '{}', spawnsAgentId: null });
const result = (id: string, isError = false) => ({ kind: 'tool_result' as const, toolUseId: id, isError, preview: `out ${id}` });

describe('buildTurns', () => {
  it('makes one assistant turn per prompt, with results inside their calls', () => {
    const turns = buildTurns([
      entry('u1', 'user', [{ kind: 'text', text: 'fix it' }]),
      entry('a1', 'assistant', [{ kind: 'text', text: 'Looking' }, call('t1')], 'opus'),
      entry('r1', 'user', [result('t1')]),
      entry('a2', 'assistant', [{ kind: 'text', text: 'Done' }], 'opus'),
      entry('u2', 'user', [{ kind: 'text', text: 'thanks' }]),
    ]);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(turns[1]!.model).toBe('opus');
    expect(turns[1]!.blocks.map((b) => b.kind)).toEqual(['block', 'tool', 'block']);
    const tool = turns[1]!.blocks[1]!;
    expect(tool.kind === 'tool' && tool.result?.preview).toBe('out t1');
  });

  it('folds three or more calls in a row, and keeps orphan results', () => {
    const turns = buildTurns([
      entry('a1', 'assistant', [call('t1'), call('t2', 'Read'), call('t3')]),
      entry('r', 'user', [result('t1'), result('t2', true), result('t3'), result('gone')]),
    ]);
    const [group, orphan] = turns[0]!.blocks;
    expect(group!.kind).toBe('group');
    expect(group!.kind === 'group' && group!.tools.map((x) => x.result?.isError)).toEqual([false, true, false]);
    expect(orphan).toMatchObject({ kind: 'block', block: { kind: 'tool_result', toolUseId: 'gone' } });
    expect(toolSummary(group!.kind === 'group' ? group!.tools : [])).toBe('Bash ×2, Read');
  });
});

describe('text the harness wrote', () => {
  const user = (text: string) => ({ key: text.slice(0, 8), ts: 1, role: 'user' as const, model: null, blocks: [{ kind: 'text' as const, text }] });
  it('shows injected messages as system lines, not your prompts', () => {
    const turns = buildTurns([user('[System: background task(s) you launched have settled]'), user('<task-notification>\n<status>completed</status>'), user('Fix the login bug')]);
    expect(turns.map((t) => t.role)).toEqual(['system', 'system', 'user']);
  });
});

describe('task lists and bookkeeping calls', () => {
  const call = (id: string, name: string, input: object) => ({ kind: 'tool_use' as const, id, name, summary: '', input: JSON.stringify(input), spawnsAgentId: null });
  const res = (id: string, preview: string) => ({ kind: 'tool_result' as const, toolUseId: id, isError: false, preview });
  it('folds task calls into one checklist and keeps quiet calls out of the way', () => {
    const turns = buildTurns([
      { key: 'u', ts: 1, role: 'user', model: null, blocks: [{ kind: 'text', text: 'go' }] },
      { key: 'a', ts: 2, role: 'assistant', model: null, blocks: [call('t1', 'TaskCreate', { subject: 'First' }), call('t2', 'TaskCreate', { subject: 'Second' }), call('t3', 'TaskUpdate', { taskId: '1', status: 'completed' }), call('s1', 'ToolSearch', { query: 'select:WebFetch' })] },
      { key: 'r', ts: 3, role: 'user', model: null, blocks: [res('t1', 'Task #1 created successfully: First'), res('t2', 'Task #2 created successfully: Second'), res('t3', 'Updated task #1 status'), res('s1', '')] },
    ]);
    const blocks = turns[1]!.blocks;
    expect(blocks[0]).toMatchObject({ kind: 'tasks', ops: 3, items: [{ id: '1', subject: 'First', status: 'completed' }, { id: '2', subject: 'Second', status: 'pending' }] });
    expect(blocks[1]).toMatchObject({ kind: 'quiet' });
  });
});

describe('round 6: row summaries and interruptions', () => {
  it('summarizes shell rows by their description, or without the leading cd', async () => {
    const { displaySummary } = await import('../src/renderer/src/transcript-model');
    expect(displaySummary('Bash', JSON.stringify({ command: 'cd "/a b" && npm test', description: 'Run the tests' }), 'cd "/a b" && npm test')).toBe('Run the tests');
    expect(displaySummary('Bash', JSON.stringify({ command: 'cd /repo && git status' }), 'cd /repo && git status')).toBe('git status');
    expect(displaySummary('Read', JSON.stringify({ file_path: '/x.ts' }), '/x.ts')).toBe('/x.ts');
  });

  it('shows "[Request interrupted by user]" as a note, not as your message', async () => {
    const { buildTurns, INTERRUPTED_NOTICE } = await import('../src/renderer/src/transcript-model');
    const turns = buildTurns([{ key: 'u', ts: 1, role: 'user', model: null, blocks: [{ kind: 'text', text: '[Request interrupted by user]' }] }]);
    expect(turns[0]!.role).toBe('notice');
    expect(turns[0]!.blocks[0]).toMatchObject({ kind: 'block', block: { kind: 'notice', text: INTERRUPTED_NOTICE } });
  });
});
