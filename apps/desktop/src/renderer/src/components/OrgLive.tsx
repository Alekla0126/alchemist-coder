import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BotConfig, BotTeam } from '@shared/api';
import { openAssignment, showOnChart } from '../actions/org';
import { AgentAvatar } from './AgentAvatar';
import { clockTime, relativeTime } from '../format';
import { cardOf, chartOf, exchangesOf, extrasIn, teamState, workIn, type CardWork, type Exchange } from '../org-model';
import { useStore, useT } from '../store';
import { doingText } from './Bots';

type T = ReturnType<typeof useT>;

/** How long a new exchange stays highlighted, on the cards and in the feed. */
const FLASH_MS = 4000;
/** Longer messages show this much, with "More" for the rest. */
const CLIP = 160;
/** How close to the bottom the feed counts as "at the end" (it then follows new messages). */
const NEAR_END = 24;

type LiveState = CardWork['state'] | 'out';

/** A connection being highlighted: from one card's center to another's, in the board's coordinates. */
interface Wire {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** One agent on the live board: its state in words, its task, and what it's doing right now. */
function LiveCard({ id, name, avatar, work, team, coordinator, flash }: { id: string; name: string; avatar?: string | null; work: CardWork | null; team: BotTeam; coordinator?: boolean; flash: boolean }) {
  const t = useT();
  const state: LiveState = work ? work.state : 'out';
  const status = t(`org.live.st.${state}`);
  const open = () => openAssignment(team, work?.botId ?? null);
  return (
    <div
      role="button"
      tabIndex={0}
      data-live={id}
      aria-label={[name, status, work?.task ?? ''].filter(Boolean).join(' · ')}
      className={`oc-card lv-card st-${state} ${coordinator ? 'oc-lead' : ''} ${flash ? 'lv-flash' : ''}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        open();
      }}
    >
      <div className="oc-head">
        <AgentAvatar name={name} avatar={avatar} size={24} state={state === 'working' ? 'working' : state === 'waiting' ? 'waiting' : state === 'error' ? 'error' : null} />
        <b className="oc-name">{name}</b>
        {/* The state in words, so no theme can hide it behind a color. */}
        <span className={`lv-state st-${state}`}>{status}</span>
      </div>
      {work && <p className="oc-task">{work.task}</p>}
      {work?.doing && <small className="oc-line st-working">{doingText(work.doing, t).text}</small>}
    </div>
  );
}

/** A message's text in a few lines, with "More" for the rest. */
function Clip({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = text.length > CLIP;
  return (
    <span className="lv-text">
      {open || !long ? text : `${text.slice(0, CLIP).trimEnd()}…`}
      {long && (
        <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? t('bots.less') : t('bots.more')}
        </button>
      )}
    </span>
  );
}

/** What kind of exchange it is, in words (with its count, when it has one). */
function kindText(x: Exchange, t: T) {
  const label = t(`org.live.k.${x.kind}`);
  if (x.n == null) return label;
  return `${label} · ${x.kind === 'applied' ? t('bots.filesN', { n: x.n }) : t('bots.count', { n: x.n })}`;
}

/**
 * The exchanges of an assignment as they happen, oldest at the top. It follows new ones only while
 * you're at the end: scrolled up, it says how many came in and waits for your click.
 */
function LiveFeed({ team, exchanges, fresh }: { team: BotTeam; exchanges: Exchange[]; fresh: Set<string> }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const box = useRef<HTMLOListElement>(null);
  const atEnd = useRef(true);
  const [unread, setUnread] = useState(0);
  // The newest exchange seen: the activity keeps its latest 200, so a count alone can stay put.
  const last = useRef(exchanges.at(-1)?.key);
  const nameOf = (id: string | null) => (id === null ? t('org.live.everyone') : id === 'you' ? t('bots.you') : id === 'autopilot' ? t('autopilot.name') : (team.bots.find((b) => b.id === id)?.name ?? id));
  const toEnd = () => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    atEnd.current = true;
    setUnread(0);
  };
  // Opening an assignment starts at its latest exchange.
  useLayoutEffect(() => {
    last.current = exchanges.at(-1)?.key;
    toEnd();
  }, [team.id]);
  const newest = exchanges.at(-1)?.key;
  useLayoutEffect(() => {
    if (newest === last.current) return;
    const i = exchanges.findIndex((x) => x.key === last.current);
    const added = i >= 0 ? exchanges.length - 1 - i : 1;
    last.current = newest;
    if (atEnd.current) toEnd();
    else setUnread((n) => n + added);
  }, [newest]);
  if (!exchanges.length) return <p className="empty lv-empty">{t('org.live.noMessages')}</p>;
  return (
    <div className="lv-feed-wrap">
      <ol
        className="lv-feed"
        ref={box}
        role="log"
        aria-label={t('org.live.messages')}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END;
          if (atEnd.current && unread) setUnread(0);
        }}
      >
        {exchanges.map((x) => (
          <li key={x.key} className={`lv-msg k-${x.kind} ${fresh.has(x.key) ? 'lv-new' : ''}`}>
            <div className="lv-msg-head">
              <time className="ev-time" dateTime={new Date(x.at).toISOString()}>
                {clockTime(x.at, locale)}
              </time>
              <b>{nameOf(x.from)}</b>
              {x.to !== x.from && (
                <>
                  <span className="lv-arrow" aria-label={t('org.live.to')}>
                    →
                  </span>
                  <b>{nameOf(x.to)}</b>
                </>
              )}
              <span className="lv-kind">{kindText(x, t)}</span>
            </div>
            {x.text && <Clip text={x.text} />}
          </li>
        ))}
      </ol>
      {unread > 0 && (
        <button className="lv-unread" onClick={toEnd}>
          ↓ {t('org.live.newN', { n: unread })}
        </button>
      )}
    </div>
  );
}

/**
 * An assignment live: the coordinator on top, each top-level agent heading its department with its
 * team, and the exchanges between them as they come in. A new one lights up the two cards, the line
 * between them and its row for a few seconds; nothing moves or scrolls the page on its own.
 */
export function OrgLive({ team, cwd }: { team: BotTeam; cwd: string }) {
  const t = useT();
  const configs = useStore((s) => s.botConfigs);
  const { coordinator, leads } = chartOf(configs, cwd);
  const extras = extrasIn(team, configs);
  const exchanges = useMemo(() => exchangesOf(team), [team.activity, team.bots, team.plan, team.finished]);
  // Exchanges already seen in this assignment: only the ones arriving after it opened light up.
  const seen = useRef<{ team: string; keys: Set<string> } | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const keys = exchanges.map((x) => x.key);
    if (seen.current?.team !== team.id) {
      seen.current = { team: team.id, keys: new Set(keys) };
      setFresh(new Set());
      return;
    }
    const known = seen.current.keys;
    const added = keys.filter((k) => !known.has(k));
    if (!added.length) return;
    added.forEach((k) => known.add(k));
    setFresh((f) => new Set([...f, ...added]));
    timers.current.push(setTimeout(() => setFresh((f) => new Set([...f].filter((k) => !added.includes(k)))), FLASH_MS));
  }, [exchanges, team.id]);
  // The cards that take part in a highlighted exchange, and the lines between them.
  const pairs = exchanges.filter((x) => fresh.has(x.key)).map((x) => ({ key: x.key, a: cardOf(team, x.from, configs), b: x.to ? cardOf(team, x.to, configs) : null }));
  const lit = new Set(pairs.flatMap((p) => [p.a, p.b]).filter((x): x is string => !!x));
  const board = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<Wire[]>([]);
  const wireKey = pairs.map((p) => `${p.key}:${p.a}:${p.b}`).join(',');
  useLayoutEffect(() => {
    const el = board.current;
    if (!el) return;
    const base = el.getBoundingClientRect();
    const box = (id: string) => {
      const card = el.querySelector<HTMLElement>(`[data-live="${CSS.escape(id)}"]`);
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2, w: r.width / 2, h: r.height / 2 };
    };
    // From edge to edge, so the line runs in the gap and never over a card's text.
    const edge = (c: { w: number; h: number }, dx: number, dy: number) => Math.min(dx ? c.w / Math.abs(dx) : Infinity, dy ? c.h / Math.abs(dy) : Infinity);
    const next: Wire[] = [];
    for (const p of pairs) {
      if (!p.a || !p.b || p.a === p.b) continue;
      const a = box(p.a);
      const b = box(p.b);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const from = edge(a, dx, dy);
      const to = 1 - edge(b, dx, dy);
      if (from >= to) continue;
      next.push({ key: p.key, x1: a.x + dx * from, y1: a.y + dy * from, x2: a.x + dx * to, y2: a.y + dy * to });
    }
    setWires(next);
  }, [wireKey]);
  const card = (m: BotConfig, lead = false) => <LiveCard key={m.id} id={m.id} name={m.name} avatar={m.avatar} work={workIn(team, m)} team={team} coordinator={lead} flash={lit.has(m.id)} />;
  if (!coordinator) return <p className="empty">{t('org.setup')}</p>;
  return (
    <div className="lv">
      <div className="lv-board" ref={board} role="group" aria-label={t('org.live.departments')}>
        <div className="lv-top">{card(coordinator, true)}</div>
        <div className="lv-depts">
          {leads.map(({ member, team: crew }) => (
            <section key={member.id} className="lv-dept" aria-label={t('org.teamOf', { name: member.name })}>
              <h4>{crew.length ? t('org.teamOf', { name: member.name }) : member.name}</h4>
              {card(member)}
              {crew.length > 0 && <div className="lv-crew">{crew.map((m) => card(m))}</div>}
            </section>
          ))}
          {extras.length > 0 && (
            <section className="lv-dept lv-extras" aria-label={t('org.live.extras')}>
              <h4>{t('org.live.extras')}</h4>
              {extras.map((x) => (
                <LiveCard key={x.key} id={x.key} name={x.name} work={x.work} team={team} flash={lit.has(x.key)} />
              ))}
            </section>
          )}
        </div>
        {wires.length > 0 && (
          <svg className="lv-wires" aria-hidden>
            {wires.map((w) => (
              <line key={w.key} x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} />
            ))}
          </svg>
        )}
      </div>
      <section className="lv-side" aria-label={t('org.live.messages')}>
        <h4>{t('org.live.messages')}</h4>
        <LiveFeed team={team} exchanges={exchanges} fresh={fresh} />
      </section>
    </div>
  );
}

/** Live with no assignment chosen: the latest ones to pick from (nothing is picked for you). */
export function LivePick({ teams }: { teams: BotTeam[] }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const recent = [...teams].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  if (!recent.length) return <p className="empty">{t('org.live.none')}</p>;
  return (
    <div className="lv-pick">
      <p className="composer-note">{t('org.live.pick')}</p>
      <ul>
        {recent.map((x) => (
          <li key={x.id}>
            <button className="org-assignment" onClick={() => showOnChart(x.id)}>
              <span className={`team-state ts-${teamState(x)}`}>{t(`bots.team.${teamState(x)}`)}</span>
              <span className="org-assignment-title">{x.title || x.goal}</span>
              <span className="r">{relativeTime(x.updatedAt, locale)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
