import { useEffect, useRef, useState } from 'react';
import type { BotConfig, BotTeam } from '@shared/api';
import { addToTeam, changeAvatar, giveTask, openAssignment, openMember, removeMember, renameMember, setLead } from '../actions/org';
import { AgentAvatar } from './AgentAvatar';
import { money, modelLabel } from '../format';
import { activityOf, canMove, chartOf, extrasIn, inFolder, workIn, type CardWork } from '../org-model';
import { baseName } from '../paths';
import { sourceOf } from '../sources';
import { useStore, useT } from '../store';
import { contextMenu } from '../ui';
import { doingText } from './Bots';
import { Icon } from './Icon';

type T = ReturnType<typeof useT>;

/** Below this width per top-level agent, the chart stacks instead of spreading them in a row. */
const MIN_COLUMN = 150;

/** An agent's first sentence of role, to say what it is in a line. */
const roleLine = (role: string) => role.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0]?.slice(0, 110) ?? '';
const workLabel = (work: CardWork, t: T) => (work.state === 'planned' ? t('org.work.planned') : t(`org.here.${work.state}`));

/** What the chart knows while you drag an agent: who it is, and the card it's over. */
interface Drag {
  id: string | null;
  over: string | null;
  set(patch: Partial<Pick<Drag, 'id' | 'over'>>): void;
}

/**
 * One agent on the chart. Without an assignment showing: its state across all of them (what it needs
 * from you, what it's doing, or its role). With one: its task there and how that is going.
 */
function Card({ member, teams, focus, drag, hasTeam }: { member: BotConfig; teams: BotTeam[]; focus: BotTeam | undefined; drag: Drag; hasTeam: boolean }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const configs = useStore((s) => s.botConfigs);
  const unsaved = useStore((s) => !!s.orgDrafts[member.id]);
  const lead = member.kind === 'coordinator';
  const teamLead = !member.proposed && !lead && !member.leadId;
  const onTeamOf = member.leadId ? configs.find((c) => c.id === member.leadId) : undefined;
  const a = activityOf(member, teams);
  const work = focus ? workIn(focus, member) : null;
  const need = a.needs[0];
  const doing = work?.doing ?? (!focus && a.status === 'working' ? a.doing : null);
  // With an assignment showing, the card is about that assignment; otherwise about everything it's in.
  const state = focus ? (work ? work.state : 'out') : a.status;
  const busy = state === 'working' || state === 'waiting';
  const dragged = drag.id ? configs.find((c) => c.id === drag.id) : undefined;
  const dropOk = !!dragged && canMove(dragged, member, configs);
  const movable = !lead && !member.proposed && !hasTeam;
  const open = () => (focus && work?.botId ? openAssignment(focus, work.botId) : openMember(member));
  // Where it could go: each other team, or back under the coordinator.
  const destinations = configs.filter((c) => c.kind !== 'coordinator' && canMove(member, c, configs));
  const scope = member.projects?.length ? `${baseName(member.projects[0]!)}${member.projects.length > 1 ? ` +${member.projects.length - 1}` : ''}` : '';
  const status = focus ? (work ? workLabel(work, t) : t('org.work.out')) : t(`org.status.${a.status}`);
  return (
    <div
      role="button"
      tabIndex={0}
      data-card
      aria-label={[member.name, status, work?.task ?? ''].filter(Boolean).join(' · ')}
      className={`oc-card st-${state} ${lead ? 'oc-lead' : ''} ${member.proposed ? 'oc-dashed' : ''} ${dropOk ? 'drop-ok' : ''} ${dropOk && drag.over === member.id ? 'drop-over' : ''} ${drag.id === member.id ? 'oc-dragged' : ''}`}
      title={member.role || undefined}
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', member.name);
        drag.set({ id: member.id });
      }}
      onDragEnd={() => drag.set({ id: null, over: null })}
      onDragOver={(e) => {
        if (!dropOk) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (drag.over !== member.id) drag.set({ over: member.id });
      }}
      onDragLeave={() => drag.over === member.id && drag.set({ over: null })}
      onDrop={(e) => {
        e.preventDefault();
        drag.set({ id: null, over: null });
        if (dragged && dropOk) void setLead(dragged, lead ? null : member);
      }}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        open();
      }}
      onContextMenu={contextMenu(
        () => [
          { id: 'profile', label: t('org.openProfile') },
          ...(member.proposed ? [] : [{ id: 'task', label: lead ? t('bots.newTeam') : t('org.giveTask', { name: member.name }) }]),
          { type: 'separator' as const },
          { id: 'rename', label: `${t('org.renameAgent')}…` },
          { id: 'avatar', label: `${t('avatar.change')}…` },
          ...(lead ? [{ id: 'add-org', label: `${t('org.addAgent')}…` }] : teamLead ? [{ id: 'add-team', label: `${t('org.addToTeam')}…` }] : []),
          ...(movable && destinations.length ? [{ id: 'move', label: t('org.moveTo'), submenu: destinations.map((c) => ({ id: `to:${c.id}`, label: t('org.teamOf', { name: c.name }) })) }] : []),
          ...(onTeamOf ? [{ id: 'leave', label: t('org.leaveTeam', { name: onTeamOf.name }) }] : []),
          ...(lead ? [] : [{ type: 'separator' as const }, { id: 'delete', label: t('org.deleteAgent') }]),
        ],
        (id) => {
          if (id === 'profile') openMember(member);
          if (id === 'task') giveTask(member);
          if (id === 'rename') void renameMember(member);
          if (id === 'avatar') void changeAvatar(member);
          if (id === 'add-org') useStore.setState({ botConfigDialog: true });
          if (id === 'add-team') void addToTeam(member, configs);
          if (id === 'leave') void setLead(member, null);
          if (id === 'delete') void removeMember(member);
          const to = id.startsWith('to:') ? configs.find((c) => c.id === id.slice(3)) : undefined;
          if (to) void setLead(member, to);
        },
      )}
    >
      <div className="oc-head">
        <AgentAvatar name={member.name} avatar={member.avatar} size={28} state={state === 'working' ? 'working' : state === 'waiting' ? 'waiting' : state === 'error' ? 'error' : null} label={status} />
        <b className="oc-name">
          {member.name}
          {unsaved && (
            <span className="org-unsaved" title={t('org.unsaved')} aria-label={t('org.unsaved')}>
              {' '}
              •
            </span>
          )}
        </b>
        {member.proposed ? (
          <span className="bot-badge proposed">{t('org.proposed')}</span>
        ) : (
          <span className="org-model" title={`${sourceOf(member.agent.harnessId).label} · ${member.agent.model === 'default' ? t('run.defaultModel') : modelLabel(member.agent.model)}`}>
            {sourceOf(member.agent.harnessId).glyph}
          </span>
        )}
      </div>
      {work ? (
        <>
          <p className="oc-task">{work.task}</p>
          <small className={`oc-line st-${work.state}`}>
            {doing ? doingText(doing, t).text : workLabel(work, t)}
            {work.more > 0 && ` · ${t('org.moreN', { n: work.more })}`}
            {work.costUsd != null && ` · ${money(work.costUsd, locale)}`}
          </small>
        </>
      ) : !focus && need ? (
        <small className="oc-line st-waiting" title={need.team.title || need.team.goal}>
          {need.kind === 'plan' ? t('bots.planWaiting') : need.detail || t('org.needAsk')}
          {a.needs.length > 1 && ` · ${t('org.moreN', { n: a.needs.length - 1 })}`}
        </small>
      ) : doing ? (
        <small className="oc-line st-working">{doingText(doing, t).text}</small>
      ) : (
        member.role && <small className="oc-role">{roleLine(member.role)}</small>
      )}
      {scope && !work && (
        <span className="org-scope" title={member.projects!.join('\n')}>
          {scope}
        </span>
      )}
      {(lead || teamLead) && (
        <button
          className="oc-add"
          onClick={(e) => {
            e.stopPropagation();
            if (lead) useStore.setState({ botConfigDialog: true });
            else void addToTeam(member, configs);
          }}
          title={lead ? t('org.addAgent') : t('org.addToTeamOf', { name: member.name })}
          aria-label={lead ? t('org.addAgent') : t('org.addToTeamOf', { name: member.name })}
        >
          <Icon name="plus" size={12} />
        </button>
      )}
    </div>
  );
}

/** An agent of the assignment that isn't in the organization: the coordinator defined it on the spot. */
function ExtraCard({ name, role, work, focus }: { name: string; role: string; work: CardWork; focus: BotTeam }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const busy = work.state === 'working' || work.state === 'waiting';
  const status = workLabel(work, t);
  const open = () => openAssignment(focus, work.botId);
  return (
    <div
      role="button"
      tabIndex={0}
      data-card
      aria-label={[name, status, work.task].join(' · ')}
      className={`oc-card oc-dashed st-${work.state}`}
      title={role || undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        open();
      }}
    >
      <div className="oc-head">
        <AgentAvatar name={name} size={28} state={work.state === 'working' ? 'working' : work.state === 'waiting' ? 'waiting' : work.state === 'error' ? 'error' : null} label={status} />
        <b className="oc-name">{name}</b>
        <span className="bot-badge" title={t('bots.definedHere')}>
          {t('org.work.new')}
        </span>
      </div>
      <p className="oc-task">{work.task}</p>
      <small className={`oc-line st-${work.state}`}>
        {work.doing ? doingText(work.doing, t).text : status}
        {work.costUsd != null && ` · ${money(work.costUsd, locale)}`}
      </small>
    </div>
  );
}

/**
 * The organization as a chart you can work on: the coordinator, the agents that report to it and each
 * one's team, with what everyone is doing right now. A click opens an agent; dragging one onto another
 * puts it on that team (onto the coordinator: back under it). With an assignment showing, each card
 * says what that agent does in it.
 */
export function OrgChart({ cwd, focus }: { cwd: string; focus: BotTeam | undefined }) {
  const t = useT();
  const configs = useStore((s) => s.botConfigs);
  const allTeams = useStore((s) => s.botTeams);
  const teams = cwd ? allTeams.filter((x) => inFolder(x, cwd)) : allTeams;
  const { coordinator, leads, proposed } = chartOf(configs, cwd);
  const extras = focus ? extrasIn(focus, configs) : [];
  const columns = leads.length + proposed.length + extras.length;
  const [dragState, setDragState] = useState<{ id: string | null; over: string | null }>({ id: null, over: null });
  const drag: Drag = { ...dragState, set: (patch) => setDragState((d) => ({ ...d, ...patch })) };
  // Spread in a row while every agent keeps a readable column; stacked otherwise (half a screen, many agents).
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const row = width === 0 || width >= columns * MIN_COLUMN;
  const busyIn = (ids: BotConfig[]) => ids.some((m) => (focus ? ['working', 'waiting'].includes(workIn(focus, m)?.state ?? '') : activityOf(m, teams).status !== 'idle'));
  if (!coordinator) return <p className="empty">{t('org.setup')}</p>;
  return (
    <div className={`oc ${row ? 'oc-row' : 'oc-stack'} ${columns ? '' : 'oc-alone'} ${dragState.id ? 'oc-dragging' : ''}`} ref={box} role="group" aria-label={t('org.chart')}>
      <div className="oc-root">
        <Card member={coordinator} teams={teams} focus={focus} drag={drag} hasTeam />
      </div>
      {columns > 0 && (
        <ul className="oc-leads">
          {leads.map(({ member, team }) => (
            <li key={member.id} className={`oc-col ${busyIn([member, ...team]) ? 'oc-live' : ''}`}>
              <Card member={member} teams={teams} focus={focus} drag={drag} hasTeam={team.length > 0} />
              {team.length > 0 && (
                <ul className="oc-team">
                  {team.map((m) => (
                    <li key={m.id} className={busyIn([m]) ? 'oc-live' : ''}>
                      <Card member={m} teams={teams} focus={focus} drag={drag} hasTeam={false} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
          {extras.map((x) => (
            <li key={x.key} className={`oc-col ${x.work.state === 'working' || x.work.state === 'waiting' ? 'oc-live' : ''}`}>
              <ExtraCard name={x.name} role={x.role} work={x.work} focus={focus!} />
            </li>
          ))}
          {proposed.map((m) => (
            <li key={m.id} className="oc-col">
              <Card member={m} teams={teams} focus={focus} drag={drag} hasTeam={false} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
