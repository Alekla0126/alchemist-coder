import { showNewMenu } from './NewProject';
import { keys } from '../keys';
import type { ProjectSummary } from '@alchemist-coder/core';
import { initials, projectGradient } from '../format';
import { useStore, useT, waitingProjectIds } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { toggleSidebar, useLayout } from '../layout';
import { contextMenu, toast } from '../ui';

export function ProjectRail() {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const openIds = useStore((s) => s.settings.openProjectIds);
  const activeId = useStore((s) => s.settings.activeProjectId);
  const sideHidden = useLayout((l) => l.sideHidden);
  const waitingProjects = useStore(useShallow((s) => waitingProjectIds(s)));
  const setActive = useStore((s) => s.setActiveProject);
  const close = useStore((s) => s.closeProject);
  const setPickerOpen = useStore((s) => s.setPickerOpen);
  const setCompose = useStore((s) => s.setCompose);
  const setMode = useStore((s) => s.setMode);
  const setSidebarTab = useStore((s) => s.setSidebarTab);
  const open = openIds.map((id) => projects.find((p) => p.id === id)).filter((p) => p != null);

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
        { id: 'close', label: t('projects.close') },
        { id: 'close-others', label: t('menu.closeOthers'), enabled: open.length > 1 },
      ],
      (id) => {
        const go = async () => {
          if (id === 'close') return close(p.id);
          if (id === 'close-others') return open.filter((o) => o.id !== p.id).forEach((o) => close(o.id));
          if (id === 'copy-path') return window.alchemist.copyText(p.cwd);
          if (id === 'reveal') return window.alchemist.revealPath(p.cwd);
          await setActive(p.id);
          if (id === 'new') setCompose(p.id);
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
    <nav className="rail" aria-label="Projects">
      {open.map((p) => (
        <div key={p.id} className="rail-item">
          <button
            className={`proj ${p.id === activeId ? 'on' : ''}`}
            style={{ background: projectGradient(p.name) }}
            title={`${p.name}\n${p.cwd}`}
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
      <span className="rail-sp" />
      <button className="rail-gear rail-side" title={`${t('shortcut.sidebar')} (${keys('⌘B')})`} aria-label={t('shortcut.sidebar')} aria-pressed={!sideHidden} onClick={toggleSidebar}>
        <span className={`panel-ic ${sideHidden ? 'off' : ''}`} aria-hidden />
      </button>
      <button className="rail-gear" title={`${t('settings.title')} (${keys('⌘,')})`} onClick={() => useStore.setState({ settingsOpen: true })}>
        ⚙
      </button>
    </nav>
  );
}
