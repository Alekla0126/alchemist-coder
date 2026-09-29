import { lazy, Suspense, useEffect } from 'react';
import { AgentPanel } from './components/AgentPanel';
import { ArenaList, ArenaView } from './components/Arena';
import { OrgSidebar, OrgView } from './components/Org';
import { HistoryView } from './components/HistoryView';
import { ProjectPicker } from './components/ProjectPicker';
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
import { useLayout } from './layout';

export function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const info = useStore((s) => s.info);
  const mode = useStore((s) => s.settings.mode);
  const pickerOpen = useStore((s) => s.pickerOpen);
  const indexReady = useStore((s) => s.progress.phase === 'ready');
  const captureReady = useStore((s) => s.captureReady);
  const locale = useStore((s) => s.locale);
  const anyRunning = useStore((s) => s.projects.some((p) => p.runningAgents > 0));
  const refreshProjects = useStore((s) => s.refreshProjects);
  const activeId = useStore((s) => s.settings.activeProjectId);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const sideHidden = useLayout((l) => l.sideHidden);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // "Running" ages out after a quiet period, so poll while something runs.
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void refreshProjects(), 15_000);
    return () => clearInterval(timer);
  }, [anyRunning, refreshProjects]);

  useEffect(() => {
    if (!info?.capture || !ready || !indexReady) return;
    if ((info.capture.select || info.capture.compose || info.capture.openFile || info.capture.arena || info.capture.themeSearch || info.capture.usage || info.capture.team) && !captureReady) return;
    window.alchemist.rendered();
  }, [info, ready, indexReady, captureReady]);

  return (
    <div className={`app platform-${info?.platform ?? 'darwin'}`}>
      <TitleBar />
      <div className={`body mode-${mode} ${sideHidden ? 'side-hidden' : ''}`}>
        <ProjectRail />
        {mode === 'history' ? (
          <HistoryView />
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
                <div className="split">
                  <div className="split-main">
                    <PanelBoundary label="Editor">
                      <EditorArea projectId={activeId} />
                    </PanelBoundary>
                    <Resizer panel="splitTerm" edge="bottom" />
                    <PanelBoundary label="Terminal">
                      <TerminalPanel projectId={activeId} />
                    </PanelBoundary>
                  </div>
                  <Resizer panel="splitSide" edge="right" />
                  <div className="split-side">
                    <AgentPanel />
                  </div>
                </div>
              )}
              </Suspense>
            </main>
          </>
        )}
      </div>
      <StatusBar />
      {pickerOpen && <ProjectPicker />}
      {settingsOpen && <Settings />}
      {paletteOpen && <CommandPalette />}
      <Overlays />
    </div>
  );
}
