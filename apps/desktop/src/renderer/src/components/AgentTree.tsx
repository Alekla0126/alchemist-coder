import type { AgentNode } from '@alchemist-coder/core';
import { Caret } from './Icon';
import { money, modelLabel } from '../format';
import { useStore, useT } from '../store';
import { StatusDot } from './StatusDot';
import { contextMenu } from '../ui';

const WAVE_MIN = 5;

type Item = { kind: 'agent'; node: AgentNode } | { kind: 'wave'; type: string; nodes: AgentNode[] };

/** Many siblings of the same type (e.g. a workflow wave) collapse into one row. */
function group(children: AgentNode[]): Item[] {
  const byType = new Map<string, AgentNode[]>();
  for (const c of children) byType.set(c.type, [...(byType.get(c.type) ?? []), c]);
  const emitted = new Set<string>();
  const items: Item[] = [];
  for (const c of children) {
    const same = byType.get(c.type)!;
    if (same.length >= WAVE_MIN) {
      if (!emitted.has(c.type)) {
        emitted.add(c.type);
        items.push({ kind: 'wave', type: c.type, nodes: same });
      }
    } else items.push({ kind: 'agent', node: c });
  }
  return items;
}

function AgentRow({ sessionId, node }: { sessionId: string; node: AgentNode }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const key = `a:${sessionId}:${node.id}`;
  const open = useStore((s) => s.expanded[key] ?? node.id === 'main');
  const selected = useStore((s) => s.selection?.sessionId === sessionId && s.selection.agentId === node.id);
  const toggle = useStore((s) => s.toggle);
  const select = useStore((s) => s.select);
  const isMain = node.id === 'main';
  // A live run waiting for your answer: the main agent shows it too, not just "running".
  const waiting = useStore((s) => {
    if (!isMain) return false;
    const runId = s.runByTarget[`s:${sessionId}`];
    return !!runId && s.runs[runId]?.status === 'waiting';
  });
  return (
    <>
      <div
        className={`row agent ${selected ? 'sel' : ''}`}
        title={isMain ? undefined : node.description}
        onClick={() => void select(sessionId, node.id)}
        onContextMenu={contextMenu(
          () => [
            { id: 'open', label: t('menu.open') },
            ...(node.parentId ? [{ id: 'parent', label: t('menu.goToParent') }] : []),
            { type: 'separator' as const },
            { id: 'copy-id', label: t('menu.copyAgentId') },
            ...(isMain ? [] : [{ id: 'copy-brief', label: t('menu.copyBrief') }]),
          ],
          (id) => {
            if (id === 'open') void select(sessionId, node.id);
            if (id === 'parent' && node.parentId) void select(sessionId, node.parentId);
            if (id === 'copy-id') void window.alchemist.copyText(node.id);
            if (id === 'copy-brief') void window.alchemist.copyText(node.description);
          },
        )}
      >
        <span
          className="car"
          onClick={(e) => {
            e.stopPropagation();
            if (node.children.length) toggle(key);
          }}
        >
          {node.children.length ? <Caret open={open} /> : null}
        </span>
        <StatusDot status={waiting ? 'waiting' : node.status} />
        {isMain ? (
          <span className="tt strong">{t('agent.main')}</span>
        ) : (
          <>
            <span className="ty">{node.type === 'general-purpose' ? 'general' : node.type}</span>
            <span className="tt">{node.description}</span>
          </>
        )}
        <span className="r">
          {node.worktreeBranch ? <span className="branch">⎇ {node.worktreeBranch}</span> : isMain ? (node.model ? modelLabel(node.model) : '') : node.costUsd != null ? money(node.costUsd, locale) : ''}
        </span>
      </div>
      {open && node.children.length > 0 && <AgentChildren sessionId={sessionId} nodes={node.children} />}
    </>
  );
}

function WaveRow({ sessionId, type, nodes }: { sessionId: string; type: string; nodes: AgentNode[] }) {
  const t = useT();
  const key = `w:${sessionId}:${type}`;
  const open = useStore((s) => s.expanded[key] ?? false);
  const toggle = useStore((s) => s.toggle);
  const running = nodes.filter((n) => n.status === 'running').length;
  const failed = nodes.filter((n) => n.status === 'error').length;
  return (
    <>
      <div className="row agent wave" onClick={() => toggle(key)}>
        <span className="car"><Caret open={open} /></span>
        <span className="ty">{type === 'general-purpose' ? 'general' : type}</span>
        <span className="tt">{t('agent.wave', { n: nodes.length })}</span>
        <span className="r wave-bars" aria-hidden>
          {nodes.slice(0, 12).map((n) => (
            <i key={n.id} className={n.status} />
          ))}
        </span>
        {(running > 0 || failed > 0) && <span className="wave-count">{running > 0 ? `● ${running}` : `✕ ${failed}`}</span>}
      </div>
      {open && <AgentChildren sessionId={sessionId} nodes={nodes} flat />}
    </>
  );
}

export function AgentChildren({ sessionId, nodes, flat }: { sessionId: string; nodes: AgentNode[]; flat?: boolean }) {
  const items: Item[] = flat ? nodes.map((node) => ({ kind: 'agent', node })) : group(nodes);
  return (
    <div className="kids">
      {items.map((it) =>
        it.kind === 'agent' ? (
          <AgentRow key={it.node.id} sessionId={sessionId} node={it.node} />
        ) : (
          <WaveRow key={`wave-${it.type}`} sessionId={sessionId} type={it.type} nodes={it.nodes} />
        ),
      )}
    </div>
  );
}

export function AgentTree({ sessionId, root }: { sessionId: string; root: AgentNode }) {
  return (
    <div className="kids">
      <AgentRow sessionId={sessionId} node={root} />
    </div>
  );
}
