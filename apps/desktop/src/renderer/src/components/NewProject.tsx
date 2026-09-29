import { useEffect, useRef, useState } from 'react';
import { projectNameError } from '@shared/project-name';
import { joinPath, parentOf, tildify } from '../paths';
import { useStore, useT } from '../store';
import { openMenu, toast } from '../ui';

type T = ReturnType<typeof useT>;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Opens a project and a new conversation in it: what you want right after creating or opening one. */
async function startIn(projectId: number) {
  const s = useStore.getState();
  await s.refreshProjects();
  await s.openProject(projectId);
  if (s.settings.mode !== 'agents' && s.settings.mode !== 'split') s.setMode('agents');
  s.setCompose(projectId);
}

/** Any folder on disk becomes a project, before its first conversation. */
export async function openFolderAsProject(t: T) {
  try {
    const id = await window.alchemist.openFolder(t('newProject.openTitle'));
    if (id == null) return;
    await startIn(id);
    const name = useStore.getState().projects.find((p) => p.id === id)?.name ?? '';
    toast(t('newProject.opened', { name }), undefined, 3000);
  } catch (e) {
    toast(errorText(e));
  }
}

export const openNewProject = () => useStore.setState({ newProjectOpen: true });

/** The rail's "+": a conversation in the open project, a new project, a folder, or one you had. */
export async function showNewMenu(t: T) {
  const s = useStore.getState();
  const active = s.projects.find((p) => p.id === s.settings.activeProjectId);
  const id = await openMenu([
    { id: 'conversation', label: active ? t('plus.conversation', { name: active.name }) : t('plus.conversationNone'), enabled: !!active, accelerator: 'CmdOrCtrl+N' },
    { type: 'separator' },
    { id: 'new-project', label: t('plus.newProject'), accelerator: 'CmdOrCtrl+Shift+N' },
    { id: 'open-folder', label: t('plus.openFolder') },
    { id: 'find', label: t('plus.find'), accelerator: 'CmdOrCtrl+O' },
  ]);
  if (id === 'conversation' && active) {
    if (s.settings.mode !== 'agents' && s.settings.mode !== 'split') s.setMode('agents');
    s.setCompose(active.id);
  } else if (id === 'new-project') openNewProject();
  else if (id === 'open-folder') void openFolderAsProject(t);
  else if (id === 'find') s.setPickerOpen(true);
}

/** A new empty folder (with git, by default) next to your other projects, then a conversation in it. */
export function NewProjectDialog() {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.settings.activeProjectId);
  const home = useStore((s) => s.info?.home ?? '');
  const [name, setName] = useState('');
  // Next to the open project (or the latest one) until you choose another place.
  const near = projects.find((p) => p.id === activeId) ?? projects[0];
  const [chosen, setChosen] = useState<string | null>(null);
  const parent = chosen ?? (near ? parentOf(near.cwd) : home);
  const [git, setGit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const close = () => useStore.setState({ newProjectOpen: false });
  const problem = name.trim() ? projectNameError(name) : null;
  const create = async () => {
    const why = projectNameError(name);
    if (why) return setError(t(`newProject.err.${why}` as never));
    if (busy || !parent) return;
    setBusy(true);
    setError(null);
    try {
      const id = await window.alchemist.createProject(parent, name.trim(), git);
      close();
      await startIn(id);
      toast(t('newProject.created', { name: name.trim() }), undefined, 3000);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const choose = async () => {
    const picked = await window.alchemist.chooseFolder(t('newProject.chooseTitle'), parent || undefined);
    if (picked) setChosen(picked);
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form
        className="dialog new-project"
        role="dialog"
        aria-modal="true"
        aria-label={t('newProject.title')}
        onKeyDown={(e) => e.key === 'Escape' && close()}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h3>{t('newProject.title')}</h3>
        <label className="np-field">
          <span>{t('newProject.name')}</span>
          <input ref={input} value={name} placeholder={t('newProject.namePlaceholder')} maxLength={80} aria-invalid={!!problem} onChange={(e) => (setName(e.target.value), setError(null))} />
        </label>
        <div className="np-field">
          <span>{t('newProject.location')}</span>
          <div className="np-where">
            {/* Right-to-left so a long path shows its end; the marks keep the slashes in place. */}
            <code title={parent}>{`\u200e${tildify(parent, home)}\u200e`}</code>
            <button type="button" className="btn-ghost" onClick={() => void choose()}>
              {t('newProject.change')}
            </button>
          </div>
        </div>
        <label className="np-check">
          <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} />
          {t('newProject.git')}
        </label>
        <p className={`np-note ${problem || error ? 'err' : ''}`} role={problem || error ? 'alert' : undefined}>
          {error ?? (problem ? t(`newProject.err.${problem}` as never) : name.trim() ? t('newProject.will', { path: tildify(joinPath(parent, name.trim()), home) }) : ' ')}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={close}>
            {t('dialog.cancel')}
          </button>
          <button type="submit" className="btn-send" disabled={busy || !name.trim() || !!problem}>
            {busy ? <span className="spin" /> : t('newProject.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
