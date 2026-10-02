import { openFolderAsProject, openNewProject } from './components/NewProject';
import { create } from 'zustand';
import type { AgentNode, AgentOption, FileDiff, PromptImage, SlashCommand, IndexProgress, PermissionChoice, PlanEntry, ProjectSummary, QuestionAnswer, SearchHit, SessionSummary, ToolState } from '@alchemist-coder/core';
import type { AgentReview, AppInfo, ArenaTask, BotConfig, BotTeam, Locale, Mode, OrgSettings, PlanUsage, RunnerCatalog, RunnerEventMessage, Settings, StartRunRequest } from '@shared/api';
import { resolveLocale, translate, type MessageKey } from './i18n';
import { moveComposerState } from './composer-state';
import { applyToTurns, markQuestion, startTurn, type LiveQuestion, type LiveTurn } from './live-turns';
import { applyWorkbench, loadTheme, type VsTheme } from './theme';
import { toggleSidebar, toggleSplitSide } from './layout';
import { useCurrentTheme } from './theme-state';
import { markViewed } from './attention';

const api = window.alchemist;
const CATALOG_KEY = 'alchemist.catalog';

/** Which build saved the cached catalog: another version or edition may offer other agents. */
let cachedFor: string | null = null;

function cachedCatalog(): RunnerCatalog | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CATALOG_KEY) ?? 'null') as { build?: string; catalog?: RunnerCatalog } | null;
    const c = saved?.catalog;
    if (!c || !Array.isArray(c.harnesses) || !Array.isArray(c.providers)) return null;
    cachedFor = saved?.build ?? null;
    return c;
  } catch {
    return null;
  }
}
const buildId = (info: AppInfo) => `${info.version}:${info.edition}:${info.personal ? 'p' : ''}`;

export interface Selection {
  sessionId: string;
  agentId: string;
}

export type SessionFilter = 'all' | 'running' | 'favorites';

export type RunStatus = 'starting' | 'running' | 'waiting' | 'idle' | 'done' | 'error' | 'interrupted';

export interface TerminalTab {
  id: string;
  title: string;
  exited: boolean;
}

export interface RunState {
  runId: string;
  harnessId: string;
  /** 's:<sessionId>' to continue a conversation, 'p:<projectId>' for a new one. */
  target: string;
  status: RunStatus;
  text: string;
  /** Latest reasoning, trimmed; cleared when the reply starts. */
  thought: string;
  tools: RunTool[];
  plan: PlanEntry[];
  planMarkdown: string | null;
  /** Permission requests still waiting for an answer. */
  permissions: PendingPermission[];
  /** Questions (forms) the agent is waiting for you to answer. */
  questions?: LiveQuestion[];
  config: { modes: Array<{ id: string; label: string }>; mode: string | null; options: AgentOption[] } | null;
  /** The agent's own "/" commands, once it announces them. */
  commands?: SlashCommand[];
  usage: { usedTokens: number; contextTokens: number; costUsd: number | null } | null;
  notices: string[];
  errors: string[];
  sessionId: string | null;
  /** Project folder of runs started from the app (their changes can be reviewed). */
  cwd?: string;
  /** What happened in this session's turns, shown in the chat until the index has it. */
  turns: LiveTurn[];
}

/** Editor tabs that show a review instead of a file. */
export const REVIEW_TAB = 'review:';

export interface RunTool {
  id?: string;
  name: string;
  summary: string;
  kind?: string;
  state?: ToolState;
  diffs?: FileDiff[];
}

export interface PendingPermission {
  requestId: string;
  title: string;
  kind: string | null;
  diffs: FileDiff[];
  choices: PermissionChoice[];
}

interface State {
  ready: boolean;
  info: AppInfo | null;
  settings: Settings;
  locale: Locale;
  progress: IndexProgress;
  projects: ProjectSummary[];
  sessions: Record<number, SessionSummary[]>;
  trees: Record<string, AgentNode | null>;
  expanded: Record<string, boolean>;
  selection: Selection | null;
  filter: SessionFilter;
  /** The Agents sidebar and home: the open project, or every open project at once. */
  agentsScope: 'project' | 'all';
  /** The latest conversations of each open project (all-projects view). */
  recent: Record<number, SessionSummary[]>;
  pickerOpen: boolean;
  /** The "New project" dialog is showing. */
  newProjectOpen: boolean;
  query: string;
  results: SearchHit[] | null;
  /** Bumped when files change on disk, so open transcripts refresh. */
  revision: number;
  changedSessions: string[];
  captureReady: boolean;
  /** Open projects were picked automatically and not yet confirmed by the user. */
  provisionalOpen: boolean;
  catalog: RunnerCatalog | null;
  /** false while `catalog` is last launch's copy: warnings wait for real detection. */
  catalogFresh: boolean;
  /** Bot teams (newest first) and saved bot configurations. */
  botTeams: BotTeam[];
  botConfigs: BotConfig[];
  /** null = the "new team" form. */
  activeTeamId: string | null;
  activeBotId: string | null;
  /** The organization agent whose profile is open (a configuration id). */
  activeMemberId: string | null;
  orgSettings: OrgSettings | null;
  /** The project the organization view is filtered to ('' = all). */
  orgProject: string;
  /** The assignment showing on the organization chart (who does what in it); null = the organization as a whole. */
  orgFocusTeamId: string | null;
  /** What you're writing as the next assignment: kept while you look at an agent or an assignment. */
  orgGoal: string;
  /** Unsaved edits to agent profiles, by agent: kept while you look at other things. */
  orgDrafts: Record<string, Record<string, unknown>>;
  /** Opens the new bot configuration dialog (screenshots). */
  /** Opens the org's add-agent dialog; with a lead: a new agent for that lead's team. */
  botConfigDialog: boolean | { leadId: string };
  loadBots(): Promise<void>;
  upsertTeam(team: BotTeam): void;
  /** You messaging a bot: shows as your turn in its chat. */
  messageBot(teamId: string, botId: string, text: string): Promise<void>;
  /** Plans and usage of the signed-in CLIs (status bar, popover and Settings share it). */
  planUsage: PlanUsage | null;
  planUsageLoading: boolean;
  runs: Record<string, RunState>;
  /** Arena tasks of the open projects, by id. */
  tasks: Record<string, ArenaTask>;
  /** null = the "new task" form. */
  activeTaskId: string | null;
  runByTarget: Record<string, string>;
  /** Project in which the user is composing a brand-new conversation. */
  composeProjectId: number | null;
  sidebarTab: 'agents' | 'files' | 'git' | 'extensions';
  theme: VsTheme | null;
  openFiles: Record<number, string[]>;
  activeFile: Record<number, string | null>;
  dirty: Record<string, boolean>;
  terminals: Record<number, TerminalTab[]>;
  activeTerminal: Record<number, string | null>;
  /** Terminal shown in the right half when the panel is split. */
  splitTerminal: Record<number, string | null>;
  /** Agent runs with changes still to review, by project folder. */
  reviews: Record<string, AgentReview[]>;
  /** The Settings screen is showing. */
  settingsOpen: boolean;
  /** Which Settings section opens next. */
  settingsSection: 'general' | 'agents' | 'usage' | 'backup' | 'shortcuts' | 'about' | null;
  /** The ⌘K command palette is showing. */
  paletteOpen: boolean;
  /** ⌘W in Code/Split: the editor closes its active tab (asking about unsaved edits). */
  closeTabSignal: number;
  /** Text to put in the visible composer (e.g. reusing an earlier prompt). */
  /** `send`: send it right away (Retry) instead of leaving it to edit. */
  composerFill: { text: string; nonce: number; send?: boolean; fork?: boolean } | null;
  /** A line the editor should scroll to once `path` is open (from a terminal link). */
  reveal: { path: string; line: number; column: number } | null;

  init(): Promise<void>;
  setSidebarTab(tab: 'agents' | 'files' | 'git' | 'extensions'): void;
  setTheme(id: string): Promise<void>;
  openFile(projectId: number, path: string): void;
  /** Opens a file at a line, showing the editor if the current mode hides it. */
  openFileAt(projectId: number, path: string, line?: number, column?: number): void;
  clearReveal(): void;
  fillComposer(text: string, send?: boolean, fork?: boolean): void;
  closeFile(projectId: number, path: string): void;
  setDirty(path: string, dirty: boolean): void;
  addTerminal(projectId: number, tab: TerminalTab, asSplit?: boolean): void;
  setSplitTerminal(projectId: number, id: string | null): void;
  setActiveTerminal(projectId: number, id: string): void;
  closeTerminal(projectId: number, id: string): void;
  markTerminalExited(id: string): void;
  renameTerminal(projectId: number, id: string, title: string): void;
  loadCatalog(): Promise<void>;
  loadPlanUsage(refresh?: boolean): Promise<void>;
  startRun(target: string, request: StartRunRequest): Promise<void>;
  sendToRun(runId: string, text: string, images?: PromptImage[]): Promise<void>;
  /** The index caught up with a finished run: its turns show from there. */
  clearTurns(runId: string): void;
  stopRun(runId: string): Promise<void>;
  loadTasks(projectCwd: string): Promise<void>;
  upsertTask(task: ArenaTask): void;
  dropTask(taskId: string): void;
  setActiveTask(taskId: string | null): void;
  interruptRun(runId: string): Promise<void>;
  respondPermission(runId: string, requestId: string, choiceId: string | null): Promise<void>;
  /** Sends your answer to an agent's question (decline = skip); `summary` is what the chat shows. */
  answerQuestion(runId: string, requestId: string, answer: QuestionAnswer | null, summary: string): Promise<void>;
  configureRun(runId: string, change: { mode?: string; option?: { id: string; value: string } }): Promise<void>;
  setCompose(projectId: number | null): void;
  refreshProjects(): Promise<void>;
  loadSessions(projectId: number): Promise<void>;
  loadTree(sessionId: string): Promise<void>;
  select(sessionId: string, agentId?: string): Promise<void>;
  setMode(mode: Mode): void;
  loadReviews(cwd: string): Promise<void>;
  /** Replaces one review after keeping or undoing something (null = nothing left). */
  updateReview(cwd: string, id: string, review: AgentReview | null): void;
  /** Opens a review as an editor tab, next to the conversation. */
  openReview(reviewId: string): Promise<void>;
  openProject(projectId: number): Promise<void>;
  closeProject(projectId: number): void;
  setActiveProject(projectId: number): Promise<void>;
  toggle(key: string): void;
  setFilter(filter: SessionFilter): void;
  setAgentsScope(scope: 'project' | 'all'): void;
  loadRecent(): Promise<void>;
  setPickerOpen(open: boolean): void;
  search(query: string): Promise<void>;
  setLocale(locale: Locale): void;
  toggleFavorite(session: SessionSummary): Promise<void>;
  /** After renaming, hiding or trashing: reload the project's list and everything keyed on revision. */
  sessionsChanged(projectId: number, sessionIds?: string[]): Promise<void>;
  /** Opens a terminal in the project running `command` (e.g. resuming a conversation) and shows it. */
  openTerminalWith(projectId: number, command: string, title?: string, cwd?: string): Promise<void>;
  onChanged(ids: string[]): Promise<void>;
  markCaptureReady(): void;
}

function findPath(node: AgentNode | null, id: string, trail: string[] = []): string[] | null {
  if (!node) return null;
  if (node.id === id) return [...trail, node.id];
  for (const c of node.children) {
    const found = findPath(c, id, [...trail, node.id]);
    if (found) return found;
  }
  return null;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  info: null,
  settings: { locale: null, theme: 'alchemist-dark', openProjectIds: [], activeProjectId: null, mode: 'agents', backupDir: null, backupAuto: true },
  locale: 'en',
  progress: { phase: 'scanning', done: 0, total: 0 },
  projects: [],
  sessions: {},
  trees: {},
  expanded: {},
  selection: null,
  filter: 'all',
  agentsScope: localStorage.getItem('alchemist.agentsScope') === 'all' ? 'all' : 'project',
  recent: {},
  pickerOpen: false,
  newProjectOpen: false,
  query: '',
  results: null,
  revision: 0,
  changedSessions: [],
  captureReady: false,
  provisionalOpen: false,
  // Last launch's agents and models, so the composer shows them at once; replaced when detection ends.
  catalog: cachedCatalog(),
  catalogFresh: false,
  botTeams: [],
  botConfigs: [],
  activeTeamId: null,
  activeBotId: null,
  activeMemberId: null,
  orgSettings: null,
  orgProject: '',
  orgFocusTeamId: null,
  orgGoal: '',
  orgDrafts: {},
  botConfigDialog: false,
  planUsage: null,
  planUsageLoading: false,
  runs: {},
  runByTarget: {},
  tasks: {},
  activeTaskId: null,
  composeProjectId: null,
  sidebarTab: 'agents',
  theme: null,
  openFiles: {},
  activeFile: {},
  dirty: {},
  terminals: {},
  activeTerminal: {},
  splitTerminal: {},
  reviews: {},
  reveal: null,
  settingsOpen: false,
  paletteOpen: false,
  settingsSection: null,
  composerFill: null,
  closeTabSignal: 0,

  async init() {
    const [info, settings, progress] = await Promise.all([api.info(), api.getSettings(), api.indexStatus()]);
    set({ info, settings, progress, locale: info.capture?.locale ?? resolveLocale(settings.locale, info.systemLocale) });
    if (cachedFor !== buildId(info) && !get().catalogFresh) set({ catalog: null });
    if (info.capture?.mode) set({ settings: { ...settings, mode: info.capture.mode } });
    await get().setTheme(info.capture?.theme ?? settings.theme);
    if (settings.mode === 'code' || info.capture?.mode === 'code') set({ sidebarTab: 'files' });
    let resolveIndexed: () => void = () => {};
    const indexed = progress.phase === 'ready' ? Promise.resolve() : new Promise<void>((r) => (resolveIndexed = r));
    api.onIndexProgress((p) => {
      const wasReady = get().progress.phase === 'ready';
      set({ progress: p });
      if (wasReady) return;
      if (p.phase === 'ready') {
        // Anything fetched while the first index was filling up may be incomplete.
        void Promise.all([get().refreshProjects(), ...Object.keys(get().trees).map((id) => get().loadTree(id)), ...(wantsRecent(get()) ? [get().loadRecent()] : [])]).then(() => resolveIndexed());
      } else if (p.done % 60 === 0) void get().refreshProjects();
    });
    api.onSessionsChanged((ids) => void get().onChanged(ids));
    api.onRunnerEvent((m) => applyRunnerEvent(m));
    api.onAppCommand((command) => runAppCommand(command));
    if (info.capture?.settings) set({ settingsOpen: true });
    if (info.capture?.newProject) set({ newProjectOpen: true });
    if (info.capture?.scope) set({ agentsScope: info.capture.scope });
    api.onTaskChanged((task) => get().upsertTask(task));
    api.onBotTeamChanged((team) => get().upsertTeam(team));
    await get().refreshProjects();
    if (wantsRecent(get())) void get().loadRecent();
    const capture = info.capture?.select;
    if (capture) {
      await indexed;
      // The conversation only shows in Agents (or Split): a profile left in another mode would never capture.
      const mode = get().settings.mode;
      if (!info.capture?.mode && mode !== 'agents' && mode !== 'split') set((s) => ({ settings: { ...s.settings, mode: 'agents' } }));
      await get().select(capture.sessionId, capture.agentId);
    }
    if (info.capture?.project || info.capture?.openFile) {
      await indexed;
      const p = get().projects.find((x) => x.name === info.capture!.project);
      if (p) await get().openProject(p.id);
      const pid = get().settings.activeProjectId;
      if (pid != null && info.capture.openFile) get().openFile(pid, info.capture.openFile);
      // A piece being written (--mk-generate) says when it's ready itself.
      if (!info.capture.mkGenerate && !info.capture.orgGoal) setTimeout(() => set({ captureReady: true }), 2500);
    } else if (info.capture?.settings) {
      // The panel reads what the index found (agents, usage): wait for it.
      await indexed;
      setTimeout(() => set({ captureReady: true }), 1000);
    }
    if (info.capture?.compose) {
      await indexed;
      await get().loadCatalog();
      get().setCompose(get().settings.activeProjectId);
      const r = info.capture.run;
      const project = get().projects.find((p) => p.id === get().settings.activeProjectId);
      if (r && project) {
        const target = `p:${project.id}`;
        await get().startRun(target, { cwd: r.cwd ?? project.cwd, harnessId: r.harnessId, providerId: r.providerId, model: r.model, permissionMode: r.permissionMode, prompt: r.prompt });
        // Capture once the agent asks something, finishes, or after two minutes.
        const settled = () => {
          const run = get().runs[get().runByTarget[target] ?? ''];
          return !run || run.permissions.length > 0 || !!run.questions?.length || ['idle', 'done', 'error', 'interrupted'].includes(run.status);
        };
        // --run-until=subagent: a few seconds into its first subagent's work.
        const delegating = () => info.capture!.runUntil === 'subagent' && !!get().runs[get().runByTarget[target] ?? '']?.tools.some((x) => (x.name === 'Agent' || x.name === 'Task') && x.state !== 'done' && x.state !== 'failed');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 120_000);
          const off = useStore.subscribe(() => {
            if (settled()) (clearTimeout(timer), off(), resolve());
            else if (delegating()) (clearTimeout(timer), off(), setTimeout(resolve, 9000));
          });
        });
        if (info.capture.review) {
          const runId = get().runByTarget[target] ?? '';
          await get().loadReviews(r.cwd ?? project.cwd);
          await get().openReview(runId);
          await new Promise((res) => setTimeout(res, 1500));
        }
      }
      set({ captureReady: true });
    }
    const arena = info.capture?.arena;
    if (arena) {
      await indexed;
      await get().loadCatalog();
      const p = get().projects.find((x) => x.name === info.capture!.project);
      if (p) await get().openProject(p.id);
      const project = get().projects.find((x) => x.id === get().settings.activeProjectId);
      if (project) {
        get().setMode('arena');
        // Waits until the active task satisfies `ok` (or the time runs out).
        const settle = (ok: (t: ArenaTask) => boolean, ms: number) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            const off = useStore.subscribe(() => {
              const t = get().activeTaskId ? get().tasks[get().activeTaskId!] : undefined;
              if (t && ok(t)) {
                clearTimeout(timer);
                off();
                resolve();
              }
            });
          });
        const task = await api.createTask(project.cwd, arena.prompt);
        get().upsertTask(task);
        get().setActiveTask(task.id);
        if (arena.planner) {
          get().upsertTask(await api.planTask(task.id, arena.planner));
          await settle((t) => t.phase === 'review' || t.phase === 'draft', 240_000);
        } else get().upsertTask(await api.editTask(task.id, { review: true }));
        if (arena.stopAt === 'compare' && arena.agents.length) {
          if (arena.tests) await api.editTask(task.id, { testCommand: arena.tests });
          get().upsertTask(await api.startTask(task.id, arena.agents));
          await settle((t) => t.phase === 'compare' && t.contestants.every((c) => c.changes && c.tests !== 'running'), 360_000);
        }
      }
      set({ captureReady: true });
    }
    if (info.capture?.query) {
      await indexed;
      await get().search(info.capture.query);
    }
    if (info.capture?.mode) get().setMode(info.capture.mode);
    if (info.capture?.sidebar) set({ sidebarTab: info.capture.sidebar });
    if (info.capture?.botsView) {
      await get().loadBots();
      const latest = get().botTeams[0];
      if (info.capture.botsView === 'team' && latest) set({ activeTeamId: latest.id, activeBotId: latest.bots[0]?.id ?? null });
      if (info.capture.botsView === 'config') set({ botConfigDialog: true });
      if (info.capture.botsView === 'chart') set({ orgFocusTeamId: (get().botTeams.find((x) => x.plan?.status === 'pending') ?? latest)?.id ?? null });
      // The organization is set up on first open: wait for its coordinator before picking a profile.
      if (info.capture.botsView === 'member' || info.capture.botsView === 'agent') {
        const pick = () => get().botConfigs.find((c) => (info.capture!.botsView === 'member' ? c.kind === 'coordinator' : c.kind !== 'coordinator' && !c.proposed));
        for (let i = 0; i < 40 && !pick(); i++) {
          await new Promise((r) => setTimeout(r, 250));
          await get().loadBots();
        }
        const found = pick();
        if (found) set({ activeMemberId: found.id, activeTeamId: null });
      }
    }
    const team = info.capture?.team;
    if (team) {
      await indexed;
      get().setMode('bots');
      // --team-org: the organization's coordinator (its own agent) takes the assignment.
      await get().loadBots();
      const lead = team.org ? get().botConfigs.find((c) => c.kind === 'coordinator') : undefined;
      const started = await api.startTeam(
        lead
          ? { goal: team.goal, cwd: team.cwd, approvePlan: team.approvePlan, configId: lead.id }
          : { goal: team.goal, cwd: team.cwd, approvePlan: team.approvePlan, coordinator: { name: 'Coordinator', role: '', agent: { harnessId: team.harnessId, providerId: team.providerId, model: team.model }, permissionMode: 'acceptEdits' } },
      );
      get().upsertTeam(started);
      set({ activeTeamId: started.id, activeBotId: started.bots[0]?.id ?? null });
      // Captured once the coordinator is done (its bots answered), or after eight minutes.
      const began = Date.now();
      const timer = setInterval(() => {
        const t = get().botTeams.find((x) => x.id === started.id);
        const lead = t?.bots[0];
        // With --team-plan: as soon as the plan waits for you.
        const settled = (team.approvePlan && t?.plan?.status === 'pending') || (!!lead && ['idle', 'done', 'error', 'stopped'].includes(lead.status) && !t!.bots.some((b) => ['starting', 'working'].includes(b.status)));
        if (settled || Date.now() - began > 8 * 60_000) {
          clearInterval(timer);
          set({ captureReady: true });
        }
      }, 2000);
    }
    set({ ready: true });
  },

  async refreshProjects() {
    const projects = await api.projects();
    let { settings } = get();
    const known = new Set(projects.map((p) => p.id));
    let open = settings.openProjectIds.filter((id) => known.has(id));
    const provisional = get().provisionalOpen || open.length === 0;
    const indexed = get().progress.phase === 'ready';
    // Until the user picks projects, show the four most active ones; save that choice only
    // once the first index is complete so it reflects the whole history.
    if (provisional) open = projects.slice(0, 4).map((p) => p.id);
    const active = settings.activeProjectId != null && open.includes(settings.activeProjectId) ? settings.activeProjectId : (open[0] ?? null);
    if (provisional && !indexed) {
      settings = { ...settings, openProjectIds: open, activeProjectId: active };
    } else if (provisional || open.join() !== settings.openProjectIds.join() || active !== settings.activeProjectId) {
      settings = await api.setSettings({ openProjectIds: open, activeProjectId: active });
    }
    set({ provisionalOpen: provisional && !indexed });
    set({ projects, settings });
    if (active != null) await get().loadSessions(active);
  },

  async loadSessions(projectId) {
    const list = await api.sessions(projectId);
    set((s) => ({ sessions: { ...s.sessions, [projectId]: list } }));
  },

  async loadTree(sessionId) {
    const tree = await api.agentTree(sessionId);
    set((s) => ({ trees: { ...s.trees, [sessionId]: tree } }));
  },

  async select(sessionId, agentId = 'main') {
    if (!(sessionId in get().trees)) await get().loadTree(sessionId);
    const path = findPath(get().trees[sessionId] ?? null, agentId) ?? ['main'];
    const expanded = { ...get().expanded, [`s:${sessionId}`]: true };
    for (const id of path.slice(0, -1)) expanded[`a:${sessionId}:${id}`] = true;
    set({ selection: { sessionId, agentId }, expanded, captureReady: false, composeProjectId: null });
    markViewed(sessionId);
    // Make sure the conversation's project is open and active.
    const session = await api.session(sessionId);
    if (session && get().settings.activeProjectId !== session.projectId) await get().openProject(session.projectId);
  },

  setMode(mode) {
    set((s) => ({ settings: { ...s.settings, mode }, sidebarTab: mode === 'code' ? 'files' : mode === 'agents' ? 'agents' : s.sidebarTab }));
    void api.setSettings({ mode });
  },

  async loadReviews(cwd) {
    const list = await api.reviews(cwd).catch(() => null);
    if (list) set((s) => ({ reviews: { ...s.reviews, [cwd]: list } }));
  },

  updateReview(cwd, id, review) {
    set((s) => {
      const list = s.reviews[cwd] ?? [];
      return { reviews: { ...s.reviews, [cwd]: review ? list.map((r) => (r.id === id ? review : r)) : list.filter((r) => r.id !== id) } };
    });
  },

  async openReview(reviewId) {
    const review = Object.values(get().reviews).flat().find((r) => r.id === reviewId);
    const project = review && get().projects.find((p) => p.cwd === review.cwd);
    if (!project) return;
    if (get().settings.activeProjectId !== project.id) await get().openProject(project.id);
    if (get().settings.mode !== 'code' && get().settings.mode !== 'split') get().setMode('split');
    get().openFile(project.id, `${REVIEW_TAB}${reviewId}`);
  },

  async openProject(projectId) {
    const { settings } = get();
    const open = settings.openProjectIds.includes(projectId) ? settings.openProjectIds : [...settings.openProjectIds, projectId];
    set({ settings: await api.setSettings({ openProjectIds: open, activeProjectId: projectId }), pickerOpen: false, provisionalOpen: false });
    await get().loadSessions(projectId);
    if (wantsRecent(get()) && !(projectId in get().recent)) reloadRecentSoon();
  },

  closeProject(projectId) {
    const { settings } = get();
    const open = settings.openProjectIds.filter((id) => id !== projectId);
    const active = settings.activeProjectId === projectId ? (open[0] ?? null) : settings.activeProjectId;
    set({ settings: { ...settings, openProjectIds: open, activeProjectId: active }, provisionalOpen: false });
    void api.setSettings({ openProjectIds: open, activeProjectId: active });
    if (active != null) void get().loadSessions(active);
    if (get().agentsScope === 'all') set((s) => ({ recent: Object.fromEntries(Object.entries(s.recent).filter(([id]) => Number(id) !== projectId)) }));
  },

  async setActiveProject(projectId) {
    set((s) => ({ settings: { ...s.settings, activeProjectId: projectId } }));
    void api.setSettings({ activeProjectId: projectId });
    await get().loadSessions(projectId);
  },

  toggle(key) {
    set((s) => ({ expanded: { ...s.expanded, [key]: !s.expanded[key] } }));
  },

  setFilter(filter) {
    set({ filter });
  },

  setAgentsScope(scope) {
    localStorage.setItem('alchemist.agentsScope', scope);
    set({ agentsScope: scope });
    if (scope === 'all') void get().loadRecent();
  },

  async loadRecent() {
    const ids = get().settings.openProjectIds ?? [];
    if (!ids.length) return set({ recent: {} });
    set({ recent: await api.recentSessions(ids, RECENT_PER_PROJECT) });
  },

  setPickerOpen(open) {
    set({ pickerOpen: open });
  },

  async search(query) {
    set({ query });
    if (query.trim().length < 2) {
      set({ results: null });
      return;
    }
    const results = await api.search(query);
    if (get().query === query) set({ results });
  },

  setLocale(locale) {
    set((s) => ({ locale, settings: { ...s.settings, locale } }));
    void api.setSettings({ locale });
  },

  async toggleFavorite(session) {
    await api.setFavorite(session.id, !session.favorite);
    await get().loadSessions(session.projectId);
  },

  async sessionsChanged(projectId, sessionIds = []) {
    await get().loadSessions(projectId);
    // changedSessions makes an open conversation reload its header (e.g. after a rename).
    set((s) => ({ revision: s.revision + 1, changedSessions: sessionIds }));
  },

  async openTerminalWith(projectId, command, title, cwd) {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;
    if (get().settings.activeProjectId !== projectId) await get().openProject(projectId);
    // A folder is passed as the terminal's working directory, never typed into the shell.
    const { id, shell } = await api.createTerminal(cwd ?? project.cwd, 100, 28, localStorage.getItem('alchemist.shell') ?? undefined);
    get().addTerminal(projectId, { id, title: title ?? (command ? command.split(' ')[0]! : shell), exited: false });
    if (command) setTimeout(() => api.writeTerminal(id, `${command}\r`), 450);
    const mode = get().settings.mode;
    if (mode !== 'terminal' && mode !== 'split') get().setMode('terminal');
  },

  async onChanged(ids) {
    const { trees, settings, runs, composeProjectId } = get();
    const open = get().selection?.sessionId;
    if (open && ids.includes(open) && document.hasFocus()) markViewed(open);
    const born = Object.values(runs).find((r) => r.target.startsWith('p:') && r.sessionId && ids.includes(r.sessionId));
    if (born?.sessionId && composeProjectId != null) {
      set({ composeProjectId: null });
      void get().select(born.sessionId, 'main');
    }
    await Promise.all(ids.filter((id) => id in trees).map((id) => get().loadTree(id)));
    const projects = await api.projects();
    set((s) => ({ projects, revision: s.revision + 1, changedSessions: ids }));
    if (settings.activeProjectId != null) await get().loadSessions(settings.activeProjectId);
    if (wantsRecent(get())) reloadRecentSoon();
  },

  markCaptureReady() {
    set({ captureReady: true });
  },

  async loadCatalog() {
    const catalog = await api.runnerCatalog();
    set({ catalog, catalogFresh: true });
    try {
      const info = get().info;
      if (info) localStorage.setItem(CATALOG_KEY, JSON.stringify({ build: buildId(info), catalog }));
    } catch {
      // too big or no storage: it's only a head start
    }
  },

  async loadBots() {
    const [botTeams, botConfigs, orgSettings] = await Promise.all([api.botTeams(), api.botConfigs(), api.orgSettings()]);
    set({ botTeams, botConfigs, orgSettings });
  },

  upsertTeam(team) {
    set((s) => {
      const i = s.botTeams.findIndex((x) => x.id === team.id);
      return { botTeams: i >= 0 ? s.botTeams.map((x) => (x.id === team.id ? team : x)) : [team, ...s.botTeams] };
    });
  },

  async messageBot(teamId, botId, text) {
    await api.messageBot(teamId, botId, text);
    const runId = get().botTeams.find((t) => t.id === teamId)?.bots.find((b) => b.id === botId)?.runId;
    if (runId) patchRun(runId, (r) => ({ ...r, status: 'running', turns: startTurn(r.turns, text) }));
  },

  async loadPlanUsage(refresh = false) {
    set({ planUsageLoading: true });
    try {
      set({ planUsage: await api.planUsage(refresh) });
    } catch {
      // keeps the last one
    } finally {
      set({ planUsageLoading: false });
    }
  },

  async startRun(target, request) {
    const { runId } = await api.startRun(request);
    // Events can beat the IPC reply: keep what already arrived.
    const prev = { ...emptyRun(runId, request.harnessId, target, request.resumeSessionId ?? null), ...useStore.getState().runs[runId] };
    const run = { ...prev, target, harnessId: request.harnessId, cwd: request.cwd, turns: startTurn(prev.turns, request.prompt, Date.now(), request.images ?? []) };
    set((s) => ({ runs: { ...s.runs, [runId]: run }, runByTarget: { ...s.runByTarget, [target]: runId } }));
  },

  async sendToRun(runId, text, images) {
    await api.sendToRun(runId, text, images);
    patchRun(runId, (r) => ({ ...r, status: 'running', text: r.text ? `${r.text}\n\n` : '', turns: startTurn(r.turns, text, Date.now(), images ?? []) }));
  },

  clearTurns(runId) {
    patchRun(runId, (r) => ({ ...r, turns: [] }));
  },

  async stopRun(runId) {
    await api.stopRun(runId);
    patchRun(runId, (r) => ({ ...r, status: 'interrupted', permissions: [], questions: [] }));
  },

  async loadTasks(projectCwd) {
    const list = await api.tasks(projectCwd).catch(() => []);
    set((s) => ({ tasks: { ...Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => t.projectCwd !== projectCwd)), ...Object.fromEntries(list.map((t) => [t.id, t])) } }));
  },

  upsertTask(task) {
    set((s) => ({ tasks: { ...s.tasks, [task.id]: task } }));
  },

  dropTask(taskId) {
    set((s) => {
      const { [taskId]: _gone, ...rest } = s.tasks;
      return { tasks: rest, activeTaskId: s.activeTaskId === taskId ? null : s.activeTaskId };
    });
  },

  setActiveTask(taskId) {
    set({ activeTaskId: taskId });
  },

  async interruptRun(runId) {
    await api.interruptRun(runId);
  },

  async respondPermission(runId, requestId, choiceId) {
    // Optimistic: the card disappears at once; the agent confirms with permissionClosed.
    patchRun(runId, (r) => ({ ...r, permissions: r.permissions.filter((p) => p.requestId !== requestId) }));
    await api.respondToRun(runId, requestId, choiceId);
  },

  async answerQuestion(runId, requestId, answer, summary) {
    patchRun(runId, (r) => ({ ...r, questions: (r.questions ?? []).filter((q) => q.requestId !== requestId), turns: markQuestion(r.turns ?? [], requestId, answer?.action === 'accept', summary) }));
    await api.answerRun(runId, requestId, answer);
  },

  async configureRun(runId, change) {
    await api.configureRun(runId, change);
  },

  setSidebarTab(tab) {
    set({ sidebarTab: tab });
  },

  async setTheme(id) {
    const theme = await loadTheme(id);
    applyWorkbench(theme);
    useCurrentTheme.setState({ theme });
    set((s) => ({ theme, settings: { ...s.settings, theme: id } }));
    void api.setSettings({ theme: id });
  },

  openFile(projectId, path) {
    set((s) => {
      let list = s.openFiles[projectId] ?? [];
      if (!list.includes(path)) {
        list = [...list, path];
        // Past 12 tabs, drop the oldest one without unsaved edits (never one with them).
        const drop = list.length > 12 ? list.find((p) => !s.dirty[p] && p !== path) : undefined;
        if (drop) list = list.filter((p) => p !== drop);
      }
      return {
        openFiles: { ...s.openFiles, [projectId]: list },
        activeFile: { ...s.activeFile, [projectId]: path },
      };
    });
  },

  openFileAt(projectId, path, line = 1, column = 1) {
    const mode = get().settings.mode;
    if (mode !== 'code' && mode !== 'split') get().setMode('split');
    get().openFile(projectId, path);
    set({ reveal: { path, line, column } });
  },

  clearReveal() {
    set({ reveal: null });
  },

  fillComposer(text, send, fork) {
    set({ composerFill: { text, nonce: Date.now(), send, fork } });
  },

  closeFile(projectId, path) {
    set((s) => {
      const list = (s.openFiles[projectId] ?? []).filter((p) => p !== path);
      const active = s.activeFile[projectId] === path ? (list.at(-1) ?? null) : (s.activeFile[projectId] ?? null);
      return { openFiles: { ...s.openFiles, [projectId]: list }, activeFile: { ...s.activeFile, [projectId]: active } };
    });
  },

  setDirty(path, dirty) {
    set((s) => (!!s.dirty[path] === dirty ? {} : { dirty: { ...s.dirty, [path]: dirty } }));
  },

  addTerminal(projectId, tab, asSplit = false) {
    set((s) => ({
      terminals: { ...s.terminals, [projectId]: [...(s.terminals[projectId] ?? []), tab] },
      ...(asSplit && s.activeTerminal[projectId]
        ? { splitTerminal: { ...s.splitTerminal, [projectId]: tab.id } }
        : { activeTerminal: { ...s.activeTerminal, [projectId]: tab.id } }),
    }));
  },

  setActiveTerminal(projectId, id) {
    set((s) => {
      // One terminal can't be in both halves: picking the right one swaps them.
      const split = s.splitTerminal[projectId];
      const swap = split === id ? { splitTerminal: { ...s.splitTerminal, [projectId]: s.activeTerminal[projectId] ?? null } } : {};
      return { activeTerminal: { ...s.activeTerminal, [projectId]: id }, ...swap };
    });
  },

  setSplitTerminal(projectId, id) {
    set((s) => ({ splitTerminal: { ...s.splitTerminal, [projectId]: id } }));
  },

  closeTerminal(projectId, id) {
    api.killTerminal(id);
    set((s) => {
      const list = (s.terminals[projectId] ?? []).filter((t) => t.id !== id);
      const split = s.splitTerminal[projectId] === id ? null : (s.splitTerminal[projectId] ?? null);
      const current = s.activeTerminal[projectId];
      const active = current && current !== id ? current : (list.filter((t) => t.id !== split).at(-1)?.id ?? split);
      return {
        terminals: { ...s.terminals, [projectId]: list },
        activeTerminal: { ...s.activeTerminal, [projectId]: active ?? null },
        splitTerminal: { ...s.splitTerminal, [projectId]: active === split ? null : split },
      };
    });
  },

  renameTerminal(projectId, id, title) {
    set((s) => ({ terminals: { ...s.terminals, [projectId]: (s.terminals[projectId] ?? []).map((t) => (t.id === id ? { ...t, title: title.slice(0, 40) } : t)) } }));
  },

  markTerminalExited(id) {
    set((s) => {
      const terminals: Record<number, TerminalTab[]> = {};
      for (const [pid, list] of Object.entries(s.terminals)) terminals[Number(pid)] = list.map((t) => (t.id === id ? { ...t, exited: true } : t));
      return { terminals };
    });
  },

  setCompose(projectId) {
    set({ composeProjectId: projectId, selection: projectId != null ? null : get().selection });
  },
}));

const MODES: Mode[] = ['agents', 'arena', 'bots', 'code', 'split', 'terminal', 'history', 'marketing', 'board'];

/** Menu bar commands. */
/** The all-projects list and the board both show every open project's latest conversations. */
const wantsRecent = (s: Pick<State, 'agentsScope' | 'settings'>) => s.agentsScope === 'all' || s.settings.mode === 'board';
/** How many of each project's latest conversations the all-projects view lists. */
const RECENT_PER_PROJECT = 8;
let recentTimer: ReturnType<typeof setTimeout> | null = null;
/** Transcripts change in bursts while agents work: refresh the all-projects lists at most every second or so. */
function reloadRecentSoon() {
  if (recentTimer) return;
  recentTimer = setTimeout(() => {
    recentTimer = null;
    void useStore.getState().loadRecent();
  }, 1200);
}

function runAppCommand(command: string) {
  const s = useStore.getState();
  const projectId = s.settings.activeProjectId;
  if (command.startsWith('mode:')) {
    const mode = command.slice(5) as Mode;
    if (MODES.includes(mode)) s.setMode(mode);
    return;
  }
  switch (command) {
    case 'toggle-sidebar':
      toggleSidebar();
      return;
    case 'toggle-agent-panel':
      if (s.settings.mode === 'split') toggleSplitSide();
      return;
    case 'new-conversation':
      if (projectId != null) {
        if (s.settings.mode !== 'agents' && s.settings.mode !== 'split') s.setMode('agents');
        s.setCompose(projectId);
      }
      return;
    case 'new-terminal':
      if (projectId != null) void s.openTerminalWith(projectId, '', undefined);
      return;
    case 'new-project':
      openNewProject();
      return;
    case 'open-folder':
      void openFolderAsProject((key, vars) => translate(s.locale, key, vars));
      return;
    case 'open-project':
      s.setPickerOpen(true);
      return;
    case 'close-tab': {
      if (projectId == null) return;
      if (s.settings.mode === 'code' || s.settings.mode === 'split') useStore.setState({ closeTabSignal: Date.now() });
      else if (s.settings.mode === 'terminal') {
        const term = s.activeTerminal[projectId];
        if (term) s.closeTerminal(projectId, term);
      }
      return;
    }
    case 'settings':
      useStore.setState({ settingsOpen: true });
      return;
    case 'palette':
      useStore.setState({ paletteOpen: !s.paletteOpen });
      return;
  }
}

export const NOTIFY_KEY = 'alchemist.notify';

/** A system notification when an agent needs you (or finishes) while the window is in the background. */
function notifyInBackground(runId: string, event: RunnerEventMessage['event']) {
  if (document.hasFocus() || localStorage.getItem(NOTIFY_KEY) === 'off') return;
  const s = useStore.getState();
  const run = s.runs[runId];
  if (!run || run.target.startsWith('bg:')) return;
  const title = event.type === 'permission' ? translate(s.locale, 'notify.permission') : event.type === 'question' ? translate(s.locale, 'notify.question') : event.type === 'result' ? translate(s.locale, event.ok ? 'notify.done' : 'notify.failed') : null;
  if (!title) return;
  const body = event.type === 'permission' ? event.title : event.type === 'question' ? event.message.slice(0, 140) : run.text.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 140) ?? '';
  const n = new Notification(title, { body, silent: event.type !== 'permission' && event.type !== 'question' });
  n.onclick = () => {
    window.focus();
    if (run.sessionId) void useStore.getState().select(run.sessionId, 'main');
  };
}

const reviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Agents edit in bursts: look at the project once things settle. */
function refreshReviewsSoon(cwd: string) {
  clearTimeout(reviewTimers.get(cwd));
  reviewTimers.set(cwd, setTimeout(() => void useStore.getState().loadReviews(cwd), 800));
}

function patchRun(runId: string, fn: (run: RunState) => RunState) {
  useStore.setState((s) => (s.runs[runId] ? { runs: { ...s.runs, [runId]: fn(s.runs[runId]!) } } : {}));
}

export function emptyRun(runId: string, harnessId: string, target: string, sessionId: string | null = null): RunState {
  return { runId, harnessId, target, status: 'starting', text: '', thought: '', tools: [], plan: [], planMarkdown: null, permissions: [], config: null, usage: null, notices: [], errors: [], sessionId, turns: [] };
}

function applyRunnerEvent({ runId, event }: RunnerEventMessage) {
  // Runs started by the main process (the Arena's planner and agents) appear on their first event.
  if (!useStore.getState().runs[runId]) useStore.setState((s) => ({ runs: { ...s.runs, [runId]: emptyRun(runId, '', `bg:${runId}`) } }));
  patchRun(runId, (r) => ({ ...reduceRun(r, event), turns: applyToTurns(r.turns ?? [], event) }));
  afterRunEvent(runId, event);
}

function reduceRun(r: RunState, event: RunnerEventMessage['event']): RunState {
    switch (event.type) {
      case 'started':
        return { ...r, sessionId: event.sessionId ?? r.sessionId };
      case 'text':
        return { ...r, text: r.text + event.text, thought: '' };
      case 'thought':
        return { ...r, thought: (r.thought + event.text).slice(-1200) };
      case 'tool': {
        const tool: RunTool = { id: event.id, name: event.name, summary: event.summary, kind: event.kind, state: event.state, diffs: event.diffs };
        const i = event.id ? r.tools.findIndex((t) => t.id === event.id) : -1;
        if (i < 0) return { ...r, tools: [...r.tools.slice(-40), tool] };
        // Updates only carry what changed.
        const prev = r.tools[i]!;
        const merged: RunTool = { ...prev, summary: event.summary || prev.summary, kind: event.kind ?? prev.kind, state: event.state ?? prev.state, diffs: event.diffs ?? prev.diffs };
        return { ...r, tools: r.tools.map((t, j) => (j === i ? merged : t)) };
      }
      case 'plan':
        return { ...r, plan: event.entries, planMarkdown: event.markdown ?? null };
      case 'permission':
        return { ...r, permissions: [...r.permissions, { requestId: event.requestId, title: event.title, kind: event.kind, diffs: event.diffs, choices: event.choices }] };
      case 'permissionClosed':
        return { ...r, permissions: r.permissions.filter((p) => p.requestId !== event.requestId) };
      case 'question':
        return { ...r, questions: [...(r.questions ?? []), { requestId: event.requestId, message: event.message, fields: event.fields }] };
      case 'questionClosed':
        return { ...r, questions: (r.questions ?? []).filter((q) => q.requestId !== event.requestId) };
      case 'config':
        return { ...r, config: { modes: event.modes, mode: event.mode, options: event.options } };
      case 'commands':
        return { ...r, commands: event.commands };
      case 'usage':
        return { ...r, usage: { usedTokens: event.usedTokens, contextTokens: event.contextTokens, costUsd: event.costUsd } };
      case 'notice':
        return { ...r, notices: [...r.notices.slice(-4), event.text] };
      case 'error':
        return { ...r, errors: [...r.errors, event.message] };
      case 'stderr':
        return /error|denied|not found|failed/i.test(event.text) ? { ...r, errors: [...r.errors.slice(-5), event.text.trim().slice(0, 400)] } : r;
      case 'result':
        return { ...r, status: event.ok ? 'idle' : 'error', thought: '', sessionId: event.sessionId ?? r.sessionId };
      case 'status':
        if (event.status === 'running') return { ...r, status: r.permissions.length || r.questions?.length ? 'waiting' : 'running' };
        if (event.status === 'waiting') return { ...r, status: 'waiting' };
        if (event.status === 'idle') return { ...r, status: 'idle' };
        // Headless Codex (no ACP, so no config) runs one process per turn: a finished process just means "your turn".
        if (event.status === 'done') return { ...r, status: r.harnessId === 'codex' && !r.config ? 'idle' : 'done', permissions: [], questions: [] };
        return { ...r, status: event.status === 'error' ? 'error' : 'interrupted' };
    }
}

function afterRunEvent(runId: string, event: RunnerEventMessage['event']) {
  // A brand-new conversation gets selected once its transcript shows up in the index.
  const run = useStore.getState().runs[runId];
  notifyInBackground(runId, event);
  const edited = event.type === 'tool' && event.state === 'done' && ['edit', 'delete', 'move', 'execute'].includes(event.kind ?? '');
  const turnOver = event.type === 'status' && event.status !== 'running' && event.status !== 'waiting';
  if (run?.cwd && (edited || turnOver || event.type === 'result')) refreshReviewsSoon(run.cwd);
  if (run?.sessionId && run.target.startsWith('p:')) {
    moveComposerState(run.target, `s:${run.sessionId}`);
    useStore.setState((s) => ({ runByTarget: { ...s.runByTarget, [`s:${run.sessionId}`]: runId } }));
  }
}

export function useT() {
  const locale = useStore((s) => s.locale);
  return (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
}

/** The projects open in the rail: where agents can be assigned and assignments given. */
export function useOpenProjects(): ProjectSummary[] {
  const projects = useStore((s) => s.projects);
  const open = useStore((s) => s.settings.openProjectIds);
  return open.map((id) => projects.find((p) => p.id === id)).filter((p): p is ProjectSummary => !!p);
}

export function findAgent(node: AgentNode | null | undefined, id: string): AgentNode | null {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children) {
    const found = findAgent(c, id);
    if (found) return found;
  }
  return null;
}

/** Runs waiting for your answer (a permission), oldest first: where they are and how to get there. */
export function waitingRuns(s: Pick<State, 'runs' | 'projects'>): Array<{ runId: string; sessionId: string | null; projectId: number | null }> {
  return Object.values(s.runs)
    .filter((r) => r.status === 'waiting')
    .map((r) => {
      const sessionId = r.target.startsWith('s:') ? r.target.slice(2) : null;
      const projectId = r.target.startsWith('p:') ? Number(r.target.slice(2)) : (s.projects.find((p) => p.cwd === r.cwd)?.id ?? null);
      return { runId: r.runId, sessionId, projectId };
    });
}

export const waitingProjectIds = (s: Pick<State, 'runs' | 'projects'>): number[] =>
  [...new Set(waitingRuns(s).map((w) => w.projectId).filter((id): id is number => id != null))].sort((a, b) => a - b);
