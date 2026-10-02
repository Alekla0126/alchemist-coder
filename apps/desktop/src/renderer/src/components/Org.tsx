import { useEffect, useRef, useState } from 'react';
import type { AgentChoice, BotConfig, BotMember, BotTeam, PermissionMode } from '@shared/api';
import type { LiveQuestion } from '../live-turns';
import { money, modelLabel as rawModelLabel, relativeTime } from '../format';
import { sourceOf } from '../sources';
import { useOpenProjects, useStore, useT, type PendingPermission } from '../store';
import { contextMenu, toast } from '../ui';
import { Icon } from './Icon';
import { baseName } from '../paths';
import { AgentPicker, defaultChoice } from './AgentPicker';
import { confirmDeleteTeam, doingText, errorText, teamActive, teamCost, teamState, TeamView } from './Bots';
import { activityOf, inFolder, inProject, resultIn, type Focus, type Need } from '../org-model';
import { addToTeam, approvePlan, askPlanChanges, dismissMember, giveTask, keepMember, openAssignment, removeMember, renameMember, setLead, showOnChart } from '../actions/org';
import { OrgChart } from './OrgChart';
import { OrgComposer } from './OrgComposer';
import { PermissionCard } from './LiveRun';
import { QuestionForm } from './QuestionForm';

type T = ReturnType<typeof useT>;
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const modelName = (t: T, model: string) => (model === 'default' ? t('run.defaultModel') : rawModelLabel(model));
const DEFAULT_NAME = 'My organization';
/** With more agents than this, available ones drop their role line so the chart stays short. */
const COMPACT_AT = 8;

/** The agents a new organization starts with (the coordinator first), in the app's language. */
const STARTERS = ['coordinator', 'coder', 'tester', 'reviewer', 'uijudge', 'researcher'];
const starterNames = (t: T) => Object.fromEntries(STARTERS.map((k) => [k, { name: t(`bots.starter.${k}.name` as never), role: t(`bots.starter.${k}.role` as never) }]));
/** Roles to start a new agent from; the ones that only read ask before acting. */
const PRESETS = ['coder', 'tester', 'reviewer', 'uijudge', 'researcher', 'planner'];
const READ_ONLY = ['reviewer', 'uijudge', 'researcher', 'planner'];

const folderName = baseName;

/** A need in words: "Plan to review" or what the agent asked. */
const needText = (n: Need, t: T) => (n.kind === 'plan' ? t('bots.planWaiting') : n.detail || t('org.needAsk'));

/** One thing the organization needs from you, answered right where it shows. */
type InboxItem =
  | { kind: 'plan'; team: BotTeam }
  | { kind: 'permission'; team: BotTeam; bot: BotMember; runId: string; request: PendingPermission }
  | { kind: 'question'; team: BotTeam; bot: BotMember; runId: string; request: LiveQuestion }
  | { kind: 'waiting'; team: BotTeam; bot: BotMember }
  | { kind: 'proposed'; member: BotConfig };

/** Plans to review, agents' permissions and questions (from their live runs), and proposed agents. */
function useInbox(teams: BotTeam[], proposed: BotConfig[]): InboxItem[] {
  const runs = useStore((s) => s.runs);
  const items: InboxItem[] = [];
  for (const team of teams) {
    if (team.plan?.status === 'pending') items.push({ kind: 'plan', team });
    for (const bot of team.bots) {
      if (bot.status !== 'waiting') continue;
      const run = bot.runId ? runs[bot.runId] : undefined;
      const asks = [...(run?.permissions ?? []).map((request) => ({ kind: 'permission' as const, team, bot, runId: bot.runId!, request })), ...(run?.questions ?? []).map((request) => ({ kind: 'question' as const, team, bot, runId: bot.runId!, request }))];
      if (asks.length) items.push(...asks);
      else if (!(bot.depth === 0 && team.plan?.status === 'pending')) items.push({ kind: 'waiting', team, bot });
    }
  }
  for (const member of proposed) items.push({ kind: 'proposed', member });
  return items;
}

/** The inbox split by urgency: agents blocked on you now, plans to review, and suggested (proposed) agents. */
function inboxGroups(items: InboxItem[]) {
  const blocking = items.filter((x) => x.kind === 'permission' || x.kind === 'question' || x.kind === 'waiting');
  const plans = items.filter((x): x is Extract<InboxItem, { kind: 'plan' }> => x.kind === 'plan');
  const suggested = items.filter((x): x is Extract<InboxItem, { kind: 'proposed' }> => x.kind === 'proposed');
  // What counts as "needs you" everywhere (title bar, callout, inbox); suggestions can wait.
  return { blocking, plans, suggested, urgent: blocking.length + plans.length };
}

/**
 * The "needs you" inbox, most urgent first: agents blocked on you now (answered right here, without
 * number-key shortcuts so no stray key answers another agent), plans to review, then suggested agents.
 */
function Inbox({ items }: { items: InboxItem[] }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const { blocking, plans, suggested, urgent } = inboxGroups(items);
  if (!items.length) return null;
  const where = (team: BotTeam) => team.title || team.goal;
  return (
    <section className={`org-inbox ${urgent ? '' : 'calm'}`} id="org-inbox" aria-label={t('org.inbox')}>
      {urgent > 0 && (
        <h3 aria-live="polite">
          <span className="org-dot st-waiting" aria-hidden /> {t('org.inboxN', { n: urgent })}
        </h3>
      )}
      {blocking.length > 0 && <h4>{t('org.groupBlocking')}</h4>}
      {blocking.map((item) => (
        <div key={`${item.kind}:${item.team.id}:${item.bot.id}:${'request' in item ? item.request.requestId : ''}`} className="org-inbox-item">
          <div className="org-inbox-head">
            <b>{item.bot.name}</b>
            <span className="org-inbox-where">{where(item.team)}</span>
            <button className="link small" onClick={() => openAssignment(item.team, item.bot.id)}>
              {item.kind === 'waiting' ? t('org.answer') : t('org.openAssignment')} →
            </button>
          </div>
          {item.kind === 'permission' && <PermissionCard runId={item.runId} request={item.request} shortcuts={false} />}
          {item.kind === 'question' && <QuestionForm runId={item.runId} request={item.request} shortcuts={false} />}
        </div>
      ))}
      {plans.length > 0 && <h4>{t('org.groupPlans', { n: plans.length })}</h4>}
      {plans.map(({ team }) => (
        <div key={`plan:${team.id}`} className="org-inbox-item">
          <div className="org-inbox-head">
            <span className="org-inbox-main">
              <b>{where(team)}</b>
              <small>
                {[team.plan?.estimateUsd != null ? `≈ ${money(team.plan.estimateUsd, locale)}` : '', t('bots.count', { n: team.plan?.bots.length ?? 0 }), relativeTime(team.updatedAt, locale)].filter(Boolean).join(' · ')}
              </small>
            </span>
            <button className="btn-ghost small" onClick={() => showOnChart(team.id)}>
              {t('org.review')}
            </button>
            <button className="btn-ghost small" onClick={() => void approvePlan(team)}>
              ✓ {t('org.approve')}
            </button>
          </div>
        </div>
      ))}
      {suggested.length > 0 && <h4>{t('org.groupSuggested', { n: suggested.length })}</h4>}
      {suggested.map(({ member }) => (
        <div key={`proposed:${member.id}`} className="org-inbox-item compact">
          <div className="org-inbox-head">
            <span className="org-inbox-main">
              <b>{member.name}</b>
              <small>{member.role.replace(/\s+/g, ' ').slice(0, 160)}</small>
            </span>
            <button className="btn-ghost small" onClick={() => void dismissMember(member)}>
              {t('org.dismiss')}
            </button>
            <button className="btn-ghost small" onClick={() => void keepMember(member)}>
              {t('org.keep')}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

const orgNameOf = (name: string | undefined, t: T) => (!name || name === DEFAULT_NAME ? t('org.defaultName') : name);

interface Draft {
  name: string;
  role: string;
  agent: AgentChoice | null;
  permissionMode: PermissionMode;
  canSpawn: boolean;
  ownWorktree: boolean;
  projects: string[];
}

const draftOf = (c: Partial<BotConfig>, fallback: AgentChoice | null): Draft => ({
  name: c.name ?? '',
  role: c.role ?? '',
  agent: c.agent ?? fallback,
  permissionMode: c.permissionMode ?? 'acceptEdits',
  canSpawn: c.canSpawn ?? false,
  ownWorktree: c.ownWorktree ?? false,
  projects: c.projects ?? [],
});

const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/** An agent's profile edits, kept in the store until saved: looking at another agent doesn't lose them. */
function useDraft(member: BotConfig) {
  const saved = draftOf(member, null);
  const kept = useStore((s) => s.orgDrafts[member.id]) as Draft | undefined;
  const draft = kept ?? saved;
  const set = (patch: Partial<Draft>) =>
    useStore.setState((s) => {
      const next = { ...((s.orgDrafts[member.id] as Draft | undefined) ?? saved), ...patch };
      const drafts = { ...s.orgDrafts };
      if (sameDraft(next, saved)) delete drafts[member.id];
      else drafts[member.id] = next as unknown as Record<string, unknown>;
      return { orgDrafts: drafts };
    });
  const clear = () =>
    useStore.setState((s) => {
      const drafts = { ...s.orgDrafts };
      delete drafts[member.id];
      return { orgDrafts: drafts };
    });
  return { draft, set, clear, dirty: !!kept && !sameDraft(kept, saved) };
}

/** Name, instructions, agent and model, permissions, and where it works. */
function MemberForm({ draft, set, coordinator, autoFocus = false }: { draft: Draft; set: (patch: Partial<Draft>) => void; coordinator: boolean; autoFocus?: boolean }) {
  const t = useT();
  const catalog = useStore((s) => s.catalog);
  const open = useOpenProjects();
  const [only, setOnly] = useState(draft.projects.length > 0);
  // Projects it's assigned to that aren't open right now still show (by folder name).
  const extra = draft.projects.filter((p) => !open.some((o) => o.cwd === p)).map((p) => ({ cwd: p, name: folderName(p) }));
  const choices = [...open.map((p) => ({ cwd: p.cwd, name: p.name })), ...extra];
  return (
    <>
      <label className="bot-field">
        <span>{t('bots.name')}</span>
        <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('bots.namePlaceholder')} autoFocus={autoFocus} />
      </label>
      <label className="bot-field">
        <span>{t('bots.role')}</span>
        <textarea value={draft.role} rows={6} onChange={(e) => set({ role: e.target.value })} placeholder={coordinator ? t('bots.coordinatorRolePlaceholder') : t('bots.rolePlaceholder')} />
      </label>
      <div className="bot-field">
        <span>{t('bots.agent')}</span>
        {draft.agent ? <AgentPicker value={draft.agent} onChange={(agent) => set({ agent })} /> : catalog ? <span className="composer-note">{t('bots.noAgent')}</span> : <span className="spin" />}
      </div>
      <label className="bot-field">
        <span>{t('run.permissions')}</span>
        <select value={draft.permissionMode} onChange={(e) => set({ permissionMode: e.target.value as PermissionMode })}>
          {MODES.map((m) => (
            <option key={m} value={m}>
              {t(`perm.${m}`)}
            </option>
          ))}
        </select>
      </label>
      {!coordinator && (
        <>
          <label className="bot-check">
            <input type="checkbox" checked={draft.canSpawn} onChange={(e) => set({ canSpawn: e.target.checked })} />
            <span>
              <b>{t('bots.canSpawn')}</b>
              <small>{t('bots.canSpawnHint')}</small>
            </span>
          </label>
          <label className="bot-check">
            <input type="checkbox" checked={draft.ownWorktree} onChange={(e) => set({ ownWorktree: e.target.checked })} />
            <span>
              <b>{t('bots.ownWorktree')}</b>
              <small>{t('bots.ownWorktreeHint')}</small>
            </span>
          </label>
          <div className="bot-field">
            <span>{t('org.projects')}</span>
            <div className="org-projects">
              <div className="lang" role="radiogroup" aria-label={t('org.projects')}>
                <button
                  role="radio"
                  aria-checked={!only}
                  className={!only ? 'on' : ''}
                  onClick={() => {
                    setOnly(false);
                    set({ projects: [] });
                  }}
                >
                  {t('org.allProjects')}
                </button>
                <button role="radio" aria-checked={only} className={only ? 'on' : ''} onClick={() => setOnly(true)}>
                  {t('org.scopeOnly')}
                </button>
              </div>
              {only &&
                choices.map((p) => (
                  <label key={p.cwd} className="org-project" title={p.cwd}>
                    <input
                      type="checkbox"
                      checked={draft.projects.includes(p.cwd)}
                      onChange={(e) => set({ projects: e.target.checked ? [...draft.projects, p.cwd] : draft.projects.filter((x) => x !== p.cwd) })}
                    />
                    {p.name}
                  </label>
                ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** A new agent for the organization, blank or from a role. */
function AddAgentDialog({ leadId, onClose }: { leadId: string | null; onClose: () => void }) {
  const t = useT();
  const catalog = useStore((s) => s.catalog);
  const leadName = useStore((s) => (leadId ? s.botConfigs.find((c) => c.id === leadId)?.name : undefined));
  const orgProject = useStore((s) => s.orgProject);
  const [draft, setDraft] = useState<Draft>(() => ({ ...draftOf({}, defaultChoice(catalog)), projects: orgProject ? [orgProject] : [] }));
  const [preset, setPreset] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => {
    if (!draft.agent && catalog) set({ agent: defaultChoice(catalog) });
  }, [catalog]);
  // Escape closes it wherever the focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const save = async () => {
    if (!draft.agent) return;
    try {
      const saved = await window.alchemist.saveBotConfig({ ...draft, agent: draft.agent, kind: 'member', leadId });
      await useStore.getState().loadBots();
      useStore.setState({ activeMemberId: saved.id, activeTeamId: null, activeBotId: null });
      toast(leadName ? t('org.joinedTeam', { name: saved.name, lead: leadName }) : t('org.joined', { name: saved.name }), undefined, 3000);
      onClose();
    } catch (e) {
      toast(errorText(e));
    }
  };
  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="commit-dialog bot-dialog" role="dialog" aria-modal="true" aria-label={leadName ? t('org.addToTeamOf', { name: leadName }) : t('org.addAgent')}>
        <h3>{leadName ? t('org.addToTeamOf', { name: leadName }) : t('org.addAgent')}</h3>
        {leadName && <p className="composer-note">{t('org.teamHint', { name: leadName })}</p>}
        <div className="bot-field">
          <span>{t('org.presets')}</span>
          <div className="bots-examples">
            {PRESETS.map((k) => (
              <button
                key={k}
                className={`f tpl-chip ${preset === k ? 'on' : ''}`}
                aria-pressed={preset === k}
                onClick={() => {
                  setPreset(k);
                  set({ name: t(`bots.starter.${k}.name` as never), role: t(`bots.starter.${k}.role` as never), permissionMode: READ_ONLY.includes(k) ? 'default' : 'acceptEdits', canSpawn: k === 'planner' });
                }}
              >
                {t(`bots.starter.${k}.name` as never)}
              </button>
            ))}
          </div>
        </div>
        <MemberForm draft={draft} set={set} coordinator={false} autoFocus />
        <div className="commit-foot">
          <span className="composer-sp" />
          <button className="btn-ghost" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button className="btn-send" disabled={!draft.name.trim() || !draft.agent} onClick={() => void save()}>
            {leadName ? t('org.addToTeam') : t('org.addAgent')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Arrow keys move between the rows of a list (org chart, assignments); Enter opens one. */
function rowKeys(e: React.KeyboardEvent<HTMLElement>, open: () => void) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    open();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const rows = [...(e.currentTarget.closest('.org-side')?.querySelectorAll<HTMLElement>('[data-row]') ?? [])];
  const i = rows.indexOf(e.currentTarget);
  rows[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
}

/** One agent in the organization's list: its state, what it needs or is doing, and its model. */
function MemberRow({ member, depth, teams, compact, focus }: { member: BotConfig; depth: number; teams: BotTeam[]; compact: boolean; focus: Focus }) {
  const t = useT();
  const configs = useStore((s) => s.botConfigs);
  const teamLead = !member.proposed && member.kind !== 'coordinator' && !member.leadId;
  const onTeamOf = member.leadId ? configs.find((c) => c.id === member.leadId) : undefined;
  const selected = useStore((s) => s.activeMemberId === member.id && !s.activeTeamId);
  const unsaved = useStore((s) => !!s.orgDrafts[member.id]);
  const a = activityOf(member, teams);
  const doing = a.doing ? doingText(a.doing, t) : null;
  const lead = member.kind === 'coordinator';
  const role = member.role.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0]?.slice(0, 90) ?? '';
  const scope = member.projects?.length ? `${folderName(member.projects[0]!)}${member.projects.length > 1 ? ` +${member.projects.length - 1}` : ''}` : '';
  const select = () => useStore.setState({ activeMemberId: member.id, activeTeamId: null, activeBotId: null });
  const need = a.needs[0];
  const status = t(`org.status.${a.status}`);
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-label={[member.name, status, focus?.kind === 'in' ? t('org.inAssignment') : focus?.kind === 'planned' ? t('org.plannedFor') : ''].filter(Boolean).join(' · ')}
      tabIndex={0}
      data-row
      className={`row org-member ${lead ? 'lead' : ''} ${selected ? 'sel' : ''} ${focus?.kind ?? ''}`}
      style={{ paddingLeft: 10 + depth * 16 }}
      onClick={select}
      onKeyDown={(e) => rowKeys(e, select)}
      onContextMenu={contextMenu(
        () => [
          { id: 'rename', label: `${t('org.renameAgent')}…` },
          ...(lead ? [{ id: 'add-org', label: `${t('org.addAgent')}…` }] : teamLead ? [{ id: 'add-team', label: `${t('org.addToTeam')}…` }] : []),
          ...(onTeamOf ? [{ id: 'leave', label: t('org.leaveTeam', { name: onTeamOf.name }) }] : []),
          ...(lead ? [] : [{ type: 'separator' as const }, { id: 'delete', label: t('org.deleteAgent') }]),
        ],
        (id) => {
          if (id === 'rename') void renameMember(member);
          if (id === 'add-org') useStore.setState({ botConfigDialog: true });
          if (id === 'add-team') void addToTeam(member, configs);
          if (id === 'leave') void setLead(member, null);
          if (id === 'delete') void removeMember(member);
        },
      )}
      title={member.role || undefined}
    >
      <span className={`org-dot st-${a.status}`} role="img" aria-label={status} title={status} />
      <span className="tt">
        <span className="org-member-name" onDoubleClick={(e) => (e.stopPropagation(), void renameMember(member))} title={t('org.renameHint2')}>
          {lead && <span className="org-lead-mark">⚗ </span>}
          {member.name}
          {unsaved && (
            <span className="org-unsaved" title={t('org.unsaved')} aria-label={t('org.unsaved')}>
              {' '}
              •
            </span>
          )}
        </span>
        {focus?.kind === 'in' ? (
          // With an assignment open: what this agent did in it.
          <small className={`org-here st-${resultIn(focus.team, focus.bots)}`}>{t(`org.here.${resultIn(focus.team, focus.bots)}`)}</small>
        ) : focus?.kind === 'planned' ? (
          <small className="org-here planned">{t('org.plannedFor')}</small>
        ) : need ? (
          <small className="org-need" title={need.team.title || need.team.goal}>
            {a.needs.length > 1 && `+${a.needs.length - 1} · `}
            {needText(need, t)} · {need.team.title || need.team.goal}
          </small>
        ) : a.status === 'working' && doing ? (
          <small className={`bot-doing ${doing.words ? 'words' : ''}`}>{doing.text}</small>
        ) : (
          !compact && role && <small className="org-role">{role}</small>
        )}
      </span>
      <span className="r">
        {member.proposed ? (
          <span className="bot-badge proposed">{t('org.proposed')}</span>
        ) : (
          <>
            {scope && (
              <span className="org-scope" title={member.projects!.join('\n')}>
                {scope}
              </span>
            )}
            <span className="org-model" title={`${sourceOf(member.agent.harnessId).label} · ${modelName(t, member.agent.model)}`}>
              {sourceOf(member.agent.harnessId).glyph}
              {member.agent.model !== 'default' && ` ${modelName(t, member.agent.model)}`}
            </span>
          </>
        )}
      </span>
      {(lead || teamLead) && (
        <span className="row-acts">
          <button
            className="row-act add"
            onClick={(e) => {
              e.stopPropagation();
              if (lead) useStore.setState({ botConfigDialog: true });
              else void addToTeam(member, configs);
            }}
            title={lead ? t('org.addAgent') : t('org.addToTeamOf', { name: member.name })}
            aria-label={lead ? t('org.addAgent') : t('org.addToTeamOf', { name: member.name })}
          >
            <Icon name="plus" size={13} />
          </button>
        </span>
      )}
    </div>
  );
}

/** The organization's name; click it to rename. */
function OrgName() {
  const t = useT();
  const org = useStore((s) => s.orgSettings);
  const name = orgNameOf(org?.name, t);
  const [editing, setEditing] = useState<string | null>(null);
  const save = async () => {
    const next = (editing ?? '').trim();
    setEditing(null);
    if (!next || next === name) return;
    const saved = await window.alchemist.saveOrgSettings({ name: next });
    useStore.setState({ orgSettings: saved });
  };
  if (editing !== null)
    return (
      <input
        className="org-name-input"
        value={editing}
        autoFocus
        aria-label={t('org.rename')}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(null);
        }}
      />
    );
  return (
    <button className="org-name" title={`${name} · ${t('org.renameHint')}`} onClick={() => setEditing(name)}>
      {name}
    </button>
  );
}

/** The left column, one scroll: the organization chart (coordinator, agents, proposed ones) and its assignments. */
export function OrgSidebar() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const catalog = useStore((s) => s.catalog);
  const configs = useStore((s) => s.botConfigs);
  const allTeams = useStore((s) => s.botTeams);
  const orgProject = useStore((s) => s.orgProject);
  const activeTeamId = useStore((s) => s.activeTeamId);
  const open = useOpenProjects();
  const [loaded, setLoaded] = useState(false);
  const ensuring = useRef(false);
  useEffect(() => {
    void useStore
      .getState()
      .loadBots()
      .finally(() => setLoaded(true));
  }, []);
  // The first time: a coordinator (with the default agent) and the starter agents.
  useEffect(() => {
    if (!catalog) {
      void useStore.getState().loadCatalog();
      return;
    }
    if (!loaded || ensuring.current || configs.some((c) => c.kind === 'coordinator')) return;
    const agent = defaultChoice(catalog);
    if (!agent) return;
    ensuring.current = true;
    void window.alchemist
      .ensureOrg(agent, starterNames(t))
      .then(() => useStore.getState().loadBots())
      .catch((e: unknown) => toast(errorText(e)))
      .finally(() => (ensuring.current = false));
  }, [catalog, configs, loaded]);
  const coordinator = configs.find((c) => c.kind === 'coordinator');
  const members = configs.filter((c) => c.kind !== 'coordinator' && (!orgProject || inProject(c, orgProject)));
  const kept = members.filter((c) => !c.proposed);
  const proposed = members.filter((c) => c.proposed);
  const compact = members.length > COMPACT_AT;
  const teams = orgProject ? allTeams.filter((x) => inFolder(x, orgProject)) : allTeams;
  // An assignment open from elsewhere (e.g. from "needs you") still shows in the list.
  const elsewhere = allTeams.filter((x) => x.id === activeTeamId && !teams.includes(x));
  const projectName = orgProject ? (open.find((p) => p.cwd === orgProject)?.name ?? folderName(orgProject)) : '';
  const inbox = useInbox(teams, proposed);
  const { urgent, suggested } = inboxGroups(inbox);
  // With an assignment open, its agents stand out in the chart: those in it, and those its pending plan names.
  const activeTeam = allTeams.find((x) => x.id === activeTeamId);
  const planned = new Set(
    activeTeam?.plan?.status === 'pending' ? activeTeam.plan.bots.map((b) => (b.config || b.name).trim().toLowerCase()) : [],
  );
  const focusOf = (m: BotConfig): Focus => {
    if (!activeTeam) return null;
    const bots = activeTeam.bots.filter((b) => b.configId === m.id);
    if (bots.length) return { kind: 'in', team: activeTeam, bots };
    if (planned.has(m.name.trim().toLowerCase())) return { kind: 'planned', team: activeTeam };
    return { kind: 'out' };
  };
  const showInbox = () => {
    showOnChart();
    setTimeout(() => document.getElementById('org-inbox')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
  };
  const openTeam = (team: BotTeam) => useStore.setState({ activeTeamId: team.id, activeBotId: team.bots[0]?.id ?? null, activeMemberId: null });
  const teamMenu = (team: BotTeam) =>
    contextMenu(
      () => [...(teamActive(team) ? [{ id: 'stop', label: t('bots.stopTeam') }] : []), { id: 'delete', label: t('bots.deleteTeam') }],
      async (id) => {
        if (id === 'stop') await window.alchemist.stopBot(team.id);
        if (id === 'delete' && (await confirmDeleteTeam(team, t))) {
          await window.alchemist.deleteTeam(team.id);
          if (useStore.getState().activeTeamId === team.id) useStore.setState({ activeTeamId: null });
          await useStore.getState().loadBots();
        }
      },
    );
  return (
    <aside className="side bots-list org-side">
      <div className="org-top">
        <OrgName />
        {open.length > 1 && (
          <select className="org-filter" value={orgProject} aria-label={t('org.project')} onChange={(e) => useStore.setState({ orgProject: e.target.value })}>
            <option value="">{t('org.allProjects')}</option>
            {open.map((p) => (
              <option key={p.id} value={p.cwd}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="sec arena-sec">
        <span>{t('org.agents')}</span>
        {coordinator && (
          <button className="new-btn" onClick={() => useStore.setState({ botConfigDialog: true })}>
            + {t('org.addAgent')}
          </button>
        )}
      </div>
      {inbox.length > 0 && (
        <button className={`org-callout ${urgent ? '' : 'calm'}`} onClick={showInbox}>
          {urgent > 0 && <span className="org-dot st-waiting" aria-hidden />}
          <span className="org-callout-text">{[urgent ? t('org.inboxN', { n: urgent }) : '', suggested.length ? t('org.suggestionsN', { n: suggested.length }) : ''].filter(Boolean).join(' · ')}</span>
          <span className="org-callout-go">{t('org.review')} →</span>
        </button>
      )}
      {activeTeam && <p className="org-focus-caption">{t('org.focusCaption', { title: activeTeam.title || activeTeam.goal })}</p>}
      <div className="tree org-chart" role="tree" aria-label={t('org.agents')}>
        {coordinator ? <MemberRow member={coordinator} depth={0} teams={teams} compact={compact} focus={focusOf(coordinator)} /> : <p className="empty">{t('org.setup')}</p>}
        {/* Each lead with its team right under it. */}
        {kept
          .filter((m) => !m.leadId || !kept.some((k) => k.id === m.leadId))
          .flatMap((m) => [m, ...kept.filter((x) => x.leadId === m.id)])
          .map((m) => (
            <MemberRow key={m.id} member={m} depth={m.leadId && kept.some((k) => k.id === m.leadId) ? 2 : 1} teams={teams} compact={compact} focus={focusOf(m)} />
          ))}
        {proposed.length > 0 && (
          <div className="org-sub" role="presentation">
            {t('org.proposedSection')}
          </div>
        )}
        {proposed.map((m) => (
          <MemberRow key={m.id} member={m} depth={1} teams={teams} compact={compact} focus={focusOf(m)} />
        ))}
      </div>
      <div className="sec arena-sec">
        <span>{t('bots.teams')}</span>
        <button className="new-btn" onClick={() => showOnChart()}>
          + {t('bots.newTeam')}
        </button>
      </div>
      <div className="tree bots-teams" role="list">
        {teams.length === 0 && !elsewhere.length && <p className="empty">{orgProject ? t('org.noAssignmentsIn', { project: projectName }) : t('bots.noTeams')}</p>}
        {[...teams, ...elsewhere].map((team) => (
          <div
            key={team.id}
            role="listitem"
            tabIndex={0}
            data-row
            aria-current={team.id === activeTeamId}
            className={`task-row${team.id === activeTeamId ? ' sel' : ''}${elsewhere.includes(team) ? ' elsewhere' : ''}`}
            onClick={() => openTeam(team)}
            onKeyDown={(e) => rowKeys(e, () => openTeam(team))}
            onContextMenu={teamMenu(team)}
          >
            <div className="task-row-top">
              <span className={`team-state ts-${teamState(team)}`}>{t(`bots.team.${teamState(team)}`)}</span>
              {team.plan?.status === 'pending' && <span className="task-row-plan">{t('bots.planWaiting')}</span>}
              <span className="r">{relativeTime(team.updatedAt, locale)}</span>
            </div>
            <div className="task-row-title" title={team.goal}>
              {team.title || team.goal}
            </div>
            <div className="task-row-meta">
              <span title={team.cwd}>
                📁 {folderName(team.cwd)} · {t('bots.count', { n: team.bots.length })}
                {teamCost(team) > 0 && ` · ${money(teamCost(team), locale)}`}
              </span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** The instructions the coordinator and every agent get; saved as you type. */
function OrgInstructions() {
  const t = useT();
  const org = useStore((s) => s.orgSettings);
  const saved = org?.instructions ?? '';
  const [text, setText] = useState(saved);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const touched = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!touched.current) setText(saved);
  }, [saved]);
  const save = async (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (value.trim() === (useStore.getState().orgSettings?.instructions ?? '').trim()) return;
    setState('saving');
    try {
      const next = await window.alchemist.saveOrgSettings({ instructions: value });
      useStore.setState({ orgSettings: next });
      touched.current = false;
      setState('saved');
    } catch (e) {
      setState('idle');
      toast(errorText(e));
    }
  };
  // Leaving the screen saves what was typed.
  useEffect(
    () => () => {
      if (timer.current && touched.current) void save(textRef.current);
    },
    [],
  );
  const textRef = useRef(text);
  textRef.current = text;
  return (
    <section className="org-instructions" aria-label={t('org.instructions')}>
      <div className="org-instructions-head">
        <h3>{t('org.instructions')}</h3>
        <span className="composer-note" aria-live="polite">
          {state === 'saving' ? t('org.saving') : state === 'saved' ? t('org.savedCheck') : ''}
        </span>
      </div>
      <p className="composer-note">{t('org.instructionsHint')}</p>
      <textarea
        rows={5}
        value={text}
        placeholder={t('org.instructionsPlaceholder')}
        onChange={(e) => {
          touched.current = true;
          setText(e.target.value);
          setState('idle');
          if (timer.current) clearTimeout(timer.current);
          const value = e.target.value;
          timer.current = setTimeout(() => void save(value), 800);
        }}
        onBlur={() => void save(text)}
      />
    </section>
  );
}

/** Assignments worth watching on the chart: the ones needing you, working, or ready for your review. */
const WATCH = ['waiting', 'working', 'yourTurn'];

/**
 * Which assignment the chart shows: the ones in progress as tabs, and what the chosen one needs from
 * you. A plan waiting for you is approved right here, with its tasks showing on the agents' cards.
 */
function ChartFocus({ teams, focus }: { teams: BotTeam[]; focus: BotTeam | undefined }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const watching = teams.filter((x) => WATCH.includes(teamState(x)) || x.id === focus?.id).slice(0, 8);
  if (!watching.length) return null;
  const state = focus ? teamState(focus) : null;
  const plan = focus?.plan?.status === 'pending' ? focus.plan : null;
  const summary = (focus?.finished?.summary ?? '').replace(/\s+/g, ' ').trim();
  return (
    <div className="oc-focus">
      <div className="oc-tabs" role="tablist" aria-label={t('org.onChart')}>
        <button role="tab" aria-selected={!focus} className={`f ${focus ? '' : 'on'}`} onClick={() => showOnChart(null)}>
          {t('org.wholeOrg')}
        </button>
        {watching.map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === focus?.id} className={`f oc-tab ${x.id === focus?.id ? 'on' : ''}`} onClick={() => showOnChart(x.id)} title={x.goal}>
            {['waiting', 'working'].includes(teamState(x)) && <span className={`org-dot st-${teamState(x)}`} aria-hidden />}
            <span className="oc-tab-title">{x.title || x.goal}</span>
          </button>
        ))}
      </div>
      {focus && state && (
        <div className={`oc-focus-card ${plan ? 'needs' : ''}`}>
          <div className="oc-focus-head">
            <span className={`team-state ts-${state}`}>{t(`bots.team.${state}`)}</span>
            <b title={focus.goal}>{focus.title || focus.goal}</b>
            <span className="ah-stats">
              {[t('bots.count', { n: plan ? plan.bots.length : focus.bots.length }), plan?.estimateUsd != null ? `≈ ${money(plan.estimateUsd, locale)}` : teamCost(focus) > 0 ? money(teamCost(focus), locale) : ''].filter(Boolean).join(' · ')}
            </span>
            <button className="link small" onClick={() => openAssignment(focus)}>
              {t('org.openAssignment')} →
            </button>
          </div>
          {plan ? (
            <>
              {plan.summary && <p className="oc-focus-text">{plan.summary}</p>}
              <div className="oc-focus-actions">
                <span className="composer-note">{t('org.planOnChart')}</span>
                <span className="composer-sp" />
                <button className="btn-ghost small" onClick={() => openAssignment(focus)}>
                  {t('org.planEdit')}
                </button>
                <button className="btn-ghost small" onClick={() => void askPlanChanges(focus)}>
                  {t('bots.planChanges')}…
                </button>
                <button className="btn-send" disabled={!plan.bots.length} onClick={() => void approvePlan(focus)}>
                  ✓ {t('bots.planApprove', { n: plan.bots.length })}
                </button>
              </div>
            </>
          ) : summary ? (
            <p className="oc-focus-text">{summary}</p>
          ) : (
            state === 'working' && focus.bots.length === 1 && <p className="composer-note">{t('org.structuring', { name: focus.bots[0]!.name })}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Nothing selected: the organization at work. One box to write what you need (the coordinator hands it
 * out), what needs you, and the chart of who does what.
 */
function OrgHome() {
  const t = useT();
  const configs = useStore((s) => s.botConfigs);
  const org = useStore((s) => s.orgSettings);
  const orgProject = useStore((s) => s.orgProject);
  const coordinator = configs.find((c) => c.kind === 'coordinator');
  const allTeams = useStore((s) => s.botTeams);
  const focus = useStore((s) => s.botTeams.find((x) => x.id === s.orgFocusTeamId));
  const teams = orgProject ? allTeams.filter((x) => inFolder(x, orgProject)) : allTeams;
  // The plan of the assignment on the chart is answered there, not twice.
  const inbox = useInbox(
    teams,
    configs.filter((c) => c.proposed && (!orgProject || inProject(c, orgProject))),
  ).filter((x) => !(x.kind === 'plan' && x.team.id === focus?.id));
  const agents = configs.filter((c) => c.kind !== 'coordinator' && !c.proposed && (!orgProject || inProject(c, orgProject))).length;
  const { urgent } = inboxGroups(inbox);
  return (
    <div className="org-home">
      <header className="org-home-head">
        <h2>{orgNameOf(org?.name, t)}</h2>
        {coordinator && (
          <p className="composer-note">
            ⚗ {coordinator.name} · {sourceOf(coordinator.agent.harnessId).label} · {modelName(t, coordinator.agent.model)} · {t('org.agentsN', { n: agents })}
          </p>
        )}
      </header>
      <OrgComposer coordinator={coordinator} examples={!allTeams.length} />
      {/* What blocks an agent goes first; suggestions can wait under the chart. */}
      {urgent > 0 && <Inbox items={inbox} />}
      <section className="oc-wrap" aria-label={t('org.chart')}>
        <div className="oc-top">
          <h3>{t('org.chart')}</h3>
          <span className="composer-note">{t('org.chartHint')}</span>
          <span className="composer-sp" />
          {coordinator && (
            <button className="btn-ghost small" onClick={() => useStore.setState({ botConfigDialog: true })}>
              + {t('org.addAgent')}
            </button>
          )}
        </div>
        <ChartFocus teams={teams} focus={focus} />
        <OrgChart cwd={orgProject} focus={focus} />
      </section>
      {urgent === 0 && <Inbox items={inbox} />}
      <OrgInstructions />
    </div>
  );
}

/** An agent's profile: what it needs from you, what it is and does (editable), and its assignments. */
function MemberPanel({ member }: { member: BotConfig }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const teams = useStore((s) => s.botTeams);
  const org = useStore((s) => s.orgSettings);
  const coordinator = useStore((s) => s.botConfigs.find((c) => c.kind === 'coordinator'));
  const { draft, set, clear, dirty } = useDraft(member);
  const lead = member.kind === 'coordinator';
  const a = activityOf(member, teams);
  const openTeam = (team: BotTeam) => useStore.setState({ activeTeamId: team.id, activeBotId: team.bots.find((b) => b.configId === member.id)?.id ?? team.bots[0]?.id ?? null, activeMemberId: null });
  const save = async (extra: Partial<BotConfig> = {}, message = t('org.saved')) => {
    if (!draft.agent) return;
    try {
      await window.alchemist.saveBotConfig({ ...member, ...draft, agent: draft.agent, ...extra });
      clear();
      await useStore.getState().loadBots();
      toast(message, undefined, 2500);
    } catch (e) {
      toast(errorText(e));
    }
  };
  const remove = async () => {
    clear();
    if (member.proposed) return void dismissMember(member);
    await removeMember(member);
  };
  // Its track record, from the assignments it took part in.
  let done = 0;
  let failed = 0;
  let last = 0;
  for (const team of a.involved) {
    last = Math.max(last, team.updatedAt);
    for (const b of team.bots.filter((x) => x.configId === member.id)) {
      if (b.status === 'error') failed++;
      else if (b.status === 'done' || b.status === 'idle') done++;
    }
  }
  // In the header: what it's busy with, in words (waiting on you vs working), not a bare count.
  const stats = [a.waiting ? t('org.waitingN', { n: a.waiting }) : '', a.working ? t('org.workingN', { n: a.working }) : ''].filter(Boolean).join(' · ');
  const pill = member.proposed ? 'proposed' : a.status;
  const instructions = (org?.instructions ?? '').trim();
  const kind = lead ? t('org.kindCoordinator') : t('org.kindAgent');
  const tiles = [
    { label: t('org.statAssignments'), value: String(a.involved.length) },
    { label: t('org.statDone'), value: String(done), tone: done ? 'ok' : '' },
    { label: t('org.statFailed'), value: String(failed), tone: failed ? 'bad' : '' },
    { label: t('org.statCost'), value: a.cost > 0 ? money(a.cost, locale) : '—' },
    { label: t('org.statLast'), value: last ? relativeTime(last, locale) : '—' },
  ];
  return (
    <section className="team-view org-member-panel">
      <header className="team-head">
        <button className="icon-btn ic-btn" onClick={() => showOnChart()} title={t('org.backToChart')} aria-label={t('org.backToChart')}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <div className="team-title">
          <span className={`team-state ts-${pill === 'idle' ? 'idle' : pill}`}>{member.proposed ? t('org.proposed') : t(`org.status.${a.status}`)}</span>
          <h1>{member.name}</h1>
        </div>
        {/* The kind says nothing new when the agent is called the same ("Coordinator"). */}
        {kind.toLowerCase() !== member.name.trim().toLowerCase() && <span className="ac">{kind}</span>}
        {stats && <span className="ah-stats">{stats}</span>}
        {!member.proposed && (
          <button className="btn-send" onClick={() => giveTask(member)}>
            ⚗ {lead ? t('bots.newTeam') : t('org.giveTask', { name: member.name })}
          </button>
        )}
      </header>
      <div className="org-member-body">
        {a.needs.map((n) => (
          <div key={n.team.id} className="org-need-card" role="status">
            <span className="org-dot st-waiting" aria-hidden />
            <span className="org-need-text">
              <b>{needText(n, t)}</b>
              <small>{n.team.title || n.team.goal}</small>
            </span>
            <button className="btn-send" onClick={() => openTeam(n.team)}>
              {n.kind === 'plan' ? t('org.review') : t('org.answer')}
            </button>
          </div>
        ))}
        {member.proposed && (
          <div className="org-proposed">
            <span>{t('org.proposedHint')}</span>
            <span className="composer-sp" />
            <button className="btn-ghost small" onClick={() => void remove()}>
              {t('org.dismiss')}
            </button>
            <button className="btn-send" onClick={() => void save({ proposed: false }, t('org.joined', { name: draft.name || member.name }))}>
              {t('org.keep')}
            </button>
          </div>
        )}
        {lead ? <p className="composer-note">{t('org.coordinatorHint')}</p> : <TeamSection member={member} coordinatorName={coordinator?.name ?? ''} />}
        {a.status === 'working' && a.doing && <p className="org-doing">◐ {doingText(a.doing, t).text}</p>}
        <div className="org-stats" role="list" aria-label={t('org.record')}>
          {tiles.map((x) => (
            <div key={x.label} className={`org-stat ${x.tone ?? ''}`} role="listitem">
              <b>{x.value}</b>
              <span>{x.label}</span>
            </div>
          ))}
        </div>
        <section className="org-assignments" aria-label={t('org.assignmentsOf')}>
          <h4>{t('org.assignmentsOf')}</h4>
          {a.involved.length ? (
            <ul>
              {a.involved.map((team) => {
                // Its own result first: the assignment can be finished while this agent failed in it.
                const res = resultIn(team, team.bots.filter((b) => b.configId === member.id));
                return (
                  <li key={team.id}>
                    <button className="org-assignment" onClick={() => openTeam(team)}>
                      <span className={`org-result st-${res}`}>{t(`org.here.${res}`)}</span>
                      <span className="org-assignment-title">{team.title || team.goal}</span>
                      <small className="org-assignment-state">{t(`bots.team.${teamState(team)}`)}</small>
                      <span className="r">{relativeTime(team.updatedAt, locale)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="empty">{t('org.noMemberAssignments')}</p>
          )}
        </section>
        <section className="org-form" aria-label={t('org.settings')}>
          <h4>{t('org.settings')}</h4>
          <MemberForm key={member.id} draft={draft} set={set} coordinator={lead} />
          <div className="bots-actions">
            {!lead && !member.proposed && (
              <button className="btn-ghost small danger" onClick={() => void remove()}>
                {t('org.deleteAgent')}
              </button>
            )}
            {dirty && (
              <button className="btn-ghost small" onClick={clear}>
                {t('dialog.cancel')}
              </button>
            )}
            <span className="composer-sp" />
            {dirty && <span className="composer-note">{t('org.unsaved')}</span>}
            <button className="btn-send" disabled={!dirty || !draft.name.trim() || !draft.agent} onClick={() => void save()}>
              {t('org.save')}
            </button>
          </div>
        </section>
        {lead ? (
          <OrgInstructions />
        ) : (
          <details className="org-also">
            <summary>
              <span>{t('org.receives', { name: draft.name || member.name })}</span>
              <small className="org-also-preview">{t('org.receivesPreview')}</small>
            </summary>
            <div className="org-receives">
              <h5>
                {t('org.instructions')}
                <button className="link small" onClick={() => useStore.setState({ activeMemberId: coordinator?.id ?? null })}>
                  {t('org.edit')}
                </button>
              </h5>
              <p>{instructions || t('org.noInstructions')}</p>
              <h5>{t('org.receivesRole')}</h5>
              <p>{draft.role.trim() || '—'}</p>
              <p className="composer-note">{t('org.receivesTask')}</p>
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

/** The organization view: an assignment, an agent's profile, or the home screen. */
/** Who an agent reports to, and its own team (a top-level agent can lead one). */
function TeamSection({ member, coordinatorName }: { member: BotConfig; coordinatorName: string }) {
  const t = useT();
  const configs = useStore((s) => s.botConfigs);
  const lead = member.leadId ? configs.find((c) => c.id === member.leadId) : undefined;
  const team = configs.filter((c) => c.leadId === member.id && !c.proposed);
  const open = (c: BotConfig) => useStore.setState({ activeMemberId: c.id, activeTeamId: null, activeBotId: null });
  if (member.proposed) return coordinatorName ? <p className="composer-note">{t('org.reportsTo', { name: coordinatorName })}</p> : null;
  if (lead)
    return (
      <div className="org-team">
        <span className="composer-note">
          {t('org.onTeamLong', { name: lead.name })}{' '}
          <button className="link small" onClick={() => open(lead)}>
            {t('org.openLead', { name: lead.name })}
          </button>
        </span>
        <button className="btn-ghost small" onClick={() => void setLead(member, null)}>
          {t('org.leaveTeam', { name: lead.name })}
        </button>
      </div>
    );
  return (
    <section className="org-team-sec" aria-label={t('org.team')}>
      <h4>
        {t('org.team')} <small>{coordinatorName && t('org.reportsTo', { name: coordinatorName })}</small>
      </h4>
      <div className="org-team-list">
        {team.map((c) => (
          <span key={c.id} className="org-team-chip">
            <button className="link" onClick={() => open(c)} title={c.role || undefined}>
              {c.name}
            </button>
            <button className="org-team-x" onClick={() => void setLead(c, null)} title={t('org.removeFromTeam', { name: c.name })} aria-label={t('org.removeFromTeam', { name: c.name })}>
              <Icon name="close" size={11} />
            </button>
          </span>
        ))}
        <button className="btn-ghost small" onClick={() => void addToTeam(member, configs)}>
          <Icon name="plus" size={12} /> {t('org.addToTeam')}
        </button>
      </div>
      {!team.length && <p className="composer-note">{t('org.teamEmpty', { name: member.name })}</p>}
    </section>
  );
}

export function OrgView() {
  const team = useStore((s) => s.botTeams.find((x) => x.id === s.activeTeamId));
  const member = useStore((s) => s.botConfigs.find((c) => c.id === s.activeMemberId));
  // Opened from the sidebar or from the chart; with a lead, the new agent goes on that lead's team.
  const adding = useStore((s) => s.botConfigDialog);
  return (
    <>
      {team ? <TeamView team={team} /> : member ? <MemberPanel key={member.id} member={member} /> : <OrgHome />}
      {adding && <AddAgentDialog leadId={typeof adding === 'object' ? adding.leadId : null} onClose={() => useStore.setState({ botConfigDialog: false })} />}
    </>
  );
}
