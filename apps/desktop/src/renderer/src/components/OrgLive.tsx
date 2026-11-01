import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BotConfig, BotMember, BotTeam, Locale } from '@shared/api';
import { openAssignment, openMember, showOnChart } from '../actions/org';
import { AgentAvatar } from './AgentAvatar';
import { clockTime, money, relativeTime, shortTokens } from '../format';
import { ACTIVE, aboutOf, cardOf, chartOf, exchangesOf, extrasIn, linksOf, newExchanges, partnersOf, teamState, workIn, YOU, type CardWork, type Exchange, type ExchangeKind } from '../org-model';
import { flowsOf, gainsOf, handsOf, ledgerOf, shareOf, totalOf, totalsOf, type Flow, type Hands, type Ledger, type SessionSpend, type Spend } from '../org-tokens';
import { useStore, useT } from '../store';
import { isDemo } from '../org-office';
import { toast } from '../ui';
import { doingText, errorText } from './Bots';

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
const CARD_W = 320;
/** How long a desk's "+12k" shows after it spent more. */
const GAIN_MS = 2600;
/** The history is read again at most this often while the agents work. */
const SPEND_EVERY_MS = 1500;
/** How many desks a card names for what it handed over or got. */
const HANDS = 3;

/** Your desk is 'owner', or 'waiting' while something waits for you. */
type LiveState = CardWork['state'] | 'out' | 'owner';

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
  /** Your own desk: whether something in the assignment waits for you. */
  owner?: { waiting: boolean };
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

/** What kind of exchange it is, in words (with its count, when it has one, and about what it weighs). */
function kindText(x: Exchange, t: T) {
  const parts = [t(`org.live.k.${x.kind}`)];
  if (x.n != null) parts.push(x.kind === 'applied' ? t('bots.filesN', { n: x.n }) : t('bots.count', { n: x.n }));
  if (x.tokens > 0) parts.push(t('org.tokens.approx', { amount: shortTokens(x.tokens) }));
  return parts.join(' · ');
}

/** A desk's state: yours says whether something waits for you; an agent's, how its part goes. */
const stateOf = (d: DeskInfo): LiveState => (d.owner ? (d.owner.waiting ? 'waiting' : 'owner') : d.work ? d.work.state : 'out');
const statusOf = (d: DeskInfo, t: T) => (d.owner ? t(d.owner.waiting ? 'org.live.st.needsYou' : 'org.live.st.owner') : t(`org.live.st.${stateOf(d)}`));

/** What a desk spent, in a line: "85M read (84M from the cache) · 870k written · US$ 5.04". */
function spendLine(s: Spend, t: T, locale: Locale) {
  const read = t('org.tokens.read', { amount: shortTokens(s.read) });
  return [
    s.cached > 0 ? `${read} (${t('org.tokens.cached', { amount: shortTokens(s.cached) })})` : read,
    t('org.tokens.written', { amount: shortTokens(s.written) }),
    s.costUsd != null ? money(s.costUsd, locale) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The assignment's conversations as the history counts them, read again (at most every
 * SPEND_EVERY_MS) when the index says one of them changed or the agents change. `team` says whose
 * they are, so a desk never compares one assignment's tokens with another's.
 */
function useSessions(team: BotTeam): { team: string; rows: Record<string, SessionSpend | null> } | null {
  const ids = team.bots.map((b) => b.sessionId).filter((x): x is string => !!x);
  const key = ids.join(',');
  const changed = useStore((s) => s.changedSessions);
  const touched = changed.some((id) => ids.includes(id)) ? changed : null;
  const [got, setGot] = useState<{ team: string; rows: Record<string, SessionSpend | null> } | null>(null);
  const last = useRef(0);
  useEffect(() => {
    let live = true;
    const read = () => {
      last.current = Date.now();
      void Promise.all(ids.map((id) => window.alchemist.session(id).catch(() => null))).then((rows) => {
        if (live) setGot({ team: team.id, rows: Object.fromEntries(ids.map((id, i) => [id, rows[i] ?? null])) });
      });
    };
    const wait = Math.max(0, last.current + SPEND_EVERY_MS - Date.now());
    if (!wait) read();
    const timer = wait ? setTimeout(read, wait) : undefined;
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [team.id, key, touched, team.bots.map((b) => b.status).join()]);
  return got;
}

/** Who can still hear from you in the assignment: a live run, or a conversation to continue. */
const reachable = (b: BotMember) => (!!b.runId && (ACTIVE.includes(b.status) || b.status === 'idle')) || !!b.sessionId;
const running = (b: BotMember) => !!b.runId && (ACTIVE.includes(b.status) || b.status === 'idle');

/** A box on a desk's card to write to its agent in this assignment, the same as from the assignment. */
export function CardWrite({ team, bot }: { team: BotTeam; bot: BotMember }) {
  const t = useT();
  const messageBot = useStore((s) => s.messageBot);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const planFirst = team.plan?.status === 'pending' && bot.depth === 0;
  const can = reachable(bot) && !planFirst;
  const live = running(bot);
  const send = async () => {
    const v = text.trim();
    if (!v || !can || busy) return;
    if (isDemo(team.id)) return void toast(t('org.office.demoNoSend'), undefined, 3000);
    setBusy(true);
    try {
      await messageBot(team.id, bot.id, v);
      setText('');
      toast(t('org.office.sent', { name: bot.name }), undefined, 2500);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="of-write">
      <textarea
        rows={2}
        value={text}
        disabled={!can || busy}
        aria-label={bot.depth === 0 ? t('org.office.writeCoordinator') : t('org.office.write')}
        placeholder={planFirst ? t('bots.answerPlanFirst') : !can ? t('bots.ended') : live ? t('bots.messagePlaceholder', { name: bot.name }) : t('bots.continuePlaceholder', { name: bot.name })}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {/* A finished agent starts again to read it: say so before it costs. */}
      {can && !live && <small className="composer-note">{t('org.office.restarts')}</small>}
      <div className="of-write-bar">
        <span className="composer-sp" />
        <button className="btn-send small" disabled={!can || busy || !text.trim()} onClick={() => void send()}>
          {live ? t('run.send') : t('bots.continue')} ↵
        </button>
      </div>
    </div>
  );
}

/**
 * An agent at its desk: the person (busy at the screen while it works, a sign when it waits, failed or
 * finished), its name, its state in words and one line on what it's doing. When it talks, a bubble
 * with what it said; its card opens on a click. Nothing here changes size when it lights up.
 */
function Desk({
  d,
  team,
  lit,
  open,
  spend,
  share,
  gain,
  onOpen,
  onHover,
}: {
  d: DeskInfo;
  team: BotTeam;
  lit: Lit | null;
  open: boolean;
  /** What its agents spent in the assignment; none when it isn't in it (or for your desk). */
  spend: Spend | null;
  share: number;
  /** Tokens it spent since the last look, while its "+12k" shows. */
  gain: { n: number; at: number } | null;
  onOpen: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  const t = useT();
  const state = stateOf(d);
  const status = statusOf(d, t);
  // In the assignment: what it does there; not in it: what it does at all.
  const line = errorOf(team, d.work) || (d.work?.doing ? doingText(d.work.doing, t).text : '') || (d.work ? oneLine(d.work.task) : d.about);
  const spent = spend ? (spend.counted ? t('org.tokens.amount', { amount: shortTokens(totalOf(spend)) }) : t('org.tokens.none')) : '';
  return (
    <div
      role="button"
      tabIndex={0}
      data-live={d.id}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={[d.name, status, line, spent].filter(Boolean).join(' · ')}
      className={`of-desk st-${state} ${d.coordinator ? 'of-lead' : ''} ${d.owner ? 'of-you' : ''} ${lit ? 'lv-flash' : ''} ${open ? 'on' : ''}`}
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
      {/* Tokens it just spent rise from its screen; the meter below already says the total in words. */}
      {gain && (
        <span key={gain.at} className="tk-gain" aria-hidden>
          +{shortTokens(gain.n)}
        </span>
      )}
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
      {spend && (
        <span className="tk-desk">
          <span className="tk-bar" aria-hidden>
            <i style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
          <small className="tk-n">{spent}</small>
        </span>
      )}
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

/** Whom a desk handed how much, or got how much from, in words: "Tester ≈ 1.2k, Reviewer ≈ 300 +1 more". */
function handsText(xs: Hands['sent'], nameOf: (id: string) => string, t: T) {
  const named = xs
    .slice(0, HANDS)
    .map((x) => `${nameOf(x.id)} ≈ ${shortTokens(x.tokens)}`)
    .join(', ');
  return xs.length > HANDS ? `${named} ${t('org.moreN', { n: xs.length - HANDS })}` : named;
}

/**
 * A desk's card: what the agent does, its part in the assignment, what it's on now, who it talked
 * with, what it spent and handed over, and a box to write to it.
 */
function DeskCard({ d, team, talk, pos, spend, hands, nameOf, onClose }: { d: DeskInfo; team: BotTeam; talk: Talk; pos: CardPos; spend: Spend | null; hands: Hands; nameOf: (id: string) => string; onClose: () => void }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const state = stateOf(d);
  const error = errorOf(team, d.work);
  const doing = d.work?.doing ? doingText(d.work.doing, t).text : '';
  const talked = [talk.named, talk.more].filter(Boolean).join(' ');
  const botId = d.work?.botId;
  // Yours writes to the coordinator; an agent's, to its latest bot in the assignment.
  const bot = d.owner ? team.bots[0] : botId ? team.bots.find((b) => b.id === botId) : undefined;
  const context = spend?.context ? (spend.contextWindow ? t('org.tokens.context', { used: shortTokens(spend.context), size: shortTokens(spend.contextWindow) }) : t('org.tokens.contextUsed', { used: shortTokens(spend.context) })) : '';
  return (
    <div className="of-card" role="dialog" aria-label={d.name} style={{ left: pos.left, top: pos.top, width: pos.width, '--tip': `${pos.tip}px` } as CSSProperties}>
      <div className="of-card-head">
        <AgentAvatar name={d.name} avatar={d.avatar} size={30} />
        <b>{d.name}</b>
        <span className={`lv-state st-${state}`}>{statusOf(d, t)}</span>
        <button className="of-close" onClick={onClose} aria-label={t('org.office.close')} title={t('org.office.close')}>
          ✕
        </button>
      </div>
      <h5>{t('org.office.about')}</h5>
      <p className="of-about">{d.about || t('org.office.noAbout')}</p>
      {d.owner ? null : d.work ? (
        <>
          <h5>{t('org.office.part')}</h5>
          <p>{clip(oneLine(d.work.task), TASK_CLIP)}</p>
          {error ? <p className="oc-line st-error">{error}</p> : doing && <p className="oc-line st-working">{`${t('org.office.now')}: ${doing}`}</p>}
        </>
      ) : (
        <p className="composer-note">{t('org.office.notIn')}</p>
      )}
      {talked && <p className="lv-talk">↔ {`${t('org.live.talkedWith')} ${talked}`}</p>}
      {(spend?.counted || hands.sent.length > 0 || hands.got.length > 0) && (
        <>
          <h5>{t('org.tokens.title')}</h5>
          {spend && spend.counted > 0 && <p className="tk-line">{spendLine(spend, t, locale)}</p>}
          {context && <p className="tk-line">{context}</p>}
          {hands.sent.length > 0 && <p className="tk-line">↗ {t('org.tokens.sent', { amount: shortTokens(hands.sentTokens), who: handsText(hands.sent, nameOf, t) })}</p>}
          {hands.got.length > 0 && <p className="tk-line">↙ {t('org.tokens.got', { amount: shortTokens(hands.gotTokens), who: handsText(hands.got, nameOf, t) })}</p>}
        </>
      )}
      {bot && (
        <>
          <h5>{d.owner ? t('org.office.writeCoordinator') : t('org.office.write')}</h5>
          <CardWrite team={team} bot={bot} />
        </>
      )}
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
 * What the assignment spent, over the office: real tokens from each agent's history, and about how
 * many they handed each other in their messages.
 */
function TokenStrip({ ledger, flows, nameOf }: { ledger: Ledger; flows: Flow[]; nameOf: (id: string) => string }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const handed = flows.reduce((a, f) => a + f.tokens, 0);
  const messages = flows.reduce((a, f) => a + f.n, 0);
  return (
    <div className="tk-strip" role="status" title={t('org.tokens.hint')}>
      <b>{t('org.tokens.strip')}</b>
      <span>{ledger.total.counted ? spendLine(ledger.total, t, locale) : t('org.tokens.none')}</span>
      {ledger.top && <span>{t('org.tokens.top', { name: nameOf(ledger.top), share: `${Math.round(shareOf(ledger, ledger.top) * 100)}%` })}</span>}
      {messages > 0 && <span>{t('org.tokens.handed', { n: messages, amount: shortTokens(handed) })}</span>}
    </div>
  );
}

/** One desk's row in the token exchange. */
interface TokenRow {
  id: string;
  name: string;
  spend: Spend | null;
  hands: Hands;
}

/**
 * The token exchange desk by desk, the biggest spender first: what each spent, read and wrote, and
 * about how much it handed over and got. A row opens its desk's card, like the desk does.
 */
export function TokenTable({ rows, ledger, open, onOpen, onHover }: { rows: TokenRow[]; ledger: Ledger; open: string | null; onOpen: (id: string) => void; onHover: (id: string | null) => void }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => (b.spend ? totalOf(b.spend) : -1) - (a.spend ? totalOf(a.spend) : -1) || b.hands.sentTokens - a.hands.sentTokens);
  const amount = (n: number) => (n > 0 ? shortTokens(n) : '—');
  return (
    <section className="tk-table" aria-label={t('org.tokens.table')}>
      <h4>{t('org.tokens.table')}</h4>
      <p className="composer-note">{t('org.tokens.hint')}</p>
      <div className="tk-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('org.tokens.col.desk')}</th>
              <th scope="col">{t('org.tokens.col.spent')}</th>
              <th scope="col">{t('org.tokens.col.read')}</th>
              <th scope="col">{t('org.tokens.col.written')}</th>
              <th scope="col">{t('org.tokens.col.sent')}</th>
              <th scope="col">{t('org.tokens.col.got')}</th>
              <th scope="col">{t('org.tokens.col.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const share = shareOf(ledger, r.id);
              return (
                <tr key={r.id} className={open === r.id ? 'on' : ''} onMouseEnter={() => onHover(r.id)} onMouseLeave={() => onHover(null)}>
                  <th scope="row">
                    <button className="tk-who" aria-expanded={open === r.id} title={t('org.tokens.rowHint')} onClick={() => onOpen(r.id)} onFocus={() => onHover(r.id)} onBlur={() => onHover(null)}>
                      {r.name}
                    </button>
                  </th>
                  <td>
                    {r.spend?.counted ? (
                      <span className="tk-cell">
                        <span className="tk-bar" aria-hidden>
                          <i style={{ width: `${Math.round(share * 100)}%` }} />
                        </span>
                        {shortTokens(totalOf(r.spend))} · {Math.round(share * 100)}%
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{r.spend ? amount(r.spend.read) : '—'}</td>
                  <td>{r.spend ? amount(r.spend.written) : '—'}</td>
                  <td>{r.hands.sentTokens ? `≈ ${shortTokens(r.hands.sentTokens)}` : '—'}</td>
                  <td>{r.hands.gotTokens ? `≈ ${shortTokens(r.hands.gotTokens)}` : '—'}</td>
                  <td>{r.spend?.costUsd != null ? money(r.spend.costUsd, locale) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
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
  const flows = useMemo(() => flowsOf(team, exchanges, configs), [exchanges, configs]);
  // What each desk spent, from the history; a desk that spends more shows "+12k" for a moment.
  const sessions = useSessions(team);
  const mine = sessions?.team === team.id ? sessions.rows : null;
  const ledger = useMemo(() => ledgerOf(team, mine ?? {}, configs), [team.bots, mine, configs]);
  const [gains, setGains] = useState<Map<string, { n: number; at: number }>>(new Map());
  const looked = useRef<{ team: string; totals: Map<string, number> } | null>(null);
  const gainTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => () => gainTimers.current.forEach(clearTimeout), []);
  useEffect(() => {
    // Only once the history is in: an empty ledger first would make every desk "spend" it all.
    if (!mine) return;
    const prev = looked.current?.team === team.id ? looked.current.totals : null;
    looked.current = { team: team.id, totals: totalsOf(ledger) };
    const grew = gainsOf(prev, ledger);
    if (!grew.size) return;
    const at = Date.now();
    setGains((g) => new Map([...g, ...[...grew].map(([card, n]) => [card, { n, at }] as const)]));
    const id = setTimeout(() => {
      gainTimers.current = gainTimers.current.filter((x) => x !== id);
      setGains((g) => new Map([...g].filter(([, x]) => x.at !== at)));
    }, GAIN_MS);
    gainTimers.current.push(id);
  }, [ledger]);
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
  const weightOf = useMemo(() => new Map(exchanges.map((x) => [x.key, x.tokens])), [exchanges]);
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
  // Screenshots only (--scroll-to=".tk-table"): the part of the office to show; you never get moved.
  useEffect(() => {
    const to = useStore.getState().info?.capture?.scrollTo;
    if (!to) return;
    const id = setTimeout(() => board.current?.closest('.lv')?.querySelector(to)?.scrollIntoView({ block: 'start' }), 400);
    return () => clearTimeout(id);
  }, []);
  // Who each agent talked with, in words ("Coordinator · 6, Tester · 1").
  const deskName = (id: string) => (id === YOU ? t('bots.you') : (configs.find((c) => c.id === id)?.name ?? extras.find((x) => x.key === id)?.name ?? t('org.live.unknown')));
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
    return <Desk key={d.id} d={d} team={team} lit={lit.get(d.id) ?? null} open={openId === d.id} spend={ledger.desks.get(d.id) ?? null} share={shareOf(ledger, d.id)} gain={gains.get(d.id) ?? null} onOpen={toggle} onHover={setHover} />;
  };
  // Your desk, beside the coordinator's: what you say comes from it, what they ask you goes to it.
  const waiting = team.plan?.status === 'pending' || team.bots.some((b) => b.status === 'waiting');
  const you = desk({ id: YOU, name: t('bots.you'), about: t('org.office.youAbout'), work: null, member: null, coordinator: false, owner: { waiting } });
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
  // The desks that spent or handed something over in this assignment, and yours.
  const rows: TokenRow[] = [...desks.values()]
    .filter((d) => d.owner || ledger.desks.has(d.id) || flows.some((f) => f.from === d.id || f.to === d.id))
    .map((d) => ({ id: d.id, name: d.name, spend: ledger.desks.get(d.id) ?? null, hands: handsOf(flows, d.id) }));
  return (
    <div className="lv">
      <TokenStrip ledger={ledger} flows={flows} nameOf={deskName} />
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
            ✉{weightOf.get(w.key) ? ` ${t('org.tokens.approx', { amount: shortTokens(weightOf.get(w.key)!) })}` : ''}
          </span>
        ))}
        <div className="of-top">
          {you}
          {top}
        </div>
        {rooms.length > 0 && <div className="of-rooms">{rooms}</div>}
        {open.length > 0 && <div className="of-open">{open}</div>}
        {visitors.length > 0 && (
          <section className="of-room lv-extras" aria-label={t('org.live.extras')}>
            <h4>{t('org.live.extras')}</h4>
            <div className="of-desks">{visitors}</div>
          </section>
        )}
        {shown && pos && <DeskCard d={shown} team={team} talk={talkOf(shown.id)} pos={pos} spend={ledger.desks.get(shown.id) ?? null} hands={handsOf(flows, shown.id)} nameOf={deskName} onClose={() => setOpenId(null)} />}
      </div>
      <TokenTable rows={rows} ledger={ledger} open={openId} onOpen={toggle} onHover={setHover} />
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
