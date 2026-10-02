import type { AgentNode } from '@alchemist-coder/core';

/** From this many subagents of one type on, they share a tab that lists them (a workflow's wave). */
export const WAVE_MIN = 5;

/** One tab over a conversation: an agent, or a wave of subagents of the same type. */
export type AgentTab = { kind: 'agent'; node: AgentNode } | { kind: 'wave'; type: string; nodes: AgentNode[] };

/** Every subagent under `root`, in the order they were launched (each one followed by its own). */
export function subagentsOf(root: AgentNode, hidden: string[] = []): AgentNode[] {
  const out: AgentNode[] = [];
  const walk = (node: AgentNode) => {
    for (const c of node.children) {
      if (hidden.includes(c.id)) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

/**
 * The tabs after the main agent's: its subagents in the order they started. Many of one type fold
 * into a single tab, and the agent you have open always keeps a tab of its own.
 */
export function agentTabs(root: AgentNode, selectedId: string, hidden: string[] = []): AgentTab[] {
  const all = subagentsOf(root, hidden);
  const byType = new Map<string, AgentNode[]>();
  for (const n of all) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
  const tabs: AgentTab[] = [];
  const waves = new Set<string>();
  for (const node of all) {
    const same = byType.get(node.type)!;
    if (same.length < WAVE_MIN) {
      tabs.push({ kind: 'agent', node });
      continue;
    }
    if (waves.has(node.type)) continue;
    waves.add(node.type);
    tabs.push({ kind: 'wave', type: node.type, nodes: same });
    const open = same.find((n) => n.id === selectedId);
    if (open) tabs.push({ kind: 'agent', node: open });
  }
  return tabs;
}

/** The subagent a tool call launched, when the tree knows it. */
export function findByToolUse(node: AgentNode | null | undefined, toolUseId: string | undefined): AgentNode | null {
  if (!node || !toolUseId) return null;
  if (node.toolUseId === toolUseId) return node;
  for (const c of node.children) {
    const found = findByToolUse(c, toolUseId);
    if (found) return found;
  }
  return null;
}

/** A subagent's type as people read it. */
export const typeLabel = (type: string) => (type === 'general-purpose' ? 'general' : type);
