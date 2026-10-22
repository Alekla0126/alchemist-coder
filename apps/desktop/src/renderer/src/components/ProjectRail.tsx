import { useState } from 'react';
import { showNewMenu } from './NewProject';
import { keys } from '../keys';
import type { ProjectSummary } from '@alchemist-coder/core';
import { initials, projectGradient } from '../format';
import { useStore, useT, waitingProjectIds } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { contextMenu, toast } from '../ui';
import { RailUsage } from './UsageMeter';
import { dropOn, dropsAfter, nudge } from '../reorder';

/** What a dragged project carries (only the rail accepts it). */
const PROJECT_DRAG = 'application/x-alchemist-project';

export function ProjectRail() {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const openIds = useStore((s) => s.settings.openProjectIds);
  const activeId = useStore((s) => s.settings.activeProjectId);
  const waitingProjects = useStore(useShallow((s) => waitingProjectIds(s)));
  const setActive = useStore((s) => s.setActiveProject);
  const close = useStore((s) => s.closeProject);
  const setPickerOpen = useStore((s) => s.setPickerOpen);
  const newConversation = useStore((s) => s.newConversation);
  const setMode = useStore((s) => s.setMode);
  const setSidebarTab = useStore((s) => s.setSidebarTab);
  const setProjectOrder = useStore((s) => s.setProjectOrder);
  const open = openIds.map((id) => projects.find((p) => p.id === id)).filter((p) => p != null);
  const order = open.map((p) => p.id);
  // Dragging a logo: which one, and where it would land (just before or after another).
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<{ id: number; after: boolean } | null>(null);
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };

  const menu = (p: ProjectSummary) =>
    contextMenu(
      () => [
        { id: 'new', label: t('menu.newConversation') },
        { id: 'agents', label: t('menu.openIn', { where: t('mode.agents') }) },
        { id: 'files', label: t('menu.openIn', { where: t('side.files') }) },
        { id: 'terminal', label: t('menu.openIn', { where: t('mode.terminal') }) },
        { type: 'separator' },
        { id: 'reveal', label: t('menu.reveal') },
        { id: 'copy-path', label: t('menu.copyPath') },
        { type: 'separator' },
        { id: 'move-up', label: t('menu.moveUp'), enabled: order.indexOf(p.id) > 0 },
        { id: 'move-down', label: t('menu.moveDown'), enabled: order.indexOf(p.id) < order.length - 1 },
        { type: 'separator' },
        { id: 'close', label: t('projects.close') },
        { id: 'close-others', label: t('menu.closeOthers'), enabled: open.length > 1 },
      ],
      (id) => {
        const go = async () => {
          if (id === 'move-up' || id === 'move-down') return setProjectOrder(nudge(order, p.id, id === 'move-up' ? -1 : 1));
          if (id === 'close') return close(p.id);
          if (id === 'close-others') return open.filter((o) => o.id !== p.id).forEach((o) => close(o.id));
          if (id === 'copy-path') return window.alchemist.copyText(p.cwd);
          if (id === 'reveal') return window.alchemist.revealPath(p.cwd);
          await setActive(p.id);
          if (id === 'new') newConversation(p.id);
          if (id === 'agents') setMode('agents');
          if (id === 'files') {
            setMode('code');
            setSidebarTab('files');
          }
          if (id === 'terminal') setMode('terminal');
        };
        void Promise.resolve(go()).catch((e: unknown) => toast(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)));
      },
    );

  return (
    <nav
      className="rail"
      aria-label="Projects"
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
      }}
    >
      {open.map((p) => (
        <div
          key={p.id}
          className={`rail-item ${dragging === p.id ? 'dragging' : ''} ${over?.id === p.id && dragging !== p.id ? (over.after ? 'drop-after' : 'drop-before') : ''}`}
          data-project-id={p.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(PROJECT_DRAG, String(p.id));
            e.dataTransfer.effectAllowed = 'move';
            setDragging(p.id);
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(PROJECT_DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const after = dropsAfter(e.clientY, e.currentTarget.getBoundingClientRect());
            if (over?.id !== p.id || over.after !== after) setOver({ id: p.id, after });
          }}
          onDrop={(e) => {
            const from = Number(e.dataTransfer.getData(PROJECT_DRAG));
            if (!from) return;
            e.preventDefault();
            setProjectOrder(dropOn(order, from, p.id, dropsAfter(e.clientY, e.currentTarget.getBoundingClientRect())));
            endDrag();
          }}
          onDragEnd={endDrag}
        >
          <button
            className={`proj ${p.id === activeId ? 'on' : ''}`}
            style={{ background: projectGradient(p.name) }}
            title={`${p.name}\n${p.cwd}\n${t('rail.dragToReorder')}`}
            onClick={() => void setActive(p.id)}
            onContextMenu={menu(p)}
          >
            {initials(p.name)}
            {waitingProjects.includes(p.id) ? (
              <span className="badge waiting" title={t('attention.waiting')}>
                !
              </span>
            ) : (
              p.runningAgents > 0 && <span className="badge">{p.runningAgents}</span>
            )}
          </button>
          <button className="proj-close" title={t('projects.close')} onClick={() => close(p.id)}>
            ×
          </button>
        </div>
      ))}
      <button className="proj add" title={t('plus.tip')} aria-label={t('plus.tip')} aria-haspopup="menu" onClick={() => void showNewMenu(t)}>
        +
      </button>
      {/* Always in sight, however many projects are open. */}
      <div className="rail-foot">
        <RailUsage />
        <button className="rail-gear" title={`${t('settings.title')} (${keys('⌘,')})`} onClick={() => useStore.setState({ settingsOpen: true })}>
          ⚙
        </button>
      </div>
    </nav>
  );
}
