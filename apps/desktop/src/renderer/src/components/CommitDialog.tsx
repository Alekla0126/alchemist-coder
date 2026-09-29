import { useEffect, useRef, useState } from 'react';
import { useT } from '../store';
import { toast } from '../ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Pick changed files, write a message, commit (and push). */
export function CommitDialog({ cwd, changes, onClose, onDone }: { cwd: string; changes: Map<string, string>; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const files = [...changes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(files.map(([p]) => p)));
  const [message, setMessage] = useState('');
  const [push, setPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);
  const root = cwd.replace(/\/+$/, '');
  const rel = (p: string) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  const all = picked.size === files.length;
  const commit = async () => {
    if (!message.trim() || !picked.size || busy) return;
    setBusy(true);
    try {
      const r = await window.alchemist.gitCommit(cwd, [...picked], message, push);
      toast(r.pushed ? t('commit.pushed', { commit: r.commit }) : r.pushError ? t('commit.pushFailed', { commit: r.commit, error: r.pushError }) : t('commit.done', { commit: r.commit }), undefined, r.pushError ? 12_000 : 5000);
      onDone();
      onClose();
    } catch (e) {
      toast(errorText(e), undefined, 10_000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="commit-dialog" role="dialog" aria-modal="true" aria-label={t('commit.title')} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h3>{t('commit.title')}</h3>
        <label className="commit-all">
          <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(files.map(([p]) => p)))} />
          {t('commit.files', { n: picked.size, total: files.length })}
        </label>
        <div className="commit-files">
          {files.map(([p, status]) => (
            <label key={p} className="commit-file" title={p}>
              <input
                type="checkbox"
                checked={picked.has(p)}
                onChange={() => {
                  const next = new Set(picked);
                  if (next.has(p)) next.delete(p);
                  else next.add(p);
                  setPicked(next);
                }}
              />
              <span className={`git-st st-${status.replace('?', 'u')}`}>{status === '?' ? 'U' : status}</span>
              <span className="commit-path">{rel(p)}</span>
            </label>
          ))}
        </div>
        <textarea
          ref={box}
          value={message}
          placeholder={t('commit.placeholder')}
          rows={4}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <div className="commit-foot">
          <label>
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> {t('commit.push')}
          </label>
          <span className="commit-note">{t('commit.hooks')}</span>
          <span className="composer-sp" />
          <button className="btn-ghost" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button className="btn-send" disabled={!message.trim() || !picked.size || busy} onClick={() => void commit()}>
            {busy ? <span className="spin" /> : '✓'} {push ? t('commit.commitPush') : t('commit.commit')} ⌘↵
          </button>
        </div>
      </div>
    </div>
  );
}
