import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@alchemist-coder/core';
import { SNIPPET_END, SNIPPET_START } from '../snippet';
import { bytes, compactNumber, money, relativeTime } from '../format';
import type { BackupStatus } from '@shared/api';
import { showSessionMenu } from '../actions/session';
import { useStore, useT } from '../store';
import { sourceOf } from '../sources';

const PAGE = 60;
type Since = 'any' | 'today' | 'week' | 'month';

/** The earliest time a filter lets through (0 = any time). */
function sinceCutoff(since: Since, now = Date.now()): number {
  if (since === 'any') return 0;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return since === 'today' ? midnight.getTime() : now - (since === 'week' ? 7 : 30) * 86_400_000;
}

function Snippet({ text }: { text: string }) {
  const parts = text.split(new RegExp(`(${SNIPPET_START}[^${SNIPPET_END}]*${SNIPPET_END})`));
  return (
    <span className="snippet">
      {parts.map((p, i) => (p.startsWith(SNIPPET_START) ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

/** Claude Code deletes transcripts after 30 days by default; the backup keeps them. */
const NUDGE_KEY = 'alchemist.backupNudgeUntil';

/** `dismissible`: the History banner can be put off for two weeks (Settings always shows it). */
export function BackupCard({ dismissible = false }: { dismissible?: boolean }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [snoozed, setSnoozed] = useState(() => dismissible && Number(localStorage.getItem(NUDGE_KEY) ?? 0) > Date.now());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.alchemist.backupStatus().then(setStatus);
    return window.alchemist.onBackupStatus(setStatus);
  }, []);
  const act = (fn: () => Promise<BackupStatus | void>) => {
    setError(null);
    void fn()
      .then((s) => s && setStatus(s))
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)));
  };
  if (!status) return null;
  if (!status.dir && snoozed) return null;
  if (!status.dir)
    return (
      <div className="backup-card off">
        <div>
          <b>{t('backup.offTitle')}</b>
          <p>{t('backup.offBody', { size: bytes(status.sourceBytes, locale) })}</p>
        </div>
        <button className="btn-send" onClick={() => act(() => window.alchemist.backupChoose())}>
          {t('backup.enable')}
        </button>
        {dismissible && (
          <button
            className="btn-ghost small"
            onClick={() => {
              localStorage.setItem(NUDGE_KEY, String(Date.now() + 14 * 86_400_000));
              setSnoozed(true);
            }}
          >
            {t('backup.notNow')}
          </button>
        )}
        {error && <div className="live-error">{error}</div>}
      </div>
    );
  const pct = status.progress && status.progress.total ? Math.round((status.progress.done / status.progress.total) * 100) : null;
  return (
    <div className="backup-card">
      <div className="backup-main">
        <b>🛟 {t('backup.onTitle')}</b>
        <span className="backup-meta">
          {status.running
            ? t('backup.running', { pct: pct ?? 0 })
            : status.lastRun
              ? t('backup.last', { when: relativeTime(status.lastRun, locale) })
              : t('backup.never')}
          {' · '}
          {t('backup.size', { files: status.files.toLocaleString(locale), size: bytes(status.bytes, locale) })}
        </span>
        <span className="backup-dir" title={status.dir}>
          {status.dir.replace(/^\/Users\/[^/]+/, '~')}
        </span>
        {status.running && pct != null && (
          <span className="ctx-bar backup-bar">
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>
      <div className="backup-actions">
        <button className="btn-ghost small" disabled={status.running} onClick={() => act(() => window.alchemist.backupRun())}>
          {t('backup.now')}
        </button>
        <button className="btn-ghost small" onClick={() => act(() => window.alchemist.backupOpen())}>
          {t('backup.open')}
        </button>
        <label className="backup-auto">
          <input type="checkbox" checked={status.auto} onChange={(e) => act(() => window.alchemist.backupSetAuto(e.target.checked))} /> {t('backup.auto')}
        </label>
      </div>
      {(error || status.error) && <div className="live-error">{error ?? status.error}</div>}
    </div>
  );
}

export function HistoryView() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const query = useStore((s) => s.query);
  const results = useStore((s) => s.results);
  const search = useStore((s) => s.search);
  const select = useStore((s) => s.select);
  const setMode = useStore((s) => s.setMode);
  const projects = useStore((s) => s.projects);
  const revision = useStore((s) => s.revision);
  const [recent, setRecent] = useState<SessionSummary[]>([]);
  const input = useRef<HTMLInputElement>(null);
  // Filters apply to both the search results and the recent list.
  const [source, setSource] = useState('all');
  const [projectFilter, setProjectFilter] = useState<number | null>(null);
  const [since, setSince] = useState<Since>('any');
  const [limit, setLimit] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    void window.alchemist.sessions(null).then((list) => setRecent([...list].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))));
  }, [revision]);
  useEffect(() => {
    const timer = setTimeout(() => void search(draft), 180);
    return () => clearTimeout(timer);
  }, [draft, search]);

  useEffect(() => setLimit(PAGE), [draft, source, projectFilter, since]);
  const cutoff = sinceCutoff(since);
  const base: Array<{ source: string; projectId: number; ts: number | null }> = results ? results : recent.map((s) => ({ source: s.source, projectId: s.projectId, ts: s.lastTs }));
  const keep = (x: { source: string; projectId: number; ts: number | null }) =>
    (source === 'all' || x.source === source) && (projectFilter == null || x.projectId === projectFilter) && (!cutoff || (x.ts ?? 0) >= cutoff);
  const hits = (results ?? []).filter(keep);
  const recentShown = recent.filter((s) => keep({ source: s.source, projectId: s.projectId, ts: s.lastTs }));
  const total = results ? hits.length : recentShown.length;
  const sources = [...new Set(base.map((x) => x.source))];
  const projectIds = [...new Set(base.map((x) => x.projectId))];
  // More rows as you reach the end of the list.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || total <= limit) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setLimit((l) => l + PAGE), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [total, limit]);

  const open = async (sessionId: string, agentId = 'main') => {
    await select(sessionId, agentId);
    setMode('agents');
  };
  const projectName = (id: number) => projects.find((p) => p.id === id)?.name ?? '';

  return (
    <div className="history">
      <div className="history-search">
        <span className="glass">⌕</span>
        <input ref={input} value={draft} placeholder={t('search.placeholder')} onChange={(e) => setDraft(e.target.value)} />
      </div>
      <div className="history-filters">
        <div className="filters" role="group" aria-label={t('history.source')}>
          <button className={`f ${source === 'all' ? 'on' : ''}`} onClick={() => setSource('all')}>
            {t('filter.all')}
          </button>
          {sources.map((src) => (
            <button key={src} className={`f ${source === src ? 'on' : ''}`} onClick={() => setSource(src)}>
              {sourceOf(src).glyph} {sourceOf(src).label}
            </button>
          ))}
        </div>
        <select value={projectFilter ?? ''} onChange={(e) => setProjectFilter(e.target.value ? Number(e.target.value) : null)} aria-label={t('history.project')}>
          <option value="">{t('history.allProjects')}</option>
          {projectIds
            .map((id) => ({ id, name: projectName(id) }))
            .filter((p) => p.name)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <select value={since} onChange={(e) => setSince(e.target.value as Since)} aria-label={t('history.when')}>
          {(['any', 'today', 'week', 'month'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`history.since.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <BackupCard dismissible />
      {results ? (
        <>
          <div className="sec">{hits.length ? t('search.results', { n: hits.length }) : t('search.noResults')}</div>
          <div className="history-list">
            {hits.slice(0, limit).map((h) => (
              <button
                key={h.sessionId}
                className="hit"
                onClick={() => void open(h.sessionId, h.agentId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void window.alchemist.session(h.sessionId).then((s) => s && showSessionMenu(s));
                }}
              >
                <span className="hit-top">
                  <span className="src" title={sourceOf(h.source).label}>{sourceOf(h.source).glyph}</span>
                  <b>{h.title}</b>
                  <span className="proj-name">{h.projectName}</span>
                  <span className="when">{relativeTime(h.ts, locale)}</span>
                </span>
                <Snippet text={h.snippet} />
              </button>
            ))}
            <div ref={sentinel} />
          </div>
        </>
      ) : (
        <>
          <div className="sec">
            {t('history.recent')} · {t('search.results', { n: recentShown.length })}
          </div>
          <div className="history-list">
            {recentShown.slice(0, limit).map((s) => (
              <button
                key={s.id}
                className="hit"
                onClick={() => void open(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void showSessionMenu(s);
                }}
              >
                <span className="hit-top">
                  <span className="src" title={sourceOf(s.source).label}>{sourceOf(s.source).glyph}</span>
                  <b>{s.title}</b>
                  {s.preserved && <span className="kept">{t('backup.kept')}</span>}
                  <span className="proj-name">{projectName(s.projectId)}</span>
                  <span className="when">{relativeTime(s.lastTs, locale)}</span>
                </span>
                <span className="hit-meta">
                  {s.agentCount > 1 && <span>⚗ {s.agentCount}</span>}
                  <span>{t('time.messages', { n: s.messageCount })}</span>
                  <span>{compactNumber(s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens + s.outputTokens, locale)} tok</span>
                  {s.costUsd != null && <span className="cost">{money(s.costUsd, locale)}</span>}
                </span>
              </button>
            ))}
            {recentShown.length === 0 && <p className="empty">{t('search.noResults')}</p>}
            <div ref={sentinel} />
          </div>
        </>
      )}
    </div>
  );
}
