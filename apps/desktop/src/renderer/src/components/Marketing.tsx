import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentChoice, BotConfig, MarketingBrand, MarketingChannel, MarketingData, MarketingDraft, MarketingPiece, MarketingStatus } from '@shared/api';
import { CHANNEL_ORDER, CHANNEL_SPECS, STATUS_ORDER, charCount, extractPiece, firstLanguage, generationPrompt, newPieceId, overLimits, parseSections, publishUrl, sectionTemplate, threadPosts } from '../marketing-model';
import { useStore, useT } from '../store';
import { confirmAction, openMenu, promptText, toast } from '../ui';
import { AgentPicker, defaultChoice } from './AgentPicker';
import { Markdown } from './Markdown';

type T = ReturnType<typeof useT>;
type Tab = 'studio' | 'calendar' | 'brand' | 'team';
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const channelName = (t: T, c: MarketingChannel) => t(`mk.channel.${c}` as never);
const statusName = (t: T, s: MarketingStatus) => t(`mk.status.${s}` as never);

/**
 * The project's marketing, saved in its marketing/ folder: loads once per project, saves a moment
 * after each change (and rewrites marketing/BRAND.md), and lists what the team drafted.
 */
function useMarketing(cwd: string | null) {
  const [data, setData] = useState<MarketingData | null>(null);
  const [drafts, setDrafts] = useState<MarketingDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const pending = useRef<MarketingData | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    if (!cwd || !pending.current) return;
    const next = pending.current;
    pending.current = null;
    setSaving(true);
    try {
      await window.alchemist.marketingSave(cwd, next);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [cwd]);
  useEffect(() => {
    setData(null);
    if (!cwd) return;
    let live = true;
    void window.alchemist.marketingLoad(cwd).then((d) => live && setData(d)).catch((e) => toast(errorText(e)));
    void window.alchemist.marketingDrafts(cwd).then((d) => live && setDrafts(d)).catch(() => {});
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
      void flush();
    };
  }, [cwd, flush]);
  const update = useCallback(
    (fn: (d: MarketingData) => MarketingData) => {
      setData((d) => {
        if (!d) return d;
        const next = fn(d);
        pending.current = next;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), 600);
        return next;
      });
    },
    [flush],
  );
  const reloadDrafts = useCallback(() => {
    if (cwd) void window.alchemist.marketingDrafts(cwd).then(setDrafts).catch(() => {});
  }, [cwd]);
  return { data, update, saving, drafts, reloadDrafts };
}

type Mk = ReturnType<typeof useMarketing>;

const patchPiece = (mk: Mk, id: string, patch: Partial<MarketingPiece>) =>
  mk.update((d) => ({ ...d, pieces: d.pieces.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)) }));

/** A new piece at the top of the list, with the channel's sections ready when it has them. */
function addPiece(mk: Mk, channel: MarketingChannel, brand: MarketingBrand, fields: Partial<MarketingPiece> = {}): string {
  const now = Date.now();
  const spec = CHANNEL_SPECS[channel];
  const piece: MarketingPiece = { id: newPieceId(), channel, title: '', brief: '', body: spec.fields ? sectionTemplate(spec.fields) : '', status: 'idea', date: null, language: firstLanguage(brand), createdAt: now, updatedAt: now, source: null, ...fields };
  mk.update((d) => ({ ...d, pieces: [piece, ...d.pieces] }));
  return piece.id;
}

async function pickChannel(t: T): Promise<MarketingChannel | null> {
  const id = await openMenu(CHANNEL_ORDER.map((c) => ({ id: c, label: `${CHANNEL_SPECS[c].icon}  ${channelName(t, c)}` })));
  return (id as MarketingChannel | null) ?? null;
}

// ---------- previews ----------

function Counter({ n, max }: { n: number; max?: number }) {
  if (!max) return <span className="mk-count">{n}</span>;
  return <span className={`mk-count ${n > max ? 'over' : n > max * 0.9 ? 'near' : ''}`}>{`${n}/${max}`}</span>;
}

function Preview({ piece, brand }: { piece: MarketingPiece; brand: MarketingBrand }) {
  const t = useT();
  const spec = CHANNEL_SPECS[piece.channel];
  const name = brand.product.trim() || t('mk.brand.product');
  const handle = `@${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
  if (spec.fields) {
    const s = parseSections(piece.body, spec.fields);
    if (piece.channel === 'seo') {
      return (
        <div className="mk-pv mk-serp">
          <small>{brand.links.split(/\s+/).find((l) => /^https?:/.test(l))?.replace(/^https?:\/\//, '') ?? 'example.com'}{s.Slug ? ` › ${s.Slug}` : ''}</small>
          <b>{s.Title || t('mk.title')}</b>
          <p>{s.Description}</p>
          <div className="mk-fields">
            {spec.fields.map((f) => (
              <span key={f.key}>
                {f.key} <Counter n={charCount(s[f.key] ?? '')} max={f.limit} />
              </span>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className={`mk-pv mk-structured ${piece.channel}`}>
        {spec.fields.map((f) => (
          <div key={f.key} className="mk-field">
            <div className="mk-field-head">
              <span>{f.key}</span>
              <Counter n={charCount(s[f.key] ?? '')} max={f.limit} />
            </div>
            {f.key === 'Body' || f.key.endsWith('description') || f.key === 'Description' ? <Markdown text={s[f.key] || '—'} /> : <p>{s[f.key] || '—'}</p>}
          </div>
        ))}
      </div>
    );
  }
  if (piece.channel === 'x' || piece.channel === 'thread') {
    const posts = piece.channel === 'thread' ? threadPosts(piece.body) : [piece.body.trim()];
    return (
      <div className="mk-pv mk-x">
        {(posts.length ? posts : ['']).map((p, i) => (
          <div key={i} className="mk-post">
            <span className="mk-avatar">{name.slice(0, 1).toUpperCase()}</span>
            <div>
              <div className="mk-post-head">
                <b>{name}</b> <small>{handle}</small>
                <Counter n={charCount(p, piece.channel)} max={spec.limit} />
              </div>
              <p>{p || '—'}</p>
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (piece.channel === 'instagram' || piece.channel === 'linkedin') {
    const cut = piece.channel === 'instagram' ? 125 : 210;
    const text = piece.body.trim();
    const tags = (text.match(/#\w+/g) ?? []).length;
    return (
      <div className={`mk-pv mk-social ${piece.channel}`}>
        <div className="mk-post-head">
          <span className="mk-avatar">{name.slice(0, 1).toUpperCase()}</span>
          <b>{name}</b>
          <Counter n={charCount(text)} max={spec.limit} />
        </div>
        {piece.channel === 'instagram' && <div className="mk-image" aria-hidden />}
        <p>
          {text.length > cut ? (
            <>
              {text.slice(0, cut)}
              <span className="mk-more">… {t('mk.more')}</span>
            </>
          ) : (
            text || '—'
          )}
        </p>
        {piece.channel === 'instagram' && <small className={tags > 30 ? 'over' : ''}>{t('mk.hashtags', { n: tags })}</small>}
      </div>
    );
  }
  const words = piece.body.trim() ? piece.body.trim().split(/\s+/).length : 0;
  return (
    <div className="mk-pv mk-doc">
      <small>{piece.channel === 'tiktok' ? t('mk.seconds', { s: Math.round(words / 2.5) }) : t('mk.words', { n: words, min: Math.max(1, Math.round(words / 220)) })}</small>
      <Markdown text={piece.body || '—'} />
    </div>
  );
}

// ---------- studio ----------

function PieceEditor({ mk, piece, brand, cwd }: { mk: Mk; piece: MarketingPiece; brand: MarketingBrand; cwd: string }) {
  const t = useT();
  const catalog = useStore((s) => s.catalog);
  const run = useStore((s) => s.runs[s.runByTarget[`mk:${piece.id}`] ?? '']);
  const [agent, setAgent] = useState<AgentChoice | null>(() => {
    try {
      return JSON.parse(localStorage.getItem('alchemist.mkAgent') ?? 'null') as AgentChoice | null;
    } catch {
      return null;
    }
  });
  const choice = agent ?? defaultChoice(catalog);
  useEffect(() => {
    if (!catalog) void useStore.getState().loadCatalog();
  }, [catalog]);
  const working = !!run && ['starting', 'running', 'waiting'].includes(run.status);
  // When the agent's turn ends, its reply becomes the text; then the agent is let go.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!run || applied.current === run.runId || working || run.status === 'starting') return;
    applied.current = run.runId;
    if (run.status === 'idle' || run.status === 'done') {
      const text = extractPiece(run.text);
      if (text) {
        patchPiece(mk, piece.id, { body: text, status: piece.status === 'idea' ? 'draft' : piece.status });
        toast(t('mk.genDone'), undefined, 2500);
      }
    } else if (run.status === 'error') toast(t('mk.genFailed', { why: run.errors.at(-1) ?? '' }), undefined, 8000);
    void window.alchemist.stopRun(run.runId).catch(() => {});
    if (useStore.getState().info?.capture?.mkGenerate) setTimeout(() => useStore.getState().markCaptureReady(), 1200);
  }, [run?.status, run?.runId]); // eslint-disable-line react-hooks/exhaustive-deps
  const generate = async (use: AgentChoice | null = choice) => {
    if (!use) return toast(t('mk.noAgent'));
    localStorage.setItem('alchemist.mkAgent', JSON.stringify(use));
    try {
      await useStore.getState().startRun(`mk:${piece.id}`, { cwd, harnessId: use.harnessId, providerId: use.providerId, model: use.model, prompt: generationPrompt(piece, brand), permissionMode: 'default' });
    } catch (e) {
      toast(errorText(e));
    }
  };
  // Automated screenshots (--mk-generate): write this piece with the given agent, capture when done.
  const captureAgent = useStore((s) => s.info?.capture?.mkGenerate ?? null);
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!captureAgent || autoStarted.current) return;
    autoStarted.current = true;
    setAgent(captureAgent);
    void generate(captureAgent);
  }, [captureAgent]); // eslint-disable-line react-hooks/exhaustive-deps
  const over = overLimits(piece);
  const url = publishUrl(piece);
  const spec = CHANNEL_SPECS[piece.channel];
  const set = (patch: Partial<MarketingPiece>) => patchPiece(mk, piece.id, patch);
  return (
    <div className="mk-editor">
      <div className="mk-row">
        <input className="mk-title" value={piece.title} placeholder={t('mk.titlePh')} aria-label={t('mk.title')} onChange={(e) => set({ title: e.target.value })} />
      </div>
      <div className="mk-row mk-meta">
        <button
          className="mk-chip"
          onClick={async () => {
            const c = await pickChannel(t);
            if (c && c !== piece.channel) set({ channel: c, body: piece.body.trim() || !CHANNEL_SPECS[c].fields ? piece.body : sectionTemplate(CHANNEL_SPECS[c].fields!) });
          }}
        >
          {spec.icon} {channelName(t, piece.channel)} ▾
        </button>
        <select className="mk-chip" value={piece.status} aria-label={t('mk.statusLabel')} onChange={(e) => set({ status: e.target.value as MarketingStatus })}>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {statusName(t, s)}
            </option>
          ))}
        </select>
        <label className="mk-chip">
          {t('mk.date')} <input type="date" value={piece.date ?? ''} onChange={(e) => set({ date: e.target.value || null, status: e.target.value && piece.status === 'approved' ? 'scheduled' : piece.status })} />
        </label>
        <label className="mk-chip">
          {t('mk.language')} <input className="mk-lang" value={piece.language} maxLength={12} placeholder={firstLanguage(brand) || 'es'} onChange={(e) => set({ language: e.target.value })} />
        </label>
      </div>
      <textarea className="mk-brief" rows={2} value={piece.brief} placeholder={t('mk.briefPh')} aria-label={t('mk.brief')} onChange={(e) => set({ brief: e.target.value })} />
      <div className="mk-split">
        <div className="mk-write">
          <textarea className="mk-body" value={piece.body} placeholder={spec.thread ? t('mk.threadPh') : t('mk.bodyPh')} aria-label={t('mk.body')} onChange={(e) => set({ body: e.target.value })} spellCheck />
          {over.length > 0 && <p className="mk-over">{t('mk.over', { what: over.join(', ') })}</p>}
        </div>
        <div className="mk-preview" aria-label={t('mk.preview')}>
          <Preview piece={piece} brand={brand} />
        </div>
      </div>
      <div className="mk-actions">
        {choice && !working && (
          <span className="mk-agent">
            <AgentPicker
              value={choice}
              onChange={(c) => {
                setAgent(c);
                localStorage.setItem('alchemist.mkAgent', JSON.stringify(c));
              }}
            />
          </span>
        )}
        {working ? (
          <>
            <span className={`live-working ${run!.status === 'waiting' ? 'waiting' : ''}`}>
              <span className="live-dot" aria-hidden /> {run!.status === 'waiting' ? t('mk.needsYou') : t('mk.writing')}
            </span>
            {run!.status === 'waiting' && run!.sessionId && (
              <button
                className="btn-ghost"
                onClick={() => {
                  useStore.getState().setMode('agents');
                  void useStore.getState().select(run!.sessionId!, 'main');
                }}
              >
                {t('mk.openRun')}
              </button>
            )}
            <button className="btn-ghost" onClick={() => void useStore.getState().stopRun(run!.runId)}>
              {t('mk.stop')}
            </button>
          </>
        ) : (
          <button className="btn-send" onClick={() => void generate()} disabled={!choice}>
            ✦ {piece.body.trim() && !(spec.fields && piece.body.trim() === sectionTemplate(spec.fields).trim()) ? t('mk.improve') : t('mk.generate')}
          </button>
        )}
        <span className="mk-sp" />
        <button
          className="btn-ghost"
          disabled={!piece.body.trim()}
          onClick={() => {
            void window.alchemist.copyText(piece.channel === 'thread' ? threadPosts(piece.body).join('\n\n') : piece.body.trim());
            toast(t('mk.copied'), undefined, 1800);
          }}
        >
          ⧉ {t('mk.copy')}
        </button>
        {url && (
          <button
            className="btn-ghost"
            disabled={!piece.body.trim()}
            title={over.length ? t('mk.over', { what: over.join(', ') }) : undefined}
            onClick={() => {
              window.open(url, '_blank');
              if (piece.status !== 'published') set({ status: 'published', date: piece.date ?? new Date().toISOString().slice(0, 10) });
            }}
          >
            ↗ {spec.publish === 'x' ? t('mk.publishX') : t('mk.publishIn')}
          </button>
        )}
        {!url && piece.status !== 'published' && (
          <button className="btn-ghost" disabled={!piece.body.trim()} onClick={() => set({ status: 'published', date: piece.date ?? new Date().toISOString().slice(0, 10) })}>
            ✓ {t('mk.markPublished')}
          </button>
        )}
        <button
          className="btn-ghost danger-text"
          onClick={async () => {
            if (!(await confirmAction({ title: t('mk.deleteConfirm'), message: piece.title || channelName(t, piece.channel), confirmLabel: t('mk.delete'), cancelLabel: t('dialog.cancel'), danger: true }))) return;
            mk.update((d) => ({ ...d, pieces: d.pieces.filter((p) => p.id !== piece.id) }));
          }}
        >
          {t('mk.delete')}
        </button>
      </div>
    </div>
  );
}

function Studio({ mk, data, cwd, selected, setSelected }: { mk: Mk; data: MarketingData; cwd: string; selected: string | null; setSelected: (id: string | null) => void }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const [query, setQuery] = useState('');
  const imported = new Set(data.pieces.map((p) => p.source).filter(Boolean));
  const fresh = mk.drafts.filter((d) => !imported.has(d.file));
  const list = data.pieces.filter((p) => !query || `${p.title} ${p.body}`.toLowerCase().includes(query.toLowerCase()));
  const piece = data.pieces.find((p) => p.id === selected) ?? list[0] ?? null;
  const create = async () => {
    const c = await pickChannel(t);
    if (c) setSelected(addPiece(mk, c, data.brand));
  };
  return (
    <div className="mk-studio">
      <aside className="mk-list">
        <div className="mk-list-head">
          <button className="btn-send" onClick={() => void create()}>
            ＋ {t('mk.new')}
          </button>
        </div>
        {data.pieces.length > 6 && <input className="mk-search" type="search" value={query} placeholder={t('mk.search')} aria-label={t('mk.search')} onChange={(e) => setQuery(e.target.value)} />}
        {fresh.length > 0 && (
          <section className="mk-drafts">
            <h4>
              {t('mk.fromTeam')} · {fresh.length}
            </h4>
            {fresh.map((d) => (
              <button
                key={d.file}
                className="mk-item draft"
                title={d.file}
                onClick={() => {
                  const id = addPiece(mk, d.channel ?? 'blog', data.brand, { title: d.title, body: d.body, status: 'draft', source: d.file });
                  setSelected(id);
                  toast(t('mk.imported', { title: d.title }), undefined, 2500);
                }}
              >
                <span className="mk-ic">{CHANNEL_SPECS[d.channel ?? 'blog'].icon}</span>
                <span className="mk-item-title">{d.title}</span>
                <small>{t('mk.import')}</small>
              </button>
            ))}
          </section>
        )}
        <div className="mk-items" role="listbox" aria-label={t('mk.tab.studio')}>
          {list.map((p) => (
            <button key={p.id} role="option" aria-selected={piece?.id === p.id} className={`mk-item ${piece?.id === p.id ? 'sel' : ''}`} onClick={() => setSelected(p.id)}>
              <span className="mk-ic" title={channelName(t, p.channel)}>
                {CHANNEL_SPECS[p.channel].icon}
              </span>
              <span className="mk-item-title">{p.title || p.body.split('\n').find((l) => l.trim() && !l.startsWith('## '))?.slice(0, 60) || channelName(t, p.channel)}</span>
              <small className={`mk-st ${p.status}`}>{p.date ? new Date(`${p.date}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' }) : statusName(t, p.status)}</small>
            </button>
          ))}
          {!data.pieces.length && <p className="empty">{t('mk.empty')}</p>}
        </div>
      </aside>
      <section className="mk-main">{piece ? <PieceEditor key={piece.id} mk={mk} piece={piece} brand={data.brand} cwd={cwd} /> : <div className="panel-empty">{t('mk.empty')}</div>}</section>
    </div>
  );
}

// ---------- calendar ----------

function Calendar({ mk, data, open }: { mk: Mk; data: MarketingData; open: (id: string) => void }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const [over, setOver] = useState<MarketingStatus | null>(null);
  const byStatus = useMemo(() => {
    const m = new Map<MarketingStatus, MarketingPiece[]>(STATUS_ORDER.map((s) => [s, []]));
    for (const p of data.pieces) m.get(p.status)!.push(p);
    for (const list of m.values()) list.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || b.updatedAt - a.updatedAt);
    return m;
  }, [data.pieces]);
  const addIdea = async () => {
    const title = await promptText({ title: t('mk.cal.add'), placeholder: t('mk.titlePh'), confirmLabel: t('mk.cal.add'), cancelLabel: t('dialog.cancel') });
    if (!title?.trim()) return;
    const channel = await pickChannel(t);
    if (channel) addPiece(mk, channel, data.brand, { title: title.trim() });
  };
  return (
    <div className="mk-board">
      {STATUS_ORDER.map((status) => (
        <div
          key={status}
          className={`mk-col ${over === status ? 'drop' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(status);
          }}
          onDragLeave={() => setOver((o) => (o === status ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            const id = e.dataTransfer.getData('text/x-mk-piece');
            if (id) patchPiece(mk, id, { status });
          }}
        >
          <h4>
            {statusName(t, status)} <span>{byStatus.get(status)!.length}</span>
          </h4>
          {byStatus.get(status)!.map((p) => (
            <button
              key={p.id}
              className="mk-card"
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/x-mk-piece', p.id)}
              onClick={() => open(p.id)}
              title={t('mk.cal.open')}
            >
              <span className="mk-card-top">
                <span className="mk-ic">{CHANNEL_SPECS[p.channel].icon}</span> {channelName(t, p.channel)}
              </span>
              <b>{p.title || p.body.split('\n').find((l) => l.trim() && !l.startsWith('## '))?.slice(0, 80) || '—'}</b>
              <small>{p.date ? new Date(`${p.date}T12:00:00`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' }) : t('mk.cal.noDate')}</small>
            </button>
          ))}
          {status === 'idea' && (
            <button className="mk-add" onClick={() => void addIdea()}>
              ＋ {t('mk.cal.add')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- brand ----------

const BRAND_FIELDS: Array<{ key: keyof MarketingBrand; rows: number }> = [
  { key: 'product', rows: 1 },
  { key: 'pitch', rows: 2 },
  { key: 'audience', rows: 2 },
  { key: 'tone', rows: 2 },
  { key: 'say', rows: 2 },
  { key: 'avoid', rows: 2 },
  { key: 'claims', rows: 4 },
  { key: 'links', rows: 2 },
  { key: 'languages', rows: 1 },
];

function Brand({ mk, data }: { mk: Mk; data: MarketingData }) {
  const t = useT();
  return (
    <div className="mk-brand">
      <p className="mk-intro">{t('mk.brand.intro')}</p>
      {BRAND_FIELDS.map(({ key, rows }) => (
        <label key={key} className="mk-bfield">
          <span>{t(`mk.brand.${key}` as never)}</span>
          {key === 'claims' && <small>{t('mk.brand.claimsHint')}</small>}
          {rows === 1 ? (
            <input value={data.brand[key]} onChange={(e) => mk.update((d) => ({ ...d, brand: { ...d.brand, [key]: e.target.value } }))} placeholder={t(`mk.brand.${key}Ph` as never)} />
          ) : (
            <textarea rows={rows} value={data.brand[key]} onChange={(e) => mk.update((d) => ({ ...d, brand: { ...d.brand, [key]: e.target.value } }))} placeholder={t(`mk.brand.${key}Ph` as never)} />
          )}
        </label>
      ))}
    </div>
  );
}

// ---------- team ----------

const ROLES = ['strategist', 'copywriter', 'seo', 'social', 'analyst'] as const;
const DRAFTS_RULE =
  'Read marketing/BRAND.md first. Write each finished piece to marketing/drafts/<short-name>.md, starting with front matter:\n---\nchannel: x | thread | instagram | linkedin | tiktok | email | landing | blog | appstore | play | seo\ntitle: <topic>\n---\nOnly claim what the brand guide or the project shows: never invent features, numbers, prices or reviews.';
const GUIDANCE =
  'This is a marketing assignment. Use this project\'s marketing agents (strategist, copywriter, SEO and app stores, social media, analyst) and give each the part that fits. Everyone reads marketing/BRAND.md first. Each finished piece goes to marketing/drafts/<short-name>.md with front matter (channel, title), so it shows up in Marketing mode. Only claim what the brand guide or the project shows.';

function Team({ cwd, projectName }: { cwd: string; projectName: string }) {
  const t = useT();
  const configs = useStore((s) => s.botConfigs);
  const coordinator = configs.find((c) => c.kind === 'coordinator');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void useStore.getState().loadBots();
  }, []);
  const names = (r: (typeof ROLES)[number]) => [t(`mk.role.${r}.name` as never)];
  const member = (r: (typeof ROLES)[number]) => configs.find((c) => c.kind !== 'coordinator' && names(r).includes(c.name) && (!c.projects?.length || c.projects.includes(cwd)));
  const missing = ROLES.filter((r) => !member(r));
  const addTeam = async () => {
    if (!coordinator) return;
    setBusy(true);
    try {
      for (const r of missing) {
        const cfg: Omit<BotConfig, 'id'> = { name: t(`mk.role.${r}.name` as never), role: `${t(`mk.role.${r}.role` as never)}\n\n${DRAFTS_RULE}`, agent: coordinator.agent, permissionMode: 'acceptEdits', canSpawn: false, kind: 'member', projects: [cwd] };
        await window.alchemist.saveBotConfig(cfg);
      }
      await useStore.getState().loadBots();
      toast(t('mk.team.added'), undefined, 3000);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const ask = async () => {
    if (!coordinator || !goal.trim()) return;
    setBusy(true);
    try {
      const team = await window.alchemist.startTeam({ goal: goal.trim(), cwd, configId: coordinator.id, approvePlan: true, guidance: GUIDANCE });
      useStore.getState().upsertTeam(team);
      useStore.setState({ activeTeamId: team.id, activeBotId: team.bots[0]?.id ?? null, activeMemberId: null });
      useStore.getState().setMode('bots');
      toast(t('mk.team.asked'), undefined, 4000);
    } catch (e) {
      toast(errorText(e), undefined, 10_000);
    } finally {
      setBusy(false);
    }
  };
  if (!coordinator) {
    return (
      <div className="mk-team">
        <p className="mk-intro">{t('mk.team.noOrg')}</p>
        <button className="btn-send" onClick={() => useStore.getState().setMode('bots')}>
          {t('mk.team.openOrg')}
        </button>
      </div>
    );
  }
  return (
    <div className="mk-team">
      <p className="mk-intro">{t('mk.team.intro', { project: projectName })}</p>
      <div className="mk-roles">
        {ROLES.map((r) => (
          <div key={r} className={`mk-role ${member(r) ? 'in' : ''}`}>
            <b>{t(`mk.role.${r}.name` as never)}</b>
            <p>{t(`mk.role.${r}.role` as never)}</p>
            <small>{member(r) ? `✓ ${t('mk.team.inOrg')}` : t('mk.team.missing')}</small>
          </div>
        ))}
      </div>
      {missing.length > 0 && (
        <button className="btn-send" disabled={busy} onClick={() => void addTeam()}>
          ＋ {t('mk.team.add')}
        </button>
      )}
      <label className="mk-bfield mk-goal">
        <span>{t('mk.team.goal')}</span>
        <textarea rows={3} value={goal} placeholder={t('mk.team.goalPh')} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <button className="btn-send" disabled={busy || !goal.trim() || missing.length === ROLES.length} onClick={() => void ask()}>
        {t('mk.team.ask')}
      </button>
    </div>
  );
}

// ---------- the mode ----------

export function MarketingView() {
  const t = useT();
  const project = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId));
  const captureTab = useStore((s) => s.info?.capture?.mkTab ?? null);
  const [tab, setTab] = useState<Tab>((captureTab as Tab | null) ?? ((localStorage.getItem('alchemist.mkTab') as Tab | null) ?? 'studio'));
  const [selected, setSelected] = useState<string | null>(null);
  const mk = useMarketing(project?.cwd ?? null);
  useEffect(() => {
    setSelected(null);
  }, [project?.id]);
  // Team drafts land while you work: look again when the view comes back.
  useEffect(() => {
    const onShow = () => !document.hidden && mk.reloadDrafts();
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [mk.reloadDrafts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const capture = useStore.getState().info?.capture;
    if (capture && !capture.mkGenerate && mk.data) setTimeout(() => useStore.getState().markCaptureReady(), 400);
  }, [mk.data]);
  const go = (next: Tab) => {
    setTab(next);
    localStorage.setItem('alchemist.mkTab', next);
    if (next === 'studio') mk.reloadDrafts();
  };
  if (!project) return <div className="panel-empty">{t('mk.noProject')}</div>;
  return (
    <div className="mk">
      <header className="mk-head">
        <h2>
          {t('mode.marketing')} <span>· {project.name}</span>
        </h2>
        <nav className="mk-tabs" role="tablist">
          {(['studio', 'calendar', 'brand', 'team'] as const).map((x) => (
            <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => go(x)}>
              {t(`mk.tab.${x}` as never)}
              {x === 'studio' && mk.drafts.length > 0 && mk.data && mk.drafts.some((d) => !mk.data!.pieces.some((p) => p.source === d.file)) && <span className="mk-dot" aria-hidden />}
            </button>
          ))}
        </nav>
        <span className="mk-saved" aria-live="polite">
          {mk.saving ? t('mk.saving') : mk.data ? t('mk.saved') : ''}
        </span>
      </header>
      {!mk.data ? (
        <div className="panel-empty">
          <span className="spin" />
        </div>
      ) : tab === 'studio' ? (
        <Studio mk={mk} data={mk.data} cwd={project.cwd} selected={selected} setSelected={setSelected} />
      ) : tab === 'calendar' ? (
        <Calendar
          mk={mk}
          data={mk.data}
          open={(id) => {
            setSelected(id);
            go('studio');
          }}
        />
      ) : tab === 'brand' ? (
        <Brand mk={mk} data={mk.data} />
      ) : (
        <Team cwd={project.cwd} projectName={project.name} />
      )}
    </div>
  );
}
