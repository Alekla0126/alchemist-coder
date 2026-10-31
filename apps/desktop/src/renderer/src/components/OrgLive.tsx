import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BotConfig, BotTeam, Locale } from '@shared/api';
import { openAssignment, openMember, showOnChart } from '../actions/org';
import { AgentAvatar } from './AgentAvatar';
import { clockTime, relativeTime } from '../format';
import { aboutOf, cardOf, chartOf, exchangesOf, extrasIn, linksOf, newExchanges, partnersOf, teamState, workIn, type CardWork, type Exchange, type ExchangeKind } from '../org-model';
import { useStore, useT } from '../store';
import { doingText } from './Bots';

type T = ReturnType<typeof useT>;

/** How long a new exchange stays lit: its two desks, the speaker's bubble, the envelope between them and its row. */
const FLASH_MS = 6000;
/** Longer messages show this much, with "More" for the rest. */
const CLIP = 160;
/** How much of a message a speech bubble holds. */
const BUBBLE = 90;
/** How much of a failed agent's error its card shows. */
const ERROR_CLIP = 120;
/** How much of its part in the assignment an agent's card shows. */
const TASK_CLIP = 220;
/** How many partners a card names; the rest are counted. */
const PARTNERS = 3;
/** How close to the bottom the feed counts as "at the end" (it then follows new messages). */
const NEAR_END = 24;
/** The card that opens under a desk is this wide, at most. */
const CARD_W = 300;

type LiveState = CardWork['state'] | 'out';

/** A line between two desks, edge to edge, in the office's coordinates. */
interface Wire {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Who an agent talked with: the first few by name and count, and how many more. */
interface Talk {
  named: string;
  more: string;
}

/** One desk of the office: an agent of the organization, or one defined for this assignment. */
interface DeskInfo {
  id: string;
  name: string;
  avatar?: string | null;
  /** What it does, in a line or two (aboutOf). */
  about: string;
  work: CardWork | null;
  /** Its organization agent; none for one defined on the spot. */
  member: BotConfig | null;
  coordinator: boolean;
}

/** What a lit desk is doing in the exchange, in a word: its side of it. */
type FlashWord = 'writes' | 'replies' | 'asks' | 'gets';
const SAYS: Partial<Record<ExchangeKind, FlashWord>> = { finished: 'replies', failed: 'replies', done: 'replies', plan: 'replies', waiting: 'asks' };

/** A lit desk: its side in a word, and what it said (its bubble) when it's the one talking. */
interface Lit {
  word: FlashWord;
  said: { text: string; to: string } | null;
}

/** A sign on the person for the states that need one, besides the word. */
const MARK: Partial<Record<LiveState, string>> = { waiting: '?', error: '!', done: '✓' };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Who an id of an exchange is: an agent of the assignment, you, Autopilot or everyone. */
const nameIn = (team: BotTeam, id: string | null, t: T) =>
  id === null ? t('org.live.everyone') : id === 'you' ? t('bots.you') : id === 'autopilot' ? t('autopilot.name') : (team.bots.find((b) => b.id === id)?.name ?? t('org.live.unknown'));

/** A failed agent's error, short and on one line. */
const errorOf = (team: BotTeam, work: CardWork | null) => (work?.state === 'error' ? clip(oneLine(team.bots.find((b) => b.id === work.botId)?.error ?? ''), ERROR_CLIP) : '');

/** What kind of exchange it is, in words (with its count, when it has one). */
function kindText(x: Exchange, t: T) {
  const label = t(`org.live.k.${x.kind}`);
  if (x.n == null) return label;
  return `${label} · ${x.kind === 'applied' ? t('bots.filesN', { n: x.n }) : t('bots.count', { n: x.n })}`;
}

/**
 * An agent at its desk: the person (busy at the screen while it works, a sign when it waits, failed or
 * finished), its name, its state in words and one line on what it's doing. When it talks, a bubble
 * with what it said; its card opens on a click. Nothing here changes size when it lights up.
 */
function Desk({ d, team, lit, open, onOpen, onHover }: { d: DeskInfo; team: BotTeam; lit: Lit | null; open: boolean; onOpen: (id: string) => void; onHover: (id: string | null) => void }) {
  const t = useT();
  const state: LiveState = d.work ? d.work.state : 'out';
  const status = t(`org.live.st.${state}`);
  // In the assignment: what it does there; not in it: what it does at all.
  const line = errorOf(team, d.work) || (d.work?.doing ? doingText(d.work.doing, t).text : '') || (d.work ? oneLine(d.work.task) : d.about);
  return (
    <div
      role="button"
      tabIndex={0}
      data-live={d.id}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={[d.name, status, line].filter(Boolean).join(' · ')}
      className={`of-desk st-${state} ${d.coordinator ? 'of-lead' : ''} ${lit ? 'lv-flash' : ''} ${open ? 'on' : ''}`}
      onClick={() => onOpen(d.id)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onOpen(d.id);
      }}
      onMouseEnter={() => onHover(d.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(d.id)}
      onBlur={() => onHover(null)}
    >
      {/* The feed below reads every message out; the bubble is for the eye. */}
      {lit?.said && (
        <span className="of-bubble" aria-hidden>
          <small>→ {lit.said.to}</small>
          <span className="of-said">{lit.said.text}</span>
        </span>
      )}
      {/* Its side in a word; the one talking has its bubble instead, which already says to whom. */}
      {lit && !lit.said && <span className="lv-flash-word of-word">{t(`org.live.flash.${lit.word}`)}</span>}
      <span className="of-person">
        <AgentAvatar name={d.name} avatar={d.avatar} size={40} />
        {MARK[state] && (
          <i className={`of-mark st-${state}`} aria-hidden>
            {MARK[state]}
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
      <b className="of-name" title={d.name}>
        {d.coordinator && <span aria-hidden>⚗ </span>}
        {d.name}
      </b>
      {/* The state in words, so no theme can hide it behind a color. */}
      <span className={`lv-state st-${state}`}>{status}</span>
      <small className="of-line" title={line || undefined}>
        {line}
      </small>
    </div>
  );
}

/** Where a desk's card opens: under it, inside the office, with its tip pointing at the desk. */
interface CardPos {
  left: number;
  top: number;
  width: number;
  tip: number;
}

/** A desk's card: what the agent does, its part in the assignment, what it's on now and who it talked with. */
function DeskCard({ d, team, talk, pos, onClose }: { d: DeskInfo; team: BotTeam; talk: Talk; pos: CardPos; onClose: () => void }) {
  const t = useT();
  const state: LiveState = d.work ? d.work.state : 'out';
  const error = errorOf(team, d.work);
  const doing = d.work?.doing ? doingText(d.work.doing, t).text : '';
  const talked = [talk.named, talk.more].filter(Boolean).join(' ');
  const botId = d.work?.botId;
  return (
    <div className="of-card" role="dialog" aria-label={d.name} style={{ left: pos.left, top: pos.top, width: pos.width, '--tip': `${pos.tip}px` } as CSSProperties}>
      <div className="of-card-head">
        <AgentAvatar name={d.name} avatar={d.avatar} size={30} />
        <b>{d.name}</b>
        <span className={`lv-state st-${state}`}>{t(`org.live.st.${state}`)}</span>
        <button className="of-close" onClick={onClose} aria-label={t('org.office.close')} title={t('org.office.close')}>
          ✕
        </button>
      </div>
      <h5>{t('org.office.about')}</h5>
      <p className="of-about">{d.about || t('org.office.noAbout')}</p>
      {d.work ? (
        <>
          <h5>{t('org.office.part')}</h5>
          <p>{clip(oneLine(d.work.task), TASK_CLIP)}</p>
          {error ? <p className="oc-line st-error">{error}</p> : doing && <p className="oc-line st-working">{`${t('org.office.now')}: ${doing}`}</p>}
        </>
      ) : (
        <p className="composer-note">{t('org.office.notIn')}</p>
      )}
      {talked && <p className="lv-talk">↔ {`${t('org.live.talkedWith')} ${talked}`}</p>}
      {(botId || d.member) && (
        <div className="of-card-actions">
          {botId && (
            <button className="btn-ghost small" onClick={() => openAssignment(team, botId)}>
              {t('org.office.openChat')}
            </button>
          )}
          {d.member && (
            <button className="btn-ghost small" onClick={() => openMember(d.member!)}>
              {t('org.office.profile')}
            </button>
          )}
        </div>
      )}
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
      {open || !long ? text : clip(text, CLIP)}
      {long && (
        <button className="lv-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? t('bots.less') : t('bots.more')}
        </button>
      )}
    </span>
  );
}

/** One row of the feed; redrawn only when what it shows changes. */
const FeedRow = memo(
  function FeedRow({ x, from, to, fresh, marked, locale }: { x: Exchange; from: string; to: string | null; fresh: boolean; marked: boolean; locale: Locale }) {
    const t = useT();
    return (
      <li className={`lv-msg k-${x.kind} ${fresh ? 'lv-new' : ''} ${marked ? 'lv-marked' : ''}`}>
        <div className="lv-msg-head">
          <time className="lv-time" dateTime={new Date(x.at).toISOString()}>
            {clockTime(x.at, locale)}
          </time>
          {fresh && <span className="lv-new-word">{t('org.live.new')}</span>}
          <b>{from}</b>
          {to !== null && x.to !== x.from && (
            <>
              <span className="lv-arrow" aria-hidden>
                →
              </span>
              <span className="sr-only">{t('org.live.to')}</span>
              <b>{to}</b>
            </>
          )}
          <span className="lv-kind">{kindText(x, t)}</span>
        </div>
        {x.text && <Clip text={x.text} />}
      </li>
    );
  },
  (a, b) => a.x.key === b.x.key && a.x.text === b.x.text && a.from === b.from && a.to === b.to && a.fresh === b.fresh && a.marked === b.marked && a.locale === b.locale,
);

/**
 * The exchanges of an assignment as they happen, oldest at the top. It follows new ones only while
 * you're at the end: scrolled up, it says how many came in and waits for your click.
 */
function LiveFeed({ team, exchanges, fresh, marked }: { team: BotTeam; exchanges: Exchange[]; fresh: Set<string>; marked: Set<string> }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const box = useRef<HTMLOListElement>(null);
  const atEnd = useRef(true);
  const [unread, setUnread] = useState(0);
  // The newest exchange seen: the activity keeps its latest 200, so a count alone can stay put.
  const last = useRef(exchanges.at(-1)?.key);
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
          <FeedRow key={x.key} x={x} from={nameIn(team, x.from, t)} to={x.to === x.from ? null : nameIn(team, x.to, t)} fresh={fresh.has(x.key)} marked={marked.has(x.key)} locale={locale} />
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

/** Measures the lines between the desks of the exchanges lighting up, from the one talking to the other. */
function measure(el: HTMLElement, pairs: Array<{ key: string; a: string; b: string }>): Wire[] {
  const base = el.getBoundingClientRect();
  const box = (id: string) => {
    const desk = el.querySelector<HTMLElement>(`[data-live="${CSS.escape(id)}"]`);
    if (!desk) return null;
    const r = desk.getBoundingClientRect();
    return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2, w: r.width / 2, h: r.height / 2 };
  };
  // From edge to edge, so the line runs in the gap and never over a desk.
  const edge = (c: { w: number; h: number }, dx: number, dy: number) => Math.min(dx ? c.w / Math.abs(dx) : Infinity, dy ? c.h / Math.abs(dy) : Infinity);
  const out: Wire[] = [];
  for (const p of pairs) {
    const a = box(p.a);
    const b = box(p.b);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const from = edge(a, dx, dy);
    const to = 1 - edge(b, dx, dy);
    if (from >= to) continue;
    out.push({ key: p.key, x1: a.x + dx * from, y1: a.y + dy * from, x2: a.x + dx * to, y2: a.y + dy * to });
  }
  return out;
}

/**
 * An assignment live, as an office: the coordinator's desk on top, each agent with a team in a room
 * of its own, the rest side by side, and the conversation below. When two agents talk, the one
 * talking gets a bubble with what it said, an envelope goes to the other and both desks light up
 * for a few seconds. A click on a desk opens its card (what the agent does, its part, who it talked
 * with). Nothing moves or scrolls the page on its own.
 */
export function OrgLive({ team, cwd }: { team: BotTeam; cwd: string }) {
  const t = useT();
  const configs = useStore((s) => s.botConfigs);
  const { coordinator, leads } = chartOf(configs, cwd);
  const extras = extrasIn(team, configs);
  const exchanges = useMemo(() => exchangesOf(team), [team.activity, team.bots, team.plan, team.finished]);
  // The desks on each side of every exchange.
  const ends = useMemo(() => new Map(exchanges.map((x) => [x.key, [cardOf(team, x.from, configs), x.to ? cardOf(team, x.to, configs) : null] as const])), [exchanges, configs]);
  const links = useMemo(() => linksOf(team, exchanges, configs), [exchanges, configs]);
  // Exchanges already seen in this assignment: only the ones arriving after it opened light up.
  const seen = useRef<{ team: string; keys: Set<string> } | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const prev = seen.current?.team === team.id ? seen.current.keys : null;
    const added = newExchanges(prev, exchanges);
    seen.current = { team: team.id, keys: new Set(exchanges.map((x) => x.key)) };
    if (!prev) {
      setFresh(new Set());
      return;
    }
    if (!added.length) return;
    setFresh((f) => new Set([...f, ...added]));
    const id = setTimeout(() => {
      timers.current = timers.current.filter((x) => x !== id);
      setFresh((f) => new Set([...f].filter((k) => !added.includes(k))));
    }, FLASH_MS);
    timers.current.push(id);
  }, [exchanges, team.id]);
  // Each lit desk's side of its latest new exchange, and the speaker's words.
  const lit = new Map<string, Lit>();
  const flashPairs: Array<{ key: string; a: string; b: string }> = [];
  for (const x of exchanges) {
    if (!fresh.has(x.key)) continue;
    const [a, b] = ends.get(x.key) ?? [null, null];
    if (a) lit.set(a, { word: SAYS[x.kind] ?? 'writes', said: { text: x.text ? clip(oneLine(x.text), BUBBLE) : kindText(x, t), to: nameIn(team, x.to, t) } });
    if (b && b !== a) lit.set(b, { word: 'gets', said: lit.get(b)?.said ?? null });
    if (a && b && a !== b) flashPairs.push({ key: x.key, a, b });
  }
  // The desk under the pointer (or focus) marks its rows in the conversation.
  const [hover, setHover] = useState<string | null>(null);
  const marked = useMemo(() => new Set(hover ? exchanges.filter((x) => ends.get(x.key)?.includes(hover)).map((x) => x.key) : []), [hover, exchanges, ends]);
  const board = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<Wire[]>([]);
  const [size, setSize] = useState(0);
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize(entry!.contentRect.width * 10000 + entry!.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const flashKey = flashPairs.map((p) => p.key).join(',');
  useLayoutEffect(() => {
    const el = board.current;
    if (!el) return;
    setWires(measure(el, flashPairs));
  }, [flashKey, size]);
  // The open card: only a click opens it (screenshots open the coordinator's), Escape or a click elsewhere closes it.
  const [openId, setOpenId] = useState<string | null>(() => (useStore.getState().info?.capture?.officeCard ? (coordinator?.id ?? null) : null));
  const [pos, setPos] = useState<CardPos | null>(null);
  const opened = useRef(team.id);
  useEffect(() => {
    if (opened.current === team.id) return;
    opened.current = team.id;
    setOpenId(null);
  }, [team.id]);
  useLayoutEffect(() => {
    const el = board.current;
    const desk = openId ? el?.querySelector<HTMLElement>(`[data-live="${CSS.escape(openId)}"]`) : null;
    if (!el || !desk) {
      setPos(null);
      return;
    }
    const base = el.getBoundingClientRect();
    const r = desk.getBoundingClientRect();
    const width = Math.min(CARD_W, base.width);
    const middle = r.left - base.left + r.width / 2;
    const left = Math.max(0, Math.min(middle - width / 2, base.width - width));
    setPos({ left, top: r.bottom - base.top + 8, width, tip: middle - left });
  }, [openId, size]);
  useEffect(() => {
    if (!openId) return;
    const down = (e: MouseEvent) => {
      const at = e.target as HTMLElement | null;
      if (at?.closest('.of-card, [data-live]')) return;
      setOpenId(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      board.current?.querySelector<HTMLElement>(`[data-live="${CSS.escape(openId)}"]`)?.focus();
      setOpenId(null);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [openId]);
  const toggle = (id: string) => setOpenId((o) => (o === id ? null : id));
  // Who each agent talked with, in words ("Coordinator · 6, Tester · 1").
  const deskName = (id: string) => configs.find((c) => c.id === id)?.name ?? extras.find((x) => x.key === id)?.name ?? t('org.live.unknown');
  const talkOf = (id: string): Talk => {
    const partners = partnersOf(links, id);
    const named = partners.slice(0, PARTNERS).map((p) => `${deskName(p.id)} · ${p.n}`).join(', ');
    return { named, more: partners.length > PARTNERS ? t('org.moreN', { n: partners.length - PARTNERS }) : '' };
  };
  if (!coordinator) return <p className="empty">{t('org.setup')}</p>;
  const of = (m: BotConfig, lead = false): DeskInfo => ({ id: m.id, name: m.name, avatar: m.avatar, about: aboutOf(m), work: workIn(team, m), member: m, coordinator: lead });
  const desks = new Map<string, DeskInfo>();
  const desk = (d: DeskInfo) => {
    desks.set(d.id, d);
    return <Desk key={d.id} d={d} team={team} lit={lit.get(d.id) ?? null} open={openId === d.id} onOpen={toggle} onHover={setHover} />;
  };
  // An agent without a team isn't a department of its own: those sit side by side.
  const depts = leads.filter((l) => l.team.length > 0);
  const solo = leads.filter((l) => !l.team.length).map((l) => l.member);
  const top = desk(of(coordinator, true));
  const rooms = depts.map(({ member, team: crew }) => (
    <section key={member.id} className="of-room" aria-label={t('org.teamOf', { name: member.name })}>
      <h4>{t('org.teamOf', { name: member.name })}</h4>
      <div className="of-desks">
        {desk(of(member))}
        {crew.map((m) => desk(of(m)))}
      </div>
    </section>
  ));
  const open = solo.map((m) => desk(of(m)));
  const visitors = extras.map((x) => desk({ id: x.key, name: x.name, about: aboutOf({ role: x.role }), work: x.work, member: null, coordinator: false }));
  const shown = openId ? desks.get(openId) : undefined;
  return (
    <div className="lv">
      <div className="lv-board of-floor" ref={board} role="group" aria-label={t('org.live.departments')}>
        {wires.length > 0 && (
          <svg className="lv-wires" aria-hidden>
            {wires.map((w) => (
              <line key={w.key} className="lv-spark" x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} />
            ))}
          </svg>
        )}
        {/* An envelope from the one talking to the other, once per message. */}
        {wires.map((w) => (
          <span key={`env:${w.key}`} className="of-envelope" style={{ offsetPath: `path('M ${w.x1} ${w.y1} L ${w.x2} ${w.y2}')` }} aria-hidden>
            ✉
          </span>
        ))}
        <div className="of-top">{top}</div>
        {rooms.length > 0 && <div className="of-rooms">{rooms}</div>}
        {open.length > 0 && <div className="of-open">{open}</div>}
        {visitors.length > 0 && (
          <section className="of-room lv-extras" aria-label={t('org.live.extras')}>
            <h4>{t('org.live.extras')}</h4>
            <div className="of-desks">{visitors}</div>
          </section>
        )}
        {shown && pos && <DeskCard d={shown} team={team} talk={talkOf(shown.id)} pos={pos} onClose={() => setOpenId(null)} />}
      </div>
      <section className="lv-chat" aria-label={t('org.live.messages')}>
        <h4>{t('org.live.messages')}</h4>
        <LiveFeed team={team} exchanges={exchanges} fresh={fresh} marked={marked} />
      </section>
    </div>
  );
}

/**
 * Live with "Whole organization" chosen: the tabs above pick an assignment (nothing is picked for
 * you). Without tabs (nothing in progress), the latest assignments to pick from.
 */
export function LivePick({ teams, tabs }: { teams: BotTeam[]; tabs: boolean }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  if (tabs) return <p className="composer-note lv-pick">{t('org.live.pickAbove')}</p>;
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
