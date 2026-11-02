import { useEffect, useRef } from 'react';
import type { OrgGroup } from '@shared/api';
import { folderInGroup, groupOf, newGroupId, ORG_GROUP_KEY, toggleFolder } from '../org-groups';
import { baseName } from '../paths';
import { useOpenProjects, useStore, useT } from '../store';
import { confirmAction, openMenu, promptText, toast } from '../ui';
import { openOrgSettings } from '../actions/org';
import { errorText } from './Bots';

type T = ReturnType<typeof useT>;

/** Looks at the organization by one of its organizations ('' = all), kept between launches. */
export function setOrgGroup(id: string) {
  const st = useStore.getState();
  // A project filter outside the new organization would leave nothing: it goes.
  const project = st.orgProject && !folderInGroup(st.orgProject, groupOf(st.orgSettings, id)) ? '' : st.orgProject;
  useStore.setState({ orgGroup: id, orgProject: project });
  try {
    localStorage.setItem(ORG_GROUP_KEY, id);
  } catch {
    // no storage
  }
}

async function saveGroups(groups: OrgGroup[]) {
  try {
    useStore.setState({ orgSettings: await window.alchemist.saveOrgSettings({ groups }) });
  } catch (e) {
    toast(errorText(e));
  }
}

/** Asks for a name and adds an organization with no folders yet; it's the one you look at then. */
async function createGroup(t: T) {
  const name = (await promptText({ title: t('org.groups.newTitle'), message: t('org.groups.newHint'), confirmLabel: t('org.groups.create'), cancelLabel: t('dialog.cancel') }))?.trim();
  if (!name) return;
  const groups = useStore.getState().orgSettings?.groups ?? [];
  const id = newGroupId(name, groups);
  await saveGroups([...groups, { id, name: name.slice(0, 80), projects: [] }]);
  setOrgGroup(id);
}

/** An organization's menu: the open project folders (and the ones it has) to tick, and renaming or deleting it. */
export async function groupMenu(group: OrgGroup, open: Array<{ cwd: string; name: string }>, t: T) {
  const folders = [...open.map((p) => ({ cwd: p.cwd, name: p.name })), ...group.projects.filter((cwd) => !open.some((p) => p.cwd === cwd)).map((cwd) => ({ cwd, name: baseName(cwd) }))];
  const id = await openMenu([
    ...(folders.length ? folders.map((f) => ({ id: `f:${f.cwd}`, label: f.name, checked: group.projects.includes(f.cwd) })) : [{ id: 'none', label: t('org.groups.noOpen'), enabled: false }]),
    { type: 'separator' as const },
    { id: 'rename', label: t('org.groups.rename') },
    { id: 'delete', label: t('org.groups.delete') },
  ]);
  const groups = useStore.getState().orgSettings?.groups ?? [];
  if (id?.startsWith('f:')) return saveGroups(toggleFolder(groups, group.id, id.slice(2)));
  if (id === 'rename') {
    const name = (await promptText({ title: t('org.groups.rename'), value: group.name, confirmLabel: t('menu.renameOk'), cancelLabel: t('dialog.cancel') }))?.trim();
    if (name && name !== group.name) await saveGroups(groups.map((g) => (g.id === group.id ? { ...g, name: name.slice(0, 80) } : g)));
  }
  if (id === 'delete' && (await confirmAction({ title: t('org.groups.deleteTitle', { name: group.name }), message: t('org.groups.deleteHint'), confirmLabel: t('org.groups.delete'), cancelLabel: t('dialog.cancel'), danger: true }))) {
    await saveGroups(groups.filter((g) => g.id !== group.id));
    if (useStore.getState().orgGroup === group.id) setOrgGroup('');
  }
}

/** Beside the organization's name: which organization to look at (all, one, or a new one), and its folders. */
export function OrgGroupPicker() {
  const t = useT();
  const org = useStore((s) => s.orgSettings);
  const chosen = useStore((s) => s.orgGroup);
  const personal = useStore((s) => s.info?.personal === true);
  const open = useOpenProjects();
  // The owner's own build, with organizations never saved: its module's, from the open folders. Main
  // saves them only if one of those folders matches and none were ever saved; else it tries again
  // when the open projects change.
  const folders = open.map((p) => p.cwd).join('\n');
  const tried = useRef('');
  useEffect(() => {
    if (!personal || !org || org.groups !== undefined || !folders || tried.current === folders) return;
    tried.current = folders;
    void window.alchemist
      .seedOrgGroups(folders.split('\n'))
      .then((saved) => saved.groups !== undefined && useStore.setState({ orgSettings: saved }))
      .catch(() => {});
  }, [personal, org, folders]);
  const groups = org?.groups ?? [];
  const group = groupOf(org, chosen);
  return (
    <span className="org-groups">
      <select
        className="org-filter org-group-select"
        value={group ? group.id : ''}
        aria-label={t('org.groups.label')}
        onChange={(e) => setOrgGroup(e.target.value)}
      >
        <option value="">{t('org.groups.all')}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>

    </span>
  );
}

/** An organization with no folders yet shows nothing: say so, with the way to give it some. */
export function OrgGroupEmpty({ group }: { group: OrgGroup }) {
  const t = useT();
  return (
    <div className="org-group-empty" role="status">
      <span>{t('org.groups.empty')}</span>
      <button className="btn-ghost small" onClick={() => openOrgSettings()}>
        📁 {t('org.groups.assign')}
      </button>
    </div>
  );
}

/** Organization folders are edited here, apart from the view filter. */
export function OrgGroupSettings() {
  const t = useT();
  const groups = useStore((s) => s.orgSettings?.groups ?? []);
  const open = useOpenProjects();
  return <section className="org-config-groups">
    <h3>{t('org.groups.label')}</h3>
    {groups.map((group) => <div key={group.id} className="org-config-group"><b>{group.name}</b><span className="composer-note">{group.projects.map(baseName).join(' · ') || t('org.groups.empty')}</span><button className="btn-ghost small" onClick={() => void groupMenu(group, open, t)}>{t('org.groups.foldersShort')} →</button></div>)}
    <button className="btn-ghost small" onClick={() => void createGroup(t)}>{t('org.groups.new')}</button>
  </section>;
}
