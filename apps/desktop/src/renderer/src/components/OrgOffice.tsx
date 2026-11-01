import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BotConfig, BotTeam } from '@shared/api';
import { dismissMember, keepMember, openAssignment } from '../actions/org';
import { relativeTime } from '../format';
import { baseName, isInside } from '../paths';
import { aboutOf, activityOf, inFolder, teamState } from '../org-model';
import { channelOf, countsOf, isDemo, waitingBot, departmentsOf, latestTeam, projectsOf, type Department, type OfficeAgent, type OfficeMember, type OfficeProject, type OfficeState } from '../org-office';
import { useOpenProjects, useStore, useT } from '../store';
import { confirmAction, toast } from '../ui';
import { AgentAvatar } from './AgentAvatar';
import { doingText } from './Bots';
import { OrgChat } from './OrgChat';
import { OrgComposer } from './OrgComposer';
import { CardWrite } from './OrgLive';

type T = ReturnType<typeof useT>;

/** The floor is read again this often, so finished work leaves it after a day without a reload. */
const TICK_MS = 60_000;
/** The coordinator, as the box's default recipient. */
const COORDINATOR = '';

/** The office's state words reuse the live view's ("Working", "Waiting for you", "Finished", "Error"). */
const LIVE: Record<OfficeState, 'working' | 'waiting' | 'done' | 'error'> = { working: 'working', waiting: 'waiting', done: 'done', failed: 'error' };
const MARK: Partial<Record<OfficeState, string>> = { waiting: '?', failed: '!', done: '✓' };

/** "2 working · 1 waiting for you · 3 finished", leaving out what's zero. */
function countText(c: Record<OfficeState, number>, t: T) {
  return [
    c.working ? t('org.workingN', { n: c.working }) : '',
    c.waiting ? t('org.waitingN', { n: c.waiting }) : '',
    c.done ? t('org.office.doneN', { n: c.done }) : '',
    c.failed ? t('org.office.failedN', { n: c.failed }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One agent on the floor: the person at its desk (busy, asking, done), its name, its state in words and its task. */
function FloorDesk({ a, onOpen }: { a: OfficeAgent; onOpen: (a: OfficeAgent) => void }) {
  const t = useT();
  const state = LIVE[a.state];
  const status = t(`org.live.st.${state}`);
  const line = (a.doing ? doingText(a.doing, t).text : '') || a.task;
  return (
    <button className={`of-desk ofc-desk st-${state} ${a.coordinator ? 'of-lead' : ''}`} aria-label={[a.name, status, line, a.team.title || a.team.goal].filter(Boolean).join(' · ')} title={a.team.title || a.team.goal} onClick={() => onOpen(a)}>
      <span className="of-person">
        <AgentAvatar name={a.name} avatar={a.avatar} size={36} />
        {MARK[a.state] && (
          <i className={`of-mark st-${state}`} aria-hidden>
            {MARK[a.state]}
          </i>
        )}
      </span>
      <span className="of-table" aria-hidden>
        <span className="of-screen">
          <i />
          <i />
          <i />
        </span>
      </span>
      <b className="of-name">
        {a.coordinator && <span aria-hidden>⚗ </span>}
        {a.name}
      </b>
      <span className={`lv-state st-${state}`}>{status}</span>
      <small className="of-line">{line}</small>
    </button>
  );
}

/** A project on the floor: its name and counts, its agents at their desks, and its assignments. */
function ProjectRoom({ p, onOpen }: { p: OfficeProject; onOpen: (a: OfficeAgent) => void }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  return (
    <section className="ofc-room" aria-label={p.name}>
      <header className="ofc-room-head">
        <h4 title={p.cwd}>📁 {p.name}</h4>
        <span className="composer-note">{countText(p.counts, t)}</span>
      </header>
      <div className="ofc-desks">
        {p.agents.map((a) => (
          <FloorDesk key={a.key} a={a} onOpen={onOpen} />
        ))}
      </div>
      <ul className="ofc-teams" aria-label={t('org.office.assignments')}>
        {p.teams.map((x) => (
          <li key={x.id}>
            {/* One that waits for you opens on whoever waits: its plan, or the agent asking. */}
            <button className="ofc-team" onClick={() => openAssignment(x, waitingBot(x)?.id)} title={x.goal}>
              <span className={`team-state ts-${teamState(x)}`}>{t(`bots.team.${teamState(x)}`)}</span>
              <span className="ofc-team-title">{x.title || x.goal}</span>
              <span className="r">{relativeTime(x.updatedAt, locale)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** An agent in its department's list: its picture with its state, its name and what it does. */
function MemberLine({ m, open, onOpen }: { m: OfficeMember; open: boolean; onOpen: (member: BotConfig, from: HTMLElement) => void }) {
  const t = useT();
  const status = t(`org.status.${m.status}`);
  return (
    <li>
      <button className={`ofc-member ${open ? 'on' : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={(e) => onOpen(m.member, e.currentTarget)} title={m.member.role || undefined}>
        <AgentAvatar name={m.member.name} avatar={m.member.avatar} size={22} state={m.status === 'idle' ? null : m.status} label={status} />
        <span className="ofc-member-text">
          <b>
            {m.member.kind === 'coordinator' && <span aria-hidden>⚗ </span>}
            {m.member.name}
          </b>
          <small>{m.member.proposed ? t('org.proposed') : m.status === 'idle' ? aboutOf(m.member) : status}</small>
        </span>
      </button>
    </li>
  );
}

/**
 * An agent's settings in a sheet beside the office: what it is on now, a way to write to it, and
 * the same form as its profile (saved through the same checks).
 */
function Sheet({ member, floor, editor, onWrite, onClose }: { member: BotConfig; floor: OfficeAgent[]; editor: (member: BotConfig) => ReactNode; onWrite: () => void; onClose: () => void }) {
  const t = useT();
  const box = useRef<HTMLElement>(null);
  const teams = useStore((s) => s.botTeams);
  const status = activityOf(member, teams).status;
  useEffect(() => box.current?.focus(), [member.id]);
  // Escape closes it from inside it (a menu or a picker that used the key keeps it); Tab stays in it.
  const onKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const all = [...(box.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])') ?? [])].filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null);
    const [first, last] = [all[0], all[all.length - 1]];
    if (!first || !last) return;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const mine = floor.filter((a) => a.configId === member.id);
  return (
    <aside className="ofc-sheet" role="dialog" aria-modal="true" aria-label={t('org.office.settingsOf', { name: member.name })} tabIndex={-1} ref={box} onKeyDown={onKey}>
      <header className="ofc-sheet-head">
        <AgentAvatar name={member.name} avatar={member.avatar} size={30} />
        <b>{member.name}</b>
        <span className={`lv-state st-${status === 'idle' ? 'out' : status}`}>{member.proposed ? t('org.proposed') : t(`org.status.${status}`)}</span>
        <button className="of-close" onClick={onClose} aria-label={t('org.office.close')} title={t('org.office.close')}>
          ✕
        </button>
      </header>
      <div className="ofc-sheet-body">
        {member.proposed && (
          <div className="org-proposed">
            <span>{t('org.proposedHint')}</span>
            <span className="composer-sp" />
            <button className="btn-ghost small" onClick={() => (isDemo(member.id) ? toast(t('org.office.demoNoSave'), undefined, 3000) : (onClose(), void dismissMember(member)))}>
              {t('org.dismiss')}
            </button>
            <button className="btn-send" onClick={() => (isDemo(member.id) ? toast(t('org.office.demoNoSave'), undefined, 3000) : void keepMember(member))}>
              {t('org.keep')}
            </button>
          </div>
        )}
        <h5>{t('org.office.now')}</h5>
        {mine.length ? (
          <ul className="ofc-now">
            {mine.map((a) => (
              <li key={a.key}>
                <span className={`lv-state st-${LIVE[a.state]}`}>{t(`org.live.st.${LIVE[a.state]}`)}</span>
                <span className="ofc-now-text">{(a.doing ? doingText(a.doing, t).text : '') || a.task}</span>
                <button className="link small" onClick={() => openAssignment(a.team, a.botId)}>
                  {t('org.openAssignment')} →
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="composer-note">{t('org.office.idle')}</p>
        )}
        {!member.proposed && (
          <button className="btn-ghost small ofc-write-to" onClick={onWrite}>
            ✎ {t('org.office.writeTo', { name: member.name })}
          </button>
        )}
        <h5>{t('org.settings')}</h5>
        {editor(member)}
      </div>
    </aside>
  );
}

/**
 * The box under the floor: to the coordinator (a new assignment, or the conversation of the one
 * that moved last) or to any agent (in the assignment it's in; none, the coordinator hands it over).
 */
function Talk({ to, setTo, configs, teams, floor, departments, coordinator }: { to: string; setTo: (id: string) => void; configs: BotConfig[]; teams: BotTeam[]; floor: OfficeAgent[]; departments: Department[]; coordinator: BotConfig | undefined }) {
  const t = useT();
  const allTeams = useStore((s) => s.botTeams);
  const [mode, setMode] = useState<'new' | 'chat'>('new');
  const focus = useStore((s) => s.botTeams.find((x) => x.id === s.orgFocusTeamId));
  const member = to ? configs.find((c) => c.id === to) : undefined;
  const channel = member ? channelOf(member, teams) : null;
  // Where its desk is, from the same floor: on an assignment it can't hear in, the coordinator passes it on.
  const desk = member ? floor.find((a) => a.configId === member.id && (a.state === 'working' || a.state === 'waiting')) : undefined;
  const latest = focus ?? latestTeam(teams);
  // Writing to an agent with nothing open: the box starts the assignment for it, as "Give it a task"
  // does. What it wrote goes when you pick someone else, unless you changed it; what you wrote stays.
  const prefilled = useRef<string | null>(null);
  useEffect(() => {
    const goal = useStore.getState().orgGoal;
    const next = member && !channel ? t('org.giveTaskGoal', { name: member.name }) : '';
    if (goal.trim() && goal !== prefilled.current) return;
    if (goal !== next) useStore.setState({ orgGoal: next });
    prefilled.current = next || null;
  }, [to]);
  const chat = !member && mode === 'chat' && !!latest;
  return (
    <section className="ofc-talk" aria-label={t('org.office.talk')}>
      <div className="ofc-to">
        <label htmlFor="ofc-to">{t('org.office.to')}</label>
        <select id="ofc-to" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value={COORDINATOR}>⚗ {coordinator?.name ?? t('org.kindCoordinator')}</option>
          {departments.map((d) => (
            <optgroup key={d.lead.id} label={d.lead.name}>
              {d.members.map((m) => (
                <option key={m.member.id} value={m.member.id}>
                  {m.member.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {!member && latest && (
          <div className="lv-view" role="group" aria-label={t('org.office.talk')}>
            {(['new', 'chat'] as const).map((v) => (
              <button key={v} aria-pressed={mode === v} className={mode === v ? 'on' : ''} onClick={() => setMode(v)}>
                {mode === v && <span aria-hidden>✓ </span>}
                {v === 'new' ? t('bots.newTeam') : t('org.chat.title')}
              </button>
            ))}
          </div>
        )}
        <span className="composer-note ofc-to-note">{member ? (channel ? t('org.office.inAssignment', { title: channel.team.title || channel.team.goal }) : desk ? t('org.office.onButVia', { title: desk.team.title || desk.team.goal }) : t('org.office.viaCoordinator')) : chat ? '' : t('org.office.toCoordinator')}</span>
      </div>
      {member && channel ? <CardWrite key={channel.bot.id} team={channel.team} bot={channel.bot} /> : chat ? <OrgChat team={latest} /> : <OrgComposer coordinator={coordinator} examples={!allTeams.length} />}
    </section>
  );
}

/** Which project the office shows, in sight: a menu with several open, else the filter's name with ✕. */
function ProjectFilter() {
  const t = useT();
  const orgProject = useStore((s) => s.orgProject);
  const open = useOpenProjects();
  const set = (orgProject: string) => useStore.setState({ orgProject });
  const name = open.find((p) => p.cwd === orgProject)?.name ?? (orgProject ? baseName(orgProject) : '');
  if (open.length > 1)
    return (
      <select className="org-filter ofc-filter" value={orgProject} aria-label={t('org.project')} onChange={(e) => set(e.target.value)}>
        <option value="">{t('org.allProjects')}</option>
        {orgProject && !open.some((p) => p.cwd === orgProject) && <option value={orgProject}>{name}</option>}
        {open.map((p) => (
          <option key={p.id} value={p.cwd}>
            {p.name}
          </option>
        ))}
      </select>
    );
  if (!orgProject) return null;
  return (
    <span className="ofc-filter-chip" title={orgProject}>
      📁 {name}
      <button className="of-close" onClick={() => set('')} aria-label={t('org.office.clearFilter', { name })} title={t('org.office.clearFilter', { name })}>
        ✕
      </button>
    </span>
  );
}

/**
 * The organization on one screen: the work going on now project by project, animated (who works,
 * who waits for you, what's done), the departments beside it with each agent's settings a click
 * away, and under the floor the box to write to the coordinator or to anyone.
 */
export function OrgOffice({ title, editor, views, callout }: { title: string; editor: (member: BotConfig) => ReactNode; views: ReactNode; callout: ReactNode }) {
  const t = useT();
  const configs = useStore((s) => s.botConfigs);
  const allTeams = useStore((s) => s.botTeams);
  const orgProject = useStore((s) => s.orgProject);
  const open = useOpenProjects();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const [sheet, setSheet] = useState<string | null>(null);
  const [to, setTo] = useState(COORDINATOR);
  // An agent that left the organization (deleted, dismissed) is no longer one to write to or look at.
  useEffect(() => {
    if (to && !configs.some((c) => c.id === to)) setTo(COORDINATOR);
  }, [configs, to]);
  const opener = useRef<HTMLElement | null>(null);
  const teams = orgProject ? allTeams.filter((x) => inFolder(x, orgProject)) : allTeams;
  const floor = projectsOf(allTeams, configs, open, now, orgProject);
  const counts = countsOf(floor);
  const { coordinator, departments, proposed } = departmentsOf(configs, teams, orgProject);
  const shown = sheet ? configs.find((c) => c.id === sheet) : undefined;
  const agents = floor.flatMap((p) => p.agents);
  // Leaving an agent with unsaved settings (closing, or opening another one) asks first; leaving drops them.
  const leave = async () => {
    const id = sheet;
    const draft = id ? useStore.getState().orgDrafts[id] : undefined;
    if (!id || !draft) return true;
    const name = configs.find((c) => c.id === id)?.name ?? '';
    if (!(await confirmAction({ title: t('org.office.discardTitle', { name }), message: t('org.office.discardHint'), confirmLabel: t('org.office.discard'), cancelLabel: t('org.office.keepEditing'), danger: true }))) return false;
    useStore.setState((st) => {
      const drafts = { ...st.orgDrafts };
      delete drafts[id];
      return { orgDrafts: drafts };
    });
    return true;
  };
  const openSheet = async (member: BotConfig, from: HTMLElement | null) => {
    if (!(await leave())) return;
    opener.current = from;
    setSheet((s) => (s === member.id ? null : member.id));
  };
  const closeSheet = async () => {
    if (!(await leave())) return;
    setSheet(null);
    opener.current?.focus();
  };
  // A desk opens its agent's settings; one the coordinator defined on the spot opens its assignment.
  const openDesk = (a: OfficeAgent) => {
    const member = a.configId ? configs.find((c) => c.id === a.configId) : undefined;
    if (member) void openSheet(member, document.activeElement as HTMLElement | null);
    else openAssignment(a.team, a.botId);
  };
  const writeTo = async (member: BotConfig) => {
    if (!(await leave())) return;
    setTo(member.kind === 'coordinator' ? COORDINATOR : member.id);
    setSheet(null);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.ofc-talk textarea')?.focus());
  };
  const summary = countText(counts, t);
  // The automations live in the detailed view's column: there, for now, without changing the view you keep.
  const automations = useStore((s) => (orgProject ? s.automations.filter((x) => isInside(x.automation.cwd, orgProject)) : s.automations).length);
  const showAutomations = () => {
    useStore.setState({ orgOffice: false, orgLive: false, orgMap: false });
    requestAnimationFrame(() => document.getElementById('org-automations')?.scrollIntoView({ block: 'start' }));
  };
  return (
    <div className={`ofc ${shown ? 'with-sheet' : ''}`}>
      <header className="ofc-head">
        <h2>{title}</h2>
        <span className="composer-note" aria-live="polite">
          {summary || t('org.office.nobody')}
        </span>
        {callout}
        <span className="composer-sp" />
        <ProjectFilter />
        <button className="btn-ghost small" onClick={showAutomations} title={t('auto.title')}>
          ⚡ {t('auto.title')}
          {automations > 0 && ` · ${automations}`}
        </button>
        {views}
      </header>
      <div className="ofc-main">
        <section className="ofc-stage" aria-label={t('org.office.floor')}>
          {floor.length ? (
            floor.map((p) => <ProjectRoom key={p.cwd} p={p} onOpen={openDesk} />)
          ) : (
            <div className="ofc-empty">
              <span className="ofc-empty-art" aria-hidden>
                ☕
              </span>
              <b>{t('org.office.nobody')}</b>
              <p className="composer-note">{allTeams.length ? t('org.office.nobodyHint') : t('org.office.noProjects')}</p>
            </div>
          )}
        </section>
        <Talk to={to} setTo={setTo} configs={configs} teams={teams} floor={agents} departments={departments} coordinator={coordinator?.member} />
      </div>
      <aside className="ofc-depts" aria-label={t('org.office.departments')}>
        <h3>{t('org.office.departments')}</h3>
        {!coordinator && <p className="empty">{t('org.setup')}</p>}
        {coordinator && (
          <ul className="ofc-dept-list">
            <MemberLine m={coordinator} open={sheet === coordinator.member.id} onOpen={openSheet} />
          </ul>
        )}
        {departments.map((d) => (
          <section key={d.lead.id} className="ofc-dept" aria-label={d.lead.name}>
            <h4>
              <span>{d.lead.name}</span>
              {(d.working > 0 || d.waiting > 0) && <small>{countText({ working: d.working, waiting: d.waiting, done: 0, failed: 0 }, t)}</small>}
            </h4>
            <ul className="ofc-dept-list">
              {d.members.map((m) => (
                <MemberLine key={m.member.id} m={m} open={sheet === m.member.id} onOpen={openSheet} />
              ))}
            </ul>
          </section>
        ))}
        {proposed.length > 0 && (
          <section className="ofc-dept" aria-label={t('org.proposedSection')}>
            <h4>
              <span>{t('org.proposedSection')}</span>
            </h4>
            <ul className="ofc-dept-list">
              {proposed.map((member) => (
                <MemberLine key={member.id} m={{ member, status: 'idle' }} open={sheet === member.id} onOpen={openSheet} />
              ))}
            </ul>
          </section>
        )}
      </aside>
      {shown && <Sheet key={shown.id} member={shown} floor={agents} editor={editor} onWrite={() => void writeTo(shown)} onClose={() => void closeSheet()} />}
    </div>
  );
}
