import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../src/shared/api';
import { layoutFlow, NODE_W } from '../src/renderer/src/flow-layout';

const n = (id: string): FlowNode => ({ id, kind: id === 's' ? 'trigger' : 'agent', title: id });

describe('diagram layout', () => {
  it('puts steps in rows by distance, branches side by side, loops around the side', () => {
    const nodes = ['s', 'a', 'b', 'c', 'lost'].map(n);
    const edges = [
      { from: 's', to: 'a' },
      { from: 'a', to: 'b', branch: 'yes' },
      { from: 'a', to: 'c', branch: 'no' },
      { from: 'c', to: 'a' },
    ];
    const { placed, arrows, width } = layoutFlow(nodes, edges);
    const at = Object.fromEntries(placed.map((p) => [p.node.id, p]));
    expect([at.s!.row, at.a!.row, at.b!.row, at.c!.row, at.lost!.row]).toEqual([0, 1, 2, 2, 3]);
    expect(at.b!.y).toBe(at.c!.y);
    expect(at.c!.x - at.b!.x).toBeGreaterThanOrEqual(NODE_W);
    // The row of two is centered like the row of one.
    expect(at.a!.x + NODE_W / 2).toBeCloseTo((at.b!.x + at.c!.x + NODE_W) / 2);
    expect(arrows.find((a) => a.edge.from === 'c')!.back).toBe(true);
    expect(arrows.filter((a) => a.back)).toHaveLength(1);
    expect(width).toBeGreaterThan(2 * NODE_W);
  });

  it('puts a step where branches meet below all of them, and fans out twin arrows', () => {
    const nodes = ['s', 'kind', 'card', 'draft', 'ok', 'tell', 'end'].map(n);
    const edges = [
      { from: 's', to: 'kind' },
      { from: 'kind', to: 'card', branch: 'bug' },
      { from: 'kind', to: 'draft', branch: 'question' },
      { from: 'kind', to: 'tell', branch: 'nothing' },
      { from: 'card', to: 'tell' },
      { from: 'draft', to: 'ok' },
      { from: 'ok', to: 'tell', branch: 'publish' },
      { from: 'ok', to: 'tell', branch: 'discard' },
      { from: 'tell', to: 'end' },
    ];
    const { placed, arrows } = layoutFlow(nodes, edges);
    const row = Object.fromEntries(placed.map((p) => [p.node.id, p.row]));
    expect(row).toEqual({ s: 0, kind: 1, card: 2, draft: 2, ok: 3, tell: 4, end: 5 });
    // No loops here: every arrow goes down.
    expect(arrows.every((a) => !a.back)).toBe(true);
    const twins = arrows.filter((a) => a.edge.from === 'ok');
    expect(twins[0]!.lx).not.toBe(twins[1]!.lx);
  });
});
