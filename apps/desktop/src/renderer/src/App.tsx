import { whileVisible } from './ui';
import { lazy, Suspense, useEffect } from 'react';
import { AgentPanel } from './components/AgentPanel';
import { ArenaList, ArenaView } from './components/Arena';
import { OrgSidebar, OrgView } from './components/Org';
import { MarketingView } from './components/Marketing';
import { HistoryView } from './components/HistoryView';
import { ProjectPicker } from './components/ProjectPicker';
import { NewProjectDialog } from './components/NewProject';
import { ProjectRail } from './components/ProjectRail';
import { Sidebar } from './components/Sidebar';
// Monaco and xterm are large: load them only when a mode needs them.
const EditorArea = lazy(() => import('./components/EditorArea').then((m) => ({ default: m.EditorArea })));
const TerminalPanel = lazy(() => import('./components/TerminalPanel').then((m) => ({ default: m.TerminalPanel })));
import { StatusBar } from './components/StatusBar';
import { Overlays } from './components/Overlays';
import { Settings } from './components/Settings';
import { CommandPalette } from './components/CommandPalette';
import { TitleBar } from './components/TitleBar';
import { useStore } from './store';
import { PanelBoundary } from './components/PanelBoundary';
import { Resizer } from './components/Resizer';
import { closeDrawer, toggleSidebar, useLayout, useViewport } from './layout';
import { WITH_SIDEBAR } from './components/TitleBar';
import { useT } from './store';
import { BoardView } from './components/Board';

export function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const info = useStore((s) => s.info);
  const mode = useStore((s) => s.settings.mode);
  const pickerOpen = useStore((s) => s.pickerOpen);
  const newProjectOpen = useStore((s) => s.newProjectOpen);
  const indexReady = useStore((s) => s.progress.phase === 'ready');
  const captureReady = useStore((s) => s.captureReady);
  const locale = useStore((s) => s.locale);
  const anyRunning = useStore((s) => s.projects.some((p) => p.runningAgents > 0));
  const refreshProjects = useStore((s) => s.refreshProjects);
  const activeId = useStore((s) => s.settings.activeProjectId);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const t = useT();
  const sideHiddenPref = useLayout((l) => l.sideHidden);
  const splitSideHidden = useLayout((l) => l.splitSideHidden);
  const narrow = useViewport((v) => v.narrow);
  const drawer = useViewport((v) => v.drawer);
  // A narrow window has no sidebar column: the sidebar floats over the page while it's open.
  const sideHidden = narrow || sideHiddenPref;
  const selectionKey = useStore((s) => `${s.selection?.sessionId ?? ''}|${s.composeProjectId ?? ''}`);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // --drawer (screenshots): the floating sidebar, open.
  useEffect(() => {
    if (!info?.capture?.drawer || !ready) return;
    const id = setTimeout(() => useViewport.setState({ drawer: true }), 1500);
    return () => clearTimeout(id);
  }, [info, ready]);

  // The floating sidebar takes the focus while open; Escape puts it away and gives the focus back.
  useEffect(() => {
    if (!narrow || !drawer) return;
    const back = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.body.narrow > aside.side button, .body.narrow > aside.side input')?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      (back?.isConnected ? back : document.querySelector<HTMLElement>('.side-toggle'))?.focus();
    };
  }, [narrow, drawer]);

  // Picking a conversation (or another mode) in the floating sidebar puts it away.
  useEffect(() => {
    closeDrawer();
  }, [selectionKey, mode]);

  // "Running" ages out after a quiet period, so poll while something runs.
  useEffect(() => {
    if (!anyRunning) return;
    return whileVisible(() => void refreshProjects(), 15_000);
  }, [anyRunning, refreshProjects]);

  useEffect(() => {
    if (!info?.capture || !ready || !indexReady) return;
    if ((info.capture.select || info.capture.compose || info.capture.project || info.capture.openFile || info.capture.settings || info.capture.arena || info.capture.themeSearch || info.capture.usage || info.capture.team || info.capture.orgGoal || info.capture.mode === 'marketing' || info.capture.mode === 'board') && !captureReady) return;
    window.alchemist.rendered();
  }, [info, ready, indexReady, captureReady]);

  return (
    <div className={`app platform-${info?.platform ?? 'darwin'}`}>
      <TitleBar />
      <div className={`body mode-${mode} ${narrow ? 'narrow' : sideHidden ? 'side-hidden' : ''} ${narrow && drawer ? 'drawer-open' : ''}`}>
        <ProjectRail />
        {narrow && drawer && <div className="drawer-scrim" onClick={closeDrawer} aria-hidden />}
        {/* A folded sidebar leaves a thin edge: click it to bring the sidebar back. */}
        {!narrow && sideHiddenPref && WITH_SIDEBAR.has(mode) && <button className="side-edge" onClick={toggleSidebar} title={t('layout.showSidebar')} aria-label={t('layout.showSidebar')} />}
        {mode === 'history' ? (
          <HistoryView />
        ) : mode === 'board' ? (
          <main className="center center-board">
            <PanelBoundary label="Board">
              <BoardView />
            </PanelBoundary>
          </main>
        ) : mode === 'marketing' ? (
          <main className="center center-marketing">
            <PanelBoundary label="Marketing">
              <MarketingView />
            </PanelBoundary>
          </main>
        ) : mode === 'bots' ? (
          <>
            <OrgSidebar />
            <main className="center center-bots">
              <PanelBoundary label="Organization">
                <OrgView />
              </PanelBoundary>
            </main>
          </>
        ) : mode === 'arena' ? (
          <>
            <ArenaList />
            {!sideHidden && <Resizer panel="side" edge="left" />}
            <main className="center center-arena">
              <PanelBoundary label="Arena">
                <ArenaView />
              </PanelBoundary>
            </main>
          </>
        ) : (
          <>
            <Sidebar />
            {!sideHidden && <Resizer panel="side" edge="left" />}
            <main className={`center center-${mode}`}>
              <Suspense fallback={<div className="panel-empty"><span className="spin" /></div>}>
              {mode === 'agents' && <AgentPanel />}
              {mode === 'code' && activeId != null && (
                <PanelBoundary label="Editor">
                  <EditorArea projectId={activeId} />
                </PanelBoundary>
              )}
              {mode === 'terminal' && activeId != null && (
                <PanelBoundary label="Terminal">
                  <TerminalPanel projectId={activeId} />
                </PanelBoundary>
              )}
              {mode === 'split' && activeId != null && (
                <div className={`split ${splitSideHidden ? 'side-off' : ''}`}>
                  <div className="split-main">
                    <PanelBoundary label="Editor">
                      <EditorArea projectId={activeId} />
                    </PanelBoundary>
                    <Resizer panel="splitTerm" edge="bottom" />
                    <PanelBoundary label="Terminal">
                      <TerminalPanel projectId={activeId} />
                    </PanelBoundary>
                  </div>
                  {!splitSideHidden && (
                    <>
                      <Resizer panel="splitSide" edge="right" />
                      <div className="split-side">
                        <AgentPanel />
                      </div>
                    </>
                  )}
                </div>
              )}
              </Suspense>
            </main>
          </>
        )}
      </div>
      <StatusBar />
      {pickerOpen && <ProjectPicker />}
      {newProjectOpen && <NewProjectDialog />}
      {settingsOpen && <Settings />}
      {paletteOpen && <CommandPalette />}
      <Overlays />
    </div>
  );
}
