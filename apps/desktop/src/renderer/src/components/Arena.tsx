import { useEffect, useMemo, useState } from 'react';
import type { FileDiff } from '@alchemist-coder/core';
import type { AgentChoice, ArenaTask, PermissionMode, TaskContestant } from '@shared/api';
import { duration, money, relativeTime } from '../format';
import { useStore, useT } from '../store';
import { AgentPicker, defaultChoice, isRunnable } from './AgentPicker';
import { DiffPreview, LiveRun } from './LiveRun';
import { Markdown } from './Markdown';
import { Preview, previewKind } from './Preview';
import { useNow } from './WorkingOrb';
import { confirmAction } from '../ui';
import { joinPath } from '../paths';

const api = window.alchemist;
const MAX_AGENTS = 4;
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];
const BADGE: Record<string, [string, string]> = { 'claude-code': ['C', 'claude'], codex: ['O', 'openai'], gemini: ['G', 'gemini'], grok: ['X', 'grok'] };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function useActiveProject() {
  return useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId));
}

function Badge({ harnessId }: { harnessId: string }) {
  const [letter, cls] = BADGE[harnessId] ?? [harnessId.slice(0, 1).toUpperCase(), 'other'];
  return <span className={`mb ${cls}`}>{letter}</span>;
}

function useLabels() {
  const catalog = useStore((s) => s.catalog);
  return (c: AgentChoice) => {
    const h = catalog?.harnesses.find((x) => x.id === c.harnessId)?.label ?? c.harnessId;
    const p = catalog?.providers.find((x) => x.id === c.providerId);
    const m = p?.models.find((x) => x.id === c.model)?.label ?? c.model;
    return { agent: h, detail: `${p?.label ?? c.providerId} · ${m}` };
  };
}

/** The Arena's left column: this project's tasks. */
export function ArenaList() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const project = useActiveProject();
  const all = useStore((s) => s.tasks);
  const activeTaskId = useStore((s) => s.activeTaskId);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const loadTasks = useStore((s) => s.loadTasks);
  const tasks = useMemo(() => Object.values(all).filter((x) => x.projectCwd === project?.cwd).sort((a, b) => b.createdAt - a.createdAt), [all, project?.cwd]);

  useEffect(() => {
    if (project) void loadTasks(project.cwd);
  }, [project?.cwd, loadTasks]);

  return (
    <aside className="side arena-list">
      <div className="sec arena-sec">
        <span>{t('arena.tasks')}{project ? ` · ${project.name}` : ''}</span>
        <button className="new-btn" onClick={() => setActiveTask(null)} disabled={!project}>
          + {t('arena.new')}
        </button>
      </div>
      <div className="tree">
        {tasks.length === 0 && <p className="empty">{t('arena.noTasks')}</p>}
        {tasks.map((task) => {
          const cost = task.contestants.reduce((acc, c) => acc + (c.costUsd ?? 0), 0);
          return (
            <div key={task.id} className={`task-row${task.id === activeTaskId ? ' sel' : ''}`} onClick={() => setActiveTask(task.id)}>
              <div className="task-row-top">
                <span className={`phase ${task.phase}`}>{t(`arena.phase.${task.phase}`)}</span>
                <span className="r">{relativeTime(task.updatedAt, locale)}</span>
              </div>
              <div className="task-row-title">{task.title}</div>
              <div className="task-row-meta">
                {task.contestants.map((c) => (
                  <Badge key={c.id} harnessId={c.harnessId} />
                ))}
                {cost > 0 && <span className="r">{money(cost, locale)}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** The Arena's main area: a new task, or the selected one. */
export function ArenaView() {
  const t = useT();
  const project = useActiveProject();
  const task = useStore((s) => (s.activeTaskId ? s.tasks[s.activeTaskId] : undefined));
  const catalog = useStore((s) => s.catalog);
  const loadCatalog = useStore((s) => s.loadCatalog);
  useEffect(() => {
    if (!catalog) void loadCatalog();
  }, [catalog, loadCatalog]);
  if (!project) return <div className="panel-empty">{t('files.empty')}</div>;
  return <section className="arena-main">{task ? <TaskDetail key={task.id} task={task} /> : <NewTask cwd={project.cwd} projectName={project.name} />}</section>;
}

function PlannerStart({ onPlan, onSkip, busy }: { onPlan: (planner: AgentChoice) => void; onSkip: () => void; busy: boolean }) {
  const t = useT();
  const catalog = useStore((s) => s.catalog);
  const [planner, setPlanner] = useState<AgentChoice | null>(null);
  useEffect(() => {
    if (!planner && catalog) setPlanner(defaultChoice(catalog));
  }, [catalog, planner]);
  return (
    <div className="plan-start">
      <div className="field-label">{t('arena.planner')}</div>
      {planner ? <AgentPicker value={planner} onChange={setPlanner} /> : <p className="composer-hint">{t('run.noModel')}</p>}
      <div className="arena-actions">
        <button className="btn-send" disabled={busy || !planner || !isRunnable(catalog, planner)} onClick={() => planner && onPlan(planner)}>
          {t('arena.planFirst')}
        </button>
        <button className="btn-ghost" disabled={busy} onClick={onSkip}>
          {t('arena.skipPlan')}
        </button>
      </div>
      <p className="composer-note">{t('arena.planHint')}</p>
    </div>
  );
}

function NewTask({ cwd, projectName }: { cwd: string; projectName: string }) {
  const t = useT();
  const upsertTask = useStore((s) => s.upsertTask);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (planner: AgentChoice | null) => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const task = await api.createTask(cwd, prompt);
      upsertTask(task);
      setActiveTask(task.id);
      upsertTask(planner ? await api.planTask(task.id, planner) : await api.editTask(task.id, { review: true }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="arena-scroll">
      <div className="arena-head">
        <div className="live">⚔ {t('arena.title').toUpperCase()}</div>
        <h1 className="aname">{t('arena.newIn', { project: projectName })}</h1>
        <p className="adesc">{t('arena.intro')}</p>
      </div>
      <div className="arena-body">
        <div className="composer-box">
          <textarea value={prompt} rows={5} placeholder={t('arena.placeholder')} onChange={(e) => setPrompt(e.target.value)} />
        </div>
        {prompt.trim() && <PlannerStart busy={busy} onPlan={(p) => void create(p)} onSkip={() => void create(null)} />}
        {error && <div className="live-error">{error}</div>}
      </div>
    </div>
  );
}

function TaskDetail({ task }: { task: ArenaTask }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const upsertTask = useStore((s) => s.upsertTask);
  const dropTask = useStore((s) => s.dropTask);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<ArenaTask | void>) => {
    setError(null);
    try {
      const r = await fn();
      if (r) upsertTask(r);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const live = task.phase === 'planning' || task.phase === 'running';
  const finished = task.phase === 'merged' || task.phase === 'discarded';
  const hasWork = task.contestants.some((c) => c.worktree);
  const cost = task.contestants.reduce((acc, c) => acc + (c.costUsd ?? 0), 0);

  return (
    <div className="arena-scroll">
      <div className="arena-head">
        <div className="arena-title-row">
          <span className={`phase ${task.phase}`}>{t(`arena.phase.${task.phase}`)}</span>
          <span className="adesc">{relativeTime(task.createdAt, locale)}</span>
          {(cost > 0 || task.budgetUsd != null) && (
            <span className="pill" title={task.budgetUsd != null ? t('arena.budgetHint') : undefined}>
              {money(cost, locale)}
              {task.budgetUsd != null ? ` / ${money(task.budgetUsd, locale)}` : ''}
            </span>
          )}
          <span className="composer-sp" />
          {live && (
            <button className="btn-stop" onClick={() => void act(() => api.stopTask(task.id))}>
              ■ {t('run.stop')}
            </button>
          )}
          {hasWork && !finished && (
            <button
              className="btn-ghost"
              onClick={() =>
                void confirmAction({ title: t('arena.discardConfirm'), confirmLabel: t('arena.discard'), cancelLabel: t('dialog.cancel'), danger: true }).then(
                  (ok) => void (ok && act(() => api.discardTask(task.id))),
                )
              }
            >
              {t('arena.discard')}
            </button>
          )}
          {(finished || task.phase === 'draft' || task.phase === 'review') && !hasWork && (
            <button
              className="btn-ghost"
              onClick={() =>
                void confirmAction({ title: t('arena.deleteConfirm'), confirmLabel: t('arena.delete'), cancelLabel: t('dialog.cancel'), danger: true }).then(
                  (ok) => void (ok && act(async () => (await api.removeTask(task.id), dropTask(task.id)))),
                )
              }
            >
              {t('arena.delete')}
            </button>
          )}
        </div>
        <h1 className="aname">{task.title}</h1>
        {task.prompt !== task.title && <p className="adesc task-prompt">{task.prompt}</p>}
      </div>
      <div className="arena-body">
        {(task.error || error) && <div className="live-error">{error ?? task.error}</div>}
        {task.phase === 'draft' && (
          <PlannerStart busy={false} onPlan={(p) => void act(() => api.planTask(task.id, p))} onSkip={() => void act(() => api.editTask(task.id, { review: true }))} />
        )}
        {task.phase === 'planning' && <Planning task={task} onSkip={() => void act(() => api.editTask(task.id, { review: true }))} />}
        {task.phase === 'review' && <Review task={task} act={act} />}
        {['running', 'compare', 'merged', 'discarded'].includes(task.phase) && <Contestants task={task} act={act} />}
      </div>
    </div>
  );
}

function Planning({ task, onSkip }: { task: ArenaTask; onSkip: () => void }) {
  const t = useT();
  const labels = useLabels();
  const run = useStore((s) => (task.planner?.runId ? s.runs[task.planner.runId] : undefined));
  return (
    <div className="planning">
      <div className="field-label">
        {t('arena.planning')} {task.planner && <b>{labels(task.planner).agent}</b>} <span className="adesc">{task.planner && labels(task.planner).detail}</span>
      </div>
      {run ? <LiveRun run={run} /> : <span className="spin" />}
      <button className="btn-ghost" onClick={onSkip}>
        {t('arena.writeMyself')}
      </button>
    </div>
  );
}

function Review({ task, act }: { task: ArenaTask; act: (fn: () => Promise<ArenaTask | void>) => Promise<void> }) {
  const t = useT();
  const catalog = useStore((s) => s.catalog);
  const edition = useStore((s) => s.info?.edition);
  const [plan, setPlan] = useState(task.plan);
  const [preview, setPreview] = useState(!!task.plan);
  const [agents, setAgents] = useState<AgentChoice[]>([]);
  const [testCommand, setTestCommand] = useState(task.testCommand ?? '');
  const [budget, setBudget] = useState(task.budgetUsd != null ? String(task.budgetUsd) : '');
  const [mode, setMode] = useState<PermissionMode>(task.permissionMode === 'plan' ? 'acceptEdits' : task.permissionMode);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!agents.length && catalog) {
      const first = defaultChoice(catalog);
      if (first) setAgents([first]);
    }
  }, [catalog, agents.length]);

  const ready = agents.length > 0 && agents.every((a) => isRunnable(catalog, a));
  const start = async () => {
    setBusy(true);
    await act(async () => {
      const cap = Number(budget.replace(',', '.'));
      await api.editTask(task.id, { plan, testCommand: testCommand.trim() || null, permissionMode: mode, budgetUsd: budget.trim() && cap > 0 ? cap : null });
      return api.startTask(task.id, agents);
    });
    setBusy(false);
  };

  return (
    <div className="review">
      <div className="plan-card">
        <div className="plan-head">
          <b>{t('arena.plan')}</b>
          <span className="adesc">{t('arena.planEditHint')}</span>
          <span className="composer-sp" />
          <button className="btn-ghost small" onClick={() => setPreview(!preview)}>
            {preview ? t('arena.edit') : t('arena.preview')}
          </button>
        </div>
        {preview ? (
          <div className="plan-preview" onDoubleClick={() => setPreview(false)}>
            {plan.trim() ? <Markdown text={plan} /> : <p className="empty">{t('arena.noPlan')}</p>}
          </div>
        ) : (
          <textarea className="plan-editor" value={plan} rows={14} placeholder={t('arena.planPlaceholder')} onChange={(e) => setPlan(e.target.value)} onBlur={() => void api.editTask(task.id, { plan })} />
        )}
      </div>

      <div className="field-label">
        {t('arena.agents')} <span className="adesc">{t('arena.agentsHint')}</span>
      </div>
      {agents.map((a, i) => (
        <AgentPicker key={i} value={a} onChange={(c) => setAgents(agents.map((x, j) => (j === i ? c : x)))} onRemove={agents.length > 1 ? () => setAgents(agents.filter((_, j) => j !== i)) : undefined} />
      ))}
      {agents.length < MAX_AGENTS && (
        <button
          className="btn-ghost small"
          onClick={() => {
            const next = defaultChoice(catalog, agents);
            if (next) setAgents([...agents, next]);
          }}
        >
          + {t('arena.addAgent')}
        </button>
      )}

      <div className="arena-options">
        <label>
          <span className="field-label">{t('arena.tests')}</span>
          <input value={testCommand} placeholder="npm test" onChange={(e) => setTestCommand(e.target.value)} />
        </label>
        <label title={t('arena.budgetHint')}>
          <span className="field-label">{t('arena.budget')}</span>
          <input className="budget-input" inputMode="decimal" value={budget} placeholder="—" onChange={(e) => setBudget(e.target.value.replace(/[^\d.,]/g, ''))} />
        </label>
        <label>
          <span className="field-label">{t('run.permissions')}</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`perm.${m}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="arena-actions">
        <button className="btn-send" disabled={busy || !ready} onClick={() => void start()}>
          ⚔ {agents.length > 1 ? t('arena.startMany', { n: agents.length }) : t('arena.startOne')}
        </button>
      </div>
      <p className="composer-note">{agents.length > 1 ? t('arena.worktreesNote') : t('arena.oneNote')}</p>
      {agents.length > 1 && <p className="composer-note">{t('arena.costNote', { n: agents.length })}</p>}
      {edition !== 'pro' && <p className="composer-note">{t('arena.community')}</p>}
    </div>
  );
}

function Contestants({ task, act }: { task: ArenaTask; act: (fn: () => Promise<ArenaTask | void>) => Promise<void> }) {
  const t = useT();
  const [squash, setSquash] = useState(true);
  const [showPlan, setShowPlan] = useState(false);
  const [preview, setPreview] = useState<{ path: string; contestantId: string } | null>(null);
  const labels = useLabels();
  const winner = task.contestants.find((c) => c.id === task.winner);
  return (
    <div className="contestants-wrap">
      {task.phase === 'merged' && winner && (
        <div className="merged-banner">
          ✓ {t('arena.merged', { agent: labels(winner).agent, branch: task.baseBranch ?? 'HEAD', commit: task.mergeCommit?.slice(0, 7) ?? '' })}
        </div>
      )}
      {task.phase === 'discarded' && <div className="live-notice">{t('arena.discarded')}</div>}
      {task.dirtyAtStart.length > 0 && task.phase !== 'merged' && <div className="live-notice warn">{t('arena.dirty', { n: task.dirtyAtStart.length })}</div>}
      {task.plan.trim() && (
        <div className="plan-card compact">
          <div className="plan-head" onClick={() => setShowPlan(!showPlan)}>
            <b>{t('arena.plan')}</b>
            <span className="adesc">{showPlan ? '▾' : '▸'}</span>
          </div>
          {showPlan && (
            <div className="plan-preview">
              <Markdown text={task.plan} />
            </div>
          )}
        </div>
      )}
      {task.phase === 'compare' && task.root && (
        <label className="squash">
          <input type="checkbox" checked={squash} onChange={(e) => setSquash(e.target.checked)} /> {t('arena.squash')}
        </label>
      )}
      <div className={`contestants n${task.contestants.length}`}>
        {task.contestants.map((c) => (
          <ContestantCard key={c.id} task={task} c={c} squash={squash} act={act} onPreview={(path) => setPreview({ path, contestantId: c.id })} />
        ))}
      </div>
      {preview && <ArenaPreview task={task} path={preview.path} initial={preview.contestantId} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** The same file as each agent left it, side by side in tabs: compare what they built. */
function ArenaPreview({ task, path, initial, onClose }: { task: ArenaTask; path: string; initial: string; onClose: () => void }) {
  const t = useT();
  const labels = useLabels();
  const holders = task.contestants.filter((c) => c.worktree && c.changes?.some((f) => f.path === path && f.status !== 'deleted'));
  const [current, setCurrent] = useState(initial);
  const c = holders.find((x) => x.id === current) ?? holders[0];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="arena-preview" onClick={(e) => e.stopPropagation()}>
        <div className="arena-preview-head">
          <b>{t('preview.title')}</b>
          <span className="change-path">{path}</span>
          <div className="agent-tabs">
            {holders.map((h) => (
              <button key={h.id} className={h.id === c?.id ? 'on' : ''} onClick={() => setCurrent(h.id)}>
                <Badge harnessId={h.harnessId} /> {labels(h).agent}
              </button>
            ))}
          </div>
          <span className="composer-sp" />
          <button className="icon-btn" onClick={onClose} title="Esc">
            ×
          </button>
        </div>
        {c?.worktree && <Preview key={c.id} root={c.worktree.path} path={joinPath(c.worktree.path, path)} />}
      </div>
    </div>
  );
}

function ContestantCard({ task, c, squash, act, onPreview }: { task: ArenaTask; c: TaskContestant; squash: boolean; act: (fn: () => Promise<ArenaTask | void>) => Promise<void>; onPreview: (path: string) => void }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const labels = useLabels();
  const run = useStore((s) => (c.runId ? s.runs[c.runId] : undefined));
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const active = c.state === 'running' || c.state === 'waiting' || c.state === 'starting';
  const now = useNow(active);
  const elapsed = c.startedAt ? (c.endedAt ?? now) - c.startedAt : null;
  const added = c.changes?.reduce((a, f) => a + f.added, 0) ?? 0;
  const removed = c.changes?.reduce((a, f) => a + f.removed, 0) ?? 0;
  const { agent, detail } = labels(c);
  const canMerge = task.phase === 'compare' && !!task.root && !!c.changes?.length && !active;

  const open = async (path: string) => {
    if (file === path) {
      setFile(null);
      return;
    }
    setFile(path);
    setDiff(null);
    try {
      const v = await api.taskDiff(task.id, c.id, path);
      setDiff({ path, oldText: v.oldText, newText: v.newText ?? '' });
    } catch {
      setFile(null);
    }
  };

  return (
    <div className={`card ${task.winner === c.id ? 'win' : ''} ${c.state === 'waiting' ? 'ask' : ''}`}>
      <div className="ch">
        <Badge harnessId={c.harnessId} />
        <div className="ch-names">
          <span className="nm">{agent}</span>
          <span className="via">{detail}</span>
        </div>
        <span className={`st ${c.state}`}>
          <span className={`dot ${c.state === 'waiting' ? 'waiting' : active ? 'running' : c.state === 'failed' ? 'waiting' : 'idle'}`} />
          {t(`arena.state.${c.state}`)}
        </span>
      </div>
      <div className="stats">
        <div className="s">
          <b>{duration(elapsed)}</b>
          <span>{t('agent.duration')}</span>
        </div>
        <div className="s">
          <b>{money(c.costUsd, locale)}</b>
          <span>{t('agent.cost')}</span>
        </div>
        <div className="s">
          <b>
            {c.changes ? (
              <>
                <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
              </>
            ) : (
              '—'
            )}
          </b>
          <span>{t('arena.files', { n: c.changes?.length ?? 0 })}</span>
        </div>
        <div className="s">
          <b className={c.tests && c.tests !== 'running' ? (c.tests.ok ? 'ok' : 'bad') : ''}>
            {c.tests === 'running' ? '…' : c.tests ? (c.tests.ok ? '✓' : '✕') : '—'}
          </b>
          <span>{t('arena.testsShort')}</span>
        </div>
      </div>
      <div className="cb">
        {run && active && (
          <div className="card-live">
            <LiveRun run={run} />
          </div>
        )}
        {c.error && <div className="live-error">{c.error}</div>}
        {!active && c.summary && (
          <div className="card-summary">
            <Markdown text={c.summary.slice(-3000)} />
          </div>
        )}
        {c.tests && c.tests !== 'running' && !c.tests.ok && <pre className="test-output">{c.tests.output.slice(-1500)}</pre>}
        {c.changes && c.changes.length > 0 && (
          <div className="changes">
            {c.changes.map((f) => (
              <div key={f.path}>
                <div className={`change-row ${f.status}${file === f.path ? ' open' : ''}`} onClick={() => void open(f.path)}>
                  <span className="change-status">{f.status[0]!.toUpperCase()}</span>
                  <span className="change-path">{f.path}</span>
                  {f.autoRun && (
                    <span className="change-autorun" title={t('arena.autoRunHint')}>
                      ⚠ {t('arena.autoRun')}
                    </span>
                  )}
                  {!f.binary && (
                    <span className="change-lines">
                      <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span>
                    </span>
                  )}
                  {previewKind(f.path) && f.status !== 'deleted' && c.worktree && (task.phase === 'compare' || task.phase === 'running') && (
                    <button
                      className="icon-btn preview-btn"
                      title={t('preview.title')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPreview(f.path);
                      }}
                    >
                      ◧
                    </button>
                  )}
                </div>
                {file === f.path && (diff ? <DiffPreview diff={diff} /> : <span className="spin" />)}
              </div>
            ))}
          </div>
        )}
        {c.changes && c.changes.length === 0 && !active && <p className="empty">{t('arena.noChanges')}</p>}
      </div>
      {canMerge && (
        <div className="card-actions">
          <button
            className="btn-send"
            onClick={() => {
              const autoRun = c.changes?.filter((f) => f.autoRun).map((f) => f.path) ?? [];
              const message = t('arena.mergeConfirm', { agent, branch: task.baseBranch ?? 'HEAD' }) + (autoRun.length ? `\n\n⚠ ${t('arena.autoRunConfirm', { files: autoRun.join(', ') })}` : '');
              void confirmAction({ title: t('arena.choose'), message, confirmLabel: t('arena.choose'), cancelLabel: t('dialog.cancel') }).then((ok) => void (ok && act(() => api.mergeTask(task.id, c.id, squash))));
            }}
          >
            ✓ {t('arena.choose')}
          </button>
        </div>
      )}
    </div>
  );
}
