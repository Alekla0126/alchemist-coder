import { useEffect, useRef, useState } from 'react';
import { Terminal, type IBufferLine, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { findLinks } from '../terminal-links';
import { terminalTheme } from '../theme';
import { useStore, useT } from '../store';
import { contextMenu, promptText } from '../ui';

interface Instance {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

// Terminals keep running (and keep their scrollback) while you switch modes or projects.
const instances = new Map<string, Instance>();
const pending = new Map<string, string[]>();
const autoStarted = new Set<number>();
// Stable empty value: a fresh [] in a selector would re-render forever.
const NO_TABS: never[] = [];
let listening = false;
const SHELL_KEY = 'alchemist.shell';
/** Answers about which printed paths are files, per project folder (misses expire: files appear). */
const linkCache = new Map<string, { path: string | null; at: number }>();
const MISS_TTL_MS = 5000;

async function resolvePaths(cwd: string, targets: string[]): Promise<Map<string, string | null>> {
  const now = Date.now();
  const out = new Map<string, string | null>();
  const ask: string[] = [];
  for (const t of new Set(targets)) {
    const hit = linkCache.get(`${cwd}\0${t}`);
    if (hit && (hit.path || now - hit.at < MISS_TTL_MS)) out.set(t, hit.path);
    else ask.push(t);
  }
  if (ask.length) {
    const found = await window.alchemist.terminalLinks(cwd, ask).catch(() => ask.map(() => null));
    ask.forEach((t, i) => {
      out.set(t, found[i] ?? null);
      linkCache.set(`${cwd}\0${t}`, { path: found[i] ?? null, at: now });
    });
  }
  return out;
}

/** The line's text plus, for each character, the terminal column it sits in (wide characters take two). */
function lineText(line: IBufferLine, cols: number): { text: string; col: number[] } {
  let text = '';
  const col: number[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' ';
    for (let i = 0; i < chars.length; i++) col.push(x);
    text += chars;
  }
  return { text, col };
}

const openLink = (event: MouseEvent) => event.metaKey || event.ctrlKey;

/**
 * Makes URLs and file paths in the output clickable (⌘/Ctrl+click): files open in the editor at the
 * printed line; only files inside your projects become links.
 */
function addLinks(term: Terminal, el: HTMLElement, projectId: number, cwd: string, hint: string) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      const { text, col } = lineText(line, term.cols);
      const found = findLinks(text);
      if (!found.length) return callback(undefined);
      const files = found.filter((l) => l.kind === 'file').map((l) => l.target);
      void resolvePaths(cwd, files).then((paths) => {
        const links: ILink[] = [];
        for (const l of found) {
          const path = l.kind === 'file' ? paths.get(l.target) : null;
          if (l.kind === 'file' && !path) continue;
          links.push({
            range: { start: { x: col[l.start]! + 1, y }, end: { x: col[l.end - 1]! + 1, y } },
            text: text.slice(l.start, l.end),
            decorations: { pointerCursor: true, underline: true },
            hover: () => (el.title = hint),
            leave: () => el.removeAttribute('title'),
            activate: (event) => {
              if (!openLink(event)) return;
              if (l.kind === 'url') window.open(l.target, '_blank');
              else useStore.getState().openFileAt(projectId, path!, l.line, l.column);
            },
          });
        }
        callback(links.length ? links : undefined);
      });
    },
  });
}

function listen() {
  if (listening) return;
  listening = true;
  window.alchemist.onTerminalData(({ id, data }) => {
    const inst = instances.get(id);
    if (inst) inst.term.write(data);
    else pending.set(id, [...(pending.get(id) ?? []), data]);
  });
  window.alchemist.onTerminalExit(({ id }) => {
    instances.get(id)?.term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
    useStore.getState().markTerminalExited(id);
  });
}

/** One xterm view. Instances outlive the pane, so their element just moves between panes. */
function TermPane({ id, split, projectId, cwd, onClose }: { id: string; split: boolean; projectId: number; cwd: string; onClose?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useStore((s) => s.theme);
  const t = useT();
  useEffect(() => {
    const host = box.current;
    if (!host) return;
    let inst = instances.get(id);
    if (!inst) {
      const el = document.createElement('div');
      el.className = 'xterm-host';
      const term = new Terminal({
        // Nerd Fonts first so powerline / oh-my-zsh prompts render their icons.
        fontFamily: "'MesloLGS NF', 'MesloLGS Nerd Font', 'JetBrainsMono Nerd Font', 'Hack Nerd Font', 'FiraCode Nerd Font', 'SF Mono', ui-monospace, Menlo, monospace",
        fontSize: 12.5,
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 5000,
        theme: theme ? terminalTheme(theme) : undefined,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      host.appendChild(el);
      term.open(el);
      addLinks(term, el, projectId, cwd, t('term.linkHint'));
      term.onData((d) => window.alchemist.writeTerminal(id, d));
      term.onResize(({ cols, rows }) => window.alchemist.resizeTerminal(id, cols, rows));
      inst = { term, fit, el };
      instances.set(id, inst);
      for (const chunk of pending.get(id) ?? []) term.write(chunk);
      pending.delete(id);
    } else {
      host.appendChild(inst.el);
    }
    const current = inst;
    const refit = () => {
      try {
        current.fit.fit();
      } catch {
        // not visible yet
      }
    };
    requestAnimationFrame(() => {
      refit();
      if (!split) current.term.focus();
    });
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    return () => {
      ro.disconnect();
      if (current.el.parentElement === host) host.removeChild(current.el);
    };
  }, [id]);
  return (
    <div className={`term-pane${split ? ' right' : ''}`} onMouseDown={() => requestAnimationFrame(() => instances.get(id)?.term.focus())}>
      {onClose && (
        <button className="term-pane-close" onClick={onClose} title="×">
          ×
        </button>
      )}
      <div className="term-box" ref={box} />
    </div>
  );
}

export function TerminalPanel({ projectId }: { projectId: number }) {
  const t = useT();
  const tabs = useStore((s) => s.terminals[projectId] ?? NO_TABS);
  const active = useStore((s) => s.activeTerminal[projectId] ?? null);
  const split = useStore((s) => s.splitTerminal[projectId] ?? null);
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const theme = useStore((s) => s.theme);
  const addTerminal = useStore((s) => s.addTerminal);
  const setActive = useStore((s) => s.setActiveTerminal);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const [error, setError] = useState<string | null>(null);
  const [shells, setShells] = useState<Array<{ path: string; label: string }>>([]);
  const [menu, setMenu] = useState(false);
  const renameTerminal = useStore((s) => s.renameTerminal);
  const setSplit = useStore((s) => s.setSplitTerminal);
  const tabMenu = (tab: { id: string; title: string }) =>
    contextMenu(
      () => [
        { id: 'rename', label: t('term.rename') },
        // Both panes can't show the same terminal: the active one can't move right.
        { id: 'split', label: tab.id === split ? t('term.unsplit') : t('term.splitRight'), enabled: tab.id === split || tab.id !== active },
        { type: 'separator' },
        { id: 'clear', label: t('term.clear') },
        { id: 'copy', label: t('term.copyAll') },
        { type: 'separator' },
        { id: 'close', label: t('term.close') },
      ],
      (id) => {
        const inst = instances.get(tab.id);
        if (id === 'rename')
          void promptText({ title: t('term.rename'), value: tab.title, confirmLabel: t('menu.renameOk'), cancelLabel: t('dialog.cancel') }).then((v) => v && renameTerminal(projectId, tab.id, v));
        if (id === 'split') setSplit(projectId, tab.id === split ? null : tab.id);
        if (id === 'clear') inst?.term.clear();
        if (id === 'copy' && inst) {
          inst.term.selectAll();
          void window.alchemist.copyText(inst.term.getSelection());
          inst.term.clearSelection();
        }
        if (id === 'close') closeTerminal(projectId, tab.id);
      },
    );
  const shownProject = useRef(projectId);
  shownProject.current = projectId;

  const create = async (command?: string, asSplit = false, shell = localStorage.getItem(SHELL_KEY) ?? undefined) => {
    if (!project) return;
    try {
      const { id, shell: used } = await window.alchemist.createTerminal(project.cwd, 100, 28, shell);
      setError(null);
      addTerminal(projectId, { id, title: command ?? used, exited: false }, asSplit);
      if (command) setTimeout(() => window.alchemist.writeTerminal(id, `${command}\r`), 450);
    } catch (e) {
      // A late failure from the project you just left isn't about this one.
      if (shownProject.current === projectId) setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    }
  };

  useEffect(() => {
    void window.alchemist.terminalShells().then(setShells).catch(() => {});
  }, []);

  useEffect(() => {
    // Each project has its own terminals: a problem with one project's folder stays with it.
    setError(null);
    listen();
    void window.alchemist.terminalAvailable().then((a) => {
      if (!a.ok) setError(t('term.unavailable', { error: a.error ?? '' }));
      else if (!autoStarted.has(projectId) && (useStore.getState().terminals[projectId] ?? []).length === 0) {
        autoStarted.add(projectId);
        void create().then(() => (useStore.getState().info?.capture?.terminalSplit ? create(undefined, true) : undefined));
      }
    });
  }, [projectId]);

  useEffect(() => {
    if (!theme) return;
    for (const inst of instances.values()) inst.term.options.theme = terminalTheme(theme);
  }, [theme]);

  return (
    <div className="terminal-panel">
      <div className="ttabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tt2 ${tab.id === active ? 'on' : ''} ${tab.id === split ? 'right-tab' : ''} ${tab.exited ? 'exited' : ''}`}
            onClick={() => setActive(projectId, tab.id)}
            onContextMenu={tabMenu(tab)}
            onAuxClick={(e) => e.button === 1 && closeTerminal(projectId, tab.id)}
          >
            {tab.id === split && <span className="split-mark">◨ </span>}
            {tab.title}
            {tab.exited && <small> · {t('term.exited')}</small>}
            <button
              className="et-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTerminal(projectId, tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="icon-btn" title={t('term.new')} onClick={() => void create()}>
          ＋
        </button>
        {shells.length > 1 && (
          <span className="shell-menu">
            <button className="icon-btn" title={t('term.shell')} onClick={() => setMenu(!menu)}>
              ▾
            </button>
            {menu && (
              <div className="shell-list" onMouseLeave={() => setMenu(false)}>
                {shells.map((sh) => (
                  <button
                    key={sh.path}
                    className={(localStorage.getItem(SHELL_KEY) ?? shells[0]!.path) === sh.path ? 'on' : ''}
                    onClick={() => {
                      localStorage.setItem(SHELL_KEY, sh.path);
                      setMenu(false);
                      void create(undefined, false, sh.path);
                    }}
                  >
                    {sh.label}
                    <small>{sh.path}</small>
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        <button className="icon-btn" title={t('term.split')} disabled={!active || !!split} onClick={() => void create(undefined, true)}>
          ◨
        </button>
        <span className="et-sp" />
        <button className="term-cmd" title={t('term.hint')} onClick={() => void create('claude')}>
          ▶ {t('term.runClaude')}
        </button>
        <button className="term-cmd" title={t('term.hint')} onClick={() => void create('codex')}>
          ▶ {t('term.runCodex')}
        </button>
      </div>
      {error ? (
        <div className="panel-empty">{error}</div>
      ) : (
        <div className="term-panes">
          {active && project && <TermPane key={`a-${active}`} id={active} split={false} projectId={projectId} cwd={project.cwd} />}
          {split && project && <TermPane key={`s-${split}`} id={split} split projectId={projectId} cwd={project.cwd} onClose={() => closeTerminal(projectId, split)} />}
        </div>
      )}
    </div>
  );
}
