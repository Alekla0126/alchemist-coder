import { useState } from 'react';
import type { AgentNode } from '@alchemist-coder/core';
import { Caret, Icon } from './Icon';
import { money, modelLabel } from '../format';
import { useStore, useT } from '../store';
import { StatusDot } from './StatusDot';
import { confirmAction, contextMenu } from '../ui';
import { useHiddenAgents } from '../agents-edit';
import { AddAgentDialog } from './AddAgent';

/** What the tree needs to add or stop agents: whose conversation it is and where it runs. */
interface TreeCtx {
  sessionId: string;
  /** Only Claude Code conversations launch subagents on request. */
  canAdd: boolean;
  cwd: string | null;
}

/** The app's own run on this conversation while it works (the one we can stop). */
function useLiveRun(sessionId: string) {
  return useStore((s) => {
    const run = s.runs[s.runByTarget[`s:${sessionId}`] ?? ''];
    return run && (run.status === 'running' || run.status === 'starting' || run.status === 'waiting') ? run.runId : null;
  });
}

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

function AgentRow({ ctx, node }: { ctx: TreeCtx; node: AgentNode }) {
  const t = useT();
  const { sessionId } = ctx;
  // --add-agent (screenshots): the dialog, open on the main agent.
  const [adding, setAdding] = useState(() => node.id === 'main' && ctx.canAdd && !!useStore.getState().info?.capture?.addAgent);
  const liveRun = useLiveRun(sessionId);
  const interrupt = useStore((s) => s.interruptRun);
  const hide = useHiddenAgents((h) => h.hide);
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
  const running = node.status === 'running';
  /** A working subagent can only stop with its whole turn (the conversation stays). */
  const stop = async () => {
    if (!liveRun) return;
    const ok = await confirmAction({ title: t('agentEdit.stopTitle'), message: t('agentEdit.stopBody'), confirmLabel: t('agentEdit.stop'), cancelLabel: t('dialog.cancel'), danger: true });
    if (ok) void interrupt(liveRun);
  };
  const actions = isMain ? (
    ctx.canAdd && (
      <button className="row-act add" onClick={(e) => (e.stopPropagation(), setAdding(true))} title={t('agentEdit.addTip')} aria-label={t('agentEdit.addTip')}>
        <Icon name="plus" size={13} />
      </button>
    )
  ) : running ? (
    <button
      className="row-act"
      disabled={!liveRun}
      onClick={(e) => (e.stopPropagation(), void stop())}
      title={liveRun ? t('agentEdit.stopTip') : t('agentEdit.stopOutside')}
      aria-label={t('agentEdit.stop')}
    >
      <Icon name="stop" size={12} />
    </button>
  ) : (
    <button className="row-act" onClick={(e) => (e.stopPropagation(), hide(sessionId, node.id))} title={t('agentEdit.hideTip')} aria-label={t('agentEdit.hide')}>
      <Icon name="close" size={12} />
    </button>
  );
  return (
    <>
      <div
        className={`row agent ${selected ? 'sel' : ''} ${isMain ? 'main' : ''}`}
        title={isMain ? undefined : node.description}
        onClick={() => void select(sessionId, node.id)}
        onContextMenu={contextMenu(
          () => [
            { id: 'open', label: t('menu.open') },
            ...(node.parentId ? [{ id: 'parent', label: t('menu.goToParent') }] : []),
            { type: 'separator' as const },
            { id: 'copy-id', label: t('menu.copyAgentId') },
            ...(isMain ? [] : [{ id: 'copy-brief', label: t('menu.copyBrief') }]),
            ...(isMain && ctx.canAdd ? [{ type: 'separator' as const }, { id: 'add', label: `${t('agentEdit.add')}…` }] : []),
            ...(!isMain && !running ? [{ type: 'separator' as const }, { id: 'hide', label: t('agentEdit.hide') }] : []),
            ...(!isMain && running && liveRun ? [{ type: 'separator' as const }, { id: 'stop', label: `${t('agentEdit.stop')}…` }] : []),
          ],
          (id) => {
            if (id === 'add') setAdding(true);
            if (id === 'hide') hide(sessionId, node.id);
            if (id === 'stop') void stop();
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
        {actions && <span className="row-acts">{actions}</span>}
      </div>
      {open && node.children.length > 0 && <AgentChildren ctx={ctx} nodes={node.children} />}
      {adding && <AddAgentDialog sessionId={sessionId} cwd={ctx.cwd} onClose={() => setAdding(false)} />}
    </>
  );
}

function WaveRow({ ctx, type, nodes }: { ctx: TreeCtx; type: string; nodes: AgentNode[] }) {
  const t = useT();
  const { sessionId } = ctx;
  const [adding, setAdding] = useState(false);
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
        {ctx.canAdd && (
          <span className="row-acts">
            <button className="row-act add" onClick={(e) => (e.stopPropagation(), setAdding(true))} title={t('agentEdit.addToWave')} aria-label={t('agentEdit.addToWave')}>
              <Icon name="plus" size={13} />
            </button>
          </span>
        )}
      </div>
      {open && <AgentChildren ctx={ctx} nodes={nodes} flat />}
      {adding && <AddAgentDialog sessionId={sessionId} cwd={ctx.cwd} type={type} onClose={() => setAdding(false)} />}
    </>
  );
}

function AgentChildren({ ctx, nodes, flat }: { ctx: TreeCtx; nodes: AgentNode[]; flat?: boolean }) {
  const hidden = useHiddenAgents((h) => h.hidden[ctx.sessionId]);
  const shown = hidden?.length ? nodes.filter((n) => !hidden.includes(n.id)) : nodes;
  const items: Item[] = flat ? shown.map((node) => ({ kind: 'agent', node })) : group(shown);
  if (!items.length) return null;
  return (
    <div className="kids">
      {items.map((it) =>
        it.kind === 'agent' ? (
          <AgentRow key={it.node.id} ctx={ctx} node={it.node} />
        ) : (
          <WaveRow key={`wave-${it.type}`} ctx={ctx} type={it.type} nodes={it.nodes} />
        ),
      )}
    </div>
  );
}

export function AgentTree({ sessionId, root, source, cwd }: { sessionId: string; root: AgentNode; source?: string; cwd?: string | null }) {
  const t = useT();
  const hidden = useHiddenAgents((h) => h.hidden[sessionId]?.length ?? 0);
  const showAll = useHiddenAgents((h) => h.showAll);
  const ctx: TreeCtx = { sessionId, canAdd: source === 'claude-code', cwd: cwd ?? null };
  return (
    <div className="kids">
      <AgentRow ctx={ctx} node={root} />
      {hidden > 0 && (
        <button className="row agent hidden-note" onClick={() => showAll(sessionId)} title={t('agentEdit.showHiddenTip')}>
          <span className="car" />
          <span className="tt">{t('agentEdit.hidden', { n: hidden })}</span>
          <span className="r">{t('agentEdit.showHidden')}</span>
        </button>
      )}
    </div>
  );
}
