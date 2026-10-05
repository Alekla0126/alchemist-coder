import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { AgentNode, AgentStatus, Source } from '@alchemist-coder/core';
import { useAgentNames, useHiddenAgents } from '../agents-edit';
import { guessAvatar } from '../avatar';
import { agentTabs, subagentsOf, typeLabel } from '../chat-model';
import { sourceOf } from '../sources';
import { useStore, useT } from '../store';
import { openMenu } from '../ui';
import { AgentAvatar, type AvatarState } from './AgentAvatar';
import { Icon } from './Icon';

const MARK: Partial<Record<AgentStatus, string>> = { running: '● ', waiting: '● ', done: '✓ ', error: '✕ ' };
const STATE: Partial<Record<AgentStatus, AvatarState>> = { running: 'working', waiting: 'waiting', error: 'error' };

/**
 * The tabs shrink to fit, a step at a time: without their kind, without the subagents' count, then one
 * by one to just their picture: finished agents first, working ones last. The open one keeps its name.
 */
function useTabsFit(bar: RefObject<HTMLElement | null>, shown: boolean) {
  const fit = useCallback(() => {
    const el = bar.current;
    if (!el) return;
    const fits = () => el.scrollWidth <= el.clientWidth + 1;
    const tabs = [...el.querySelectorAll<HTMLElement>('.atab:not(.wave)')];
    for (const tab of tabs) delete tab.dataset.pic;
    for (const level of ['full', 'names', 'count']) {
      el.dataset.fit = level;
      if (fits()) return;
    }
    const busy = (tab: HTMLElement) => (tab.querySelector('.agent-av.st-working, .agent-av.st-waiting') ? 2 : tab.classList.contains('main') ? 1 : 0);
    const order = tabs.filter((tab) => !tab.classList.contains('on')).sort((a, b) => busy(a) - busy(b));
    for (const tab of order) {
      tab.dataset.pic = '';
      if (fits()) return;
    }
  }, [bar]);
  // After every change of tabs, names or states, before it's painted.
  useLayoutEffect(fit);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit, shown]);
}

/**
 * Who is in this conversation, as tabs over the chat: the main agent first, then the subagents it
 * launched. Each tab shows how that agent is doing; a click shows its part of the conversation.
 */
export function AgentTabs({ sessionId, root, selectedId, mainStatus, source }: { sessionId: string; root: AgentNode; selectedId: string; mainStatus: AgentStatus; source?: Source }) {
  const t = useT();
  const select = useStore((s) => s.select);
  const hidden = useHiddenAgents((h) => h.hidden[sessionId]);
  const names = useAgentNames((n) => n.names[sessionId]);
  const bar = useRef<HTMLElement>(null);
  const total = subagentsOf(root, hidden).length;
  useTabsFit(bar, total > 0);
  // The open agent's tab stays in sight when there are more than fit.
  useEffect(() => {
    bar.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);
  if (!total) return null;
  const tabs = agentTabs(root, selectedId, hidden);
  const nameOf = (n: AgentNode) => names?.[n.id] ?? n.description;
  const mainName = names?.main ?? t('agent.main');
  // The main agent's picture is its CLI's mark; a subagent's, its kind's or its task's.
  const cli = source ? sourceOf(source) : null;
  const pick = async (nodes: AgentNode[]) => {
    const id = await openMenu(nodes.slice(0, 60).map((n) => ({ id: n.id, label: `${MARK[n.status] ?? ''}${nameOf(n)}`.slice(0, 120), checked: n.id === selectedId })));
    if (id) void select(sessionId, id);
  };
  return (
    <nav className="chat-agents" role="tablist" aria-label={t('chat.agents')} ref={bar}>
      <button
        role="tab"
        aria-selected={selectedId === 'main'}
        aria-label={mainName}
        className={`atab main ${selectedId === 'main' ? 'on' : ''}`}
        title={cli ? `${mainName} · ${cli.label}` : mainName}
        onClick={() => void select(sessionId, 'main')}
      >
        <AgentAvatar name={cli?.label ?? mainName} avatar={cli ? `emoji:${cli.glyph}` : undefined} size={16} state={STATE[mainStatus] ?? null} label={t(`status.${mainStatus}`)} />
        <span className="atab-name">{mainName}</span>
      </button>
      <span className="atab-sep" aria-hidden>
        <Icon name="chevronRight" size={12} /> <span className="atab-sep-n">{t('agent.subagentsN', { n: total })}</span>
      </span>
      {tabs.map((tab) =>
        tab.kind === 'agent' ? (
          <button
            key={tab.node.id}
            role="tab"
            aria-selected={tab.node.id === selectedId}
            aria-label={nameOf(tab.node)}
            className={`atab ${tab.node.id === selectedId ? 'on' : ''}`}
            title={`${typeLabel(tab.node.type)} · ${tab.node.description}`}
            onClick={() => void select(sessionId, tab.node.id)}
          >
            <AgentAvatar name={nameOf(tab.node)} avatar={guessAvatar(tab.node.type, tab.node.description)} size={16} state={STATE[tab.node.status] ?? null} label={t(`status.${tab.node.status}`)} />
            <small className="atab-type">{typeLabel(tab.node.type)}</small>
            <span className="atab-name">{nameOf(tab.node)}</span>
          </button>
        ) : (
          <button key={`wave:${tab.type}`} className="atab wave" aria-haspopup="menu" title={t('agent.wave', { n: tab.nodes.length })} onClick={() => void pick(tab.nodes)}>
            <AgentAvatar name={typeLabel(tab.type)} avatar={guessAvatar(tab.type)} size={16} state={tab.nodes.some((n) => n.status === 'waiting') ? 'waiting' : tab.nodes.some((n) => n.status === 'running') ? 'working' : null} />
            <small className="atab-type">{typeLabel(tab.type)}</small>
            <span className="atab-name">×{tab.nodes.length}</span>
            <Icon name="chevronDown" size={12} />
          </button>
        ),
      )}
    </nav>
  );
}
