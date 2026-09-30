import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SubagentDef } from '@shared/api';
import { BUILTIN_SUBAGENTS, subagentPrompt } from '../agents-edit';
import { keys } from '../keys';
import { useStore, useT } from '../store';
import { Icon } from './Icon';

/**
 * "Add an agent" to a conversation: its main agent launches one more subagent (Claude Code's Task
 * tool) of the type you pick, with the task you write. If the main agent is busy, the request
 * waits in the queue and goes out when it finishes its turn.
 */
export function AddAgentDialog({ sessionId, cwd, type, onClose }: { sessionId: string; cwd: string | null; type?: string; onClose: () => void }) {
  const t = useT();
  const [custom, setCustom] = useState<SubagentDef[]>([]);
  const [kind, setKind] = useState(type ?? 'general-purpose');
  const [task, setTask] = useState('');
  const [background, setBackground] = useState(true);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    void window.alchemist
      .subagents(cwd)
      .then((list) => alive && setCustom(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cwd]);
  const busy = useStore((s) => {
    const run = s.runs[s.runByTarget[`s:${sessionId}`] ?? ''];
    return run?.status === 'running' || run?.status === 'starting' || run?.status === 'waiting';
  });
  // Working in another process (a terminal, another app): continuing it here too would run it twice.
  const elsewhere = useStore((s) => {
    if (s.runByTarget[`s:${sessionId}`]) return false;
    const session = [...Object.values(s.sessions), ...Object.values(s.recent)].flat().find((x) => x.id === sessionId);
    return !!session && (session.runningAgents > 0 || session.status === 'running');
  });
  const describe = (name: string) => {
    const key = `addAgent.type.${name}`;
    const text = t(key as never);
    return text === key ? name : text;
  };
  const chosen = custom.find((c) => c.name === kind);

  const add = async () => {
    if (!task.trim()) return;
    const text = subagentPrompt({ ask: t('addAgent.ask'), background: t('addAgent.askBackground'), report: t('addAgent.askReport') }, { type: kind, task, background });
    onClose();
    const s = useStore.getState();
    if (s.settings.mode !== 'agents' && s.settings.mode !== 'split') s.setMode('agents');
    await s.select(sessionId, 'main');
    // The conversation's message box sends it (or queues it while the agent works); a conversation
    // busy elsewhere gets a copy with its context, where the new agent runs.
    s.fillComposer(text, true, elsewhere);
  };

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog add-agent"
        role="dialog"
        aria-modal="true"
        aria-label={t('addAgent.title')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void add();
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <h3>{t('addAgent.title')}</h3>
        <p className="add-agent-sub">{t('addAgent.sub')}</p>
        <label className="np-field">
          <span>{t('addAgent.kind')}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <optgroup label={t('addAgent.builtin')}>
              {BUILTIN_SUBAGENTS.map((b) => (
                <option key={b} value={b}>
                  {describe(b)}
                </option>
              ))}
            </optgroup>
            {custom.length > 0 && (
              <optgroup label={t('addAgent.yours')}>
                {custom.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                    {c.scope === 'user' ? ` · ${t('addAgent.personal')}` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {type && !BUILTIN_SUBAGENTS.includes(type as never) && !custom.some((c) => c.name === type) && <option value={type}>{type}</option>}
          </select>
          {chosen?.description && <small className="add-agent-desc">{chosen.description}</small>}
        </label>
        <label className="np-field">
          <span>{t('addAgent.task')}</span>
          <textarea ref={box} rows={5} maxLength={20000} value={task} placeholder={t('addAgent.taskPh')} onChange={(e) => setTask(e.target.value)} />
        </label>
        <label className="np-check">
          <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} />
          {t('addAgent.background')}
        </label>
        {busy && <p className="add-agent-note">{t('addAgent.busy')}</p>}
        {elsewhere && <p className="add-agent-note">{t('addAgent.elsewhere')}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button type="submit" className="btn-send" disabled={!task.trim()}>
            <Icon name="plus" size={13} /> {elsewhere ? t('addAgent.addCopy') : busy ? t('addAgent.queue') : t('addAgent.add')} <kbd>{keys('⌘↵')}</kbd>
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
