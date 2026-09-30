import { useEffect, useState } from 'react';
import type { FileDiff } from '@alchemist-coder/core';
import { compactNumber, money } from '../format';
import { lineDiff } from '../diff';
import { useStore, useT, type PendingPermission, type RunState, type RunTool } from '../store';
import { relativePath, withoutRoot } from '../paths';
import { Markdown } from './Markdown';
import { QuestionForm } from './QuestionForm';

const MAX_DIFF_LINES = 40;
const TOOL_ICON: Record<string, string> = { pending: '○', running: '◐', done: '✓', failed: '✕' };

/** `path` relative to `root` when it's inside it. */
export const relativeTo = (path: string, root: string | null | undefined) => (root && relativePath(path, root)) || path;

/** A project's folder, to show paths relative to it. */
export const useProjectRoot = () => useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId)?.cwd ?? null);

export function DiffPreview({ diff, newFile = diff.oldText == null }: { diff: FileDiff; newFile?: boolean }) {
  const t = useT();
  const root = useProjectRoot();
  const [all, setAll] = useState(false);
  const lines = lineDiff(diff.oldText, diff.newText);
  const shown = lines.slice(0, all ? 3000 : MAX_DIFF_LINES);
  return (
    <div className="diff">
      <div className="diff-path" title={diff.path}>
        {relativeTo(diff.path, root)}
        {newFile && <span className="diff-new">{t('perm.newFile')}</span>}
      </div>
      <pre>
        {shown.map((l, i) => (
          <div key={i} className={`dl ${l.kind}`}>
            <span>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            {l.text || ' '}
          </div>
        ))}
        {lines.length > shown.length && (
          <button className="dl more" onClick={() => setAll(true)}>
            {t('perm.moreLines', { n: lines.length - shown.length })} · {t('perm.showAll')}
          </button>
        )}
      </pre>
    </div>
  );
}

/** Cards waiting for an answer, oldest first: number keys answer the oldest. */
const waiting: string[] = [];

/** `shortcuts` off where several cards from different agents sit together (the organization's inbox): no stray key answers the wrong one. */
export function PermissionCard({ runId, request, shortcuts = true }: { runId: string; request: PendingPermission; shortcuts?: boolean }) {
  const t = useT();
  const respond = useStore((s) => s.respondPermission);
  const root = useProjectRoot();
  const hasReject = request.choices.some((c) => c.kind.startsWith('reject'));
  const choices: Array<{ id: string | null; label: string; kind: string }> = [...request.choices, ...(hasReject ? [] : [{ id: null, label: t('perm.deny'), kind: 'reject_once' }])];
  useEffect(() => {
    if (!shortcuts) return;
    waiting.push(request.requestId);
    const key = (e: KeyboardEvent) => {
      if (waiting[0] !== request.requestId || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      // Typing a message stays typing.
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const n = Number(e.key);
      const choice = Number.isInteger(n) && n >= 1 ? choices[n - 1] : undefined;
      if (!choice) return;
      e.preventDefault();
      void respond(runId, request.requestId, choice.id);
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      waiting.splice(waiting.indexOf(request.requestId), 1);
    };
  }, [request.requestId, runId, shortcuts]);
  // Paths inside the project read shorter.
  const title = root ? withoutRoot(request.title, root) : request.title;
  return (
    <div className="perm-card">
      <div className="perm-head">
        <span className="perm-badge">{t('perm.needed')}</span>
        <b title={request.title}>{title}</b>
        {request.kind && <span className="perm-kind">{request.kind}</span>}
      </div>
      {request.diffs.map((d, i) => (
        <DiffPreview key={i} diff={d} />
      ))}
      <div className="perm-actions">
        {choices.map((c, i) => (
          <button key={c.id ?? 'deny'} className={`perm-btn ${c.kind}`} onClick={() => void respond(runId, request.requestId, c.id)} title={shortcuts && i < 9 ? t('perm.key', { n: i + 1 }) : undefined}>
            {shortcuts && i < 9 && <kbd className="perm-key">{i + 1}</kbd>}
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToolRow({ tool }: { tool: RunTool }) {
  return (
    <div className={`tool-row ${tool.state ?? ''}`}>
      <span className="tool-state">{TOOL_ICON[tool.state ?? ''] ?? '·'}</span>
      <span className="tool-name">{tool.name}</span>
      {tool.summary !== tool.name && <span className="tool-sum">{tool.summary}</span>}
      {tool.diffs && tool.diffs.length > 0 && <span className="tool-diff">±{tool.diffs.length}</span>}
    </div>
  );
}

/**
 * Everything a running agent shows: plan, tools, questions for you, reply, cost. `compact` is the
 * strip above the composer: the reply, tools and permissions are in the chat itself then.
 */
export function LiveRun({ run, compact = false }: { run: RunState; compact?: boolean }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const configure = useStore((s) => s.configureRun);
  const review = useStore((s) => (run.cwd ? s.reviews[run.cwd]?.find((r) => r.id === run.runId) : undefined));
  const openReview = useStore((s) => s.openReview);
  const busy = run.status === 'running' || run.status === 'starting' || run.status === 'waiting';
  const model = run.config?.options.find((o) => o.id === 'model');
  const pct = run.usage && run.usage.contextTokens > 0 ? Math.round((run.usage.usedTokens / run.usage.contextTokens) * 100) : null;
  const change = (c: { mode?: string; option?: { id: string; value: string } }) => void configure(run.runId, c).catch(() => {});
  return (
    <div className={`live-run ${run.status} ${compact ? 'compact' : ''}`}>
      <div className="live-run-head">
        <span className={`dot ${run.status === 'waiting' ? 'waiting' : busy ? 'running' : run.status === 'error' ? 'waiting' : 'idle'}`} />
        {t(`run.${run.status}`)}
        {!compact && run.config && run.config.modes.length > 0 && (
          <select className="live-select" value={run.config.mode ?? ''} onChange={(e) => change({ mode: e.target.value })} title={t('run.mode')}>
            {run.config.modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        {!compact && model && model.choices.length > 1 && (
          <select className="live-select" value={model.value} onChange={(e) => change({ option: { id: model.id, value: e.target.value } })} title={t('run.model')}>
            {model.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        <span className="composer-sp" />
        {run.usage && (
          <span className="live-usage" title={t('run.tokens', { n: compactNumber(run.usage.usedTokens, locale) })}>
            {/* In the composer the context has its own chip. */}
            {pct != null && !compact && <span className="ctx-bar"><i style={{ width: `${Math.min(pct, 100)}%` }} /></span>}
            {pct != null && !compact && t('run.context', { pct })}
            {run.usage.costUsd != null && <b>{money(run.usage.costUsd, locale)}</b>}
          </span>
        )}
      </div>
      {(run.plan.length > 0 || run.planMarkdown) && (
        <div className="live-plan">
          <div className="live-sec">{t('run.plan')}</div>
          {run.plan.map((e, i) => (
            <div key={i} className={`plan-row ${e.status}`}>
              <span>{e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '◐' : '○'}</span>
              {e.content}
            </div>
          ))}
          {run.planMarkdown && <Markdown text={run.planMarkdown} />}
        </div>
      )}
      {!compact && run.tools.length > 0 && (
        <div className="live-tools">
          {run.tools.slice(-6).map((tool, i) => (
            <ToolRow key={tool.id ?? i} tool={tool} />
          ))}
        </div>
      )}
      {!compact && run.permissions.map((p) => <PermissionCard key={p.requestId} runId={run.runId} request={p} />)}
      {!compact && run.questions?.map((q) => <QuestionForm key={q.requestId} runId={run.runId} request={q} />)}
      {!compact && run.thought && !run.text && <div className="live-thought">{t('run.thinking')} {run.thought.slice(-280)}</div>}
      {!compact && run.text && (
        <div className="live-text">
          <Markdown text={run.text.slice(-6000)} />
        </div>
      )}
      {compact && (run.permissions.length > 0 || !!run.questions?.length) && <div className="live-waiting">↑ {t(run.permissions.length ? 'run.needsYou' : 'run.needsAnswer')}</div>}
      {run.notices.slice(-2).map((n, i) => (
        <div key={`n${i}`} className="live-notice">
          {n}
        </div>
      ))}
      {run.errors.slice(-2).map((e, i) => (
        <div key={i} className="live-error">
          {e}
        </div>
      ))}
      {review && review.files.length > 0 && (
        <div className="live-review">
          ✎ {t('review.changed', { n: review.files.length })}
          <span className="live-review-lines">
            <span className="plus">+{review.files.reduce((a, f) => a + f.added, 0)}</span> <span className="minus">−{review.files.reduce((a, f) => a + f.removed, 0)}</span>
          </span>
          <span className="composer-sp" />
          <button className="btn-ghost small" onClick={() => void openReview(review.id)}>
            {t('review.open')}
          </button>
        </div>
      )}
    </div>
  );
}
