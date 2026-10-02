import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@alchemist-coder/core';
import { useShallow } from 'zustand/react/shallow';
import { activityTotals, buildActivity, type ActivityItem, type Doing } from '../activity-model';
import { duration, modelLabel, money } from '../format';
import { sourceOf } from '../sources';
import { useStore, useT } from '../store';
import { doingText } from './Bots';
import { toolLabel } from './LiveTurns';
import { useNow, WorkingOrb } from './WorkingOrb';

type T = ReturnType<typeof useT>;

/** How many agents get their own chip in the bar, by the window's width; the rest are a click away. */
const chipsFor = (width: number) => (width > 1500 ? 2 : width > 1180 ? 1 : 0);

function useChipCount(): number {
  const [n, setN] = useState(() => chipsFor(window.innerWidth));
  useEffect(() => {
    const onResize = () => setN(chipsFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return n;
}

/**
 * The latest conversations of the other projects with agents at work (the open project's are already
 * loaded), so the bar can name them. Agents work in bursts: at most one look every second and a half.
 */
function useWorkingElsewhere(): SessionSummary[] {
  const key = useStore(useShallow((s) => s.projects.filter((p) => p.runningAgents > 0 && p.id !== s.settings.activeProjectId).map((p) => `${p.id}:${p.runningAgents}`))).join();
  const revision = useStore((s) => s.revision);
  const [lists, setLists] = useState<SessionSummary[]>([]);
  const last = useRef(0);
  useEffect(() => {
    if (!key) return setLists([]);
    let alive = true;
    const ids = key.split(',').map((x) => Number(x.split(':')[0]));
    const timer = setTimeout(
      () => {
        last.current = Date.now();
        void window.alchemist
          .recentSessions(ids, 8)
          .then((r) => alive && setLists(Object.values(r).flat()))
          .catch(() => {});
      },
      Math.max(0, 1500 - (Date.now() - last.current)),
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, revision]);
  return lists;
}

/** Everyone working or waiting for you right now, across the app. */
function useActivity(): ActivityItem[] {
  const runs = useStore((s) => s.runs);
  const runByTarget = useStore((s) => s.runByTarget);
  const botTeams = useStore((s) => s.botTeams);
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const here = useStore((s) => (s.settings.activeProjectId != null ? s.sessions[s.settings.activeProjectId] : undefined));
  const elsewhere = useWorkingElsewhere();
  return buildActivity({ runs, runByTarget, botTeams, tasks, projects, sessions: [...(here ?? []), ...elsewhere] });
}

function doingLabel(doing: Doing, t: T): string {
  switch (doing.kind) {
    case 'text':
      return doingText(doing.text, t).text;
    case 'tool':
      return t('run.usingTool', { tool: toolLabel(doing.tool, t).label });
    case 'agents':
      return t('status.runningAgents', { n: doing.n });
    case 'thinking':
      return t('run.thinking');
    case 'writing':
      return t('run.writing');
    case 'starting':
      return t('run.starting');
    case 'waiting':
      return t('attention.waiting');
    case 'plan':
      return t('bots.planWaiting');
    case 'elsewhere':
      return t('activity.elsewhere');
    default:
      return t('run.running');
  }
}

const nameOf = (item: ActivityItem) => item.name || (item.agent ? `${sourceOf(item.agent.harnessId).label} · ${modelLabel(item.agent.model)}` : '');

/** Takes you to the agent: its assignment, its conversation, its Arena task or its project. */
async function goTo(item: ActivityItem) {
  const s = useStore.getState();
  const target = item.target;
  const toAgents = () => s.settings.mode !== 'agents' && s.settings.mode !== 'split' && s.setMode('agents');
  if (target.kind === 'bot') {
    s.setMode('bots');
    useStore.setState({ activeTeamId: target.teamId, activeBotId: target.botId, activeMemberId: null });
  } else if (target.kind === 'arena') {
    s.setMode('arena');
    s.setActiveTask(target.taskId);
  } else if (target.kind === 'session') {
    toAgents();
    await s.select(target.sessionId, 'main');
  } else if (target.kind === 'compose') {
    toAgents();
    if (s.settings.activeProjectId !== target.projectId) await s.setActiveProject(target.projectId);
    s.setCompose(target.projectId);
  } else {
    toAgents();
    await s.openProject(target.projectId);
    s.setAgentsScope('project');
    useStore.setState({ selection: null, composeProjectId: null });
  }
}

function Popover({ items, now, onClose }: { items: ActivityItem[]; now: number; onClose: () => void }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The bar's own buttons toggle the popover themselves.
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.activity-sum, .activity-more') && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const totals = activityTotals(items);
  const waiting = items.filter((x) => x.state === 'waiting');
  const working = items.filter((x) => x.state === 'working');
  const row = (item: ActivityItem) => (
    <button key={item.key} className={`act-row ${item.state}`} onClick={() => (onClose(), void goTo(item))}>
      <WorkingOrb state={item.state === 'waiting' ? 'waiting' : 'running'} size={14} />
      <span className="act-main">
        <b>{nameOf(item)}</b>
        <small>{doingLabel(item.doing, t)}</small>
      </span>
      <span className="act-side">
        {item.where && <span className="act-where">{item.where}</span>}
        <small>{[item.since != null ? duration(Math.max(0, now - item.since)) : '', item.costUsd ? money(item.costUsd, locale) : ''].filter(Boolean).join(' · ')}</small>
      </span>
    </button>
  );
  return (
    <div className="activity-pop" ref={box} role="dialog" aria-label={t('activity.title')}>
      <div className="usage-head">
        <b>{t('activity.title')}</b>
        {totals.costUsd != null && (
          <span className="act-total" title={t('activity.costHint')}>
            {money(totals.costUsd, locale)}
          </span>
        )}
      </div>
      {!items.length && <p className="usage-note">{t('activity.none')}</p>}
      {waiting.length > 0 && (
        <section className="act-sec">
          <h4 className="waiting">{t('attention.needYou', { n: waiting.length })}</h4>
          {waiting.map(row)}
        </section>
      )}
      {working.length > 0 && (
        <section className="act-sec">
          <h4>{t('status.runningAgents', { n: totals.working })}</h4>
          {working.map(row)}
        </section>
      )}
    </div>
  );
}

/**
 * The status bar's activity: who needs you and who is working right now, what each one is doing and
 * for how long. A click on an agent takes you to it; the summary lists everyone.
 */
export function ActivityBar() {
  const t = useT();
  const items = useActivity();
  const [open, setOpen] = useState(false);
  // The organization's agents count from the start, not only once its view was opened.
  useEffect(() => void useStore.getState().loadBots(), []);
  const capture = useStore((s) => s.info?.capture?.activity ?? false);
  useEffect(() => {
    if (capture) setOpen(true);
  }, [capture]);
  const now = useNow(items.some((x) => x.since != null));
  const totals = activityTotals(items);
  const chips = items.slice(0, useChipCount());
  // Without chips, the summary already stands for everyone.
  const rest = chips.length ? items.length - chips.length : 0;
  return (
    <span className="activity">
      <button className="activity-sum" onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open} title={t('activity.title')}>
        {totals.waiting > 0 && (
          <span className="act-count waiting">
            <WorkingOrb state="waiting" size={11} /> {t('attention.needYou', { n: totals.waiting })}
          </span>
        )}
        {totals.working > 0 && (
          <span className="act-count working">
            <WorkingOrb size={11} /> {t('status.runningAgents', { n: totals.working })}
          </span>
        )}
        {!items.length && <span className="act-count idle">{t('activity.idle')}</span>}
      </button>
      {chips.map((item) => {
        const doing = doingLabel(item.doing, t);
        return (
          <button key={item.key} className={`activity-chip ${item.state}`} onClick={() => void goTo(item)} title={[nameOf(item), item.where, doing].filter(Boolean).join(' · ')}>
            <b>{nameOf(item)}</b>
            <span className="act-doing">{doing}</span>
            {item.since != null && <span className="act-time">{duration(Math.max(0, now - item.since))}</span>}
          </button>
        );
      })}
      {rest > 0 && (
        <button className="activity-more" onClick={() => setOpen(!open)} title={t('activity.title')} aria-label={t('activity.moreN', { n: rest })}>
          +{rest}
        </button>
      )}
      {open && <Popover items={items} now={now} onClose={() => setOpen(false)} />}
    </span>
  );
}
