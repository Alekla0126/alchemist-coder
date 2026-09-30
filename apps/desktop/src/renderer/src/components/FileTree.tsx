import { useCallback, useEffect, useState } from 'react';
import { Caret } from './Icon';
import type { DirEntry, GitChange, MenuItem } from '@shared/api';
import type { ProjectSummary } from '@alchemist-coder/core';
import { translate, type MessageKey } from '../i18n';
import { useStore, useT } from '../store';
import { CommitDialog } from './CommitDialog';
import { confirmAction, openMenu, promptText, toast } from '../ui';
import { baseName, parentOf, relativePath, tailOf } from '../paths';

const STATUS_CLASS: Record<string, string> = { M: 'mod', A: 'add', '?': 'new', '??': 'new', D: 'del', R: 'mod', AM: 'add', MM: 'mod' };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Right-click on a file or folder of the project (or its root). */
async function entryMenu(project: ProjectSummary, entry: { path: string; dir: boolean; root?: boolean }, refresh: () => void) {
  const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(useStore.getState().locale, key, vars);
  const s = useStore.getState();
  const rel = entry.path === project.cwd ? '.' : entry.path.slice(project.cwd.length + 1);
  const items: MenuItem[] = [
    ...(entry.dir ? [{ id: 'new-file', label: t('files.newFile') }, { id: 'new-folder', label: t('files.newFolder') }, { type: 'separator' as const }] : [{ id: 'open', label: t('menu.open') }, { type: 'separator' as const }]),
    ...(entry.root ? [] : [{ id: 'rename', label: t('menu.renameEntry') }]),
    { id: 'copy-path', label: t('menu.copyPath') },
    { id: 'copy-rel', label: t('menu.copyRelative') },
    { id: 'reveal', label: t('menu.reveal') },
    { id: 'terminal', label: t('files.terminalHere') },
    ...(entry.root ? [{ type: 'separator' as const }, { id: 'refresh', label: t('files.refresh') }] : [{ type: 'separator' as const }, { id: 'trash', label: t('menu.trash') }]),
  ];
  const id = await openMenu(items);
  if (!id) return;
  const folder = entry.dir ? entry.path : parentOf(entry.path);
  try {
    switch (id) {
      case 'open':
        return s.openFile(project.id, entry.path);
      case 'new-file':
      case 'new-folder': {
        const kind = id === 'new-file' ? 'file' : 'folder';
        const name = await promptText({ title: t(kind === 'file' ? 'files.newFile' : 'files.newFolder'), placeholder: kind === 'file' ? 'notes.md' : 'src', confirmLabel: t('files.create'), cancelLabel: t('dialog.cancel') });
        if (!name) return;
        const created = await window.alchemist.createEntry(folder, name, kind);
        refresh();
        if (kind === 'file') s.openFile(project.id, created);
        return;
      }
      case 'rename': {
        const name = await promptText({ title: t('menu.renameEntry'), value: baseName(entry.path), confirmLabel: t('menu.renameOk'), cancelLabel: t('dialog.cancel') });
        if (!name || name === baseName(entry.path)) return;
        const to = await window.alchemist.renameEntry(entry.path, name);
        // Keep an open tab pointing at the file under its new name.
        if (!entry.dir && (s.openFiles[project.id] ?? []).includes(entry.path)) {
          s.closeFile(project.id, entry.path);
          s.openFile(project.id, to);
        }
        return refresh();
      }
      case 'copy-path':
        return window.alchemist.copyText(entry.path);
      case 'copy-rel':
        return window.alchemist.copyText(rel);
      case 'reveal':
        return window.alchemist.revealPath(entry.path);
      case 'terminal':
        return s.openTerminalWith(project.id, '', undefined, folder);
      case 'refresh':
        return refresh();
      case 'trash': {
        if (!entry.dir && s.dirty[entry.path]) return toast(t('review.dirty'));
        const ok = await confirmAction({ title: t('files.trashTitle', { name: baseName(entry.path) }), message: t('files.trashBody'), confirmLabel: t('menu.trashOk'), cancelLabel: t('dialog.cancel'), danger: true });
        if (!ok) return;
        await window.alchemist.trashEntry(entry.path);
        if ((s.openFiles[project.id] ?? []).includes(entry.path)) s.closeFile(project.id, entry.path);
        return refresh();
      }
    }
  } catch (e) {
    toast(errorText(e));
  }
}

interface TreeProps {
  project: ProjectSummary;
  changes: Map<string, string>;
  onOpen: (p: string) => void;
  refresh: () => void;
  /** Bumped by refresh: open folders reload their listing without closing. */
  version: number;
}

/** Folders you opened stay open across refreshes and mode switches. */
const openDirs = new Set<string>();

function Dir({ entry, depth, ...props }: TreeProps & { entry: DirEntry; depth: number }) {
  const { project, changes, onOpen, refresh, version } = props;
  const [open, setOpenState] = useState(depth === 0 || openDirs.has(entry.path));
  const setOpen = (v: boolean) => {
    if (v) openDirs.add(entry.path);
    else openDirs.delete(entry.path);
    setOpenState(v);
  };
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  useEffect(() => {
    if (open) void window.alchemist.listDir(entry.path).then(setChildren).catch(() => setChildren([]));
  }, [open, entry.path, version]);
  const dirty = [...changes.keys()].some((p) => !!relativePath(p, entry.path));
  return (
    <>
      {depth > 0 && (
        <div
          className={`row file dir ${entry.heavy ? 'heavy' : ''}`}
          style={{ paddingLeft: 6 + (depth - 1) * 12 }}
          onClick={() => setOpen(!open)}
          onContextMenu={(e) => {
            e.preventDefault();
            void entryMenu(project, { path: entry.path, dir: true }, refresh);
          }}
        >
          <span className="car"><Caret open={open} /></span>
          <span className="tt">{entry.name}</span>
          {dirty && <span className="r git-dot" />}
        </div>
      )}
      {open &&
        children?.map((c) =>
          c.dir ? (
            <Dir key={c.path} entry={c} depth={depth + 1} {...props} />
          ) : (
            <div
              key={c.path}
              className="row file"
              // Same indent as a folder's name at this depth: past where its caret would be.
              style={{ paddingLeft: 6 + depth * 12 + 20 }}
              title={c.path}
              onClick={() => onOpen(c.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                void entryMenu(project, { path: c.path, dir: false }, refresh);
              }}
            >
              <span className={`tt ${STATUS_CLASS[changes.get(c.path) ?? ''] ?? ''}`}>{c.name}</span>
              {changes.get(c.path) && <span className={`r git ${STATUS_CLASS[changes.get(c.path)!] ?? ''}`}>{changes.get(c.path)}</span>}
            </div>
          ),
        )}
    </>
  );
}

export function FileTree() {
  const t = useT();
  const project = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId));
  const openFile = useStore((s) => s.openFile);
  const [changes, setChanges] = useState<Map<string, string>>(new Map());
  const [version, setVersion] = useState(0);
  const [committing, setCommitting] = useState(false);
  const refresh = useCallback(() => {
    if (!project) return;
    void window.alchemist.gitStatus(project.cwd).then((list: GitChange[]) => setChanges(new Map(list.map((c) => [c.path, c.status]))));
    setVersion((v) => v + 1);
  }, [project]);
  useEffect(refresh, [refresh]);
  if (!project) return <p className="empty">{t('files.empty')}</p>;
  const rootMenu = () => void entryMenu(project, { path: project.cwd, dir: true, root: true }, refresh);
  return (
    <div className="tree files">
      <div
        className="files-head"
        onContextMenu={(e) => {
          e.preventDefault();
          rootMenu();
        }}
      >
        <span className="tt" title={project.cwd}>
          {tailOf(project.cwd, 2)}
        </span>
        <button className="icon-btn" onClick={rootMenu} title={t('files.new')}>
          ＋
        </button>
        {changes.size > 0 && (
          <button className="btn-ghost small commit-btn" onClick={() => setCommitting(true)} title={t('commit.title')}>
            ⇡ {t('commit.button', { n: changes.size })}
          </button>
        )}
        <button className="icon-btn" onClick={refresh} title={t('files.refresh')}>
          ↻
        </button>
      </div>
      {committing && <CommitDialog cwd={project.cwd} changes={changes} onClose={() => setCommitting(false)} onDone={refresh} />}
      <Dir entry={{ name: project.name, path: project.cwd, dir: true, heavy: false }} depth={0} project={project} changes={changes} onOpen={(p) => openFile(project.id, p)} refresh={refresh} version={version} />
    </div>
  );
}
