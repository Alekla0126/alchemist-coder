import { useEffect, useRef, useState } from 'react';
import type { BotConfig } from '@shared/api';
import { defaultTemplate, HOUSE_TEMPLATE, loadTemplates, saveTemplates, setDefaultTemplate, starterTemplates, type Template } from '../org-templates';
import { baseName } from '../paths';
import { useOpenProjects, useStore, useT } from '../store';
import { openMenu, promptText, toast } from '../ui';
import { errorText } from './Bots';
import { Chip } from './ComposerChips';
import { Icon } from './Icon';

/** --org-goal (screenshots) was already given in this launch. */
let shotSent = false;

/**
 * One box to give the organization work: you write what you need once and the coordinator hands it
 * out. The project, a template, a spending cap and the plan review are chips, already set to sensible values.
 */
export function OrgComposer({ coordinator, examples: showExamples }: { coordinator: BotConfig | undefined; examples: boolean }) {
  const t = useT();
  const orgProject = useStore((s) => s.orgProject);
  const activeProject = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId));
  const goal = useStore((s) => s.orgGoal);
  const setGoal = (orgGoal: string) => useStore.setState({ orgGoal });
  const open = useOpenProjects();
  // The project you picked on the chip; until then (or once it's closed) the one you're in, so switching projects in the rail takes the box with you.
  const [picked, setPicked] = useState<string | null>(null);
  const cwd = (picked && open.some((p) => p.cwd === picked) ? picked : '') || orgProject || activeProject?.cwd || open[0]?.cwd || '';
  const [templates, setTemplates] = useState<Template[]>(loadTemplates);
  const all = [...starterTemplates(t), ...templates];
  // The box starts from the default template: The Alchemist Code's way of working, unless you made another one the default.
  const [first] = useState(() => defaultTemplate(all));
  const [guidance, setGuidance] = useState(first?.guidance ?? '');
  const [budget, setBudget] = useState(first?.budget ?? '');
  const [reviewPlan, setReviewPlan] = useState(first?.reviewPlan ?? true);
  const [busy, setBusy] = useState(false);
  const [tplId, setTplId] = useState<string | null>(first?.id ?? null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Filtering the organization to a project is picking it.
  useEffect(() => setPicked(null), [orgProject]);
  // A goal started elsewhere ("Give <agent> a task"): the cursor goes after it, ready to type.
  useEffect(() => {
    const el = box.current;
    if (el && goal) el.setSelectionRange(goal.length, goal.length);
  }, []);
  // The box grows with what you write, up to a point.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [goal]);
  // So do the instructions, one rule per line, once they're unfolded.
  const guidanceBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = guidanceBox.current;
    const fit = () => {
      if (!el || !el.offsetParent) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight + 2, 260)}px`;
    };
    fit();
    const details = el?.closest('details');
    details?.addEventListener('toggle', fit);
    return () => details?.removeEventListener('toggle', fit);
  }, [guidance]);

  const current = all.find((x) => x.id === tplId);
  const applyTemplate = (tpl: Template | null) => {
    if (tpl?.goal) setGoal(tpl.goal);
    setGuidance(tpl?.guidance ?? '');
    setReviewPlan(tpl?.reviewPlan ?? true);
    setBudget(tpl?.budget ?? '');
    setTplId(tpl?.id ?? null);
    box.current?.focus();
  };
  const pickTemplate = async () => {
    const saved = !!current && !current.id.startsWith('starter:');
    const isDefault = !!current && defaultTemplate(all)?.id === current.id;
    const id = await openMenu([
      ...all.map((tpl) => ({ id: `t:${tpl.id}`, label: tpl.id === HOUSE_TEMPLATE ? t('org.tplRecommended', { name: tpl.name }) : tpl.name, checked: tpl.id === tplId })),
      { type: 'separator' },
      ...(current ? [{ id: 'none', label: t('org.tplNone') }] : []),
      ...(current ? [{ id: 'default', label: t('org.tplDefault', { name: current.name }), checked: isDefault }] : []),
      { id: 'save', label: t('bots.tplSave'), enabled: !!goal.trim() || !!guidance.trim() },
      ...(saved ? [{ id: 'delete', label: `${t('bots.tplDelete')}: ${current.name}` }] : []),
    ]);
    if (!id) return;
    if (id === 'none') return applyTemplate(null);
    // Unticking it: assignments start with no template.
    if (id === 'default') {
      setDefaultTemplate(isDefault ? null : current!.id);
      return toast(isDefault ? t('org.tplDefaultNone') : t('org.tplDefaultSet', { name: current!.name }), undefined, 3000);
    }
    if (id === 'delete') {
      const next = templates.filter((x) => x.id !== tplId);
      setTemplates(next);
      saveTemplates(next);
      return setTplId(null);
    }
    if (id === 'save') {
      const name = await promptText({ title: t('bots.tplSave'), placeholder: t('bots.tplNamePlaceholder'), confirmLabel: t('bots.save'), cancelLabel: t('dialog.cancel') });
      if (!name?.trim()) return;
      const tpl = { id: `tpl-${Date.now()}`, name: name.trim().slice(0, 60), goal, guidance, reviewPlan, budget };
      const next = [...templates, tpl];
      setTemplates(next);
      saveTemplates(next);
      return setTplId(tpl.id);
    }
    const tpl = all.find((x) => `t:${x.id}` === id);
    if (tpl) applyTemplate(tpl);
  };
  const pickProject = async () => {
    const id = await openMenu(open.map((p) => ({ id: p.cwd, label: p.name, checked: p.cwd === cwd })));
    if (id) setPicked(id);
  };
  const pickBudget = async () => {
    const value = await promptText({ title: t('bots.budget'), message: t('bots.budgetHint'), value: budget, placeholder: t('bots.budgetNone'), confirmLabel: t('bots.save'), cancelLabel: t('dialog.cancel') });
    if (value === null) return;
    const n = Number(value.replace(',', '.').replace(/[^\d.]/g, ''));
    setBudget(Number.isFinite(n) && n > 0 ? String(n) : '');
  };

  const ready = !!goal.trim() && !!cwd && !!coordinator;
  const why = !coordinator ? t('org.setup') : !cwd ? t('org.pickProject') : '';
  const start = async () => {
    if (!ready || !coordinator || busy) return;
    setBusy(true);
    try {
      const team = await window.alchemist.startTeam({ goal, cwd, configId: coordinator.id, budgetUsd: Number(budget) || null, approvePlan: reviewPlan, guidance });
      useStore.getState().upsertTeam(team);
      // You stay on the chart: it shows who gets what as the coordinator hands the work out.
      useStore.setState({ orgFocusTeamId: team.id });
      setGoal('');
    } catch (e) {
      toast(errorText(e), undefined, 10_000);
    } finally {
      setBusy(false);
    }
  };
  // --org-goal (screenshots): the assignment is given from this box, like you would.
  const shot = useStore((s) => s.info?.capture?.orgGoal ?? null);
  useEffect(() => {
    // Once per launch (the view can mount twice while a capture sets its mode), in the project it asked for.
    const wanted = useStore.getState().info?.capture?.project;
    if (!shot || shotSent || !coordinator || !cwd || (wanted && open.find((p) => p.cwd === cwd)?.name !== wanted)) return;
    shotSent = true;
    setGoal(shot);
    setTimeout(() => document.querySelector<HTMLButtonElement>('.org-composer .btn-send')?.click(), 400);
    // Captured once its plan waits for you (with --org-approve: approved, and a while into the agents' work).
    const began = Date.now();
    let approved = false;
    const timer = setInterval(() => {
      const s = useStore.getState();
      const team = s.botTeams.find((x) => x.id === s.orgFocusTeamId);
      const lead = team?.bots[0];
      const done = () => (clearInterval(timer), s.markCaptureReady());
      if (Date.now() - began > 5 * 60_000 || (lead && ['error', 'stopped'].includes(lead.status) && team?.plan?.status !== 'pending')) return done();
      if (team?.plan?.status !== 'pending' && !approved) return;
      if (!s.info?.capture?.orgApprove) return done();
      if (!approved) {
        approved = true;
        void window.alchemist.answerPlan(team!.id, { approve: true, bots: team!.plan!.bots, feedback: '' });
      } else if (team && team.bots.some((b) => b.depth > 0 && b.status === 'working' && b.doing)) (clearInterval(timer), setTimeout(() => useStore.getState().markCaptureReady(), 6000));
      else if (team && team.bots.length > 1 && !team.bots.some((b) => ['starting', 'working', 'waiting'].includes(b.status))) done();
    }, 1000);
  }, [shot, coordinator, cwd]);
  const examples = [t('bots.example1'), t('bots.example2'), t('bots.example3')];
  const projectName = open.find((p) => p.cwd === cwd)?.name ?? (cwd ? baseName(cwd) : t('org.pickProject'));
  return (
    <section className="org-composer" aria-label={t('bots.newTeam')}>
      <div className="composer-box">
        <textarea
          ref={box}
          rows={2}
          value={goal}
          autoFocus
          placeholder={t('org.composePlaceholder')}
          aria-label={t('bots.goal')}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <div className="composer-bar">
          <Chip icon="folder" label={projectName} title={t('org.project')} fixed={open.length < 2 && !!cwd} onClick={() => void pickProject()} />
          <Chip glyph="⚗" label={current?.name ?? t('bots.templates')} title={t('bots.templates')} className={current ? 'on' : ''} onClick={() => void pickTemplate()} />
          <Chip icon="gauge" label={budget ? t('org.budgetChip', { cap: budget }) : t('bots.budgetNone')} title={t('bots.budget')} className={budget ? 'on' : ''} onClick={() => void pickBudget()} />
          <button className={`cchip toggle ${reviewPlan ? 'on' : ''}`} aria-pressed={reviewPlan} title={t('bots.reviewPlanHint')} onClick={() => setReviewPlan(!reviewPlan)}>
            {reviewPlan && <Icon name="check" size={12} />}
            <span className="cchip-label">{t('bots.reviewPlan')}</span>
          </button>
          <span className="composer-sp" />
          {why && <span className="composer-note" title={why}>{why}</span>}
          <button className="btn-send" disabled={!ready || busy} onClick={() => void start()} title={why || t('org.homeLead')}>
            {busy ? <span className="spin" /> : '⚗'} {t('bots.start')} ↵
          </button>
        </div>
      </div>
      {guidance && (
        <details className="org-guidance">
          <summary>
            <Icon name="chevronRight" size={12} />
            {t('bots.coordInstructions')}
            {current && <span className="org-guidance-tpl"> · {current.name}</span>}
          </summary>
          <textarea ref={guidanceBox} value={guidance} rows={3} aria-label={t('bots.coordInstructions')} onChange={(e) => setGuidance(e.target.value)} />
        </details>
      )}
      {/* Ideas to start from, until the organization has had its first assignment. */}
      {showExamples && !goal && (
        <div className="org-examples">
          <span className="bots-examples-label">{t('bots.examples')}</span>
          {examples.map((ex) => (
            <button key={ex} className="f" onClick={() => (setGoal(ex), box.current?.focus())}>
              {ex}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
