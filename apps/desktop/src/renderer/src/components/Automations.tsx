import { useEffect, useMemo, useState } from 'react';
import type { Automation, AutomationRun, AutomationState, AutomationTrigger, Autonomy, BotConfig, FlowEdge, FlowNode, FlowNodeKind } from '@shared/api';
import { openAssignment, showOnChart } from '../actions/org';
import { duration, money, relativeTime } from '../format';
import { layoutFlow, NODE_H, NODE_W } from '../flow-layout';
import { useOpenProjects, useStore, useT } from '../store';
import { confirmAction, openMenu, promptText, toast } from '../ui';
import { baseName } from '../paths';
import { AgentAvatar } from './AgentAvatar';
import { errorText } from './Bots';
import { Chip } from './ComposerChips';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { WorkingOrb } from './WorkingOrb';

type T = ReturnType<typeof useT>;

const KIND_ICON: Record<FlowNodeKind, string> = { trigger: '⏱', agent: '⚗', decision: '◇', human: '✋', cards: '🗂', work: '▦', notify: '🔔', end: '■' };
const ADDABLE: FlowNodeKind[] = ['agent', 'decision', 'human', 'cards', 'work', 'notify', 'end'];
const EVERY = [15, 30, 60, 180, 360, 720];
const live = (r: AutomationRun | undefined) => !!r && (r.status === 'running' || r.status === 'waiting');

/** "Every day at 08:00", "Every 6 h", "Non-stop (5 min pause)", "When you start it". */
export function triggerText(tr: AutomationTrigger, t: T): string {
  if (tr.kind === 'every') return tr.minutes % 60 === 0 ? t('auto.trigger.everyH', { n: tr.minutes / 60 }) : t('auto.trigger.everyMin', { n: tr.minutes });
  if (tr.kind === 'daily') return tr.days?.length ? t('auto.trigger.weekly', { days: tr.days.map((d) => t(`auto.day.${d}` as never)).join(', '), at: tr.at }) : t('auto.trigger.daily', { at: tr.at });
  if (tr.kind === 'continuous') return t('auto.trigger.continuous', { n: tr.pauseMinutes });
  return t('auto.trigger.manual');
}

/** How an automation is doing, in a few words, and the dot that goes with it. */
function stateOf(s: AutomationState, t: T, locale: string): { tone: 'run' | 'wait' | 'on' | 'off' | 'bad'; text: string } {
  const run = s.runs[0];
  if (run?.status === 'waiting') return { tone: 'wait', text: t('auto.state.waiting') };
  if (run?.status === 'running') {
    const step = s.automation.nodes.find((n) => n.id === run.steps.at(-1)?.nodeId);
    return { tone: 'run', text: step ? step.title : t('auto.state.running') };
  }
  if (!s.automation.enabled) return { tone: 'off', text: run?.status === 'failed' ? t('auto.state.failedOff') : t('auto.state.off') };
  if (s.nextAt) return { tone: run?.status === 'failed' ? 'bad' : 'on', text: t('auto.state.next', { when: relativeTime(s.nextAt, locale as never) }) };
  return { tone: 'on', text: triggerText(s.automation.trigger, t) };
}

const openAutomation = (id: string) => useStore.setState({ activeAutomationId: id, activeTeamId: null, activeMemberId: null, activeBotId: null });

/** The organization sidebar's automations: what each one is doing, and a way to make a new one. */
export function AutomationList() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const list = useStore((s) => s.automations);
  const active = useStore((s) => s.activeAutomationId);
  const orgProject = useStore((s) => s.orgProject);
  const shown = orgProject ? list.filter((s) => s.automation.cwd === orgProject || s.automation.cwd.startsWith(`${orgProject}/`)) : list;
  return (
    <>
      <div className="sec arena-sec">
        <span>{t('auto.title')}</span>
        <button className="new-btn" onClick={() => useStore.setState({ automationDialog: true })}>
          + {t('auto.new')}
        </button>
      </div>
      <div className="tree auto-list" role="list">
        {!shown.length && <p className="empty">{t('auto.none')}</p>}
        {shown.map((s) => {
          const st = stateOf(s, t, locale);
          return (
            <button key={s.automation.id} role="listitem" className={`auto-row ${active === s.automation.id ? 'sel' : ''}`} onClick={() => openAutomation(s.automation.id)} title={s.automation.prompt}>
              {st.tone === 'run' ? <WorkingOrb size={12} /> : st.tone === 'wait' ? <WorkingOrb state="waiting" size={12} /> : <span className={`auto-dot ${st.tone}`} aria-hidden />}
              <span className="auto-row-text">
                <b>{s.automation.name}</b>
                <small>{st.text}</small>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

const TEMPLATES: Array<{ id: 'agent' | 'office' | 'goal'; icon: string }> = [
  { id: 'agent', icon: '✨' },
  { id: 'office', icon: '▦' },
  { id: 'goal', icon: '◎' },
];

/** A new automation from your words: an agent draws the diagram, or a ready-made one is filled in. */
export function NewAutomationDialog() {
  const t = useT();
  const open = useOpenProjects();
  const orgProject = useStore((s) => s.orgProject);
  const activeCwd = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId)?.cwd);
  const [prompt, setPrompt] = useState('');
  const [template, setTemplate] = useState<'agent' | 'office' | 'goal'>('agent');
  const [cwd, setCwd] = useState(orgProject || activeCwd || open[0]?.cwd || '');
  const [autonomy, setAutonomy] = useState<Autonomy>('balanced');
  const [busy, setBusy] = useState(false);
  const close = () => !busy && useStore.setState({ automationDialog: false });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  });
  const create = async () => {
    if (!prompt.trim() || !cwd) return;
    setBusy(true);
    try {
      const state = await window.alchemist.createAutomation({ prompt, cwd, template, autonomy });
      useStore.setState((s) => ({ automations: [state, ...s.automations.filter((x) => x.automation.id !== state.automation.id)], automationDialog: false }));
      openAutomation(state.automation.id);
    } catch (e) {
      toast(errorText(e), undefined, 10_000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="commit-dialog auto-dialog" role="dialog" aria-modal="true" aria-label={t('auto.newTitle')}>
        <h3>{t('auto.newTitle')}</h3>
        <p className="composer-note">{t('auto.newLead')}</p>
        <textarea className="auto-prompt" rows={4} value={prompt} autoFocus placeholder={t(`auto.placeholder.${template}` as never)} onChange={(e) => setPrompt(e.target.value)} />
        <div className="auto-templates" role="radiogroup" aria-label={t('auto.template')}>
          {TEMPLATES.map((x) => (
            <button key={x.id} role="radio" aria-checked={template === x.id} className={`auto-template ${template === x.id ? 'on' : ''}`} onClick={() => setTemplate(x.id)}>
              <span className="auto-template-icon">{x.icon}</span>
              <b>{t(`auto.tpl.${x.id}` as never)}</b>
              <small>{t(`auto.tpl.${x.id}.hint` as never)}</small>
            </button>
          ))}
        </div>
        <div className="auto-dialog-row">
          <label className="bot-field">
            <span>{t('org.project')}</span>
            <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
              {!cwd && <option value="">—</option>}
              {open.map((p) => (
                <option key={p.id} value={p.cwd}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="bot-field">
            <span>{t('auto.autonomy')}</span>
            <select value={autonomy} onChange={(e) => setAutonomy(e.target.value as Autonomy)}>
              {(['careful', 'balanced', 'autonomous'] as const).map((x) => (
                <option key={x} value={x}>
                  {t(`auto.autonomy.${x}` as never)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="composer-note">{t(`auto.autonomy.${autonomy}.hint` as never)}</p>
        <div className="commit-foot">
          {busy && template === 'agent' && <span className="composer-note">{t('auto.designing')}</span>}
          <span className="composer-sp" />
          <button className="btn-ghost" onClick={close} disabled={busy}>
            {t('dialog.cancel')}
          </button>
          <button className="btn-send" disabled={!prompt.trim() || !cwd || busy} onClick={() => void create()}>
            {busy ? <span className="spin" /> : '⚗'} {t('auto.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Who does a step: its agent, or the coordinator when it names none. */
function useAgentOf() {
  const configs = useStore((s) => s.botConfigs);
  const coordinator = configs.find((c) => c.kind === 'coordinator');
  return (node: FlowNode): BotConfig | undefined => (node.agentId ? configs.find((c) => c.id === node.agentId) : coordinator);
}

/** The diagram: steps as cards, arrows between them; a run's progress shows on its steps. */
function FlowDiagram({ nodes, edges, run, selected, onSelect }: { nodes: FlowNode[]; edges: FlowEdge[]; run: AutomationRun | null; selected: string | null; onSelect: (id: string) => void }) {
  const t = useT();
  const agentOf = useAgentOf();
  const { placed, arrows, width, height } = useMemo(() => layoutFlow(nodes, edges), [nodes, edges]);
  const status = new Map<string, { status: string; visits: number }>();
  for (const s of run?.steps ?? []) status.set(s.nodeId, { status: s.status, visits: (status.get(s.nodeId)?.visits ?? 0) + 1 });
  return (
    <div className="flow-scroll">
      <div className="flow" style={{ width, height: height + 8 }}>
        <svg className="flow-arrows" width={width} height={height + 8} aria-hidden>
          <defs>
            <marker id="flow-head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {arrows.map((a, i) => (
            <path key={i} d={a.path} className={`flow-arrow ${a.back ? 'back' : ''} ${run?.steps.some((s, j) => s.nodeId === a.edge.from && run.steps[j + 1]?.nodeId === a.edge.to) ? 'taken' : ''}`} markerEnd="url(#flow-head)" />
          ))}
        </svg>
        {arrows
          .filter((a) => a.edge.branch)
          .map((a, i) => (
            <span key={i} className="flow-label" style={{ left: a.lx, top: a.ly }}>
              {a.edge.branch}
            </span>
          ))}
        {placed.map(({ node, x, y }) => {
          const st = status.get(node.id);
          const who = ['agent', 'decision', 'cards'].includes(node.kind) ? agentOf(node) : undefined;
          return (
            <button key={node.id} className={`flow-node k-${node.kind} ${st ? `s-${st.status}` : ''} ${selected === node.id ? 'sel' : ''}`} style={{ left: x, top: y, width: NODE_W, height: NODE_H }} onClick={() => onSelect(node.id)}>
              <span className="flow-node-top">
                <span className="flow-kind">
                  {KIND_ICON[node.kind]} {t(`auto.kind.${node.kind}` as never)}
                </span>
                {st?.status === 'running' ? <WorkingOrb size={12} /> : st?.status === 'waiting' ? <WorkingOrb state="waiting" size={12} /> : st?.status === 'done' ? <span className="flow-ok">✓</span> : st?.status === 'failed' ? <span className="flow-bad">✕</span> : null}
                {st && st.visits > 1 && <span className="flow-visits">×{st.visits}</span>}
              </span>
              <b className="flow-title">{node.title}</b>
              {who ? (
                <span className="flow-who">
                  <AgentAvatar name={who.name} avatar={who.avatar} size={16} /> {who.name}
                </span>
              ) : (
                node.text && <small className="flow-text">{node.text}</small>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Edits one step: its words, who does it, its branches and where each one goes. */
function NodeInspector({ draft, node, onChange, onClose }: { draft: Automation; node: FlowNode; onChange: (next: Pick<Automation, 'nodes' | 'edges'>) => void; onClose: () => void }) {
  const t = useT();
  const configs = useStore((s) => s.botConfigs).filter((c) => !c.proposed);
  const set = (patch: Partial<FlowNode>) => onChange({ nodes: draft.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)), edges: draft.edges });
  const outs = node.branches ?? [null];
  const targetOf = (branch: string | null) => draft.edges.find((e) => e.from === node.id && (branch ? e.branch === branch : !e.branch))?.to ?? '';
  const setTarget = (branch: string | null, to: string) => {
    const edges = draft.edges.filter((e) => !(e.from === node.id && (branch ? e.branch === branch : !e.branch)));
    if (to) edges.push({ from: node.id, to, ...(branch ? { branch } : {}) });
    onChange({ nodes: draft.nodes, edges });
  };
  const setBranches = (branches: string[]) => {
    const kept = draft.edges.filter((e) => e.from !== node.id || (e.branch && branches.includes(e.branch)));
    onChange({ nodes: draft.nodes.map((n) => (n.id === node.id ? { ...n, branches } : n)), edges: kept });
  };
  const addAfter = async () => {
    const kind = (await openMenu(ADDABLE.map((k) => ({ id: k, label: `${KIND_ICON[k]} ${t(`auto.kind.${k}` as never)}` })))) as FlowNodeKind | null;
    if (!kind) return;
    const id = `n${Date.now().toString(36)}`;
    const fresh: FlowNode = { id, kind, title: t(`auto.kind.${kind}` as never), ...(kind === 'decision' ? { branches: ['Sí', 'No'] } : kind === 'human' ? { branches: ['Aprobar', 'Rechazar'] } : {}) };
    // The new step goes between this one and where it led.
    const out = draft.edges.find((e) => e.from === node.id && !e.branch);
    const edges = draft.edges.filter((e) => e !== out);
    edges.push({ from: node.id, to: id });
    if (out) edges.push({ from: id, to: out.to, ...(fresh.branches ? { branch: fresh.branches[0] } : {}) });
    onChange({ nodes: [...draft.nodes, fresh], edges });
  };
  const remove = () => {
    // Whatever led here now leads to where it went.
    const next = draft.edges.find((e) => e.from === node.id)?.to;
    const edges = draft.edges.filter((e) => e.from !== node.id).map((e) => (e.to === node.id ? (next ? { ...e, to: next } : null) : e)).filter((e): e is FlowEdge => !!e);
    onChange({ nodes: draft.nodes.filter((n) => n.id !== node.id), edges });
    onClose();
  };
  const textLabel = node.kind === 'decision' || node.kind === 'human' ? t('auto.field.question') : node.kind === 'notify' ? t('auto.field.message') : node.kind === 'cards' ? t('auto.field.goal') : t('auto.field.instruction');
  return (
    <aside className="flow-inspector" aria-label={t('auto.step')}>
      <div className="flow-inspector-head">
        <span className="flow-kind">
          {KIND_ICON[node.kind]} {t(`auto.kind.${node.kind}` as never)}
        </span>
        <span className="composer-sp" />
        <button className="icon-btn" onClick={onClose} aria-label={t('dialog.close')} title={t('dialog.close')}>
          ×
        </button>
      </div>
      <p className="composer-note">{t(`auto.kind.${node.kind}.hint` as never)}</p>
      <label className="auto-field">
        <span>{t('auto.field.title')}</span>
        <input value={node.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      {['agent', 'decision', 'cards'].includes(node.kind) && (
        <label className="auto-field">
          <span>{t('auto.field.who')}</span>
          <select value={node.agentId ?? ''} onChange={(e) => set({ agentId: e.target.value || null })}>
            <option value="">{t('auto.field.coordinator')}</option>
            {configs
              .filter((c) => c.kind !== 'coordinator')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {!['trigger', 'end', 'work'].includes(node.kind) && (
        <label className="auto-field">
          <span>{textLabel}</span>
          <textarea rows={4} value={node.text ?? ''} onChange={(e) => set({ text: e.target.value })} />
        </label>
      )}
      {node.kind === 'work' && (
        <label className="auto-field">
          <span>{t('auto.field.extra')}</span>
          <textarea rows={2} value={node.text ?? ''} onChange={(e) => set({ text: e.target.value })} />
        </label>
      )}
      {node.branches && (
        <label className="auto-field">
          <span>{t('auto.field.branches')}</span>
          <input
            value={node.branches.join(', ')}
            onChange={(e) =>
              setBranches(
                e.target.value
                  .split(',')
                  .map((b) => b.trim())
                  .filter(Boolean)
                  .slice(0, 6),
              )
            }
          />
        </label>
      )}
      {node.kind !== 'end' &&
        outs.map((branch) => (
          <label key={branch ?? '-'} className="auto-field">
            <span>{branch ? t('auto.field.ifBranch', { branch }) : t('auto.field.next')}</span>
            <select value={targetOf(branch)} onChange={(e) => setTarget(branch, e.target.value)}>
              <option value="">{t('auto.field.stop')}</option>
              {draft.nodes
                .filter((n) => n.kind !== 'trigger' && n.id !== node.id)
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {KIND_ICON[n.kind]} {n.title}
                  </option>
                ))}
            </select>
          </label>
        ))}
      <div className="flow-inspector-actions">
        {node.kind !== 'end' && (
          <button className="btn-ghost small" onClick={() => void addAfter()}>
            + {t('auto.addAfter')}
          </button>
        )}
        <span className="composer-sp" />
        {node.kind !== 'trigger' && (
          <button className="btn-ghost small danger" onClick={remove}>
            {t('auto.removeStep')}
          </button>
        )}
      </div>
    </aside>
  );
}

/** One run: when, how it went, what it cost; it opens to each step's result. */
function RunRow({ automation, run, selected, onSelect }: { automation: Automation; run: AutomationRun; selected: boolean; onSelect: () => void }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const teams = useStore((s) => s.botTeams);
  const took = (run.endedAt ?? Date.now()) - run.startedAt;
  return (
    <div className={`auto-run ${selected ? 'sel' : ''}`}>
      <button className="auto-run-head" onClick={onSelect} aria-expanded={selected}>
        <span className={`auto-run-state s-${run.status}`}>{t(`auto.run.${run.status}` as never)}</span>
        <span className="auto-run-when">{relativeTime(run.startedAt, locale)}</span>
        <small>{[duration(took), run.costUsd > 0 ? money(run.costUsd, locale) : ''].filter(Boolean).join(' · ')}</small>
        {run.why && run.why !== 'stopped' && <small className="auto-run-why">{run.why === 'appClosed' ? t('auto.run.appClosed') : run.why}</small>}
      </button>
      {selected && (
        <ol className="auto-steps">
          {run.steps.map((s, i) => {
            const node = automation.nodes.find((n) => n.id === s.nodeId);
            if (!node || node.kind === 'trigger' || node.kind === 'end') return null;
            return (
              <li key={i} className={`s-${s.status}`}>
                <div className="auto-step-head">
                  <span>{KIND_ICON[node.kind]}</span>
                  <b>{node.title}</b>
                  {s.branch && <span className="ac">→ {s.branch}</span>}
                  <span className="composer-sp" />
                  {s.teamIds.slice(0, 3).map((id) => {
                    const team = teams.find((x) => x.id === id);
                    return team ? (
                      <button key={id} className="link small" onClick={() => openAssignment(team)}>
                        {team.bots[0]?.name ?? t('auto.assignment')} →
                      </button>
                    ) : null;
                  })}
                </div>
                {s.output && (
                  <details className="auto-step-out" open={s.status === 'failed'}>
                    <summary>{s.output.split('\n')[0]!.slice(0, 140)}</summary>
                    <Markdown text={s.output} />
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** An automation: its diagram (editable), when it runs, what agents may decide alone, and its runs. */
export function AutomationView({ state }: { state: AutomationState }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const open = useOpenProjects();
  const telegram = useTelegram();
  const a = state.automation;
  const latest = state.runs[0];
  const running = live(latest);
  const [draft, setDraft] = useState<Automation>(a);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [change, setChange] = useState('');
  const [busy, setBusy] = useState<'' | 'revise' | 'save'>('');
  // A fresh copy from the app replaces ours unless we're editing it.
  useEffect(() => {
    if (!dirty) setDraft(a);
  }, [a, dirty]);
  useEffect(() => {
    setSelected(null);
    setRunId(null);
    setDirty(false);
  }, [a.id]);
  const shownRun = state.runs.find((r) => r.id === runId) ?? (running ? latest! : null);
  const edit = (patch: Partial<Automation>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const save = async (extra: Partial<Automation> = {}) => {
    setBusy('save');
    try {
      const saved = await window.alchemist.saveAutomation({ ...draft, ...extra });
      useStore.setState((s) => ({ automations: s.automations.map((x) => (x.automation.id === saved.automation.id ? saved : x)) }));
      setDraft(saved.automation);
      setDirty(false);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy('');
    }
  };
  const toggle = async () => {
    try {
      if (dirty) await save();
      await window.alchemist.setAutomationEnabled(a.id, !a.enabled);
      if (!a.enabled) toast(a.trigger.kind === 'manual' ? t('auto.onManual') : t('auto.onToast', { when: triggerText(a.trigger, t) }), undefined, 4000);
    } catch (e) {
      toast(errorText(e));
    }
  };
  const run = async () => {
    try {
      if (dirty) await save();
      await window.alchemist.runAutomation(a.id);
      setRunId(null);
    } catch (e) {
      toast(errorText(e));
    }
  };
  const revise = async () => {
    if (!change.trim()) return;
    setBusy('revise');
    try {
      const next = await window.alchemist.reviseAutomation(a.id, change);
      useStore.setState((s) => ({ automations: s.automations.map((x) => (x.automation.id === next.automation.id ? next : x)) }));
      setDraft(next.automation);
      setDirty(false);
      setChange('');
      setSelected(null);
    } catch (e) {
      toast(errorText(e), undefined, 10_000);
    } finally {
      setBusy('');
    }
  };
  const remove = async () => {
    if (!(await confirmAction({ title: t('auto.deleteTitle', { name: a.name }), message: t('auto.deleteBody'), confirmLabel: t('auto.delete'), cancelLabel: t('dialog.cancel'), danger: true }))) return;
    await window.alchemist.deleteAutomation(a.id);
    useStore.setState((s) => ({ automations: s.automations.filter((x) => x.automation.id !== a.id), activeAutomationId: null }));
  };
  const pickTrigger = async () => {
    const id = await openMenu([
      { id: 'manual', label: t('auto.trigger.manual'), checked: draft.trigger.kind === 'manual' },
      { type: 'separator' },
      ...EVERY.map((m) => ({ id: `every:${m}`, label: m % 60 === 0 ? t('auto.trigger.everyH', { n: m / 60 }) : t('auto.trigger.everyMin', { n: m }), checked: draft.trigger.kind === 'every' && draft.trigger.minutes === m })),
      { type: 'separator' },
      { id: 'daily', label: `${t('auto.trigger.dailyPick')}…`, checked: draft.trigger.kind === 'daily' && !draft.trigger.days?.length },
      { id: 'weekly', label: t('auto.trigger.weeklyPick'), submenu: [1, 2, 3, 4, 5, 6, 0].map((d) => ({ id: `day:${d}`, label: t(`auto.day.${d}` as never), checked: draft.trigger.kind === 'daily' && !!draft.trigger.days?.includes(d) })) },
      { id: 'continuous', label: t('auto.trigger.continuous', { n: 5 }), checked: draft.trigger.kind === 'continuous' },
    ]);
    if (!id) return;
    if (id.startsWith('day:')) {
      // Weekdays add up: tick Monday and Thursday for both.
      const d = Number(id.slice(4));
      const days = draft.trigger.kind === 'daily' ? (draft.trigger.days ?? []) : [];
      const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
      edit({ trigger: { kind: 'daily', at: draft.trigger.kind === 'daily' ? draft.trigger.at : '09:00', ...(next.length ? { days: next } : {}) } });
      return;
    }
    if (id === 'daily') {
      const at = await promptText({ title: t('auto.trigger.dailyPick'), message: t('auto.trigger.dailyHint'), value: draft.trigger.kind === 'daily' ? draft.trigger.at : '08:00', confirmLabel: t('bots.save'), cancelLabel: t('dialog.cancel') });
      if (at && /^([01]?\d|2[0-3]):[0-5]\d$/.test(at.trim())) edit({ trigger: { kind: 'daily', at: at.trim().padStart(5, '0') } });
      else if (at) toast(t('auto.trigger.badTime'));
      return;
    }
    edit({ trigger: id === 'manual' ? { kind: 'manual' } : id === 'continuous' ? { kind: 'continuous', pauseMinutes: 5 } : { kind: 'every', minutes: Number(id.slice(6)) } });
  };
  const pickAutonomy = async () => {
    const id = await openMenu((['careful', 'balanced', 'autonomous'] as const).map((x) => ({ id: x, label: t(`auto.autonomy.${x}` as never), checked: draft.autonomy === x })));
    if (id) edit({ autonomy: id as Autonomy });
  };
  const pickBudget = async () => {
    const value = await promptText({ title: t('auto.budget'), message: t('auto.budgetHint'), value: draft.budgetUsdPerDay ? String(draft.budgetUsdPerDay) : '', placeholder: t('bots.budgetNone'), confirmLabel: t('bots.save'), cancelLabel: t('dialog.cancel') });
    if (value === null) return;
    const n = Number(value.replace(',', '.').replace(/[^\d.]/g, ''));
    edit({ budgetUsdPerDay: Number.isFinite(n) && n > 0 ? n : null });
  };
  const rename = async () => {
    const name = await promptText({ title: t('auto.rename'), value: draft.name, confirmLabel: t('menu.renameOk'), cancelLabel: t('dialog.cancel') });
    if (name?.trim()) edit({ name: name.trim() });
  };
  const node = draft.nodes.find((n) => n.id === selected);
  const asks = latest?.asks ?? [];
  const projectName = open.find((p) => p.cwd === a.cwd)?.name ?? baseName(a.cwd);
  const st = stateOf(state, t, locale);
  return (
    <section className="team-view auto-view">
      <header className="team-head">
        <button className="icon-btn ic-btn" onClick={() => (useStore.setState({ activeAutomationId: null }), showOnChart())} title={t('org.backToChart')} aria-label={t('org.backToChart')}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <div className="team-title">
          <span className={`team-state ts-${a.enabled ? (running ? 'working' : 'finished') : 'stopped'}`}>{a.enabled ? t('auto.on') : t('auto.off')}</span>
          <h1 title={a.prompt} onDoubleClick={() => void rename()}>
            {draft.name}
          </h1>
        </div>
        <span className="ah-stats">{[st.text, state.spentToday > 0 ? t('auto.spentToday', { cost: money(state.spentToday, locale) }) : ''].filter(Boolean).join(' · ')}</span>
        {running ? (
          <button className="btn-stop" onClick={() => void window.alchemist.stopAutomationRun(latest!.id)}>
            ■ {t('auto.stop')}
          </button>
        ) : (
          <button className="btn-ghost" onClick={() => void run()}>
            ▶ {t('auto.runNow')}
          </button>
        )}
        <button className={a.enabled ? 'btn-ghost' : 'btn-send'} onClick={() => void toggle()} title={a.enabled ? t('auto.turnOffHint') : t('auto.turnOnHint')}>
          {a.enabled ? t('auto.turnOff') : t('auto.turnOn')}
        </button>
        <button
          className="icon-btn"
          title={t('menu.more')}
          aria-label={t('menu.more')}
          onClick={() =>
            void openMenu([
              { id: 'rename', label: `${t('auto.rename')}…` },
              { type: 'separator' },
              { id: 'delete', label: t('auto.delete') },
            ]).then((id) => {
              if (id === 'rename') void rename();
              if (id === 'delete') void remove();
            })
          }
        >
          ⋯
        </button>
      </header>
      <div className="auto-body">
        <div className="auto-chips">
          <Chip glyph="⏱" label={triggerText(draft.trigger, t)} title={t('auto.when')} onClick={() => void pickTrigger()} />
          <Chip icon="folder" label={projectName} title={t('org.project')} fixed />
          <Chip glyph="⚖" label={t(`auto.autonomy.${draft.autonomy}` as never)} title={t('auto.autonomy')} onClick={() => void pickAutonomy()} />
          <Chip icon="gauge" label={draft.budgetUsdPerDay ? t('auto.budgetChip', { cap: draft.budgetUsdPerDay }) : t('auto.noBudget')} title={t('auto.budget')} onClick={() => void pickBudget()} />
          <button className={`cchip ${telegram?.paired ? 'on' : ''}`} onClick={() => useStore.setState({ settingsOpen: true, settingsSection: 'automations' })} title={t('auto.phoneHint')}>
            <span className="cchip-glyph">📱</span>
            <span className="cchip-label">{telegram?.paired ? t('auto.phoneOn', { name: telegram.chatName ?? 'Telegram' }) : t('auto.phoneOff')}</span>
          </button>
          <span className="composer-sp" />
          {dirty && (
            <>
              <span className="composer-note">{t('org.unsaved')}</span>
              <button className="btn-ghost small" onClick={() => (setDraft(a), setDirty(false))}>
                {t('dialog.cancel')}
              </button>
              <button className="btn-send" disabled={busy === 'save'} onClick={() => void save()}>
                {t('org.save')}
              </button>
            </>
          )}
        </div>
        {asks.map((ask) => (
          <div key={ask.id} className="org-need-card auto-ask" role="status">
            <WorkingOrb state="waiting" size={16} />
            <span className="org-need-text">
              <b>{ask.question}</b>
              {ask.detail && (
                <details>
                  <summary>{t('auto.askDetail')}</summary>
                  <Markdown text={ask.detail} />
                </details>
              )}
            </span>
            {ask.choices.map((c, i) => (
              <button key={c} className={i === 0 ? 'btn-send' : 'btn-ghost small'} onClick={() => void window.alchemist.answerAutomation(latest!.id, ask.id, c)}>
                {c}
              </button>
            ))}
          </div>
        ))}
        <div className={`auto-canvas ${node ? 'with-inspector' : ''}`}>
          <FlowDiagram nodes={draft.nodes} edges={draft.edges} run={shownRun} selected={selected} onSelect={(id) => setSelected(id === selected ? null : id)} />
          {node && !running && <NodeInspector draft={draft} node={node} onChange={(next) => edit(next)} onClose={() => setSelected(null)} />}
          {node && running && (
            <aside className="flow-inspector">
              <p className="composer-note">{t('auto.lockedRunning')}</p>
            </aside>
          )}
        </div>
        <div className="auto-revise">
          <input value={change} placeholder={t('auto.revisePlaceholder')} disabled={!!busy || running} onChange={(e) => setChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void revise()} />
          <button className="btn-ghost small" disabled={!change.trim() || !!busy || running} onClick={() => void revise()}>
            {busy === 'revise' ? <span className="spin" /> : '✨'} {t('auto.revise')}
          </button>
        </div>
        <section className="auto-runs" aria-label={t('auto.runs')}>
          <h4>{t('auto.runs')}</h4>
          {!state.runs.length && <p className="empty">{t('auto.noRuns')}</p>}
          {state.runs.slice(0, 12).map((r) => (
            <RunRow key={r.id} automation={a} run={r} selected={shownRun?.id === r.id} onSelect={() => setRunId(shownRun?.id === r.id && !live(r) ? null : r.id)} />
          ))}
        </section>
        <p className="composer-note auto-foot">{t('auto.keepOpen')}</p>
      </div>
    </section>
  );
}

/** Whether your phone gets the automations' messages. */
function useTelegram() {
  const [s, setS] = useState<{ paired: boolean; chatName: string | null } | null>(null);
  const open = useStore((st) => st.settingsOpen);
  useEffect(() => {
    void window.alchemist.automationSettings().then((x) => setS({ paired: x.telegram.paired && x.telegram.connected, chatName: x.telegram.chatName }));
  }, [open]);
  return s;
}

/** Settings → Automations: your phone (your own Telegram bot), opening at login, staying awake. */
export function AutomationSettingsCard() {
  const t = useT();
  const [s, setS] = useState<Awaited<ReturnType<typeof window.alchemist.automationSettings>> | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.alchemist.automationSettings().then(setS);
  }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errorText(e), undefined, 8000);
    } finally {
      setBusy(false);
    }
  };
  if (!s) return <span className="spin" />;
  const tg = s.telegram;
  return (
    <div className="auto-settings">
      <section className="settings-card">
        <h4>📱 {t('auto.tg.title')}</h4>
        <p className="composer-note">{t('auto.tg.lead')}</p>
        {!tg.connected ? (
          <>
            <ol className="auto-tg-steps">
              <li>{t('auto.tg.step1')}</li>
              <li>{t('auto.tg.step2')}</li>
            </ol>
            <div className="auto-tg-row">
              <input type="password" value={token} placeholder="123456789:AA…" aria-label={t('auto.tg.token')} onChange={(e) => setToken(e.target.value)} />
              <button
                className="btn-send"
                disabled={!token.trim() || busy}
                onClick={() =>
                  void act(async () => {
                    const r = await window.alchemist.connectTelegram(token);
                    if (!r.ok) throw new Error(r.error || t('auto.tg.bad'));
                    setToken('');
                    setS(r.settings);
                  })
                }
              >
                {t('auto.tg.connect')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              {t('auto.tg.connected', { name: tg.username ? `@${tg.username}` : 'bot' })}
              {tg.paired && ` · ${t('auto.tg.paired', { name: tg.chatName ?? '' })}`}
            </p>
            {!tg.paired && <p className="composer-note">{t('auto.tg.step3', { name: tg.username ? `@${tg.username}` : 'bot' })}</p>}
            <div className="auto-tg-row">
              {!tg.paired ? (
                <button className="btn-send" disabled={busy} onClick={() => void act(async () => setS(await window.alchemist.pairTelegram()))}>
                  {t('auto.tg.pair')}
                </button>
              ) : (
                <button className="btn-ghost small" disabled={busy} onClick={() => void act(async () => toast((await window.alchemist.testTelegram()) ? t('auto.tg.sent') : t('auto.tg.notSent')))}>
                  {t('auto.tg.test')}
                </button>
              )}
              <span className="composer-sp" />
              <button className="btn-ghost small danger" disabled={busy} onClick={() => void act(async () => setS((await window.alchemist.connectTelegram(null)).settings))}>
                {t('auto.tg.disconnect')}
              </button>
            </div>
          </>
        )}
      </section>
      <section className="settings-card">
        <h4>🌙 {t('auto.alwaysOn')}</h4>
        <label className="bot-check">
          <input type="checkbox" checked={s.openAtLogin} onChange={(e) => void act(async () => setS(await window.alchemist.setAutomationOptions({ openAtLogin: e.target.checked })))} />
          <span>
            <b>{t('auto.openAtLogin')}</b>
            <small>{t('auto.openAtLoginHint')}</small>
          </span>
        </label>
        <label className="bot-check">
          <input type="checkbox" checked={s.keepAwake} onChange={(e) => void act(async () => setS(await window.alchemist.setAutomationOptions({ keepAwake: e.target.checked })))} />
          <span>
            <b>{t('auto.keepAwake')}</b>
            <small>{t('auto.keepAwakeHint')}</small>
          </span>
        </label>
      </section>
    </div>
  );
}

export { openAutomation };
