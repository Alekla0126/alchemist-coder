import type { OrgGroup } from '@shared/api';
import { groupOf, newGroupId, ORG_GROUP_KEY, toggleFolder } from '../org-groups';
import { baseName } from '../paths';
import { useOpenProjects, useStore, useT } from '../store';
import { confirmAction, openMenu, promptText, toast } from '../ui';
import { errorText } from './Bots';

type T = ReturnType<typeof useT>;

/** The "+ New…" entry of the menu. */
const NEW = '__new';

/** Looks at the organization by one of its organizations ('' = all), kept between launches. */
export function setOrgGroup(id: string) {
  useStore.setState({ orgGroup: id });
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
  const open = useOpenProjects();
  const groups = org?.groups ?? [];
  const group = groupOf(org, chosen);
  return (
    <span className="org-groups">
      <select
        className="org-filter org-group-select"
        value={group ? group.id : ''}
        aria-label={t('org.groups.label')}
        onChange={(e) => (e.target.value === NEW ? void createGroup(t) : setOrgGroup(e.target.value))}
      >
        <option value="">{t('org.groups.all')}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
        <option value={NEW}>{t('org.groups.new')}</option>
      </select>
      {group && (
        <button className="icon-btn ic-btn org-group-folders" onClick={() => void groupMenu(group, open, t)} title={t('org.groups.folders', { name: group.name })} aria-label={t('org.groups.folders', { name: group.name })}>
          📁
        </button>
      )}
    </span>
  );
}

/** An organization with no folders yet shows nothing: say so, with the way to give it some. */
export function OrgGroupEmpty({ group }: { group: OrgGroup }) {
  const t = useT();
  const open = useOpenProjects();
  return (
    <div className="org-group-empty" role="status">
      <span>{t('org.groups.empty')}</span>
      <button className="btn-ghost small" onClick={() => void groupMenu(group, open, t)}>
        📁 {t('org.groups.assign')}
      </button>
    </div>
  );
}
