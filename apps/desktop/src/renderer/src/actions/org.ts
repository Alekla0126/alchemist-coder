import type { BotConfig, BotTeam } from '@shared/api';
import { translate, type MessageKey } from '../i18n';
import { canMove } from '../org-model';
import { AVATAR_EMOJI, chooseImage, resizeImage } from '../avatar';
import { useStore } from '../store';
import { confirmAction, openMenu, promptText, toast } from '../ui';

const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(useStore.getState().locale, key, vars);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Opens an agent's profile. */
export const openMember = (member: BotConfig) => useStore.setState({ activeMemberId: member.id, activeTeamId: null, activeBotId: null });

/** Opens an assignment, on one of its agents (the coordinator when none is given). */
export const openAssignment = (team: BotTeam, botId?: string | null) => useStore.setState({ activeTeamId: team.id, activeBotId: botId ?? team.bots[0]?.id ?? null, activeMemberId: null });

/** Back to the organization's chart; with an id (or null) it also changes which assignment shows on it. */
export const showOnChart = (teamId?: string | null) => useStore.setState({ activeTeamId: null, activeBotId: null, activeMemberId: null, activeAutomationId: null, ...(teamId === undefined ? {} : { orgFocusTeamId: teamId }) });

/** Starts writing an assignment for one agent ("Ask Tester to …"), on the chart's message box. */
export function giveTask(member: BotConfig) {
  useStore.setState({ orgGoal: member.kind === 'coordinator' ? useStore.getState().orgGoal : t('org.giveTaskGoal', { name: member.name }) });
  showOnChart();
  requestAnimationFrame(() => {
    const box = document.querySelector<HTMLTextAreaElement>('.org-composer textarea');
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  });
}

/** Renames an agent right from the list (its unsaved edits keep the new name too). */
export async function renameMember(member: BotConfig) {
  const value = await promptText({ title: t('org.renameAgent'), value: member.name, confirmLabel: t('menu.renameOk'), cancelLabel: t('dialog.cancel') });
  const name = value?.trim();
  if (!name || name === member.name) return;
  try {
    await window.alchemist.saveBotConfig({ ...member, name });
    const draft = useStore.getState().orgDrafts[member.id];
    if (draft) useStore.setState((s) => ({ orgDrafts: { ...s.orgDrafts, [member.id]: { ...draft, name } } }));
    await useStore.getState().loadBots();
  } catch (e) {
    toast(errorText(e));
  }
}

/** Gives an agent a picture: one of yours (cropped and made small), one of the app's, or none (its initials). */
export async function changeAvatar(member: BotConfig) {
  const id = await openMenu([
    { id: 'upload', label: `${t('avatar.upload')}…` },
    { id: 'emoji', label: t('avatar.pick'), submenu: AVATAR_EMOJI.map((e, i) => ({ id: `e:${i}`, label: e, checked: member.avatar === `emoji:${e}` })) },
    ...(member.avatar ? [{ type: 'separator' as const }, { id: 'none', label: t('avatar.remove') }] : []),
  ]);
  if (!id) return;
  let avatar: string | null = null;
  if (id === 'upload') {
    const file = await chooseImage();
    if (!file) return;
    try {
      avatar = await resizeImage(file);
    } catch {
      return toast(t('avatar.unreadable'));
    }
  } else if (id.startsWith('e:')) avatar = `emoji:${AVATAR_EMOJI[Number(id.slice(2))]}`;
  try {
    await window.alchemist.saveBotConfig({ ...member, avatar });
    await useStore.getState().loadBots();
  } catch (e) {
    toast(errorText(e));
  }
}

/** Puts an agent on a lead's team, or back under the coordinator (null). */
export async function setLead(member: BotConfig, lead: BotConfig | null) {
  try {
    await window.alchemist.saveBotConfig({ ...member, leadId: lead?.id ?? null });
    await useStore.getState().loadBots();
    toast(lead ? t('org.joinedTeam', { name: member.name, lead: lead.name }) : t('org.leftTeam', { name: member.name }), undefined, 3000);
  } catch (e) {
    toast(errorText(e));
  }
}

/** "+" on an agent: a new agent for its team, or one of the organization's agents moved onto it. */
export async function addToTeam(lead: BotConfig, configs: BotConfig[]) {
  const nameOf = (id?: string | null) => configs.find((c) => c.id === id)?.name ?? '';
  const movable = configs.filter((c) => canMove(c, lead, configs));
  const id = await openMenu([
    { id: 'new', label: t('org.newTeamAgent') },
    ...(movable.length
      ? [{ type: 'separator' as const }, { id: 'h', label: t('org.moveHere'), enabled: false }, ...movable.map((c) => ({ id: `m:${c.id}`, label: c.leadId ? `${c.name} · ${t('org.onTeam', { name: nameOf(c.leadId) })}` : c.name }))]
      : []),
  ]);
  if (id === 'new') useStore.setState({ botConfigDialog: { leadId: lead.id } });
  const moved = id?.startsWith('m:') ? configs.find((c) => c.id === id.slice(2)) : undefined;
  if (moved) await setLead(moved, lead);
}

/** Removes an agent from the organization, after asking. */
export async function removeMember(member: BotConfig): Promise<boolean> {
  if (!(await confirmAction({ title: t('org.deleteAgentTitle', { name: member.name }), confirmLabel: t('org.deleteAgent'), cancelLabel: t('dialog.cancel'), danger: true }))) return false;
  try {
    await window.alchemist.deleteBotConfig(member.id);
    if (useStore.getState().activeMemberId === member.id) useStore.setState({ activeMemberId: null });
    await useStore.getState().loadBots();
    return true;
  } catch (e) {
    toast(errorText(e));
    return false;
  }
}

/** Keeping a proposed agent: it becomes one of the organization's agents. */
export async function keepMember(member: BotConfig, patch: Partial<BotConfig> = {}) {
  try {
    await window.alchemist.saveBotConfig({ ...member, ...patch, proposed: false });
    await useStore.getState().loadBots();
    toast(t('org.joined', { name: patch.name || member.name }), undefined, 3000);
  } catch (e) {
    toast(errorText(e));
  }
}

/** Dismissing a proposed agent needs no confirmation, only a way back. */
export async function dismissMember(member: BotConfig) {
  try {
    await window.alchemist.deleteBotConfig(member.id);
    if (useStore.getState().activeMemberId === member.id) useStore.setState({ activeMemberId: null });
    await useStore.getState().loadBots();
    toast(t('org.dismissed', { name: member.name }), { label: t('org.undo'), run: () => void window.alchemist.saveBotConfig({ ...member, id: undefined }).then(() => useStore.getState().loadBots()) }, 8000);
  } catch (e) {
    toast(errorText(e));
  }
}

/** Approving a plan as it is (Review opens it to edit first). */
export async function approvePlan(team: BotTeam) {
  if (!team.plan) return;
  try {
    await window.alchemist.answerPlan(team.id, { approve: true, bots: team.plan.bots, feedback: '' });
    await useStore.getState().loadBots();
    toast(t('bots.planApproved', { n: team.plan.bots.length }), undefined, 3000);
  } catch (e) {
    toast(errorText(e));
  }
}

/** Asking the coordinator for another plan, saying what to change. */
export async function askPlanChanges(team: BotTeam) {
  const feedback = (await promptText({ title: t('bots.planChanges'), message: team.title || team.goal, placeholder: t('org.planChangesPlaceholder'), confirmLabel: t('bots.planChanges'), cancelLabel: t('dialog.cancel') }))?.trim();
  if (!feedback) return;
  try {
    await window.alchemist.answerPlan(team.id, { approve: false, feedback });
    await useStore.getState().loadBots();
  } catch (e) {
    toast(errorText(e));
  }
}
