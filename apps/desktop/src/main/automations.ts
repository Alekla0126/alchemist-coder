import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Automation, AutomationAsk, AutomationRun, AutomationState, AutomationTrigger, Autonomy, BoardData, BotConfig, BotTeam, FlowEdge, FlowNode, FlowNodeKind, PermissionMode, RunStep, TeamOrigin } from '../shared/api';

/**
 * Automations: a diagram of steps that runs on its own (at a time, every so often, or again and again),
 * with the organization's agents as the employees who do the work. Each agent step is an assignment of
 * its own, so it shows, asks and stops like any other. What can't be undone waits for you.
 */

const KINDS: FlowNodeKind[] = ['trigger', 'agent', 'decision', 'human', 'cards', 'work', 'notify', 'end'];
const AUTONOMY: Autonomy[] = ['careful', 'balanced', 'autonomous'];
const MAX_NODES = 40;
/** Steps one run may take (loops included) before it stops: a diagram that never ends costs money. */
const MAX_STEPS = 60;
/** How often one step may run in the same run (a decision that keeps sending work back). */
const MAX_VISITS = 6;
const MAX_CARDS = 6;
/** Employees working at once in a work step. */
const PARALLEL = 3;
const MAX_RUNS_KEPT = 30;
const CLIP = 6000;

export type Template = 'agent' | 'office' | 'goal';
export type Lang = 'es' | 'en';

/** What automations say to you (notifications, questions, run results), in the app's language. */
const WORDS = {
  es: {
    start: 'Empezar',
    approve: 'Aprobar',
    reject: 'Rechazar',
    yes: 'Sí',
    no: 'No',
    untitled: 'Automatización',
    stopped: 'se detuvo',
    paused: 'en pausa',
    needsYou: 'te necesita',
    chose: (c: string) => `Elegiste: ${c}`,
    unclear: (title: string) => `${title}: el agente no decidió con claridad. ¿Qué hacemos?`,
    bringIn: (name: string, title: string) => `¿Llevar al proyecto los cambios de ${name} en «${title}»?`,
    files: (n: number, list: string) => `${n} archivos: ${list}`,
    apply: 'Aplicar',
    discard: 'Descartar',
    notApplied: (name: string, branch: string) => `${name}: los cambios no se aplicaron (quedan en su rama ${branch}).`,
    newCards: 'Tarjetas nuevas',
    noCards: 'No hizo falta ninguna tarjeta nueva.',
    noOpen: 'No había tarjetas pendientes.',
    unfinished: 'no terminó',
    noChanges: 'Sin cambios.',
    loop: (title: string, n: number) => `«${title}» corrió ${n} veces en esta ejecución; se detuvo para no repetirse sin fin.`,
    tooLong: (n: number) => `Pasó de ${n} pasos y se detuvo.`,
    capPaused: (cap: number) => `Llegó al tope de hoy (US$ ${cap}).`,
    capStop: (cap: number) => `Llegó al tope de gasto de hoy (US$ ${cap}) y quedó en pausa.`,
    failed: (name: string, why: string) => `${name}: ${why || 'su ejecución falló'}`,
    wasStopped: (name: string) => `${name} fue detenido.`,
    noEmployees: 'La organización no tiene agentes para este proyecto a quienes dar tarjetas.',
    noAgents: 'La organización todavía no tiene agentes.',
    office: {
      name: 'La oficina en el Board',
      plan: 'El gerente reparte el trabajo en tarjetas',
      work: 'Los empleados hacen sus tarjetas',
      check: '¿Objetivo cumplido?',
      checkText: (g: string) => `El objetivo era: ${g}\nCon lo que ya se hizo, ¿está cumplido o hacen falta más tarjetas?`,
      more: 'Más tarjetas',
      done: 'Cumplido',
      tell: 'Te aviso del resultado',
      tellText: 'Objetivo cumplido.',
      end: 'Fin',
    },
    goal: {
      name: 'Ciclo de objetivo',
      start: 'Cada 6 horas',
      measure: 'Medir cómo vamos',
      measureText: (g: string) => `Mide cómo vamos hacia este objetivo: ${g}\nDa el valor actual de la métrica, cómo cambió desde la última vez y de dónde lo sacaste. No cambies archivos.`,
      plan: 'Decidir los próximos pasos',
      planText: (g: string) => `Con la medición anterior, decide las próximas tareas (como mucho 3) que más nos acercan a: ${g}`,
      work: 'Los empleados hacen sus tarjetas',
      report: 'Informe del ciclo',
      reportText: 'Informe del ciclo.',
      end: 'Fin',
    },
  },
  en: {
    start: 'Start',
    approve: 'Approve',
    reject: 'Reject',
    yes: 'Yes',
    no: 'No',
    untitled: 'Automation',
    stopped: 'stopped',
    paused: 'paused',
    needsYou: 'needs you',
    chose: (c: string) => `You chose: ${c}`,
    unclear: (title: string) => `${title}: the agent didn't decide clearly. What do we do?`,
    bringIn: (name: string, title: string) => `Bring ${name}'s changes in "${title}" into the project?`,
    files: (n: number, list: string) => `${n} files: ${list}`,
    apply: 'Apply',
    discard: 'Discard',
    notApplied: (name: string, branch: string) => `${name}: the changes weren't applied (they stay on its branch ${branch}).`,
    newCards: 'New cards',
    noCards: 'No new card was needed.',
    noOpen: 'There were no open cards.',
    unfinished: "didn't finish",
    noChanges: 'No changes.',
    loop: (title: string, n: number) => `"${title}" ran ${n} times in this run; it stopped so it doesn't loop forever.`,
    tooLong: (n: number) => `It took more than ${n} steps and stopped.`,
    capPaused: (cap: number) => `Reached today's cap (US$ ${cap}).`,
    capStop: (cap: number) => `It reached today's spending cap (US$ ${cap}) and was paused.`,
    failed: (name: string, why: string) => `${name}: ${why || 'its run failed'}`,
    wasStopped: (name: string) => `${name} was stopped.`,
    noEmployees: 'The organization has no agents for this project to give cards to.',
    noAgents: 'The organization has no agents yet.',
    office: {
      name: 'The office on the Board',
      plan: 'The manager splits the work into cards',
      work: 'The employees do their cards',
      check: 'Goal reached?',
      checkText: (g: string) => `The goal was: ${g}\nWith what was done, is it reached or are more cards needed?`,
      more: 'More cards',
      done: 'Reached',
      tell: 'Tell you the result',
      tellText: 'Goal reached.',
      end: 'End',
    },
    goal: {
      name: 'Goal cycle',
      start: 'Every 6 hours',
      measure: 'Measure how we are doing',
      measureText: (g: string) => `Measure how we are doing toward this goal: ${g}\nGive the metric's current value, how it changed since last time and where you got it. Don't change files.`,
      plan: 'Decide the next steps',
      planText: (g: string) => `With the measurement above, decide the next tasks (at most 3) that bring us closest to: ${g}`,
      work: 'The employees do their cards',
      report: 'Cycle report',
      reportText: 'Cycle report.',
      end: 'End',
    },
  },
};

export interface AutomationDeps {
  configs(): BotConfig[];
  /** `noCopyPermission`: how it works when it can't get its own copy (the project doesn't use git). */
  startSolo(input: { configId: string; cwd: string; task: string; title?: string; ownWorktree?: boolean; readOnly?: boolean; permissionMode?: PermissionMode; noCopyPermission?: PermissionMode; origin?: TeamOrigin | null }): Promise<BotTeam>;
  team(teamId: string): BotTeam | undefined;
  watch(fn: (team: BotTeam) => void): () => void;
  stopTeam(teamId: string): void;
  changes(teamId: string, botId: string): Promise<Array<{ path: string }>>;
  apply(teamId: string, botId: string): Promise<string>;
  board: { get(): BoardData; patch(fn: (data: BoardData) => void): BoardData };
  /** A message for you (the Mac and your phone); with `ask`, a question you answer with one of its choices. */
  notify(message: { title: string; body: string; automationId?: string; ask?: AutomationAsk & { key: string } }): void;
  /** A question answered in the app: the phone's copy shows it. */
  resolved?(key: string, choice: string): void;
  /** One answer from an agent, no tools (to draw a diagram from your words). */
  oneShot(prompt: string, cwd: string, agent: BotConfig): Promise<string>;
  emit(state: AutomationState): void;
  now?: () => number;
  /** The app's language, for what automations say. */
  lang?: () => Lang;
}

const str = (v: unknown, max = 20_000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clip = (s: string, max = CLIP) => (s.length > max ? `${s.slice(0, max)}…` : s);
/** A word as people mean it: no case, no accents ("si" is "Sí"). */
const loose = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const id = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex')}`;

function cleanTrigger(v: unknown): AutomationTrigger {
  const t = (v ?? {}) as Record<string, unknown>;
  const n = (x: unknown, min: number, max: number, def: number) => {
    const v = Number(x);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
  };
  if (t.kind === 'every') return { kind: 'every', minutes: n(t.minutes, 5, 7 * 24 * 60, 60) };
  if (t.kind === 'daily') {
    const days = [...new Set((Array.isArray(t.days) ? t.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    const at = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(t.at)) ? String(t.at).padStart(5, '0') : '08:00';
    return { kind: 'daily', at, ...(days.length && days.length < 7 ? { days } : {}) };
  }
  if (t.kind === 'continuous') return { kind: 'continuous', pauseMinutes: n(t.pauseMinutes, 1, 24 * 60, 5) };
  return { kind: 'manual' };
}

/**
 * Whatever was stored, sent or drawn by an agent, as a diagram that can run: one trigger first, known
 * kinds, unique ids, agents that exist, branches on decisions and questions, edges between real steps.
 */
export function cleanFlow(rawNodes: unknown, rawEdges: unknown, configs: BotConfig[], lang: Lang = 'en'): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const w = WORDS[lang];
  const agentOf = (v: unknown) => {
    const s = str(v, 100).toLowerCase();
    if (!s) return null;
    return configs.find((c) => c.id === v)?.id ?? configs.find((c) => c.name.toLowerCase() === s)?.id ?? null;
  };
  const nodes: FlowNode[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(rawNodes) ? rawNodes.slice(0, MAX_NODES) : []) {
    const x = (raw ?? {}) as Record<string, unknown>;
    const kind = KINDS.includes(x.kind as FlowNodeKind) ? (x.kind as FlowNodeKind) : null;
    let nid = str(x.id, 40).replace(/[^\w-]/g, '');
    if (!kind) continue;
    if (!nid || seen.has(nid)) nid = `n${nodes.length + 1}-${randomBytes(2).toString('hex')}`;
    seen.add(nid);
    const node: FlowNode = { id: nid, kind, title: str(x.title, 120) || kind };
    if (['agent', 'decision', 'cards'].includes(kind)) node.agentId = agentOf(x.agentId ?? x.agent);
    const text = str(x.text, 8000);
    if (text) node.text = text;
    if (kind === 'decision' || kind === 'human') {
      // No branches on the step: the ones its arrows name.
      const named = Array.isArray(x.branches) && x.branches.length ? x.branches : (Array.isArray(rawEdges) ? rawEdges : []).filter((e) => str((e as Record<string, unknown>)?.from, 40) === str(x.id, 40)).map((e) => (e as Record<string, unknown>).branch);
      const branches = named.map((b) => str(b, 60)).filter(Boolean).map((b) => b[0]!.toUpperCase() + b.slice(1));
      node.branches = branches.filter((b, i) => branches.findIndex((o) => loose(o) === loose(b)) === i).slice(0, 6);
      if (node.branches.length < 2) node.branches = kind === 'human' ? [w.approve, w.reject] : [w.yes, w.no];
    }
    nodes.push(node);
  }
  // It always starts at one trigger.
  const triggers = nodes.filter((n) => n.kind === 'trigger');
  if (!triggers.length) nodes.unshift({ id: 'start', kind: 'trigger', title: w.start });
  else if (nodes[0]!.kind !== 'trigger') nodes.splice(0, 0, ...nodes.splice(nodes.indexOf(triggers[0]!), 1));
  for (const extra of nodes.filter((n, i) => n.kind === 'trigger' && i > 0)) nodes.splice(nodes.indexOf(extra), 1);
  const ids = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: FlowEdge[] = [];
  const edgeKeys = new Set<string>();
  const add = (from: string, to: string, branch: string | null) => {
    const key = `${from}|${branch ?? ''}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, ...(branch ? { branch } : {}) });
  };
  const unnamed: Array<{ from: string; to: string }> = [];
  for (const raw of Array.isArray(rawEdges) ? rawEdges.slice(0, MAX_NODES * 4) : []) {
    const x = (raw ?? {}) as Record<string, unknown>;
    const from = str(x.from, 40);
    const to = str(x.to, 40);
    if (!ids.has(from) || !ids.has(to) || byId.get(to)!.kind === 'trigger') continue;
    const node = byId.get(from)!;
    if (!node.branches) {
      add(from, to, null);
      continue;
    }
    const said = str(x.branch, 60);
    if (!said) {
      unnamed.push({ from, to });
      continue;
    }
    // Branches as written on the step, whatever the case or accents ("si" is "Sí"); a branch the step
    // doesn't have yet becomes one of its options, rather than losing the arrow.
    let branch = node.branches.find((b) => loose(b) === loose(said));
    if (!branch && node.branches.length < 6) node.branches.push((branch = said[0]!.toUpperCase() + said.slice(1)));
    if (branch) add(from, to, branch);
  }
  // An arrow out of a decision without a branch: the first of its branches with no arrow yet.
  for (const { from, to } of unnamed) {
    const free = byId.get(from)!.branches!.find((b) => !edgeKeys.has(`${from}|${b}`));
    if (free) add(from, to, free);
  }
  return { nodes, edges };
}

/** Where a run goes after a step: the edge for the branch it took, or its only way on. */
export function nextNode(automation: Pick<Automation, 'nodes' | 'edges'>, from: string, branch: string | null): FlowNode | null {
  const out = automation.edges.filter((e) => e.from === from);
  const edge = branch ? out.find((e) => e.branch?.toLowerCase() === branch.toLowerCase()) : (out.find((e) => !e.branch) ?? out[0]);
  return edge ? (automation.nodes.find((n) => n.id === edge.to) ?? null) : null;
}

/** The option an agent picked: its last line "DECISION: <option>" (or DECISIÓN), matched to the branches. */
export function parseDecision(text: string, branches: string[]): string | null {
  const lines = [...text.matchAll(/DECISI[OÓ]N\s*:\s*(.+)/gi)];
  const said = loose(lines.at(-1)?.[1]?.replace(/[*_`"«».]+/g, '') ?? '');
  if (!said) return null;
  return branches.find((b) => loose(b) === said) ?? branches.find((b) => said.startsWith(loose(b)) || loose(b).startsWith(said)) ?? null;
}

/** The cards a manager wrote down: a JSON block `{"cards":[{title, assignee, detail}]}`, or a bare list. */
export function parseCards(text: string): Array<{ title: string; assignee: string; detail: string; after: string[] }> {
  const block = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text.slice(text.search(/[[{]/));
  try {
    const v = JSON.parse(block) as unknown;
    const list = Array.isArray(v) ? v : Array.isArray((v as { cards?: unknown }).cards) ? (v as { cards: unknown[] }).cards : [];
    return list
      .map((c) => {
        const x = (c ?? {}) as Record<string, unknown>;
        const after = (Array.isArray(x.after) ? x.after : x.after ? [x.after] : []).map((a) => str(a, 200)).filter(Boolean);
        return { title: str(x.title, 200), assignee: str(x.assignee, 100), detail: str(x.detail, 4000), after };
      })
      .filter((c) => c.title)
      .slice(0, MAX_CARDS);
  } catch {
    return [];
  }
}

/** When an automation starts next on its own; null: only when you start it. */
export function nextRunAt(a: Pick<Automation, 'enabled' | 'trigger' | 'updatedAt'>, last: Pick<AutomationRun, 'startedAt' | 'endedAt'> | null, now: number): number | null {
  if (!a.enabled) return null;
  const t = a.trigger;
  if (t.kind === 'manual') return null;
  if (t.kind === 'every') return last ? last.startedAt + t.minutes * 60_000 : now;
  if (t.kind === 'continuous') return last ? (last.endedAt ?? Infinity) + t.pauseMinutes * 60_000 : now;
  // daily: the first slot after the last run (or after you turned it on), in local time.
  const [h, m] = t.at.split(':').map(Number) as [number, number];
  const ref = last?.startedAt ?? a.updatedAt;
  const slot = new Date(ref);
  slot.setHours(h, m, 0, 0);
  if (slot.getTime() <= ref) slot.setDate(slot.getDate() + 1);
  // Only on its weekdays, when it has them.
  for (let i = 0; i < 7 && t.days?.length && !t.days.includes(slot.getDay()); i++) slot.setDate(slot.getDate() + 1);
  return slot.getTime();
}

const dayStart = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The diagrams the app offers ready-made, filled in with what you asked. */
export function templateFlow(template: Exclude<Template, 'agent'>, prompt: string, configs: BotConfig[], lang: Lang = 'en'): { name: string; trigger: AutomationTrigger; nodes: FlowNode[]; edges: FlowEdge[] } {
  const goal = prompt.trim();
  const w = WORDS[lang];
  if (template === 'office') {
    return {
      name: w.office.name,
      trigger: { kind: 'manual' },
      nodes: [
        { id: 'start', kind: 'trigger', title: w.start },
        { id: 'plan', kind: 'cards', title: w.office.plan, agentId: null, text: goal },
        { id: 'work', kind: 'work', title: w.office.work },
        { id: 'check', kind: 'decision', title: w.office.check, agentId: null, text: w.office.checkText(goal), branches: [w.office.more, w.office.done] },
        { id: 'tell', kind: 'notify', title: w.office.tell, text: w.office.tellText },
        { id: 'end', kind: 'end', title: w.office.end },
      ],
      edges: [
        { from: 'start', to: 'plan' },
        { from: 'plan', to: 'work' },
        { from: 'work', to: 'check' },
        { from: 'check', to: 'plan', branch: w.office.more },
        { from: 'check', to: 'tell', branch: w.office.done },
        { from: 'tell', to: 'end' },
      ],
    };
  }
  const measurer = configs.find((c) => /investig|research|analis|analyst|data|dato/i.test(c.name) && !c.proposed)?.id ?? null;
  return {
    name: w.goal.name,
    trigger: { kind: 'every', minutes: 360 },
    nodes: [
      { id: 'start', kind: 'trigger', title: w.goal.start },
      { id: 'measure', kind: 'agent', title: w.goal.measure, agentId: measurer, text: w.goal.measureText(goal) },
      { id: 'plan', kind: 'cards', title: w.goal.plan, agentId: null, text: w.goal.planText(goal) },
      { id: 'work', kind: 'work', title: w.goal.work },
      { id: 'report', kind: 'notify', title: w.goal.report, text: w.goal.reportText },
      { id: 'end', kind: 'end', title: w.goal.end },
    ],
    edges: [
      { from: 'start', to: 'measure' },
      { from: 'measure', to: 'plan' },
      { from: 'plan', to: 'work' },
      { from: 'work', to: 'report' },
      { from: 'report', to: 'end' },
    ],
  };
}

/** What the designer agent is asked: your words, the employees, and the shape of the diagram. */
export function designPrompt(prompt: string, configs: BotConfig[], current?: Pick<Automation, 'name' | 'trigger' | 'nodes' | 'edges'>): string {
  const roster = configs.filter((c) => !c.proposed).map((c) => `- ${c.name}${c.kind === 'coordinator' ? ' (the coordinator, the manager)' : ''}: ${c.role.replace(/\s+/g, ' ').slice(0, 160) || 'no role set'}`);
  return [
    'You design automations for Alchemist Coder: diagrams of steps that run on their own, with the organization\'s agents as the employees.',
    current ? `This is the automation now:\n${JSON.stringify({ name: current.name, trigger: current.trigger, nodes: current.nodes, edges: current.edges })}\n\nChange it as asked: ${prompt}` : `The user wants: ${prompt}`,
    '',
    'The organization\'s agents (use their exact names in "agent"):',
    ...roster,
    '',
    'Kinds of steps:',
    '- trigger: where it starts (exactly one, first).',
    '- agent: one agent does a task ("text" says what to do). It may change files in its own copy; the user decides whether the changes reach the project.',
    '- decision: one agent reads what happened and picks one of "branches" ("text" is the question).',
    '- human: the user picks one of "branches" on their phone ("text" is the question). Use it before anything that can\'t be undone or that speaks for the user to others.',
    '- cards: the manager (or "agent") splits a goal ("text") into cards on the Board, each for one agent.',
    '- work: the agents do their cards on the Board.',
    '- notify: a message to the user ("text").',
    '- end.',
    'Edges go from one step to the next; from a decision or a human step, give "branch" (one of its branches). Loops are allowed, back to an earlier step.',
    'Triggers: {"kind":"manual"} | {"kind":"every","minutes":N} | {"kind":"daily","at":"HH:MM"} (add "days":[1] for Mondays only; 0 = Sunday … 6 = Saturday) | {"kind":"continuous","pauseMinutes":N}.',
    'Every decision and human step needs "branches" (at least two), and each of its edges names one of them exactly in "branch". An agent step works on its own copy and already asks the user before its changes go into the project: no extra step, and no human step, just for that.',
    '',
    'Keep it small (at most 12 steps), write titles and texts in the user\'s language, and never invent facts or numbers. Reply with only a JSON block:',
    '```json',
    '{"name":"…","trigger":{"kind":"daily","at":"08:00"},"nodes":[{"id":"start","kind":"trigger","title":"…"},{"id":"read","kind":"agent","title":"…","agent":"<agent name>","text":"…"},{"id":"pick","kind":"decision","title":"…?","agent":"<agent name>","text":"…?","branches":["<option A>","<option B>"]},{"id":"tell","kind":"notify","title":"…","text":"…"},{"id":"end","kind":"end","title":"…"}],"edges":[{"from":"start","to":"read"},{"from":"read","to":"pick"},{"from":"pick","to":"tell","branch":"<option A>"},{"from":"pick","to":"end","branch":"<option B>"},{"from":"tell","to":"end"}]}',
    '```',
  ].join('\n');
}

interface Live {
  run: AutomationRun;
  automation: Automation;
  stopped: boolean;
  teams: Set<string>;
}

export class AutomationManager {
  private automations: Automation[] = [];
  private runs: AutomationRun[] = [];
  private readonly live = new Map<string, Live>();
  /** Questions waiting for you, by `${runId}:${askId}`. */
  private readonly asks = new Map<string, (choice: string) => void>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  private get lang(): Lang {
    return this.deps.lang?.() ?? 'en';
  }

  private get w() {
    return WORDS[this.lang];
  }

  constructor(
    private readonly files: { automations: string; runs: string },
    private readonly deps: AutomationDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.automations = this.read<Automation[]>(files.automations) ?? [];
    // Runs end with the app: one cut short says so.
    this.runs = (this.read<AutomationRun[]>(files.runs) ?? []).map((r) => (r.status === 'running' || r.status === 'waiting' ? { ...r, status: 'stopped', endedAt: r.endedAt ?? this.now(), why: 'appClosed', asks: [] } : { ...r, asks: r.asks ?? [] }));
  }

  private read<T>(file: string): T | null {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as T;
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }

  private write(file: string, value: unknown) {
    writeFileSync(`${file}.tmp`, JSON.stringify(value));
    renameSync(`${file}.tmp`, file);
  }

  private saveTimer: NodeJS.Timeout | null = null;

  /** Runs change many times a second while agents work: save a moment later. */
  private saveSoon() {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      this.saveAll();
    }, 500);
  }

  private saveAll() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      this.write(this.files.automations, this.automations);
      this.write(this.files.runs, this.runs.slice(0, 400));
    } catch {
      // kept in memory; saved next time
    }
  }

  /** Starts the clock that runs automations on their own. */
  start(intervalMs = 30_000) {
    this.timer ??= setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stopAll() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const l of this.live.values()) this.stopRun(l.run.id, 'appClosed');
    this.saveAll();
  }

  /** Whether anything should keep the Mac awake: an automation that is on, or a run going. */
  busy(): boolean {
    return this.live.size > 0 || this.automations.some((a) => a.enabled && a.trigger.kind !== 'manual');
  }

  list(): AutomationState[] {
    return this.automations.map((a) => this.stateOf(a));
  }

  private runsOf(automationId: string) {
    return this.runs.filter((r) => r.automationId === automationId);
  }

  private stateOf(a: Automation): AutomationState {
    const runs = this.runsOf(a.id).slice(0, MAX_RUNS_KEPT);
    const today = dayStart(this.now());
    return {
      automation: structuredClone(a),
      runs: structuredClone(runs),
      nextAt: this.live.has(a.id) ? null : nextRunAt(a, runs[0] ?? null, this.now()),
      spentToday: runs.filter((r) => r.startedAt >= today).reduce((s, r) => s + r.costUsd, 0),
    };
  }

  private changed(a: Automation) {
    this.saveSoon();
    this.deps.emit(this.stateOf(a));
  }

  /** Saves an automation (new or edited), cleaned up so it can run. */
  save(input: unknown): AutomationState {
    const x = (input ?? {}) as Partial<Automation>;
    const prev = this.automations.find((a) => a.id === x.id);
    const configs = this.deps.configs();
    const { nodes, edges } = cleanFlow(x.nodes ?? prev?.nodes, x.edges ?? prev?.edges, configs, this.lang);
    const cwd = str(x.cwd ?? prev?.cwd, 4096);
    if (!cwd.startsWith('/')) throw new Error('Choose the project it works in');
    const budget = Number(x.budgetUsdPerDay ?? prev?.budgetUsdPerDay);
    const now = this.now();
    const a: Automation = {
      id: prev?.id ?? id('auto'),
      name: str(x.name ?? prev?.name, 80) || this.w.untitled,
      prompt: str(x.prompt ?? prev?.prompt, 8000),
      cwd,
      enabled: (x.enabled ?? prev?.enabled) === true,
      trigger: cleanTrigger(x.trigger ?? prev?.trigger),
      autonomy: AUTONOMY.includes(x.autonomy as Autonomy) ? (x.autonomy as Autonomy) : (prev?.autonomy ?? 'balanced'),
      budgetUsdPerDay: Number.isFinite(budget) && budget > 0 ? Math.min(budget, 1000) : null,
      nodes,
      edges,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    if (prev) this.automations[this.automations.indexOf(prev)] = a;
    else this.automations.unshift(a);
    this.changed(a);
    return this.stateOf(a);
  }

  remove(automationId: string) {
    const live = this.live.get(automationId);
    if (live) this.stopRun(live.run.id, 'deleted');
    this.automations = this.automations.filter((a) => a.id !== automationId);
    this.runs = this.runs.filter((r) => r.automationId !== automationId);
    this.saveAll();
  }

  /**
   * A new automation from your words: a ready-made diagram filled in, or one an agent draws. It starts
   * off: you look at it, then turn it on.
   */
  async create(input: { prompt: string; cwd: string; template: Template; autonomy?: Autonomy }): Promise<AutomationState> {
    const prompt = str(input.prompt, 8000);
    if (!prompt) throw new Error('Write what the automation should do');
    const configs = this.deps.configs();
    if (input.template !== 'agent') {
      const t = templateFlow(input.template, prompt, configs, this.lang);
      return this.save({ ...t, prompt, cwd: input.cwd, autonomy: input.autonomy, enabled: false });
    }
    const designed = await this.design(prompt, input.cwd);
    return this.save({ ...designed, prompt, cwd: input.cwd, autonomy: input.autonomy, enabled: false });
  }

  /** Changes an automation's diagram as you ask, in your words. */
  async revise(automationId: string, change: string): Promise<AutomationState> {
    const a = this.automations.find((x) => x.id === automationId);
    if (!a) throw new Error('That automation no longer exists');
    if (this.live.has(a.id)) throw new Error('Wait until it finishes, or stop it, to change it');
    const designed = await this.design(str(change, 4000), a.cwd, a);
    return this.save({ ...a, nodes: designed.nodes, edges: designed.edges, trigger: designed.trigger ?? a.trigger });
  }

  private async design(prompt: string, cwd: string, current?: Automation): Promise<{ name: string; trigger: AutomationTrigger; nodes: FlowNode[]; edges: FlowEdge[] }> {
    const configs = this.deps.configs();
    const designer = configs.find((c) => c.kind === 'coordinator') ?? configs[0];
    if (!designer) throw new Error(this.w.noAgents);
    const text = await this.deps.oneShot(designPrompt(prompt, configs, current), cwd, designer);
    const block = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text.slice(text.indexOf('{'));
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(block) as Record<string, unknown>;
    } catch {
      throw new Error("The agent didn't answer with a diagram. Try again, or start from a template.");
    }
    const flow = cleanFlow(v.nodes, v.edges, configs, this.lang);
    if (flow.nodes.length < 2) throw new Error("The agent's diagram has no steps. Try again with more detail.");
    return { name: str(v.name, 80) || current?.name || this.w.untitled, trigger: cleanTrigger(v.trigger), ...flow };
  }

  /** Runs automations whose time has come. */
  tick() {
    const now = this.now();
    for (const a of this.automations) {
      if (!a.enabled || this.live.has(a.id)) continue;
      const at = nextRunAt(a, this.runsOf(a.id)[0] ?? null, now);
      if (at != null && at <= now) void this.runNow(a.id).catch(() => {});
    }
  }

  setEnabled(automationId: string, on: boolean): AutomationState {
    const a = this.automations.find((x) => x.id === automationId);
    if (!a) throw new Error('That automation no longer exists');
    a.enabled = on;
    a.updatedAt = this.now();
    this.changed(a);
    if (on) this.tick();
    return this.stateOf(a);
  }

  /** Starts a run now; it goes on in the background. */
  async runNow(automationId: string): Promise<AutomationRun> {
    const a = this.automations.find((x) => x.id === automationId);
    if (!a) throw new Error('That automation no longer exists');
    if (this.live.has(a.id)) throw new Error('It is already running');
    const run: AutomationRun = { id: id('run'), automationId: a.id, startedAt: this.now(), endedAt: null, status: 'running', steps: [], costUsd: 0, asks: [] };
    this.runs.unshift(run);
    const live: Live = { run, automation: structuredClone(a), stopped: false, teams: new Set() };
    this.live.set(a.id, live);
    this.changed(a);
    void this.execute(live);
    return structuredClone(run);
  }

  stopRun(runId: string, why = 'stopped') {
    const live = [...this.live.values()].find((l) => l.run.id === runId);
    if (!live) return;
    live.stopped = true;
    live.run.why = why;
    for (const teamId of live.teams) this.deps.stopTeam(teamId);
    // Questions it was waiting on go away (the phone's copies too).
    for (const ask of live.run.asks) {
      const key = `${runId}:${ask.id}`;
      this.asks.get(key)?.('');
      this.deps.resolved?.(key, '—');
    }
  }

  /** Your answer to a run's question (from the app, or from your phone with `fromPhone`). */
  answer(runId: string, askId: string, choice: string, fromPhone = false) {
    const key = `${runId}:${askId}`;
    const resolve = this.asks.get(key);
    if (!resolve) return false;
    resolve(choice);
    if (!fromPhone) this.deps.resolved?.(key, choice);
    return true;
  }

  private async execute(live: Live) {
    const { run, automation: a } = live;
    let node: FlowNode | null = a.nodes[0] ?? null;
    // The first step builds on what you asked (no title); later ones on the step before.
    let prev = { title: '', output: a.prompt };
    const visits = new Map<string, number>();
    try {
      for (let i = 0; node && i < MAX_STEPS; i++) {
        if (live.stopped) break;
        if (node.kind === 'end') {
          await this.step(live, node, () => ({ output: '', branch: null }));
          break;
        }
        const seen = (visits.get(node.id) ?? 0) + 1;
        visits.set(node.id, seen);
        if (seen > MAX_VISITS) throw new Error(this.w.loop(node.title, MAX_VISITS));
        const spent = this.stateOf(a).spentToday;
        if (a.budgetUsdPerDay && spent >= a.budgetUsdPerDay) {
          this.pause(a.id, this.w.capPaused(a.budgetUsdPerDay));
          throw new Error(this.w.capStop(a.budgetUsdPerDay));
        }
        const current: FlowNode = node;
        const result = await this.step(live, current, (step) => this.perform(live, current, prev, step));
        if (live.stopped) break;
        prev = { title: current.title, output: result.output };
        node = nextNode(a, current.id, result.branch);
      }
      if (node && node.kind !== 'end' && !live.stopped) throw new Error(this.w.tooLong(MAX_STEPS));
      run.status = live.stopped ? 'stopped' : 'done';
    } catch (e) {
      run.status = live.stopped ? 'stopped' : 'failed';
      run.why ??= e instanceof Error ? e.message : String(e);
      if (!live.stopped) this.deps.notify({ title: `${a.name}: ${this.w.stopped}`, body: run.why ?? '', automationId: a.id });
    } finally {
      run.endedAt = this.now();
      run.asks = [];
      this.live.delete(a.id);
      const current = this.automations.find((x) => x.id === a.id);
      if (current) this.changed(current);
    }
  }

  /** Runs one step, keeping its record (status, output, branch) up to date. */
  private async step(live: Live, node: FlowNode, fn: (step: RunStep) => Promise<{ output: string; branch: string | null }> | { output: string; branch: string | null }) {
    const step: RunStep = { nodeId: node.id, status: 'running', startedAt: this.now(), endedAt: null, output: '', branch: null, teamIds: [] };
    live.run.steps.push(step);
    this.touch(live);
    try {
      const result = await fn(step);
      step.status = 'done';
      step.output = clip(result.output);
      step.branch = result.branch;
      return result;
    } catch (e) {
      step.status = 'failed';
      step.output = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      step.endedAt = this.now();
      this.touch(live);
    }
  }

  private touch(live: Live) {
    live.run.status = live.run.asks.length ? 'waiting' : 'running';
    const a = this.automations.find((x) => x.id === live.automation.id);
    if (a) this.changed(a);
  }

  private pause(automationId: string, why: string) {
    const a = this.automations.find((x) => x.id === automationId);
    if (!a) return;
    a.enabled = false;
    this.deps.notify({ title: `${a.name}: ${this.w.paused}`, body: why, automationId: a.id });
  }

  private context(a: Automation, prev: { title: string; output: string }) {
    return [`The automation "${a.name}" works toward: ${a.prompt}`, prev.output && prev.title ? `What the previous step («${prev.title}») came up with:\n${clip(prev.output, 4000)}` : ''].filter(Boolean).join('\n\n');
  }

  private coordinatorId(): string {
    const configs = this.deps.configs();
    const c = configs.find((x) => x.kind === 'coordinator') ?? configs[0];
    if (!c) throw new Error(this.w.noAgents);
    return c.id;
  }

  private permissionFor(a: Automation): { permissionMode?: PermissionMode; noCopyPermission?: PermissionMode } {
    // Careful: every change asks. Otherwise each agent's own setting in its copy; without a copy its
    // changes land in the project at once, so they ask first unless the automation is autonomous.
    if (a.autonomy === 'careful') return { permissionMode: 'default' };
    return a.autonomy === 'balanced' ? { noCopyPermission: 'default' } : {};
  }

  private async perform(live: Live, node: FlowNode, prev: { title: string; output: string }, step: RunStep): Promise<{ output: string; branch: string | null }> {
    const a = live.automation;
    const origin = (label: string): TeamOrigin => ({ automationId: a.id, runId: live.run.id, nodeId: node.id, label });
    switch (node.kind) {
      case 'trigger':
        return { output: '', branch: null };
      case 'notify': {
        const body = [node.text ?? '', prev.output && prev.title ? clip(prev.output, 3000) : ''].filter(Boolean).join('\n\n');
        this.deps.notify({ title: `${a.name}: ${node.title}`, body, automationId: a.id });
        return { output: body, branch: null };
      }
      case 'human': {
        const choice = await this.ask(live, step, { question: node.text || node.title, detail: clip(prev.output, 3000), choices: node.branches ?? [this.w.approve, this.w.reject] });
        return { output: this.w.chose(choice), branch: choice };
      }
      case 'agent': {
        const team = await this.solo(live, step, { configId: node.agentId ?? this.coordinatorId(), task: `${node.text || node.title}\n\n${this.context(a, prev)}`, title: node.title, ownWorktree: true, origin: origin(a.name) });
        const answer = team.bots[0]?.lastReply ?? '';
        const applied = await this.bringIn(live, step, team, node.title);
        return { output: [answer, applied.text].filter(Boolean).join('\n\n'), branch: null };
      }
      case 'decision': {
        const branches = node.branches ?? [this.w.yes, this.w.no];
        const task = `${node.text || node.title}\n\n${this.context(a, prev)}\n\nPick exactly one of: ${branches.join(' | ')}. Explain briefly why, and end with a last line exactly like "DECISION: <option>".`;
        const team = await this.solo(live, step, { configId: node.agentId ?? this.coordinatorId(), task, title: node.title, readOnly: true, origin: origin(a.name) });
        const answer = team.bots[0]?.lastReply ?? '';
        const branch = parseDecision(answer, branches);
        if (branch) return { output: answer, branch };
        // It couldn't decide clearly: you do.
        const choice = await this.ask(live, step, { question: this.w.unclear(node.title), detail: clip(answer, 3000), choices: branches });
        return { output: `${answer}\n\n${this.w.chose(choice)}`, branch: choice };
      }
      case 'cards':
        return this.planCards(live, node, prev, step, origin(a.name));
      case 'work':
        return this.workCards(live, node, step, origin(a.name));
      default:
        return { output: '', branch: null };
    }
  }

  /** An employee alone on a task, waited for; its assignment follows the run. */
  private async solo(live: Live, step: RunStep, input: { configId: string; task: string; title: string; ownWorktree?: boolean; readOnly?: boolean; origin: TeamOrigin }): Promise<BotTeam> {
    const team = await this.deps.startSolo({ ...input, cwd: live.automation.cwd, ...this.permissionFor(live.automation) });
    live.teams.add(team.id);
    step.teamIds.push(team.id);
    this.touch(live);
    const done = await this.settle(live, team.id, step);
    const lead = done.bots[0];
    if (lead?.status === 'error') throw new Error(this.w.failed(lead.name, lead.error ?? ''));
    if (lead?.status === 'stopped' && !live.stopped) throw new Error(this.w.wasStopped(lead.name));
    return done;
  }

  /** Waits until an assignment's agents are all done, counting what it costs and showing when one waits for you. */
  private settle(live: Live, teamId: string, step: RunStep): Promise<BotTeam> {
    return new Promise((resolve) => {
      let off: () => void = () => {};
      const check = (team: BotTeam) => {
        const cost = team.bots.reduce((s, b) => s + (b.costUsd ?? 0), 0);
        const others = [...live.teams].filter((t) => t !== teamId).reduce((s, t) => s + (this.deps.team(t)?.bots.reduce((x, b) => x + (b.costUsd ?? 0), 0) ?? 0), 0);
        live.run.costUsd = cost + others;
        const waiting = team.bots.some((b) => b.status === 'waiting');
        const status = waiting ? 'waiting' : 'running';
        if (step.status !== status && step.status !== 'done' && step.status !== 'failed') {
          step.status = status;
          this.touch(live);
        }
        const active = team.bots.some((b) => b.status === 'starting' || b.status === 'working' || b.status === 'waiting');
        if (!active || live.stopped) {
          off();
          if (step.status === 'waiting') step.status = 'running';
          resolve(team);
        }
      };
      off = this.deps.watch((team) => team.id === teamId && check(team));
      const now = this.deps.team(teamId);
      if (now) check(now);
    });
  }

  /** A question for you: shown in the app and sent to your phone; the run waits for the answer. */
  private ask(live: Live, step: RunStep, q: { question: string; detail: string; choices: string[]; cardId?: string }): Promise<string> {
    const ask: AutomationAsk = { id: id('ask').slice(0, 13), question: clip(q.question, 500), detail: q.detail, choices: q.choices, cardId: q.cardId ?? null };
    const key = `${live.run.id}:${ask.id}`;
    return new Promise((resolve) => {
      this.asks.set(key, (choice) => {
        this.asks.delete(key);
        live.run.asks = live.run.asks.filter((x) => x.id !== ask.id);
        if (step.status === 'waiting' && !live.run.asks.length) step.status = 'running';
        this.touch(live);
        resolve(choice);
      });
      live.run.asks.push(ask);
      step.status = 'waiting';
      this.touch(live);
      this.deps.notify({ title: `${live.automation.name}: ${this.w.needsYou}`, body: q.question, automationId: live.automation.id, ask: { ...ask, key } });
    });
  }

  /**
   * An employee's work in its own copy reaching the project: on its own when the automation is
   * autonomous, after your yes otherwise. Says what happened (empty when nothing changed) and whether
   * the work is in the project or left on the agent's branch.
   */
  private async bringIn(live: Live, step: RunStep, team: BotTeam, title: string, cardId?: string): Promise<{ text: string; kept: boolean }> {
    const bot = team.bots[0];
    if (!bot?.worktree || live.stopped) return { text: '', kept: true };
    const changes = await this.deps.changes(team.id, bot.id).catch(() => []);
    if (!changes.length) return { text: '', kept: true };
    const files = changes.slice(0, 12).map((c) => c.path).join(', ');
    if (live.automation.autonomy !== 'autonomous') {
      const w = this.w;
      const choice = await this.ask(live, step, { question: w.bringIn(bot.name, title), detail: `${w.files(changes.length, files)}\n\n${clip(bot.lastReply, 2000)}`, choices: [w.apply, w.discard], cardId });
      if (choice !== w.apply) return { text: w.notApplied(bot.name, bot.worktree.branch), kept: false };
    }
    const result = await this.deps.apply(team.id, bot.id);
    return { text: `${bot.name}: ${result}`, kept: true };
  }

  /** The manager splits the goal into cards for the employees, written on the Board. */
  private async planCards(live: Live, node: FlowNode, prev: { title: string; output: string }, step: RunStep, origin: TeamOrigin): Promise<{ output: string; branch: string | null }> {
    const a = live.automation;
    const employees = this.deps.configs().filter((c) => c.kind !== 'coordinator' && !c.proposed && (!c.projects?.length || c.projects.some((p) => a.cwd.startsWith(p) || p.startsWith(a.cwd))));
    if (!employees.length) throw new Error(this.w.noEmployees);
    const open = this.deps.board.get().tasks.filter((t) => t.automationId === a.id && t.phase !== 'done');
    const task = [
      `Split this into cards for your team, each one a task one agent can finish alone in one sitting: ${node.text || a.prompt}`,
      this.context(a, prev),
      open.length ? `Cards still open on the Board (don't repeat them):\n${open.map((t) => `- ${t.title}`).join('\n')}` : '',
      `Your team:\n${employees.map((c) => `- ${c.name}: ${c.role.replace(/\s+/g, ' ').slice(0, 160) || 'no role set'}`).join('\n')}`,
      `At most ${MAX_CARDS} cards; none if nothing is needed. Cards run at the same time, each in its own copy of the project: when a card needs another card's result (tests for code still to be written), name that card in "after" and it starts once that one is done. Don't change any file. Reply with your reasoning and then only a JSON block:\n\`\`\`json\n{"cards":[{"title":"…","assignee":"<exact team member name>","detail":"what to do and how to know it's done","after":["<title of a card it needs first>"]}]}\n\`\`\``,
    ]
      .filter(Boolean)
      .join('\n\n');
    const team = await this.solo(live, step, { configId: node.agentId ?? this.coordinatorId(), task, title: node.title, readOnly: true, origin });
    const cards = parseCards(team.bots[0]?.lastReply ?? '');
    const now = this.now();
    const made: string[] = [];
    this.deps.board.patch((data) => {
      const whoOf = (c: (typeof cards)[number]) => employees.find((e) => e.name.toLowerCase() === c.assignee.toLowerCase()) ?? employees.find((e) => c.assignee && e.name.toLowerCase().includes(c.assignee.toLowerCase()));
      const kept = cards.filter(whoOf).map((c) => ({ ...c, cardId: id('t'), who: whoOf(c)! }));
      // "after" names cards by title, in any order: this batch's or ones still open.
      const byTitle = new Map([...open.map((t) => [t.title.toLowerCase(), t.id] as const), ...kept.map((c) => [c.title.toLowerCase(), c.cardId] as const)]);
      for (const c of kept) {
        const after = c.after.map((t) => byTitle.get(t.toLowerCase())).filter((x): x is string => !!x && x !== c.cardId);
        data.tasks.unshift({ id: c.cardId, cwd: a.cwd, title: c.title, notes: c.detail, phase: 'backlog', sessionId: null, createdAt: now, updatedAt: now, assignee: c.who.id, automationId: a.id, teamId: null, after });
        made.push(`- ${c.title} → ${c.who.name}${after.length ? ` (${c.after.join(', ')} →)` : ''}`);
      }
    });
    return { output: made.length ? `${this.w.newCards}:\n${made.join('\n')}` : this.w.noCards, branch: null };
  }

  /** The employees do the automation's open cards, a few at once and one each, moving them along the Board. */
  private async workCards(live: Live, node: FlowNode, step: RunStep, origin: TeamOrigin): Promise<{ output: string; branch: string | null }> {
    const a = live.automation;
    const configs = this.deps.configs();
    const queue = this.deps.board.get().tasks.filter((t) => t.automationId === a.id && t.phase !== 'done' && t.assignee && configs.some((c) => c.id === t.assignee)).reverse();
    if (!queue.length) return { output: this.w.noOpen, branch: null };
    const busy = new Set<string>();
    const lines: string[] = [];
    const move = (taskId: string, patch: { phase?: 'implementing' | 'validating' | 'done'; teamId?: string; sessionId?: string | null }) =>
      this.deps.board.patch((data) => {
        const t = data.tasks.find((x) => x.id === taskId);
        if (t) Object.assign(t, patch, { updatedAt: this.now() });
      });
    const doCard = async (card: (typeof queue)[number]) => {
      const who = configs.find((c) => c.id === card.assignee)!;
      busy.add(who.id);
      try {
        move(card.id, { phase: 'implementing' });
        const task = [`Your card on the Board: ${card.title}`, card.notes, node.text ?? '', `It's part of the automation "${a.name}", which works toward: ${a.prompt}`].filter(Boolean).join('\n\n');
        const team = await this.deps.startSolo({ configId: who.id, cwd: a.cwd, task, title: card.title, ownWorktree: true, ...this.permissionFor(a), origin });
        live.teams.add(team.id);
        step.teamIds.push(team.id);
        move(card.id, { teamId: team.id });
        // The card shows the conversation once the agent has one.
        const off = this.deps.watch((t) => {
          const sid = t.id === team.id ? t.bots[0]?.sessionId : null;
          if (sid) {
            off();
            move(card.id, { sessionId: sid });
          }
        });
        const done = await this.settle(live, team.id, step);
        off();
        const lead = done.bots[0];
        if (lead?.status === 'error' || (lead?.status === 'stopped' && !live.stopped)) {
          move(card.id, { phase: 'validating' });
          lines.push(`✕ ${card.title} (${who.name}): ${lead?.error || this.w.unfinished}`);
          return;
        }
        if (live.stopped) return;
        const applied = await this.bringIn(live, step, done, card.title, card.id);
        move(card.id, { phase: applied.kept ? 'done' : 'validating' });
        lines.push(`${applied.kept ? '✓' : '◐'} ${card.title} (${who.name})${applied.text ? ` — ${applied.text}` : ''}`);
      } catch (e) {
        // One card going wrong doesn't stop the others.
        move(card.id, { phase: 'validating' });
        lines.push(`✕ ${card.title} (${who.name}): ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        busy.delete(who.id);
      }
    };
    // A few employees at once, each on one card at a time; a card waits for the ones it comes after.
    const running = new Set<Promise<void>>();
    const working = new Set<string>();
    const waitsFor = (c: (typeof queue)[number]) => (c.after ?? []).some((d) => working.has(d) || queue.some((q) => q.id === d));
    while ((queue.length || running.size) && !live.stopped) {
      let next = queue.findIndex((c) => !busy.has(c.assignee!) && !waitsFor(c));
      // Cards that only wait for each other: one goes first.
      if (next < 0 && !running.size) next = 0;
      if (next >= 0 && running.size < PARALLEL) {
        const card = queue.splice(next, 1)[0]!;
        working.add(card.id);
        const p: Promise<void> = doCard(card).finally(() => (running.delete(p), working.delete(card.id)));
        running.add(p);
        continue;
      }
      await Promise.race(running);
    }
    return { output: lines.join('\n') || this.w.noChanges, branch: null };
  }
}
