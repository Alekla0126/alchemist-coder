import { useEffect, useState } from 'react';
import type { AgentReview, ReviewFile, ReviewFileContent } from '@shared/api';
import { hunks, keepHunk, undoHunk, type Hunk } from '../diff';
import { refreshFromDisk } from '../editor/models';
import { relativeTime } from '../format';
import { sourceOf } from '../sources';
import { useStore, useT } from '../store';
import { confirmAction } from '../ui';
import { joinPath } from '../paths';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
/** Blocks longer than this are folded to their first lines. */
const MAX_BLOCK_LINES = 60;

function Lines({ lines, kind }: { lines: string[]; kind: 'same' | 'add' | 'del' }) {
  const shown = lines.length > MAX_BLOCK_LINES ? lines.slice(0, MAX_BLOCK_LINES) : lines;
  return (
    <>
      {shown.map((text, i) => (
        <div key={i} className={`dl ${kind}`}>
          <span>{kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}</span>
          {text || ' '}
        </div>
      ))}
      {lines.length > shown.length && <div className="dl more">… {lines.length - shown.length}</div>}
    </>
  );
}

function FileReview({ review, file, onChange }: { review: AgentReview; file: ReviewFile; onChange: (r: AgentReview | null) => void }) {
  const t = useT();
  const dirty = useStore((s) => s.dirty);
  const openFile = useStore((s) => s.openFile);
  const projectId = useStore((s) => s.projects.find((p) => p.cwd === review.cwd)?.id);
  const [content, setContent] = useState<ReviewFileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const full = joinPath(review.root, file.path);

  const load = () => {
    setError(null);
    window.alchemist
      .reviewFile(review.id, file.path)
      .then(setContent)
      .catch((e: unknown) => setError(errorText(e)));
  };
  // Reload whenever the counts change (the agent edited it again, or a block was kept or undone).
  useEffect(load, [review.id, file.path, file.added, file.removed]);

  const act = async (fn: () => Promise<AgentReview | null>, touchesDisk: boolean) => {
    if (touchesDisk && dirty[full]) return setError(t('review.dirty'));
    setBusy(true);
    try {
      const next = await fn();
      if (touchesDisk) await refreshFromDisk(full);
      onChange(next);
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const blocks: Hunk[] = content && !content.binary && file.status === 'modified' ? hunks(content.oldText ?? '', content.newText ?? '') : [];
  const whole = file.status !== 'modified' || file.binary || content?.binary;
  return (
    <div className="review-file">
      <div className="review-file-head">
        <span className={`change-status ${file.status}`}>{file.status[0]!.toUpperCase()}</span>
        <button className="review-path" onClick={() => projectId != null && file.status !== 'deleted' && openFile(projectId, full)} title={full}>
          {file.path}
        </button>
        {!file.binary && (
          <span className="change-lines">
            <span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span>
          </span>
        )}
        <span className="composer-sp" />
        <button className="btn-ghost small" disabled={busy} onClick={() => void act(() => window.alchemist.reviewKeep(review.id, file.path), false)}>
          ✓ {t('review.keepFile')}
        </button>
        <button className="btn-ghost small danger" disabled={busy} onClick={() => void act(() => window.alchemist.reviewUndo(review.id, file.path), true)}>
          ↺ {t('review.undoFile')}
        </button>
      </div>
      {error && <div className="live-error">{error}</div>}
      {whole ? (
        <div className="review-whole">
          {file.binary || content?.binary ? (
            <p className="composer-note">{t('review.binary')}</p>
          ) : content ? (
            <div className="diff">
              <pre>
                <Lines lines={(file.status === 'deleted' ? content.oldText : content.newText)?.split('\n') ?? []} kind={file.status === 'deleted' ? 'del' : 'add'} />
              </pre>
            </div>
          ) : (
            <span className="spin" />
          )}
        </div>
      ) : (
        blocks.map((h, i) => (
          <div key={`${h.oldStart}-${h.newStart}-${i}`} className="hunk">
            <div className="hunk-head">
              <span>{h.newLines.length > 1 ? t('review.lines', { from: h.newStart + 1, to: h.newStart + h.newLines.length }) : t('review.line', { n: h.newStart + 1 })}</span>
              <span className="composer-sp" />
              <button className="btn-ghost small" disabled={busy} onClick={() => void act(() => window.alchemist.reviewKeep(review.id, file.path, keepHunk(content!.oldText ?? '', h), content!.oldText ?? ''), false)}>
                ✓ {t('review.keep')}
              </button>
              <button className="btn-ghost small danger" disabled={busy} onClick={() => void act(() => window.alchemist.reviewUndo(review.id, file.path, undoHunk(content!.newText ?? '', h), content!.newText ?? ''), true)}>
                ↺ {t('review.undo')}
              </button>
            </div>
            <div className="diff">
              <pre>
                <Lines lines={h.before} kind="same" />
                <Lines lines={h.oldLines} kind="del" />
                <Lines lines={h.newLines} kind="add" />
                <Lines lines={h.after} kind="same" />
              </pre>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** What one agent run changed, to keep or undo file by file and block by block. */
export function ReviewPanel({ reviewId }: { reviewId: string }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const review = useStore((s) => Object.values(s.reviews).flat().find((r) => r.id === reviewId) ?? null);
  const catalog = useStore((s) => s.catalog);
  const updateReview = useStore((s) => s.updateReview);
  const select = useStore((s) => s.select);
  const setMode = useStore((s) => s.setMode);
  const dirty = useStore((s) => s.dirty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!review) return <div className="panel-empty editor-msg">{t('review.none')}</div>;
  const agent = catalog?.harnesses.find((h) => h.id === review.harnessId)?.label ?? sourceOf(review.harnessId).label;
  const onChange = (next: AgentReview | null) => updateReview(review.cwd, review.id, next);

  const all = async (undo: boolean) => {
    if (undo && !(await confirmAction({ title: t('review.undoAll'), message: t('review.undoAllConfirm', { n: review.files.length }), confirmLabel: t('review.undoAll'), cancelLabel: t('dialog.cancel'), danger: true }))) return;
    setBusy(true);
    setError(null);
    let last: AgentReview | null = review;
    try {
      for (const f of review.files) {
        const full = joinPath(review.root, f.path);
        if (undo && dirty[full]) continue;
        last = undo ? await window.alchemist.reviewUndo(review.id, f.path) : await window.alchemist.reviewKeep(review.id, f.path);
        if (undo) await refreshFromDisk(full);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      onChange(last);
      setBusy(false);
    }
  };

  return (
    <div className="review">
      <div className="review-head">
        <div className="review-title">
          <b>✎ {t('review.by', { agent })}</b>
          <span className="review-meta">
            {review.model && `${review.model} · `}
            {relativeTime(review.createdAt, locale)} · {t('review.files', { n: review.files.length })}
          </span>
        </div>
        {review.title && <p className="review-prompt">“{review.title}”</p>}
        <div className="review-actions">
          {review.sessionId && (
            <button
              className="btn-ghost small"
              onClick={() => {
                void select(review.sessionId!, 'main');
                setMode('split');
              }}
            >
              ↗ {t('review.conversation')}
            </button>
          )}
          <span className="composer-sp" />
          <button className="btn-send" disabled={busy} onClick={() => void all(false)}>
            ✓ {t('review.keepAll')}
          </button>
          <button className="btn-ghost small danger" disabled={busy} onClick={() => void all(true)}>
            ↺ {t('review.undoAll')}
          </button>
        </div>
        <p className="composer-note">{t('review.note')}</p>
        {error && <div className="live-error">{error}</div>}
      </div>
      {review.files.map((f) => (
        <FileReview key={f.path} review={review} file={f} onChange={onChange} />
      ))}
    </div>
  );
}
