import { useEffect, useRef } from 'react';
import type { AgentNode, AgentStatus } from '@alchemist-coder/core';
import { useAgentNames, useHiddenAgents } from '../agents-edit';
import { agentTabs, subagentsOf, typeLabel } from '../chat-model';
import { useStore, useT } from '../store';
import { openMenu } from '../ui';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';
import { WorkingOrb } from './WorkingOrb';

const MARK: Partial<Record<AgentStatus, string>> = { running: '● ', waiting: '● ', done: '✓ ', error: '✕ ' };

function Status({ status }: { status: AgentStatus }) {
  const t = useT();
  return status === 'running' || status === 'waiting' ? <WorkingOrb state={status} size={12} label={t(`status.${status}`)} /> : <StatusDot status={status} />;
}

/**
 * Who is in this conversation, as tabs over the chat: the main agent first, then the subagents it
 * launched. Each tab shows how that agent is doing; a click shows its part of the conversation.
 */
export function AgentTabs({ sessionId, root, selectedId, mainStatus }: { sessionId: string; root: AgentNode; selectedId: string; mainStatus: AgentStatus }) {
  const t = useT();
  const select = useStore((s) => s.select);
  const hidden = useHiddenAgents((h) => h.hidden[sessionId]);
  const names = useAgentNames((n) => n.names[sessionId]);
  const bar = useRef<HTMLElement>(null);
  // The open agent's tab stays in sight when there are more than fit.
  useEffect(() => {
    bar.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);
  const total = subagentsOf(root, hidden).length;
  if (!total) return null;
  const tabs = agentTabs(root, selectedId, hidden);
  const nameOf = (n: AgentNode) => names?.[n.id] ?? n.description;
  const pick = async (nodes: AgentNode[]) => {
    const id = await openMenu(nodes.slice(0, 60).map((n) => ({ id: n.id, label: `${MARK[n.status] ?? ''}${nameOf(n)}`.slice(0, 120), checked: n.id === selectedId })));
    if (id) void select(sessionId, id);
  };
  return (
    <nav className="chat-agents" role="tablist" aria-label={t('chat.agents')} ref={bar}>
      <button role="tab" aria-selected={selectedId === 'main'} className={`atab main ${selectedId === 'main' ? 'on' : ''}`} onClick={() => void select(sessionId, 'main')}>
        <Status status={mainStatus} />
        <span className="atab-name">{names?.main ?? t('agent.main')}</span>
      </button>
      <span className="atab-sep" aria-hidden>
        <Icon name="chevronRight" size={12} /> {t('agent.subagentsN', { n: total })}
      </span>
      {tabs.map((tab) =>
        tab.kind === 'agent' ? (
          <button
            key={tab.node.id}
            role="tab"
            aria-selected={tab.node.id === selectedId}
            className={`atab ${tab.node.id === selectedId ? 'on' : ''}`}
            title={`${typeLabel(tab.node.type)} · ${tab.node.description}`}
            onClick={() => void select(sessionId, tab.node.id)}
          >
            <Status status={tab.node.status} />
            <small className="atab-type">{typeLabel(tab.node.type)}</small>
            <span className="atab-name">{nameOf(tab.node)}</span>
          </button>
        ) : (
          <button key={`wave:${tab.type}`} className="atab wave" aria-haspopup="menu" title={t('agent.wave', { n: tab.nodes.length })} onClick={() => void pick(tab.nodes)}>
            {tab.nodes.some((n) => n.status === 'running') ? <WorkingOrb size={12} /> : <span className="status-icon done">✓</span>}
            <small className="atab-type">{typeLabel(tab.type)}</small>
            <span className="atab-name">×{tab.nodes.length}</span>
            <Icon name="chevronDown" size={12} />
          </button>
        ),
      )}
    </nav>
  );
}
