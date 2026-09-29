import { describe, expect, it } from 'vitest';
import type { RunnerEvent } from '@alchemist-coder/core';
import { answerSummary, applyToTurns, markQuestion, startTurn, type LiveTurn } from '../src/renderer/src/live-turns';

const run = (turns: LiveTurn[], events: RunnerEvent[]) => events.reduce((t, e) => applyToTurns(t, e, 5), turns);

describe('live turns', () => {
  it('shows your message at once, then text, thinking, tools and permissions in order', () => {
    let turns = startTurn([], 'fix the bug', 1);
    turns = run(turns, [
      { type: 'thought', text: 'Look at ' },
      { type: 'thought', text: 'the test.' },
      { type: 'text', text: 'Reading the test' },
      { type: 'tool', id: 't1', name: 'Read', summary: 'a.test.ts', kind: 'read', state: 'running' },
      { type: 'tool', id: 't1', name: 'Read', summary: '', state: 'done' },
      { type: 'text', text: '\n\nFound it.' },
      { type: 'permission', requestId: 'p1', toolId: 't2', title: 'Edit a.ts', kind: 'edit', diffs: [], choices: [], content: null },
      { type: 'permissionClosed', requestId: 'p1', choiceId: 'allow' },
      { type: 'status', status: 'running' },
      { type: 'result', ok: true, sessionId: 's', costUsd: null },
    ]);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.prompt).toBe('fix the bug');
    expect(t.endedAt).toBe(5);
    expect(t.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool', 'text', 'permission']);
    expect(t.blocks[0]).toEqual({ kind: 'thinking', text: 'Look at the test.' });
    expect(t.blocks[2]).toMatchObject({ tool: { id: 't1', summary: 'a.test.ts', state: 'done' } });
    expect(t.blocks[3]).toEqual({ kind: 'text', text: 'Found it.' });
    expect(t.blocks[4]).toMatchObject({ resolved: true, choiceId: 'allow' });
  });

  it('opens a turn for events that arrive before the prompt is registered, and the next message starts a new one', () => {
    let turns = run([], [{ type: 'text', text: 'Hi' }]);
    turns = startTurn(turns, 'hello', 2);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toBe('hello');
    turns = run(turns, [{ type: 'status', status: 'idle' }]);
    turns = startTurn(turns, 'again', 9);
    expect(turns.map((x) => x.prompt)).toEqual(['hello', 'again']);
    // Nothing to show after a turn ended: no empty turn is opened.
    expect(run([{ prompt: 'x', startedAt: 1, endedAt: 2, blocks: [] }], [{ type: 'status', status: 'done' }])).toHaveLength(1);
  });

  it("keeps an agent's question in the chat: open until answered, then what you answered (or skipped)", () => {
    const fields = [
      { key: 'question_0', title: 'Color', description: '', kind: 'single' as const, options: [{ value: 'Red', title: 'Red (warm)', description: '' }] },
      { key: 'question_0_custom', title: 'Other', description: '', kind: 'text' as const, options: [], forKey: 'question_0' },
    ];
    let turns = startTurn([], 'pick', 1);
    turns = run(turns, [{ type: 'question', requestId: 'form-1', message: 'Which color?', fields }]);
    expect(turns[0]!.blocks.at(-1)).toMatchObject({ kind: 'question', resolved: false, request: { message: 'Which color?' } });
    const summary = answerSummary(fields, { question_0: 'Red', question_0_custom: 'dark' });
    expect(summary).toBe('Color: Red (warm) — “dark”');
    turns = markQuestion(turns, 'form-1', true, summary);
    // The agent confirming keeps your answer.
    turns = run(turns, [{ type: 'questionClosed', requestId: 'form-1', answered: true }]);
    expect(turns[0]!.blocks.at(-1)).toMatchObject({ resolved: true, answered: true, summary: 'Color: Red (warm) — “dark”' });
    // Closed without an answer (stopped, or the agent gave up): skipped.
    turns = run(turns, [{ type: 'question', requestId: 'form-2', message: 'Again?', fields }, { type: 'questionClosed', requestId: 'form-2', answered: false }]);
    expect(turns[0]!.blocks.at(-1)).toMatchObject({ resolved: true, answered: false, summary: '' });
  });
});
