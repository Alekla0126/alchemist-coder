import type { FlowEdge, FlowNode } from '@shared/api';

export interface Placed {
  node: FlowNode;
  /** Row (how many steps from the start, along the longest way) and column within the row. */
  row: number;
  col: number;
  x: number;
  y: number;
}

export interface Arrow {
  edge: FlowEdge;
  /** Goes back up to an earlier step (a loop): drawn around the side. */
  back: boolean;
  path: string;
  /** Where its label sits. */
  lx: number;
  ly: number;
}

export const NODE_W = 220;
export const NODE_H = 86;
const GAP_X = 36;
const GAP_Y = 64;

/**
 * Lays a diagram out top to bottom. Each step sits below every step that leads to it (the longest way
 * from the start), so branches that meet again continue underneath them. Arrows that go back to an
 * earlier step are the loops: they go around the right side. Steps of a row line up under the steps
 * they come from; steps nothing leads to go last.
 */
export function layoutFlow(nodes: FlowNode[], edges: FlowEdge[]): { placed: Placed[]; arrows: Arrow[]; width: number; height: number } {
  const ids = new Set(nodes.map((n) => n.id));
  const valid = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const out = new Map<string, FlowEdge[]>();
  for (const e of valid) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  // Loops: an arrow to a step still on the way from the start to here.
  const backEdges = new Set<FlowEdge>();
  const order: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const e of out.get(id) ?? []) {
      const s = state.get(e.to);
      if (s === 'open') backEdges.add(e);
      else if (!s) visit(e.to);
    }
    state.set(id, 'done');
    order.unshift(id);
  };
  if (nodes[0]) visit(nodes[0].id);
  // Rows along the longest way, in the order steps come (a topological order).
  const row = new Map<string, number>();
  for (const id of order) row.set(id, row.get(id) ?? 0);
  for (const id of order) for (const e of out.get(id) ?? []) if (!backEdges.has(e)) row.set(e.to, Math.max(row.get(e.to) ?? 0, row.get(id)! + 1));
  let last = Math.max(-1, ...row.values());
  for (const n of nodes) if (!row.has(n.id)) row.set(n.id, ++last);
  const rows = new Map<number, string[]>();
  for (const n of nodes) rows.set(row.get(n.id)!, [...(rows.get(row.get(n.id)!) ?? []), n.id]);
  // Each row ordered under the steps it comes from (their average column).
  const col = new Map<string, number>();
  const sortedRows = [...rows].sort((a, b) => a[0] - b[0]);
  for (const [, list] of sortedRows) {
    const key = (id: string) => {
      const from = valid.filter((e) => e.to === id && !backEdges.has(e) && col.has(e.from)).map((e) => col.get(e.from)!);
      return from.length ? from.reduce((s, c) => s + c, 0) / from.length : Infinity;
    };
    const keyed = list.map((id, i) => ({ id, k: key(id), i }));
    keyed.sort((a, b) => a.k - b.k || a.i - b.i);
    keyed.forEach((x, i) => col.set(x.id, i - (keyed.length - 1) / 2));
    list.splice(0, list.length, ...keyed.map((x) => x.id));
  }
  const widest = Math.max(1, ...sortedRows.map(([, r]) => r.length));
  const inner = widest * NODE_W + (widest - 1) * GAP_X;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed: Placed[] = [];
  for (const [r, list] of sortedRows) {
    const rowWidth = list.length * NODE_W + (list.length - 1) * GAP_X;
    const left = (inner - rowWidth) / 2;
    list.forEach((id, c) => placed.push({ node: byId.get(id)!, row: r, col: c, x: left + c * (NODE_W + GAP_X), y: r * (NODE_H + GAP_Y) }));
  }
  const at = new Map(placed.map((p) => [p.node.id, p]));
  const arrows: Arrow[] = [];
  let loops = 0;
  const lanes = { left: 0, right: 0 };
  // How far the side lanes reach out, to make room for them.
  let minX = 0;
  let maxX = inner;
  for (const edge of valid) {
    const a = at.get(edge.from)!;
    const b = at.get(edge.to)!;
    const back = backEdges.has(edge) || b.row <= a.row;
    const between = placed.filter((p) => p.row > a.row && p.row < b.row);
    if (!back && between.length) {
      // It skips rows: around the steps in between, on the side closer to where it starts.
      const left = Math.min(...between.map((p) => p.x));
      const right = Math.max(...between.map((p) => p.x + NODE_W));
      const fromX = a.x + NODE_W / 2;
      const goLeft = fromX - left < right - fromX;
      const lane = goLeft ? left - 22 - 12 * lanes.left++ : right + 22 + 12 * lanes.right++;
      const x1 = fromX + (goLeft ? -NODE_W / 4 : NODE_W / 4);
      const y1 = a.y + NODE_H;
      const x2 = b.x + NODE_W / 2 + (goLeft ? -NODE_W / 4 : NODE_W / 4);
      const y2 = b.y;
      const top = y1 + GAP_Y / 2;
      const bottom = y2 - GAP_Y / 2;
      arrows.push({ edge, back, path: `M ${x1} ${y1} C ${x1} ${top}, ${lane} ${y1}, ${lane} ${top + 10} L ${lane} ${bottom - 10} C ${lane} ${y2}, ${x2} ${bottom}, ${x2} ${y2 - 6}`, lx: lane, ly: top + 22 });
      minX = Math.min(minX, lane - 30);
      maxX = Math.max(maxX, lane + 30);
    } else if (!back) {
      // Several arrows between the same two steps (two branches meeting) fan out a little.
      const twins = valid.filter((e) => e.from === edge.from && e.to === edge.to);
      const spread = (twins.indexOf(edge) - (twins.length - 1) / 2) * 56;
      const x1 = a.x + NODE_W / 2 + spread / 2;
      const y1 = a.y + NODE_H;
      const x2 = b.x + NODE_W / 2 + spread / 4;
      const y2 = b.y;
      const mid = y1 + Math.min(GAP_Y, (y2 - y1) / 2);
      // Their labels one above the other, so they don't cover each other.
      const step = (twins.indexOf(edge) - (twins.length - 1) / 2) * 24;
      arrows.push({ edge, back, path: `M ${x1} ${y1} C ${x1 + spread} ${mid}, ${x2} ${mid}, ${x2} ${y2 - 6}`, lx: x1 + spread * 0.6 + (x2 - x1) * 0.35, ly: y1 + Math.min(GAP_Y, (y2 - y1) / 2) * 0.62 + step });
    } else {
      // Around the right edge of the widest row, a little further out for each loop.
      const outX = Math.max(inner, maxX) + 34 + 16 * loops++;
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x + NODE_W;
      const y2 = b.y + NODE_H / 2;
      arrows.push({ edge, back, path: `M ${x1} ${y1} C ${outX} ${y1}, ${outX} ${y2}, ${x2 + 6} ${y2}`, lx: outX - 4, ly: (y1 + y2) / 2 });
    }
  }
  const height = (Math.max(0, ...placed.map((p) => p.row)) + 1) * (NODE_H + GAP_Y) - GAP_Y;
  // Lanes that reach past the left edge: everything moves right to make room.
  const shift = Math.max(0, -minX);
  if (shift) {
    for (const p of placed) p.x += shift;
    for (const a of arrows) {
      a.path = a.path.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => `${Number(x) + shift} ${y}`);
      a.lx += shift;
    }
  }
  return { placed, arrows, width: Math.max(inner + 60 + 16 * loops, maxX) + shift + 10, height };
}
