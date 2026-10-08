import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { ensureLanguage, languageFor, monaco, useTheme as applyEditorTheme } from '../editor/monaco';
import { attachVim, useEditorKeys } from '../editor/vim';
import { models, type OpenModel } from '../editor/models';
import { REVIEW_TAB, useStore, useT } from '../store';
import { sourceOf } from '../sources';
import { Preview, previewKind } from './Preview';
import { ReviewPanel } from './ReviewPanel';
import { confirmAction, contextMenu } from '../ui';
import { joinPath, relativePath, samePath } from '../paths';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
// Stable empty value: a fresh [] in a selector would re-render forever.
const NO_FILES: string[] = [];

export function EditorArea({ projectId }: { projectId: number }) {
  const t = useT();
  const files = useStore((s) => s.openFiles[projectId] ?? NO_FILES);
  const active = useStore((s) => s.activeFile[projectId] ?? null);
  const dirty = useStore((s) => s.dirty);
  const theme = useStore((s) => s.theme);
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const openFile = useStore((s) => s.openFile);
  const closeFile = useStore((s) => s.closeFile);
  const setDirty = useStore((s) => s.setDirty);
  const reviews = useStore((s) => (project ? s.reviews[project.cwd] : undefined));
  const loadReviews = useStore((s) => s.loadReviews);
  const openReview = useStore((s) => s.openReview);
  const select = useStore((s) => s.select);
  const setMode = useStore((s) => s.setMode);
  const catalog = useStore((s) => s.catalog);
  const isReview = !!active?.startsWith(REVIEW_TAB);
  const reveal = useStore((s) => s.reveal);
  const clearReveal = useStore((s) => s.clearReveal);
  const host = useRef<HTMLDivElement>(null);
  const diffHost = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffEditor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const activeRef = useRef(active);
  const [state, setState] = useState<{ kind: 'empty' | 'loading' | 'ready' | 'binary' | 'tooLarge'; size?: number }>({ kind: 'empty' });
  const [showDiff, setShowDiff] = useState(false);
  const capturePreview = useStore((s) => s.info?.capture?.preview ?? false);
  // Remembered across files and restarts: people who preview Markdown or HTML tend to keep it open.
  const [showPreview, setShowPreviewState] = useState(() => capturePreview || localStorage.getItem('alchemist.preview') === '1');
  const setShowPreview = (on: boolean) => {
    setShowPreviewState(on);
    localStorage.setItem('alchemist.preview', on ? '1' : '0');
  };
  const [liveText, setLiveText] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  activeRef.current = active;

  const save = async () => {
    const path = activeRef.current;
    const open = path ? models.get(path) : undefined;
    if (!path || !open) return;
    const value = open.model.getValue();
    await window.alchemist.writeFile(path, value);
    open.saved = value;
    setDirty(path, false);
    setSavedVersion((v) => v + 1);
    setFlash(t('editor.saved'));
    setTimeout(() => setFlash(null), 1200);
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const ed = monaco.editor.create(host.current!, {
      automaticLayout: true,
      fontFamily: "'SF Mono', ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 20,
      minimap: { enabled: true, scale: 1, renderCharacters: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      padding: { top: 10 },
      bracketPairColorization: { enabled: true },
      stickyScroll: { enabled: true },
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
    editor.current = ed;
    return () => {
      ed.dispose();
      diffEditor.current?.dispose();
      diffEditor.current = null;
    };
  }, []);

  useEffect(() => {
    if (theme) void applyEditorTheme(theme);
  }, [theme]);

  // Vim keys, when turned on in Settings: the mode shows in the line under the editor.
  const vim = useEditorKeys((k) => k.vim);
  const vimStatus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!vim || !editor.current || !vimStatus.current) return;
    let off: (() => void) | null = null;
    let gone = false;
    void attachVim(editor.current, vimStatus.current, () => void saveRef.current()).then((dispose) => (gone ? dispose() : (off = dispose)));
    return () => {
      gone = true;
      off?.();
    };
  }, [vim]);

  useEffect(() => {
    if (project) void loadReviews(project.cwd);
  }, [project?.cwd, loadReviews]);

  useEffect(() => {
    setShowDiff(false);
    if (!active || active.startsWith(REVIEW_TAB)) {
      editor.current?.setModel(null);
      setState({ kind: 'empty' });
      return;
    }
    let cancelled = false;
    void (async () => {
      let open = models.get(active);
      if (!open) {
        setState({ kind: 'loading' });
        const content = await window.alchemist.readFile(active).catch(() => null);
        if (cancelled) return;
        if (!content || content.binary || content.tooLarge || content.text == null) {
          setState({ kind: content?.tooLarge ? 'tooLarge' : 'binary', size: content?.size });
          editor.current?.setModel(null);
          return;
        }
        const lang = languageFor(active);
        await ensureLanguage(lang);
        const model = monaco.editor.getModel(monaco.Uri.file(active)) ?? monaco.editor.createModel(content.text, lang, monaco.Uri.file(active));
        const entry: OpenModel = { model, saved: content.text };
        model.onDidChangeContent(() => setDirty(active, model.getValue() !== entry.saved));
        models.set(active, entry);
        open = entry;
      }
      if (cancelled) return;
      editor.current?.setModel(open.model);
      setState({ kind: 'ready' });
    })();
    return () => {
      cancelled = true;
    };
  }, [active, setDirty]);

  useEffect(() => {
    if (!showDiff || !active || !project) return;
    const open = models.get(active);
    if (!open) return;
    let original: monaco.editor.ITextModel | null = null;
    void window.alchemist.gitHead(project.cwd, active).then((head) => {
      if (!diffHost.current) return;
      diffEditor.current ??= monaco.editor.createDiffEditor(diffHost.current, { automaticLayout: true, renderSideBySide: true, fontSize: 12.5, readOnly: false, originalEditable: false });
      original = monaco.editor.createModel(head ?? '', open.model.getLanguageId());
      diffEditor.current.setModel({ original, modified: open.model });
    });
    return () => {
      diffEditor.current?.setModel(null);
      original?.dispose();
    };
  }, [showDiff, active, project]);

  // Terminal links: scroll to the line once the file is showing.
  useEffect(() => {
    if (!reveal || reveal.path !== active || state.kind !== 'ready' || !editor.current) return;
    const ed = editor.current;
    ed.revealLineInCenter(reveal.line);
    ed.setPosition({ lineNumber: reveal.line, column: reveal.column });
    ed.focus();
    clearReveal();
  }, [reveal, active, state.kind, clearReveal]);

  const kind = previewKind(active);
  // Markdown previews follow the unsaved buffer as you type.
  useEffect(() => {
    if (!showPreview || kind !== 'markdown' || !active || state.kind !== 'ready') return setLiveText(null);
    const model = models.get(active)?.model;
    if (!model) return;
    setLiveText(model.getValue());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setLiveText(model.getValue()), 200);
    });
    return () => {
      clearTimeout(timer);
      sub.dispose();
    };
  }, [showPreview, kind, active, state.kind]);
  const imageOnly = state.kind === 'binary' && kind === 'image';

  /** Closes tabs, asking before throwing away unsaved edits. */
  const closeTabs = async (paths: string[]) => {
    const unsaved = paths.filter((p) => dirty[p]);
    if (unsaved.length) {
      const ok = await confirmAction({
        title: t('editor.discardTitle', { n: unsaved.length }),
        message: unsaved.map(fileName).join(', '),
        confirmLabel: t('editor.discard'),
        cancelLabel: t('dialog.cancel'),
        danger: true,
      });
      if (!ok) return;
      for (const p of unsaved) {
        const open = models.get(p);
        if (open) open.model.setValue(open.saved);
        setDirty(p, false);
      }
    }
    for (const p of paths) closeFile(projectId, p);
  };
  const closeTabSignal = useStore((s) => s.closeTabSignal);
  useEffect(() => {
    if (closeTabSignal && active) void closeTabs([active]);
  }, [closeTabSignal]);
  const tabMenu = (f: string) =>
    contextMenu(
      () => {
        const i = files.indexOf(f);
        const isFile = !f.startsWith(REVIEW_TAB);
        return [
          { id: 'close', label: t('editor.close') },
          { id: 'others', label: t('editor.closeOthers'), enabled: files.length > 1 },
          { id: 'right', label: t('editor.closeRight'), enabled: i < files.length - 1 },
          { id: 'saved', label: t('editor.closeSaved') },
          { id: 'all', label: t('editor.closeAll') },
          ...(isFile
            ? [
                { type: 'separator' as const },
                { id: 'copy-path', label: t('menu.copyPath') },
                ...(project && relativePath(f, project.cwd) ? [{ id: 'copy-rel', label: t('menu.copyRelative') }] : []),
                { id: 'reveal', label: t('menu.reveal') },
              ]
            : []),
        ];
      },
      (id) => {
        const i = files.indexOf(f);
        if (id === 'close') void closeTabs([f]);
        if (id === 'others') void closeTabs(files.filter((x) => x !== f));
        if (id === 'right') void closeTabs(files.slice(i + 1));
        if (id === 'saved') void closeTabs(files.filter((x) => !dirty[x]));
        if (id === 'all') void closeTabs(files);
        if (id === 'copy-path') void window.alchemist.copyText(f);
        if (id === 'copy-rel' && project) void window.alchemist.copyText(f.slice(project.cwd.length + 1));
        if (id === 'reveal') void window.alchemist.revealPath(f);
      },
    );
  const agentName = (id: string) => catalog?.harnesses.find((h) => h.id === id)?.label ?? sourceOf(id).label;
  const reviewOf = (tab: string) => reviews?.find((r) => r.id === tab.slice(REVIEW_TAB.length));
  // The newest run with unreviewed changes to the open file.
  const editedBy = active && !isReview ? reviews?.find((r) => r.files.some((f) => samePath(joinPath(r.root, f.path), active))) : undefined;

  return (
    <div className="editor-area">
      <div className="etabs">
        {files.map((f) => (
          <div
            key={f}
            className={`et ${f === active ? 'on' : ''} ${f.startsWith(REVIEW_TAB) ? 'review-tab' : ''}`}
            onClick={() => openFile(projectId, f)}
            onAuxClick={(e) => e.button === 1 && void closeTabs([f])}
            onContextMenu={tabMenu(f)}
            title={f.startsWith(REVIEW_TAB) ? reviewOf(f)?.title : f}
          >
            <span className="et-name">{f.startsWith(REVIEW_TAB) ? `✎ ${t('review.tab', { agent: agentName(reviewOf(f)?.harnessId ?? '') })}` : fileName(f)}</span>
            {/* Unsaved tabs show a dot that turns into × on hover, like VS Code. */}
            <button
              className={`et-close ${dirty[f] ? 'dirty' : ''}`}
              title={dirty[f] ? t('editor.unsaved') : t('editor.close')}
              onClick={(e) => {
                e.stopPropagation();
                void closeTabs([f]);
              }}
            >
              <span className="et-x"><Icon name="close" size={12} /></span>
              {dirty[f] && <span className="et-dot">●</span>}
            </button>
          </div>
        ))}
        <span className="et-sp" />
        {state.kind === 'ready' && kind && (
          <button className={`et-action ${showPreview ? 'on' : ''}`} onClick={() => setShowPreview(!showPreview)}>
            ◧ {t('preview.title')}
          </button>
        )}
        {state.kind === 'ready' && (
          <button className={`et-action ${showDiff ? 'on' : ''}`} onClick={() => setShowDiff(!showDiff)}>
            Δ {t('editor.changes')}
          </button>
        )}
        {flash && <span className="et-flash">{flash}</span>}
      </div>
      {active && !isReview && <div className="bc">{project ? (relativePath(active, project.cwd) || active).split(/[\\/]/).join(' › ') : active}</div>}
      {editedBy && (
        <div className="edited-by">
          ✎ {t('review.editedBy', { agent: agentName(editedBy.harnessId) })}
          <span className="edited-by-title">{editedBy.title}</span>
          <span className="composer-sp" />
          <button className="btn-ghost small" onClick={() => void openReview(editedBy.id)}>
            {t('review.open')}
          </button>
          {editedBy.sessionId && (
            <button
              className="btn-ghost small"
              onClick={() => {
                void select(editedBy.sessionId!, 'main');
                setMode('split');
              }}
            >
              <Icon name="goto" size={12} /> {t('review.conversation')}
            </button>
          )}
        </div>
      )}
      <div className="editor-split">
        <div className="editor-body">
          <div ref={host} className={`monaco-host ${vim ? 'with-vim' : ''}`} style={{ visibility: state.kind === 'ready' && !showDiff ? 'visible' : 'hidden' }} />
          {vim && <div ref={vimStatus} className="vim-status" style={{ visibility: state.kind === 'ready' && !showDiff ? 'visible' : 'hidden' }} />}
          <div ref={diffHost} className="monaco-host" style={{ visibility: showDiff ? 'visible' : 'hidden' }} />
          {imageOnly && active && (
            <div className="editor-msg">
              <Preview root={project?.cwd ?? null} path={active} />
            </div>
          )}
          {isReview && active && (
            <div className="editor-msg review-host">
              <ReviewPanel reviewId={active.slice(REVIEW_TAB.length)} />
            </div>
          )}
          {state.kind !== 'ready' && !imageOnly && !isReview && (
            <div className="panel-empty editor-msg">
              {state.kind === 'loading' ? <span className="spin" /> : state.kind === 'binary' ? t('editor.binary') : state.kind === 'tooLarge' ? t('editor.tooLarge', { size: `${Math.round((state.size ?? 0) / 1e6)} MB` }) : t('editor.empty')}
            </div>
          )}
        </div>
        {showPreview && kind && active && state.kind === 'ready' && (
          <div className="editor-preview">
            <Preview root={project?.cwd ?? null} path={active} text={kind === 'markdown' ? liveText : undefined} version={savedVersion} />
          </div>
        )}
      </div>
    </div>
  );
}
