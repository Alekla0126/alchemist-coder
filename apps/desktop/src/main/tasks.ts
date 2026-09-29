import { existsSync, readFileSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  commitAll,
  createWorktree,
  currentBranch,
  dirtyFiles,
  executionPrompt,
  extractPlan,
  fileVersions,
  git,
  headCommit,
  listChanges,
  mergeBranch,
  planningPrompt,
  removeWorktree,
  repoRoot,
  runTests,
  slug,
  taskTitle,
  WORKTREES_DIR,
} from '@alchemist-coder/arena';
import type { AgentChoice, ArenaTask, PermissionMode, RunnerEventMessage, TaskContestant, TaskEdit } from '../shared/api';
import type { RunnerManager } from './runner';

const MAX_CONTESTANTS = 4;
const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const FINAL: TaskContestant['state'][] = ['finished', 'failed', 'stopped'];

type RunRole = { taskId: string; role: 'planner' } | { taskId: string; role: 'contestant'; contestantId: string };

/** What the planner has produced so far (kept out of the persisted task). */
interface PlannerDraft {
  reply: string;
  submitted: string | null;
  lastError: string | null;
}

/**
 * Plan first, then the Arena: a planner agent drafts a plan the user edits and approves, then one to
 * four agents solve the task in their own git worktrees; the user compares and merges the winner.
 */
export class TaskManager {
  private tasks: ArenaTask[] = [];
  private readonly roles = new Map<string, RunRole>();
  private readonly drafts = new Map<string, PlannerDraft>();
  private readonly replies = new Map<string, string>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly runner: RunnerManager,
    private readonly resolveProject: (cwd: unknown) => string,
    private readonly emit: (task: ArenaTask) => void,
  ) {
    this.load();
    runner.observe((m) => this.onRunEvent(m));
  }

  private load() {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return; // first run
    }
    try {
      const data = JSON.parse(text) as ArenaTask[];
      if (!Array.isArray(data)) throw new Error('not a list');
      // Runs don't survive a restart: whatever was in flight is now stopped.
      this.tasks = data.map((t) => {
        const contestants = t.contestants.map((c) => (FINAL.includes(c.state) ? c : { ...c, state: 'stopped' as const, runId: null, endedAt: c.endedAt ?? t.updatedAt }));
        const phase = t.phase === 'planning' ? 'draft' : t.phase === 'running' ? 'compare' : t.phase;
        return { ...t, budgetUsd: t.budgetUsd ?? null, phase, contestants, planner: t.planner ? { ...t.planner, runId: null } : null };
      });
    } catch (error) {
      // Keep the unreadable file (tasks point at worktrees and branches) instead of overwriting it.
      const aside = `${this.file}.broken-${Date.now()}`;
      try {
        renameSync(this.file, aside);
      } catch {
        // leave it where it is
      }
      console.error(`[tasks] could not read ${this.file} (${error instanceof Error ? error.message : error}); kept it as ${aside}`);
      this.tasks = [];
    }
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.write();
    }, 300);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.write();
  }

  /** Temp file + rename: a crash mid-write never leaves half a tasks.json. */
  private write() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.tasks, null, 1));
    renameSync(tmp, this.file);
  }

  private get(taskId: unknown): ArenaTask {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('Task not found');
    return task;
  }

  private update(task: ArenaTask, patch: Partial<ArenaTask>): ArenaTask {
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.save();
    this.emit(structuredClone(task));
    return task;
  }

  private patchContestant(task: ArenaTask, id: string, patch: Partial<TaskContestant>) {
    this.update(task, { contestants: task.contestants.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
    if (task.phase === 'running' && task.contestants.every((c) => FINAL.includes(c.state))) this.update(task, { phase: 'compare' });
  }

  list(projectCwd: unknown): ArenaTask[] {
    const cwd = this.resolveProject(projectCwd);
    return this.tasks.filter((t) => t.projectCwd === cwd).sort((a, b) => b.createdAt - a.createdAt);
  }

  create(projectCwd: unknown, prompt: unknown): ArenaTask {
    const cwd = this.resolveProject(projectCwd);
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (!text || text.length > 50_000) throw new Error('Describe the task first');
    const now = Date.now();
    const task: ArenaTask = {
      id: `${slug(taskTitle(text), 28)}-${randomBytes(2).toString('hex')}`,
      projectCwd: cwd,
      root: null,
      base: null,
      baseBranch: null,
      dirtyAtStart: [],
      title: taskTitle(text),
      prompt: text,
      phase: 'draft',
      planner: null,
      plan: '',
      testCommand: null,
      budgetUsd: null,
      permissionMode: 'acceptEdits',
      contestants: [],
      winner: null,
      mergeCommit: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    this.save();
    return structuredClone(task);
  }

  /** Starts the planner in plan mode (read-only) in the project folder. */
  plan(taskId: unknown, planner: AgentChoice): ArenaTask {
    const task = this.get(taskId);
    if (task.phase !== 'draft' && task.phase !== 'review') throw new Error('This task is already running');
    const { runId } = this.runner.start({ cwd: task.projectCwd, ...pick(planner), prompt: planningPrompt(task.prompt), permissionMode: 'plan' });
    this.roles.set(runId, { taskId: task.id, role: 'planner' });
    this.drafts.set(runId, { reply: '', submitted: null, lastError: null });
    return structuredClone(this.update(task, { phase: 'planning', planner: { ...pick(planner), runId }, error: null }));
  }

  edit(taskId: unknown, edit: TaskEdit): ArenaTask {
    const task = this.get(taskId);
    const e = (edit ?? {}) as TaskEdit;
    const patch: Partial<ArenaTask> = {};
    if (typeof e.plan === 'string') patch.plan = e.plan.slice(0, 100_000);
    if (typeof e.prompt === 'string' && e.prompt.trim() && ['draft', 'review'].includes(task.phase)) {
      patch.prompt = e.prompt.trim().slice(0, 50_000);
      patch.title = taskTitle(patch.prompt);
    }
    if (e.testCommand === null || typeof e.testCommand === 'string') patch.testCommand = e.testCommand?.trim().slice(0, 500) || null;
    if (e.budgetUsd === null) patch.budgetUsd = null;
    else if (typeof e.budgetUsd === 'number' && Number.isFinite(e.budgetUsd) && e.budgetUsd > 0) patch.budgetUsd = Math.min(e.budgetUsd, 10_000);
    if (PERMISSION_MODES.includes(e.permissionMode as PermissionMode)) patch.permissionMode = e.permissionMode;
    if (e.review && (task.phase === 'draft' || task.phase === 'planning')) {
      if (task.planner?.runId) this.stopRun(task.planner.runId);
      patch.phase = 'review';
    }
    return structuredClone(this.update(task, patch));
  }

  /** Creates one worktree per agent and starts them all with the approved plan. */
  async start(taskId: unknown, choices: AgentChoice[]): Promise<ArenaTask> {
    const task = this.get(taskId);
    if (task.phase !== 'draft' && task.phase !== 'review') throw new Error('This task has already started');
    const picked = (Array.isArray(choices) ? choices : []).slice(0, MAX_CONTESTANTS).map(pick);
    if (!picked.length) throw new Error('Choose at least one agent');
    const root = await repoRoot(task.projectCwd);
    if (!root && picked.length > 1) throw new Error('Several agents need a git repository, so each one can work on its own branch. Run `git init` or pick one agent.');
    const base = root ? await headCommit(root).catch(() => null) : null;
    if (root && !base) throw new Error('This repository has no commits yet. Make a first commit, then start the task.');

    const prompt = executionPrompt(task.prompt, task.plan, picked.length);
    const contestants: TaskContestant[] = [];
    try {
      for (const [i, choice] of picked.entries()) {
        const id = `${i + 1}-${slug(choice.harnessId, 16)}`;
        const worktree = root && base ? await createWorktree(root, task.id, id, base) : null;
        if (worktree && root) shareNodeModules(root, worktree.path);
        contestants.push({
          ...choice,
          id,
          worktree,
          runId: null,
          sessionId: null,
          state: 'starting',
          startedAt: Date.now(),
          endedAt: null,
          costUsd: null,
          changes: null,
          tests: null,
          summary: null,
          error: null,
        });
      }
    } catch (error) {
      if (root) for (const c of contestants) if (c.worktree) await removeWorktree(root, c.worktree).catch(() => {});
      throw error;
    }

    this.update(task, {
      root,
      base,
      baseBranch: root ? await currentBranch(root).catch(() => null) : null,
      dirtyAtStart: root ? await dirtyFiles(root).catch(() => []) : [],
      phase: 'running',
      contestants,
      winner: null,
      mergeCommit: null,
      error: null,
    });
    for (const c of contestants) {
      try {
        const { runId } = this.runner.start({ cwd: c.worktree?.path ?? task.projectCwd, ...pick(c), prompt, permissionMode: task.permissionMode });
        this.roles.set(runId, { taskId: task.id, role: 'contestant', contestantId: c.id });
        this.patchContestant(task, c.id, { runId, state: 'running' });
      } catch (error) {
        this.patchContestant(task, c.id, { state: 'failed', error: message(error), endedAt: Date.now() });
      }
    }
    return structuredClone(task);
  }

  /** Stops the planner and every running agent; `inspect` lists what they changed so far. */
  stop(taskId: unknown, inspect = true): ArenaTask {
    const task = this.get(taskId);
    if (task.planner?.runId) this.stopRun(task.planner.runId);
    for (const c of task.contestants) {
      if (!FINAL.includes(c.state)) {
        if (c.runId) this.stopRun(c.runId);
        this.patchContestant(task, c.id, { state: 'stopped', endedAt: Date.now() });
        if (inspect) void this.inspect(task, c.id);
      }
    }
    if (task.phase === 'planning') this.update(task, { phase: 'draft' });
    return structuredClone(task);
  }

  async diff(taskId: unknown, contestantId: unknown, path: unknown) {
    const task = this.get(taskId);
    const c = task.contestants.find((x) => x.id === contestantId);
    if (!c?.worktree || !task.base) throw new Error('This agent has no worktree');
    if (typeof path !== 'string' || !c.changes?.some((f) => f.path === path)) throw new Error('Unknown file');
    return fileVersions(c.worktree.path, task.base, path);
  }

  /** Commits the winner's worktree, merges its branch into the checked-out branch and cleans up. */
  async merge(taskId: unknown, contestantId: unknown, squash: unknown): Promise<ArenaTask> {
    const task = this.get(taskId);
    const c = task.contestants.find((x) => x.id === contestantId);
    if (!c) throw new Error('Unknown agent');
    if (!FINAL.includes(c.state)) throw new Error('Wait until this agent finishes, or stop the task');
    if (!task.root || !c.worktree) throw new Error('Nothing to merge: this task ran without git');
    const label = `${task.title} (${c.harnessId} · ${c.model})`;
    const commit = await commitAll(c.worktree.path, `Alchemist: ${label}`);
    if (!commit && !c.changes?.length) throw new Error('This agent did not change anything');
    const mergeCommit = await mergeBranch(task.root, c.worktree.branch, { squash: squash !== false, message: label, into: task.baseBranch });
    await this.cleanup(task);
    return structuredClone(this.update(task, { phase: 'merged', winner: c.id, mergeCommit, error: null }));
  }

  async discard(taskId: unknown): Promise<ArenaTask> {
    const task = this.get(taskId);
    this.stop(task.id, false);
    await this.cleanup(task);
    return structuredClone(this.update(task, { phase: 'discarded' }));
  }

  remove(taskId: unknown): void {
    const task = this.get(taskId);
    if (['planning', 'running'].includes(task.phase)) throw new Error('Stop the task first');
    if (task.contestants.some((c) => c.worktree && existsSync(c.worktree.path))) throw new Error('Merge or discard the agents’ work first');
    this.tasks = this.tasks.filter((t) => t !== task);
    this.save();
  }

  private async cleanup(task: ArenaTask) {
    if (!task.root) return;
    for (const c of task.contestants) {
      if (c.runId) this.stopRun(c.runId);
      if (c.worktree) await removeWorktree(task.root, c.worktree).catch(() => {});
    }
    await git(task.root, ['worktree', 'prune']).catch(() => '');
    // Drop the task folder once its agent folders are gone (rmdir only removes empty folders).
    try {
      rmdirSync(join(task.root, WORKTREES_DIR, task.id));
    } catch {
      // not empty or already gone
    }
  }

  private stopRun(runId: string) {
    this.runner.stop(runId);
    this.roles.delete(runId);
    this.drafts.delete(runId);
    this.replies.delete(runId);
  }

  /** After an agent stops: what it changed and whether the tests pass. */
  private async inspect(task: ArenaTask, contestantId: string) {
    const c = task.contestants.find((x) => x.id === contestantId);
    if (!c?.worktree || !task.base) return;
    try {
      const changes = await listChanges(c.worktree.path, task.base);
      this.patchContestant(task, c.id, { changes });
      if (task.testCommand && changes.length) {
        this.patchContestant(task, c.id, { tests: 'running' });
        this.patchContestant(task, c.id, { tests: await runTests(c.worktree.path, task.testCommand) });
      }
    } catch (error) {
      this.patchContestant(task, c.id, { error: message(error) });
    }
  }

  private onRunEvent({ runId, event }: RunnerEventMessage) {
    const role = this.roles.get(runId);
    if (!role) return;
    const task = this.tasks.find((t) => t.id === role.taskId);
    if (!task) return;

    if (role.role === 'planner') {
      const draft = this.drafts.get(runId);
      if (!draft || task.phase !== 'planning') return;
      if (event.type === 'text') draft.reply += event.text;
      else if (event.type === 'error') draft.lastError = event.message;
      else if (event.type === 'permission' && event.content && (event.kind === 'switch_mode' || /plan/i.test(event.title))) {
        // The planner submitted its plan for approval (ExitPlanMode): that's the plan.
        draft.submitted = event.content;
        this.finishPlanning(task, runId, draft);
      } else if (event.type === 'result') this.finishPlanning(task, runId, draft);
      else if (event.type === 'status' && (event.status === 'error' || event.status === 'done' || event.status === 'interrupted')) {
        if (draft.reply.trim() || draft.submitted) this.finishPlanning(task, runId, draft);
        else {
          this.stopRun(runId);
          this.update(task, { phase: 'draft', error: draft.lastError ?? 'The planner stopped without a plan' });
        }
      }
      return;
    }

    const c = task.contestants.find((x) => x.id === role.contestantId);
    if (!c || FINAL.includes(c.state)) return;
    switch (event.type) {
      case 'started':
        if (event.sessionId) this.patchContestant(task, c.id, { sessionId: event.sessionId });
        return;
      case 'text':
        this.replies.set(runId, ((this.replies.get(runId) ?? '') + event.text).slice(-6000));
        return;
      case 'usage':
        if (event.costUsd != null) {
          this.patchContestant(task, c.id, { costUsd: event.costUsd });
          this.enforceBudget(task);
        }
        return;
      case 'error':
        this.patchContestant(task, c.id, { error: event.message.slice(0, 1000) });
        return;
      case 'status':
        if (event.status === 'waiting' || event.status === 'running') {
          if (c.state !== event.status) this.patchContestant(task, c.id, { state: event.status });
        } else if (event.status === 'error' || event.status === 'done' || event.status === 'interrupted') {
          this.finishContestant(task, c.id, runId, event.status === 'error' ? 'failed' : 'finished');
        }
        return;
      case 'result':
        if (event.costUsd != null) this.patchContestant(task, c.id, { costUsd: event.costUsd });
        this.finishContestant(task, c.id, runId, event.ok ? 'finished' : 'failed');
        return;
      default:
        return;
    }
  }

  /** The cap covers every agent of the task together; only agents that report cost count. */
  private enforceBudget(task: ArenaTask) {
    if (task.budgetUsd == null || task.phase !== 'running') return;
    const spent = task.contestants.reduce((acc, c) => acc + (c.costUsd ?? 0), 0);
    if (spent < task.budgetUsd) return;
    for (const c of task.contestants) {
      if (FINAL.includes(c.state)) continue;
      if (c.runId) this.stopRun(c.runId);
      this.patchContestant(task, c.id, { state: 'stopped', endedAt: Date.now(), runId: null });
      void this.inspect(task, c.id);
    }
    this.update(task, { error: `Stopped at your $${task.budgetUsd.toFixed(2)} budget ($${spent.toFixed(2)} spent). What the agents changed so far is kept.` });
  }

  private finishPlanning(task: ArenaTask, runId: string, draft: PlannerDraft) {
    const plan = extractPlan(draft.submitted, draft.reply);
    this.stopRun(runId);
    this.update(task, { phase: 'review', plan, planner: task.planner ? { ...task.planner, runId: null } : null, error: plan ? null : 'The planner returned an empty plan' });
  }

  private finishContestant(task: ArenaTask, id: string, runId: string, state: 'finished' | 'failed') {
    const summary = this.replies.get(runId)?.trim() || null;
    // One turn per contestant: free its processes; the conversation stays in the history.
    this.stopRun(runId);
    this.patchContestant(task, id, { state, summary, endedAt: Date.now(), runId: null });
    void this.inspect(task, id);
  }
}

function pick(choice: AgentChoice): AgentChoice {
  const s = (v: unknown, name: string) => {
    if (typeof v !== 'string' || !/^[\w.:/@[\]-]{1,120}$/.test(v)) throw new Error(`Invalid ${name}`);
    return v;
  };
  return { harnessId: s(choice?.harnessId, 'agent'), providerId: s(choice?.providerId, 'provider'), model: s(choice?.model, 'model') };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * JavaScript projects: reuse the project's node_modules through a symlink so tests can run in the
 * worktree without a fresh install, but only when git would ignore it there too.
 */
function shareNodeModules(root: string, worktree: string) {
  const source = join(root, 'node_modules');
  const target = join(worktree, 'node_modules');
  if (!existsSync(source) || existsSync(target)) return;
  try {
    symlinkSync(source, target, 'junction');
    void git(worktree, ['check-ignore', '-q', 'node_modules']).catch(() => {
      try {
        unlinkSync(target);
      } catch {
        // already gone
      }
    });
  } catch {
    // no symlink permission (Windows without developer mode): agents install what they need
  }
}
