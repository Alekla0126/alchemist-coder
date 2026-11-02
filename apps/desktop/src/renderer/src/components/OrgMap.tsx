import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BotConfig, BotTeam } from '@shared/api';
import { modelLabel, money, shortTokens } from '../format';
import { columnsOf, companyOf, EXTRA, linkWidth, mapShare, since, type CompanyMap, type MapLink, type MapSpend } from '../org-map';
import { inFolder, inProject, YOU } from '../org-model';
import { totalOf, type SessionSpend } from '../org-tokens';
import { useStore, useT } from '../store';
import { AgentAvatar } from './AgentAvatar';

type T = ReturnType<typeof useT>;

/** The card's size and the room around it. */
const W = 184;
const H = 78;
const COL = 204;
const ROW = H + 46;
const STEP = H + 14;
/** Members sit a little to the right of their lead, so a team reads as one. */
const INDENT = 14;
const PAD = 22;
/** Where the line from the coordinator runs down the left side to every row of departments. */
const TRUNK = 9;
/** Room above a row of departments for the line that joins its leads. */
const BUS = 22;
/** Links labeled with their tokens without hovering: the heaviest ones. */
const LABELED = 6;
const PERIODS = [7, 30, 0] as const;
const PERIOD_KEY = 'alchemist.orgMapDays';

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
}

/** The history's count of each conversation, read once and again only for the ones that change. */
const spendCache = new Map<string, SessionSpend | null>();

function useCompanySessions(teams: BotTeam[]): Record<string, SessionSpend | null> {
  const ids = teams.flatMap((x) => x.bots.map((b) => b.sessionId)).filter((x): x is string => !!x);
  const key = ids.join(',');
  const changed = useStore((s) => s.changedSessions);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const stale = ids.filter((id) => !spendCache.has(id) || changed.includes(id));
    if (!stale.length) return;
    let live = true;
    // The first look reads them all now; after that, a burst of changes is read once.
    const timer = setTimeout(
      () =>
        void Promise.all(stale.map((id) => window.alchemist.session(id).catch(() => null))).then((rows) => {
          stale.forEach((id, i) => {
            const r = rows[i];
            spendCache.set(id, r ? { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, contextTokens: r.contextTokens, contextWindow: r.contextWindow } : null);
          });
          if (live) setVersion((v) => v + 1);
        }),
      stale.length === ids.length ? 0 : 1500,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, changed]);
  return useMemo(() => Object.fromEntries(ids.map((id) => [id, spendCache.get(id) ?? null])), [key, version]);
}

/** A link's path from the heavier sender to the other one, and where its label goes. */
function route(from: Box, to: Box): { d: string; mx: number; my: number } {
  const cx = (b: Box) => b.x + b.w / 2;
  let p: number[];
  if (Math.abs(cx(from) - cx(to)) < W) {
    // The same column: around its right side.
    const x1 = from.x + from.w;
    const x2 = to.x + to.w;
    const bulge = Math.max(x1, x2) + 26 + Math.min(40, Math.abs(from.y - to.y) / 8);
    p = [x1, from.y + H / 2, bulge, from.y + H / 2, bulge, to.y + H / 2, x2, to.y + H / 2];
  } else if (Math.abs(from.y - to.y) < H) {
    // The same row: side to side.
    const [x1, x2] = cx(from) < cx(to) ? [from.x + from.w, to.x] : [from.x, to.x + to.w];
    const dx = (x2 - x1) / 2;
    p = [x1, from.y + H / 2, x1 + dx, from.y + H / 2 - 30, x2 - dx, to.y + H / 2 - 30, x2, to.y + H / 2];
  } else {
    // One above the other: bottom to top.
    const down = from.y < to.y;
    const y1 = down ? from.y + H : from.y;
    const y2 = down ? to.y : to.y + H;
    const dy = (y2 - y1) / 2;
    p = [cx(from), y1, cx(from), y1 + dy, cx(to), y2 - dy, cx(to), y2];
  }
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p as [number, number, number, number, number, number, number, number];
  return { d: `M${x0},${y0} C${x1},${y1} ${x2},${y2} ${x3},${y3}`, mx: (x0 + 3 * x1 + 3 * x2 + x3) / 8, my: (y0 + 3 * y1 + 3 * y2 + y3) / 8 };
}

/**
 * Where everyone goes: you and the coordinator on top, then a column per lead with its team under
 * it, in as many rows as it takes to fit `room` (an organization without teams is a grid, not a
 * line too wide to see).
 */
function layout(configs: BotConfig[], hasExtra: boolean, room: number) {
  const columns = columnsOf(configs);
  const slots: Array<{ id: string; team: BotConfig[] }> = [...columns.map((c) => ({ id: c.lead.id, team: c.team })), ...(hasExtra ? [{ id: EXTRA, team: [] }] : [])];
  const perRow = Math.max(1, Math.min(slots.length, Math.floor((room - PAD * 2) / COL)));
  const width = PAD * 2 + Math.max(1, perRow) * COL;
  const center = width / 2 - W / 2;
  const boxes = new Map<string, Box>();
  const coordinator = configs.find((c) => c.kind === 'coordinator');
  boxes.set(YOU, { id: YOU, x: center, y: PAD, w: W });
  if (coordinator) boxes.set(coordinator.id, { id: coordinator.id, x: center, y: PAD + ROW, w: W });
  // Each row of departments: its top, and the leads the line above it joins.
  const rows: Array<{ bus: number; leads: string[] }> = [];
  let top = PAD + ROW * 2;
  for (let i = 0; i < slots.length; i += perRow) {
    const row = slots.slice(i, i + perRow);
    rows.push({ bus: top - BUS, leads: row.map((s) => s.id).filter((id) => id !== EXTRA) });
    row.forEach((slot, j) => {
      const x = PAD + j * COL + (COL - W) / 2;
      boxes.set(slot.id, { id: slot.id, x, y: top, w: W });
      slot.team.forEach((m, k) => boxes.set(m.id, { id: m.id, x: x + INDENT, y: top + STEP * (k + 1), w: W - INDENT }));
    });
    top += STEP * Math.max(0, ...row.map((s) => s.team.length)) + H + BUS + 26;
  }
  return { boxes, rows, coordinator, width, height: top - BUS - 26 + PAD };
}

function spendLine(s: MapSpend | undefined, t: T, locale: Parameters<typeof money>[1]) {
  if (!s || totalOf(s) === 0) return t('org.map.noSpend');
  return [t('org.map.tokens', { amount: shortTokens(totalOf(s)) }), s.costUsd != null ? money(s.costUsd, locale) : ''].filter(Boolean).join(' · ');
}

/** One link's numbers in words, both ways. */
function linkText(l: MapLink, nameOf: (id: string) => string, t: T) {
  return [
    l.ab > 0 ? t('org.map.handed', { from: nameOf(l.a), to: nameOf(l.b), amount: shortTokens(l.ab) }) : '',
    l.ba > 0 ? t('org.map.handed', { from: nameOf(l.b), to: nameOf(l.a), amount: shortTokens(l.ba) }) : '',
    t('org.map.messages', { n: l.n }),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The company on one map: you, the coordinator and every department with its team, each card with
 * the tokens it spent in all its assignments, and a line between the ones that handed each other
 * work, as thick as the tokens they handed. A card opens its numbers and its settings beside the map.
 */
export function OrgMap({ cwd, editor }: { cwd: string; editor: (member: BotConfig) => ReactNode }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const allConfigs = useStore((s) => s.botConfigs);
  const allTeams = useStore((s) => s.botTeams);
  const [days, setDays] = useState<number>(() => {
    const v = Number(localStorage.getItem(PERIOD_KEY) ?? 30);
    return PERIODS.includes(v as never) ? v : 30;
  });
  // How wide the map can be: it fits the window (and the panel beside it), in rows.
  const scroller = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(1100);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const seen = new ResizeObserver(() => setRoom(Math.max(COL + PAD * 2, el.clientWidth)));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const configs = cwd ? allConfigs.filter((c) => c.kind === 'coordinator' || inProject(c, cwd)) : allConfigs;
  const teams = useMemo(() => since(cwd ? allTeams.filter((x) => inFolder(x, cwd)) : allTeams, days), [allTeams, cwd, days]);
  const sessions = useCompanySessions(teams);
  const map: CompanyMap = useMemo(() => companyOf(teams, sessions, allConfigs), [teams, sessions, allConfigs]);
  const hasExtra = totalOf(map.spend.get(EXTRA) ?? { read: 0, written: 0 }) > 0;
  const { boxes, rows, coordinator, width, height } = layout(configs, hasExtra, room);
  const byId = new Map(allConfigs.map((c) => [c.id, c]));
  const nameOf = (id: string) => (id === YOU ? t('bots.you') : id === EXTRA ? t('org.map.extra') : (byId.get(id)?.name ?? '?'));
  const links = map.links.filter((l) => boxes.has(l.a) && boxes.has(l.b));
  const heaviest = links.reduce((m, l) => Math.max(m, l.ab + l.ba), 0);
  const focus = hover ?? picked;
  const near = (l: MapLink) => !!focus && (l.a === focus || l.b === focus);
  const selected = picked ? byId.get(picked) : undefined;
  // --bots-view=map (screenshots): the agent that spent the most, open beside the map.
  const capture = useStore((s) => s.info?.capture?.botsView === 'map');
  useEffect(() => {
    if (!capture || picked) return;
    const top = [...map.spend].filter(([id]) => byId.get(id)?.kind === 'member').sort((a, b) => totalOf(b[1]) - totalOf(a[1]))[0];
    if (top) setPicked(top[0]);
  }, [capture, map]);
  const choose = (n: number) => {
    setDays(n);
    localStorage.setItem(PERIOD_KEY, String(n));
  };

  const card = (id: string, body: ReactNode, extraClass = '') => {
    const b = boxes.get(id);
    if (!b) return null;
    const s = map.spend.get(id);
    const share = mapShare(map, id);
    return (
      <button
        key={id}
        className={`om-card ${extraClass} ${picked === id ? 'on' : ''} ${focus && focus !== id && !links.some((l) => near(l) && (l.a === id || l.b === id)) ? 'dim' : ''}`}
        style={{ left: b.x, top: b.y, width: b.w, height: H }}
        onClick={() => setPicked(picked === id ? null : id)}
        onMouseEnter={() => setHover(id)}
        onMouseLeave={() => setHover(null)}
        aria-pressed={picked === id}
      >
        {body}
        <span className="om-spend">{id === YOU ? t('org.map.youWrote', { amount: shortTokens(links.filter((l) => l.a === YOU || l.b === YOU).reduce((a, l) => a + (l.a === YOU ? l.ab : l.ba), 0)) }) : spendLine(s, t, locale)}</span>
        {/* Its share of everything the company spent, as a bar and in words for the screen reader. */}
        {id !== YOU && (
          <span className="om-bar" role="img" aria-label={t('org.map.share', { pct: Math.round(share * 100) })}>
            <i style={{ width: `${Math.max(share > 0 ? 3 : 0, Math.round(share * 100))}%` }} />
          </span>
        )}
      </button>
    );
  };
  const agentCard = (c: BotConfig) =>
    card(
      c.id,
      <>
        <span className="om-head">
          <AgentAvatar name={c.name} avatar={c.avatar} size={20} />
          <b title={c.name}>{c.kind === 'coordinator' ? `⚗ ${c.name}` : c.name}</b>
        </span>
        <span className="om-model">
          {c.agent.model === 'default' ? t('run.defaultModel') : modelLabel(c.agent.model)} · {t('org.map.assignments', { n: map.spend.get(c.id)?.assignments ?? 0 })}
        </span>
      </>,
      c.kind === 'coordinator' ? 'lead coord' : c.leadId ? '' : 'lead',
    );

  const partners = picked ? links.filter(near).map((l) => ({ id: l.a === picked ? l.b : l.a, sent: l.a === picked ? l.ab : l.ba, got: l.a === picked ? l.ba : l.ab, n: l.n })) : [];
  const own = picked ? map.spend.get(picked) : undefined;
  return (
    <div className="om">
      <div className="om-top">
        <span className="composer-note">
          {t('org.map.total', { amount: shortTokens(totalOf(map.total)), cached: shortTokens(map.total.cached), written: shortTokens(map.total.written), n: map.assignments })}
          {map.total.costUsd != null && ` · ${money(map.total.costUsd, locale)}`}
        </span>
        <span className="composer-sp" />
        <div className="lv-view" role="group" aria-label={t('org.map.period')}>
          {PERIODS.map((n) => (
            <button key={n} aria-pressed={days === n} className={days === n ? 'on' : ''} onClick={() => choose(n)}>
              {days === n && <span aria-hidden>✓ </span>}
              {n ? t('org.map.days', { n }) : t('org.map.allTime')}
            </button>
          ))}
        </div>
      </div>
      <div className={`om-body ${selected || picked === YOU || picked === EXTRA ? 'with-side' : ''}`}>
        <div className="om-scroll" ref={scroller}>
          <div className="om-canvas" style={{ width, height }}>
            <svg className="om-lines" width={width} height={height} aria-hidden>
              <defs>
                <marker id="om-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" />
                </marker>
              </defs>
              {/* Who reports to whom, thin and quiet under the token links: you to the coordinator, the
                  coordinator down the left side to a line over each row of leads, each lead to its team. */}
              {coordinator && (
                <path
                  className="om-report"
                  d={[
                    `M${boxes.get(YOU)!.x + W / 2},${PAD + H} V${PAD + ROW}`,
                    rows.length ? `M${boxes.get(coordinator.id)!.x + W / 2},${PAD + ROW + H} V${rows[0]!.bus}` : '',
                    rows.length > 1 ? `M${TRUNK},${rows[0]!.bus} V${rows[rows.length - 1]!.bus}` : '',
                    ...rows.map((r) => {
                      const xs = r.leads.map((id) => boxes.get(id)!.x + W / 2);
                      return xs.length ? `M${rows.length > 1 ? TRUNK : Math.min(...xs)},${r.bus} H${Math.max(...xs, boxes.get(coordinator.id)!.x + W / 2)} ${xs.map((x) => `M${x},${r.bus} V${r.bus + BUS}`).join(' ')}` : '';
                    }),
                  ].join(' ')}
                />
              )}
              {[...boxes.values()].map((b) => {
                const member = byId.get(b.id);
                const lead = member?.leadId ? boxes.get(member.leadId) : undefined;
                if (!lead || b.y <= lead.y) return null;
                const x = lead.x + INDENT / 2;
                return <path key={`t-${b.id}`} className="om-report" d={`M${x},${lead.y + H} V${b.y + H / 2} H${b.x}`} />;
              })}
              {links.map((l) => {
                const [from, to] = l.ab >= l.ba ? [l.a, l.b] : [l.b, l.a];
                const r = route(boxes.get(from)!, boxes.get(to)!);
                return <path key={`${l.a}|${l.b}`} className={`om-link ${near(l) ? 'hot' : focus ? 'dim' : ''}`} d={r.d} strokeWidth={linkWidth(l.ab + l.ba, heaviest)} markerEnd="url(#om-arrow)" />;
              })}
            </svg>
            {links.map((l, i) => {
              if (!(near(l) || (!focus && i < LABELED))) return null;
              const [from, to] = l.ab >= l.ba ? [l.a, l.b] : [l.b, l.a];
              const r = route(boxes.get(from)!, boxes.get(to)!);
              return (
                <span key={`l-${l.a}|${l.b}`} className={`om-label ${near(l) ? 'hot' : ''}`} style={{ left: r.mx, top: r.my }} title={linkText(l, nameOf, t)}>
                  {shortTokens(l.ab + l.ba)}
                </span>
              );
            })}
            {card(
              YOU,
              <>
                <span className="om-head">
                  <b>{t('bots.you')}</b>
                </span>
                <span className="om-model">{t('org.map.assignments', { n: map.assignments })}</span>
              </>,
              'you',
            )}
            {coordinator && agentCard(coordinator)}
            {configs.filter((c) => c.kind !== 'coordinator' && boxes.has(c.id)).map(agentCard)}
            {hasExtra &&
              card(
                EXTRA,
                <>
                  <span className="om-head">
                    <b>{t('org.map.extra')}</b>
                  </span>
                  <span className="om-model">{t('org.map.extraHint')}</span>
                </>,
                'extra',
              )}
          </div>
        </div>
        {picked && (selected || picked === YOU || picked === EXTRA) && (
          <aside className="om-side" aria-label={nameOf(picked)}>
            <div className="om-side-head">
              <b>{nameOf(picked)}</b>
              <button className="link small" onClick={() => setPicked(null)}>
                {t('dialog.close')}
              </button>
            </div>
            {own && (
              <dl className="om-stats">
                <dt>{t('org.map.read')}</dt>
                <dd>
                  {shortTokens(own.read)} <small>({t('org.tokens.cached', { amount: shortTokens(own.cached) })})</small>
                </dd>
                <dt>{t('org.map.written')}</dt>
                <dd>{shortTokens(own.written)}</dd>
                <dt>{t('org.statCost')}</dt>
                <dd>{money(own.costUsd, locale)}</dd>
                <dt>{t('org.statAssignments')}</dt>
                <dd>{own.assignments}</dd>
                <dt>{t('org.map.shareLabel')}</dt>
                <dd>{Math.round(mapShare(map, picked) * 100)} %</dd>
              </dl>
            )}
            {partners.length > 0 && (
              <>
                <h4>{t('org.map.talksWith')}</h4>
                <ul className="om-partners">
                  {partners.map((p) => (
                    <li key={p.id}>
                      <button className="link" onClick={() => setPicked(p.id)}>
                        {nameOf(p.id)}
                      </button>
                      <span>
                        → {shortTokens(p.sent)} · ← {shortTokens(p.got)} · {t('org.map.messages', { n: p.n })}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {selected && (
              <>
                <h4>{t('org.map.settings')}</h4>
                {editor(selected)}
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
