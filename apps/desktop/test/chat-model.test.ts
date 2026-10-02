import { describe, expect, it } from 'vitest';
import type { AgentNode } from '@alchemist-coder/core';
import { agentTabs, findByToolUse, subagentsOf } from '../src/renderer/src/chat-model';

const node = (id: string, type: string, children: AgentNode[] = [], toolUseId: string | null = null): AgentNode =>
  ({ id, sessionId: 's', parentId: null, toolUseId, type, description: `${type} ${id}`, depth: 1, model: null, isFork: false, worktreePath: null, worktreeBranch: null, status: 'done', startedTs: null, endedTs: null, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null, children }) as AgentNode;

describe('agent tabs of a conversation', () => {
  it('lists subagents in launch order, each followed by its own', () => {
    const root = node('main', 'main', [node('a', 'Explore', [node('a1', 'Plan')]), node('b', 'general-purpose')]);
    expect(subagentsOf(root).map((n) => n.id)).toEqual(['a', 'a1', 'b']);
    expect(subagentsOf(root, ['a']).map((n) => n.id)).toEqual(['b']);
    expect(agentTabs(root, 'main').map((t) => (t.kind === 'agent' ? t.node.id : `wave:${t.type}`))).toEqual(['a', 'a1', 'b']);
  });

  it('folds a wave into one tab and keeps the open agent in sight', () => {
    const wave = Array.from({ length: 6 }, (_, i) => node(`w${i}`, 'general-purpose'));
    const root = node('main', 'main', [node('x', 'Explore'), ...wave]);
    const ids = (selected: string) => agentTabs(root, selected).map((t) => (t.kind === 'agent' ? t.node.id : `wave:${t.type}×${t.nodes.length}`));
    expect(ids('main')).toEqual(['x', 'wave:general-purpose×6']);
    expect(ids('w3')).toEqual(['x', 'wave:general-purpose×6', 'w3']);
  });

  it('finds the subagent a tool call launched', () => {
    const root = node('main', 'main', [node('a', 'Explore', [node('a1', 'Plan', [], 'toolu_2')], 'toolu_1')]);
    expect(findByToolUse(root, 'toolu_2')?.id).toBe('a1');
    expect(findByToolUse(root, 'nope')).toBeNull();
    expect(findByToolUse(root, undefined)).toBeNull();
  });
});
