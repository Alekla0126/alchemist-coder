import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BotConfig, BotTeam, Locale } from '@shared/api';
import { openAssignment, showOnChart } from '../actions/org';
import { AgentAvatar } from './AgentAvatar';
import { clockTime, relativeTime } from '../format';
import { cardOf, chartOf, exchangesOf, extrasIn, linksOf, newExchanges, partnersOf, teamState, workIn, type CardWork, type Exchange, type ExchangeKind } from '../org-model';
import { useStore, useT } from '../store';
import { doingText } from './Bots';

type T = ReturnType<typeof useT>;

/** How long a new exchange stays highlighted, on the cards and in the feed. */
const FLASH_MS = 4000;
/** Longer messages show this much, with "More" for the rest. */
const CLIP = 160;
/** How much of a failed agent's error its card shows. */
const ERROR_CLIP = 120;
/** How many partners a card names; the rest are counted. */
const PARTNERS = 3;
/** How close to the bottom the feed counts as "at the end" (it then follows new messages). */
const NEAR_END = 24;

type LiveState = CardWork['state'] | 'out';

/** A line between two cards, edge to edge, in the board's coordinates. */
interface Wire {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** What a highlighted card is doing in the exchange, in a word: its side of it. */
type FlashWord = 'writes' | 'replies' | 'asks' | 'gets';
const SAYS: Partial<Record<ExchangeKind, FlashWord>> = { finished: 'replies', failed: 'replies', done: 'replies', plan: 'replies', waiting: 'asks' };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/** One agent on the live board: its state in words, its task, what it's doing (or why it failed) and who it talked with. */
function LiveCard({ id, name, avatar, work, team, coordinator, flash, talk, onHover }: { id: string; name: string; avatar?: string | null; work: CardWork | null; team: BotTeam; coordinator?: boolean; flash: FlashWord | null; talk: string; onHover: (id: string | null) => void }) {
  const t = useT();
  const state: LiveState = work ? work.state : 'out';
  const status = t(`org.live.st.${state}`);
  const doing = work?.doing ? doingText(work.doing, t).text : '';
  const error = state === 'error' ? clip((team.bots.find((b) => b.id === work?.botId)?.error ?? '').replace(/\s+/g, ' ').trim(), ERROR_CLIP) : '';
  const open = () => openAssignment(team, work?.botId ?? null);
  return (
    <div
      role="button"
      tabIndex={0}
      data-live={id}
      aria-label={[name, status, doing, error, work?.task ?? '', talk ? `${t('org.live.talkedWith')} ${talk}` : ''].filter(Boolean).join(' · ')}
      className={`oc-card lv-card st-${state} ${coordinator ? 'oc-lead' : ''} ${flash ? 'lv-flash' : ''}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        open();
      }}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(null)}
    >
      <div className="oc-head">
        <AgentAvatar name={name} avatar={avatar} size={24} state={state === 'working' ? 'working' : state === 'waiting' ? 'waiting' : state === 'error' ? 'error' : null} />
        <b className="oc-name">{name}</b>
        {/* The state in words, so no theme can hide it behind a color. */}
        <span className={`lv-state st-${state}`}>{status}</span>
      </div>
      {flash && <span className="lv-flash-word">{t(`org.live.flash.${flash}`)}</span>}
      {work && <p className="oc-task">{work.task}</p>}
      {error ? <small className="oc-line st-error">{error}</small> : doing && <small className="oc-line st-working">{doing}</small>}
      {talk && (
        <small className="lv-talk" title={`${t('org.live.talkedWith')} ${talk}`}>
          <span aria-hidden>↔ </span>
          {talk}
        </small>
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

/** What kind of exchange it is, in words (with its count, when it has one). */
function kindText(x: Exchange, t: T) {
  const label = t(`org.live.k.${x.kind}`);
  if (x.n == null) return label;
  return `${label} · ${x.kind === 'applied' ? t('bots.filesN', { n: x.n }) : t('bots.count', { n: x.n })}`;
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
  const nameOf = (id: string | null) => (id === null ? t('org.live.everyone') : id === 'you' ? t('bots.you') : id === 'autopilot' ? t('autopilot.name') : (team.bots.find((b) => b.id === id)?.name ?? t('org.live.unknown')));
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
          <FeedRow key={x.key} x={x} from={nameOf(x.from)} to={x.to === x.from ? null : nameOf(x.to)} fresh={fresh.has(x.key)} marked={marked.has(x.key)} locale={locale} />
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

/** Measures the lines between the cards of the exchanges lighting up. */
function measure(el: HTMLElement, pairs: Array<{ key: string; a: string; b: string }>): Wire[] {
  const base = el.getBoundingClientRect();
  const box = (id: string) => {
    const card = el.querySelector<HTMLElement>(`[data-live="${CSS.escape(id)}"]`);
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2, w: r.width / 2, h: r.height / 2 };
  };
  // From edge to edge, so the line runs in the gap and never over a card's text.
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
 * An assignment live: the coordinator on top, each agent with a team heading its department, the
 * rest side by side, and the exchanges between them as they come in. Each card names who it talked
 * with and how often; a new exchange lights up its two cards (with a word for their side of it), the
 * line between them and its row for a few seconds. Nothing moves or scrolls the page on its own.
 */
export function OrgLive({ team, cwd }: { team: BotTeam; cwd: string }) {
  const t = useT();
  const configs = useStore((s) => s.botConfigs);
  const { coordinator, leads } = chartOf(configs, cwd);
  const extras = extrasIn(team, configs);
  const exchanges = useMemo(() => exchangesOf(team), [team.activity, team.bots, team.plan, team.finished]);
  // The cards on each side of every exchange.
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
  // Each lit card's side of its latest new exchange.
  const flashes = new Map<string, FlashWord>();
  const flashPairs: Array<{ key: string; a: string; b: string }> = [];
  for (const x of exchanges) {
    if (!fresh.has(x.key)) continue;
    const [a, b] = ends.get(x.key) ?? [null, null];
    if (a) flashes.set(a, SAYS[x.kind] ?? 'writes');
    if (b && b !== a) flashes.set(b, 'gets');
    if (a && b && a !== b) flashPairs.push({ key: x.key, a, b });
  }
  // The card under the pointer (or focus) marks its rows in the feed.
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
  // Who each card talked with, in words ("Coordinator · 6, Tester · 1"): a line between two cards can
  // seem to reach a third one, a name can't.
  const cardName = (id: string) => configs.find((c) => c.id === id)?.name ?? extras.find((x) => x.key === id)?.name ?? t('org.live.unknown');
  const talkOf = (id: string) => {
    const partners = partnersOf(links, id);
    const named = partners.slice(0, PARTNERS).map((p) => `${cardName(p.id)} · ${p.n}`).join(', ');
    return partners.length > PARTNERS ? `${named} ${t('org.moreN', { n: partners.length - PARTNERS })}` : named;
  };
  const card = (m: BotConfig, lead = false) => <LiveCard key={m.id} id={m.id} name={m.name} avatar={m.avatar} work={workIn(team, m)} team={team} coordinator={lead} flash={flashes.get(m.id) ?? null} talk={talkOf(m.id)} onHover={setHover} />;
  if (!coordinator) return <p className="empty">{t('org.setup')}</p>;
  // An agent without a team isn't a department of its own: those stand side by side.
  const depts = leads.filter((l) => l.team.length > 0);
  const solo = leads.filter((l) => !l.team.length).map((l) => l.member);
  return (
    <div className="lv">
      <div className="lv-board" ref={board} role="group" aria-label={t('org.live.departments')}>
        {wires.length > 0 && (
          <svg className="lv-wires" aria-hidden>
            {wires.map((w) => (
              <line key={w.key} className="lv-spark" x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} />
            ))}
          </svg>
        )}
        <div className="lv-top">{card(coordinator, true)}</div>
        {depts.length > 0 && (
          <div className="lv-depts">
            {depts.map(({ member, team: crew }) => (
              <section key={member.id} className="lv-dept" aria-label={t('org.teamOf', { name: member.name })}>
                <h4>{t('org.teamOf', { name: member.name })}</h4>
                {card(member)}
                <div className="lv-crew">{crew.map((m) => card(m))}</div>
              </section>
            ))}
          </div>
        )}
        {solo.length > 0 && <div className="lv-solo">{solo.map((m) => card(m))}</div>}
        {extras.length > 0 && (
          <section className="lv-dept lv-extras" aria-label={t('org.live.extras')}>
            <h4>{t('org.live.extras')}</h4>
            <div className="lv-solo">
              {extras.map((x) => (
                <LiveCard key={x.key} id={x.key} name={x.name} work={x.work} team={team} flash={flashes.get(x.key) ?? null} talk={talkOf(x.key)} onHover={setHover} />
              ))}
            </div>
          </section>
        )}
      </div>
      <section className="lv-side" aria-label={t('org.live.messages')}>
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
