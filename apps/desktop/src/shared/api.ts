import type { AgentNode, IndexProgress, ModelSpec, PermissionMode, ProjectSummary, QuestionAnswer, RunnerEvent, SearchHit, SessionSummary, SlashCommand, PromptImage, TranscriptPage } from '@alchemist-coder/core';

export type { PermissionMode };

export type Mode = 'agents' | 'arena' | 'bots' | 'code' | 'split' | 'terminal' | 'history' | 'marketing' | 'board';

/** Marketing mode: where a piece goes. */
export type MarketingChannel = 'x' | 'thread' | 'instagram' | 'linkedin' | 'tiktok' | 'email' | 'landing' | 'blog' | 'appstore' | 'play' | 'seo';
export type MarketingStatus = 'idea' | 'draft' | 'approved' | 'scheduled' | 'published';

/** The project's brand, written to marketing/BRAND.md for every agent. */
export interface MarketingBrand {
  product: string;
  pitch: string;
  audience: string;
  tone: string;
  say: string;
  avoid: string;
  /** What may be claimed (and nothing else): features that exist, numbers that are true. */
  claims: string;
  links: string;
  languages: string;
}

export interface MarketingPiece {
  id: string;
  channel: MarketingChannel;
  title: string;
  /** What it should say, for whoever writes it (you or an agent). */
  brief: string;
  body: string;
  status: MarketingStatus;
  /** When it goes out (YYYY-MM-DD). */
  date: string | null;
  language: string;
  createdAt: number;
  updatedAt: number;
  /** The team's draft file it came from (marketing/drafts/…). */
  source?: string | null;
}

export interface MarketingData {
  version: 1;
  brand: MarketingBrand;
  pieces: MarketingPiece[];
}

/** A draft the marketing team wrote in marketing/drafts/. */
export interface MarketingDraft {
  file: string;
  title: string;
  channel: MarketingChannel | null;
  body: string;
}

/** A column of the board, the same phases Nimbalyst uses. */
export type BoardPhase = 'backlog' | 'planning' | 'implementing' | 'validating' | 'done';
/** A piece of work on the board: written down first, then handed to an agent (its conversation). */
export interface BoardTask {
  id: string;
  /** The project's folder (project ids change if the index is rebuilt). */
  cwd: string;
  title: string;
  notes: string;
  phase: BoardPhase;
  /** The conversation working on it, once started. */
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
}
/** Where you put a conversation, and when: newer agent activity moves it on its own again. */
export interface BoardPlacement {
  phase: BoardPhase;
  at: number;
}
export interface BoardData {
  tasks: BoardTask[];
  placed: Record<string, BoardPlacement>;
}
/** A reusable prompt from the project's ai-actions.md ("## Name" then the prompt). */
export interface ActionPrompt {
  label: string;
  body: string;
}
export type Locale = 'en' | 'es';

export interface Settings {
  /** null = follow the system language. */
  locale: Locale | null;
  /** Id of the color theme (bundled VS Code theme or an imported one). */
  theme: string;
  openProjectIds: number[];
  activeProjectId: number | null;
  mode: Mode;
  /** Folder of the versioned history backup; null = off. */
  backupDir: string | null;
  /** Back up automatically every 30 minutes. */
  backupAuto: boolean;
}

export interface BackupStatus {
  dir: string | null;
  auto: boolean;
  running: boolean;
  progress: { done: number; total: number } | null;
  lastRun: number | null;
  lastCommit: string | null;
  files: number;
  bytes: number;
  /** What the live history weighs, to size the first backup. */
  sourceBytes: number;
  error: string | null;
}

export type ExportFormat = 'md' | 'html' | 'json';

export interface AppInfo {
  version: string;
  edition: 'community' | 'pro';
  /** The owner's own build (never distributed): Claude sign-in and Claude's usage percentages. */
  personal: boolean;
  platform: string;
  systemLocale: string;
  /** The user's home folder (where a first project goes by default). */
  home: string;
  /** Set when the app was launched with --capture (automated screenshots). */
  capture: {
    select: { sessionId: string; agentId: string } | null;
    mode: Mode | null;
    query: string | null;
    locale: Locale | null;
    /** Opens the New project dialog. */
    newProject?: boolean;
    /** Open the floating sidebar (narrow windows). */
    drawer?: boolean;
    /** Open the board's new-task dialog. */
    boardNew?: boolean;
    /** Open this conversation next to the board. */
    boardOpen?: string | null;
    /** The Agents view scope to show. */
    scope?: 'project' | 'all' | null;
    /** Marketing mode's tab to show. */
    mkTab?: string | null;
    /** Writes the first piece with this agent, then captures. */
    mkGenerate?: AgentChoice | null;
    compose: boolean;
    /** Typed into the new-conversation composer (shows @ / suggestions). */
    composeText: string | null;
    theme: string | null;
    project: string | null;
    openFile: string | null;
    /** Opens the editor's preview pane next to the file. */
    preview: boolean;
    /** Sidebar tab to show. */
    sidebar: 'agents' | 'files' | 'extensions' | null;
    /** Opens the theme picker searching Open VSX for this. */
    themeSearch: string | null;
    /** Opens the terminal split in two. */
    terminalSplit: boolean;
    /** After --run, open the run's review. */
    review: boolean;
    /** Open the plans & usage popover. */
    usage: boolean;
    /** Open Settings at this section. */
    settings: 'general' | 'agents' | 'usage' | 'backup' | 'shortcuts' | 'about' | null;
    /** Starts a real agent run and captures once it asks for permission or finishes. */
    run: { harnessId: string; providerId: string; model: string; permissionMode: PermissionMode; prompt: string; cwd: string | null } | null;
    /** Bots mode: open the most recent team, or the new-configuration dialog. */
    botsView: 'team' | 'config' | 'member' | 'agent' | null;
    /** Starts a real bot team (coordinator agent from `agent`) and captures once it settles. */
    team: { goal: string; harnessId: string; providerId: string; model: string; cwd: string; approvePlan: boolean; org: boolean } | null;
    /** Runs a real Arena task and captures it at plan review or once the agents finish. */
    arena: { prompt: string; planner: AgentChoice | null; agents: AgentChoice[]; tests: string | null; stopAt: 'review' | 'compare' } | null;
  } | null;
}

export interface RunnerCatalog {
  harnesses: Array<{
    id: string;
    label: string;
    installed: boolean;
    /** The agent adapter's version (ACP). */
    version: string | null;
    /** The CLI's own version, when it has a separate binary (claude, codex). */
    cliVersion: string | null;
    /** From what the CLI keeps locally; null = can't tell. */
    signedIn: boolean | null;
    account: string | null;
    cliPath: string | null;
  }>;
  providers: Array<{
    id: string;
    label: string;
    edition: 'community' | 'pro';
    /** Agent CLIs this provider can drive. */
    harnesses: string[];
    available: boolean;
    detail: string | null;
    models: ModelSpec[];
    credential: { label: string; placeholder: string | null; isSet: boolean; optional: boolean } | null;
  }>;
}

export interface StartRunRequest {
  cwd: string;
  harnessId: string;
  providerId: string;
  model: string;
  prompt: string;
  resumeSessionId?: string;
  /** With resumeSessionId: start a new conversation from that one, leaving it untouched. */
  fork?: boolean;
  permissionMode?: PermissionMode;
  /** Reasoning effort, when the agent offers it for the model. */
  effort?: string;
  /** Pasted images, for agents that take them. */
  images?: PromptImage[];
}

export interface RunnerEventMessage {
  runId: string;
  event: RunnerEvent;
}

export type TaskPhase = 'draft' | 'planning' | 'review' | 'running' | 'compare' | 'merged' | 'discarded';

/** One agent + provider + model, as picked in the composer. */
/** A saved bot: who it is and how it runs. Any configuration can coordinate a team or be created by one. */
export interface BotConfig {
  id: string;
  name: string;
  /** Its role and standing instructions. */
  role: string;
  agent: AgentChoice;
  permissionMode: PermissionMode;
  /** It may create other bots (within the team's limits). */
  canSpawn: boolean;
  /** It works in its own copy of the project (a git worktree); its creator applies the result. */
  ownWorktree?: boolean;
  /** The organization's coordinator (one), or one of its agents. */
  kind?: 'coordinator' | 'member';
  /** Project folders it works in; none means every project. */
  projects?: string[];
  /** Defined on the spot by the coordinator: you keep it or dismiss it. */
  proposed?: boolean;
}

/** The organization: its name and the instructions the coordinator and every agent get. */
export interface OrgSettings {
  name: string;
  instructions: string;
}

export type BotStatus = 'starting' | 'working' | 'waiting' | 'idle' | 'done' | 'error' | 'stopped';

export interface BotMember {
  id: string;
  name: string;
  /** The configuration it came from; null when it was defined directly. */
  configId: string | null;
  role: string;
  agent: AgentChoice;
  permissionMode: PermissionMode;
  canSpawn: boolean;
  parentId: string | null;
  depth: number;
  runId: string | null;
  /** The CLI's conversation id, to open its full transcript. */
  sessionId?: string | null;
  /** Its own copy of the project, when it has one. `base`: what its changes are measured against. */
  worktree?: { path: string; branch: string; base: string; root: string } | null;
  status: BotStatus;
  /** What it was asked to do. */
  task: string;
  /** Its latest answer (trimmed). */
  lastReply: string;
  /** What it's doing right now ("Bash: npm test"), while it works. */
  doing?: string | null;
  /** Why its last turn failed, when it did (cleared when it starts again). */
  error?: string | null;
  costUsd: number | null;
  createdAt: number;
}

/** One bot the coordinator means to create, as the user sees (and may edit) it before approving. */
export interface PlannedBot {
  name: string;
  task: string;
  /** A saved configuration's name, or empty when defined on the spot. */
  config: string;
  role: string;
  ownWorktree: boolean;
}

export type TeamEventKind = 'created' | 'waiting' | 'finished' | 'failed' | 'stopped' | 'plan' | 'approved' | 'changes' | 'applied' | 'message' | 'done';

/** One line of a team's activity: who (bot id) did what, and when. */
export interface TeamEvent {
  at: number;
  botId: string;
  kind: TeamEventKind;
  /** Details: the other bot's id for created/message, a task or a count. */
  detail: string;
}

export interface TeamPlan {
  summary: string;
  bots: PlannedBot[];
  estimateUsd: number | null;
  /** pending: waiting for you; approved: bots may be created; changes: you asked for another plan. */
  status: 'pending' | 'approved' | 'changes';
  feedback: string;
  /** Bumped each time the coordinator proposes again. */
  revision: number;
}

export interface BotTeam {
  id: string;
  /** Short name: the goal's first line, or what you renamed it to. */
  title?: string;
  goal: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** The coordinator is bots[0]. */
  bots: BotMember[];
  /** Spending cap in US$ for the whole team (null = none); reaching it stops every bot. */
  budgetUsd?: number | null;
  /** Why the team was stopped by the app, when it was: 'budget:<spent>' or 'appClosed'. */
  stoppedReason?: string | null;
  /** The coordinator said the goal is done (finish_team), with its summary; cleared when you message it again. */
  finished?: { summary: string; at: number } | null;
  /** You review the coordinator's plan before any bot is created. */
  approvePlan?: boolean;
  /** What happened in the team, newest last (at most 200). */
  activity?: TeamEvent[];
  plan?: TeamPlan | null;
}

export interface StartTeamRequest {
  goal: string;
  cwd: string;
  /** A saved configuration for the coordinator, or one defined here. */
  configId?: string;
  coordinator?: Omit<BotConfig, 'id' | 'canSpawn'>;
  budgetUsd?: number | null;
  approvePlan?: boolean;
  /** Extra instructions for this assignment only (a template's guidance). */
  guidance?: string;
}

export interface AgentChoice {
  harnessId: string;
  providerId: string;
  model: string;
}

/** One entry of a right-click menu (shown natively by the main process). */
export type MenuItem =
  | { type: 'separator' }
  | { id: string; label: string; enabled?: boolean; checked?: boolean; accelerator?: string; submenu?: MenuItem[] };

/** Consumption in the last `hours`, summed from local transcripts. */
export interface UsageWindow {
  hours: number;
  tokens: number;
  outputTokens: number;
  /** What it would cost at API prices (subscriptions aren't billed per token). */
  costUsd: number;
  messages: number;
}

/** A usage window of a subscription: how much of it is used and when it starts over. */
export interface LimitWindow {
  percent: number;
  resetsAt: number | null;
}

/** Claude's own percentages (personal builds): session, weekly, and per-model weekly limits. */
export interface ClaudeLimits {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  sevenDayOpus: LimitWindow | null;
  models: Array<{ model: string } & LimitWindow>;
  at: number;
  /** 'no-login' | 'expired' | 'rate-limited' | 'offline' | 'http-NNN' */
  error: string | null;
  /** These are the last good numbers (from `at`): the latest check failed with this. */
  stale?: string | null;
}

/** Subscription plans and usage, read from what the CLIs keep on this machine (no network). */
export interface PlanUsage {
  claude: {
    plan: string | null;
    account: string | null;
    extraUsage: boolean;
    windows: UsageWindow[];
    /** A usage limit Claude Code hit that is still in effect. */
    limit: { type: string; resetsAt: number } | null;
    /** The plan's real percentages, when this build may ask for them (personal builds). */
    limits?: ClaudeLimits | null;
  } | null;
  codex: {
    plan: string | null;
    windows: Array<{ label: 'five_hour' | 'weekly'; usedPercent: number; windowMinutes: number; resetsAt: number | null }>;
    /** When Codex last reported these numbers. */
    asOf: number;
  } | null;
  at: number;
}

/** A file an agent run changed that hasn't been kept or undone yet. */
export interface ReviewFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added: number;
  removed: number;
  binary: boolean;
}

/** One agent run's changes to its project, compared with the project as the agent found it. */
export interface AgentReview {
  id: string;
  cwd: string;
  root: string;
  harnessId: string;
  model: string;
  /** The first line of the prompt. */
  title: string;
  sessionId: string | null;
  createdAt: number;
  files: ReviewFile[];
}

export interface ReviewFileContent {
  /** The file before the agent (minus changes already kept); null = it didn't exist. */
  oldText: string | null;
  /** The file now; null = deleted. */
  newText: string | null;
  binary: boolean;
}

export interface TaskFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  binary: boolean;
  /** Git hooks, direnv, CI or editor tasks: tools run these on their own, so they deserve a close look. */
  autoRun?: boolean;
}

export interface TaskTestResult {
  ok: boolean;
  code: number | null;
  output: string;
  durationMs: number;
}

export interface TaskContestant extends AgentChoice {
  /** Also the worktree folder name, e.g. "1-claude-code". */
  id: string;
  worktree: { path: string; branch: string } | null;
  runId: string | null;
  sessionId: string | null;
  state: 'starting' | 'running' | 'waiting' | 'finished' | 'failed' | 'stopped';
  startedAt: number | null;
  endedAt: number | null;
  costUsd: number | null;
  changes: TaskFileChange[] | null;
  tests: TaskTestResult | 'running' | null;
  summary: string | null;
  error: string | null;
}

/** A task solved by one or several agents (the Arena), optionally from an approved plan. */
export interface ArenaTask {
  id: string;
  projectCwd: string;
  /** Git top-level folder; null when the project is not a repository (one agent only). */
  root: string | null;
  base: string | null;
  baseBranch: string | null;
  /** Uncommitted files at start: they are not in the agents' worktrees. */
  dirtyAtStart: string[];
  title: string;
  prompt: string;
  phase: TaskPhase;
  planner: (AgentChoice & { runId: string | null }) | null;
  plan: string;
  testCommand: string | null;
  /** Stop every agent once their reported cost reaches this many USD; null = no cap. */
  budgetUsd: number | null;
  permissionMode: PermissionMode;
  contestants: TaskContestant[];
  winner: string | null;
  mergeCommit: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEdit {
  plan?: string;
  prompt?: string;
  testCommand?: string | null;
  budgetUsd?: number | null;
  permissionMode?: PermissionMode;
  /** Moves a draft (or a finished planning step) to plan review. */
  review?: boolean;
}

export type HubAgent = 'claude-code' | 'codex' | 'gemini' | 'grok';
export type HubVia = 'own' | 'compat';
export interface HubSource {
  agent: HubAgent;
  scope: 'user' | 'project' | 'local';
  file: string;
}

/** An MCP server as the renderer sees it: env and header values never leave the main process. */
export interface HubMcp {
  /** Name + definition fingerprint (one name can mean different servers in different configs). */
  id: string;
  name: string;
  conflict: boolean;
  transport: 'stdio' | 'http' | 'sse';
  command: string | null;
  args: string[];
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  sources: HubSource[];
  agents: Partial<Record<HubAgent, HubVia>>;
}

export interface HubInventory {
  mcp: HubMcp[];
  skills: Array<{ name: string; description: string; sources: HubSource[]; agents: Partial<Record<HubAgent, HubVia>> }>;
  hooks: Array<{ event: string; matcher: string | null; command: string; sources: HubSource[]; agents: Partial<Record<HubAgent, HubVia>> }>;
  instructions: { files: Array<{ name: string; exists: boolean; bytes: number; importsAgents: boolean }>; readBy: Record<HubAgent, string[]>; unified: boolean } | null;
  grokCompat: { mcps: boolean; skills: boolean; hooks: boolean };
  installed: Record<HubAgent, boolean>;
}

/** What "use in every agent" would run, per agent, before the user confirms. */
export interface HubInstallPlan {
  agent: HubAgent;
  description: string | null;
  reason: string | null;
  /** Things to double-check before confirming: a name used for different servers, a repo-defined server. */
  warnings: Array<'conflict' | 'project'>;
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  heavy: boolean;
}

export interface FileContent {
  path: string;
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}

export interface GitChange {
  path: string;
  status: string;
}

export interface AlchemistApi {
  info(): Promise<AppInfo>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  projects(): Promise<ProjectSummary[]>;
  /** Picks a folder and adds it as a project (null when cancelled). */
  openFolder(title: string): Promise<number | null>;
  /** Picks a folder, for example where a new project goes (null when cancelled). */
  chooseFolder(title: string, defaultPath?: string): Promise<string | null>;
  /** Creates `name` inside `parent` (with `git init` if asked) and adds it as a project. */
  createProject(parent: string, name: string, git: boolean): Promise<number>;
  /** The project's marketing (brand and pieces), from its marketing/ folder. */
  marketingLoad(cwd: string): Promise<MarketingData>;
  /** Saves the marketing and rewrites marketing/BRAND.md. */
  marketingSave(cwd: string, data: MarketingData): Promise<MarketingData>;
  /** Drafts the marketing team left in marketing/drafts/. */
  marketingDrafts(cwd: string): Promise<MarketingDraft[]>;
  /** The board: tasks and where you put conversations. */
  boardLoad(): Promise<BoardData>;
  boardSave(data: BoardData): Promise<BoardData>;
  /** The project's ai-actions.md prompts (exists: whether the file is there). */
  actionsList(cwd: string): Promise<{ exists: boolean; path: string; actions: ActionPrompt[] }>;
  /** Writes an ai-actions.md with examples if there is none; its path. */
  actionsCreate(cwd: string, example: string): Promise<string>;
  sessions(projectId: number | null, favoritesOnly?: boolean): Promise<SessionSummary[]>;
  /** The latest `perProject` conversations of each project, for the all-projects view. */
  recentSessions(projectIds: number[], perProject: number): Promise<Record<number, SessionSummary[]>>;
  session(id: string): Promise<SessionSummary | null>;
  agentTree(sessionId: string): Promise<AgentNode | null>;
  transcript(sessionId: string, agentId: string, offset?: number, limit?: number): Promise<TranscriptPage>;
  search(query: string, projectId?: number | null): Promise<SearchHit[]>;
  setFavorite(sessionId: string, favorite: boolean): Promise<void>;
  /** Your own title for a conversation ('' = back to the CLI's). */
  renameSession(sessionId: string, title: string): Promise<void>;
  renameTeam(teamId: string, title: string): Promise<void>;
  /** What a bot with its own copy changed there and hasn't been applied yet. */
  botChanges(teamId: string, botId: string): Promise<Array<{ path: string; status: string; added: number; removed: number; binary: boolean }>>;
  /** The patch a bot's own copy would apply, to review before applying it. */
  botDiff(teamId: string, botId: string): Promise<string>;
  /** Brings that work into the project folder (uncommitted); fails without touching anything on a clash. */
  applyBotWork(teamId: string, botId: string): Promise<string>;
  /** Approve the coordinator's plan (with your edits), or ask for changes. */
  answerPlan(teamId: string, answer: { approve: boolean; bots?: PlannedBot[]; feedback?: string }): Promise<void>;
  /** Hides (or brings back) a conversation in Alchemist; the CLI's files stay. */
  hideSession(sessionId: string, hidden: boolean): Promise<void>;
  hiddenSessions(): Promise<SessionSummary[]>;
  /** Moves a conversation's files to the Trash (recoverable) and hides it. */
  trashSession(sessionId: string): Promise<void>;
  /** Shows a conversation's transcript file in Finder. */
  revealSession(sessionId: string): Promise<void>;
  indexStatus(): Promise<IndexProgress>;
  onIndexProgress(listener: (progress: IndexProgress) => void): () => void;
  onSessionsChanged(listener: (sessionIds: string[]) => void): () => void;
  runnerCatalog(): Promise<RunnerCatalog>;
  /** Stores (or clears, with null) a provider's API key in the OS keychain. */
  setProviderCredential(providerId: string, value: string | null): Promise<void>;
  startRun(request: StartRunRequest): Promise<{ runId: string }>;
  sendToRun(runId: string, text: string, images?: PromptImage[]): Promise<void>;
  stopRun(runId: string): Promise<void>;
  /** Stops the current turn but keeps the conversation open. */
  interruptRun(runId: string): Promise<void>;
  /** Answers a permission request; null denies it. */
  respondToRun(runId: string, requestId: string, choiceId: string | null): Promise<void>;
  /** Answers an agent's question (a form); null cancels it. */
  answerRun(runId: string, requestId: string, answer: QuestionAnswer | null): Promise<void>;
  /** Changes the live session's mode or an option such as the model. */
  configureRun(runId: string, change: { mode?: string; option?: { id: string; value: string } }): Promise<void>;
  onRunnerEvent(listener: (message: RunnerEventMessage) => void): () => void;
  /** A sandboxed preview URL for a file (HTML, SVG, images); `root` is where its relative assets resolve. */
  previewUrl(root: string | null, path: string): Promise<string>;
  /** A preview tried to open a page outside the preview (and was stopped). */
  onPreviewBlocked(listener: (url: string) => void): () => void;
  /** MCP servers, skills, hooks and instructions of the four agent CLIs (for a project, if given). */
  hubInventory(projectCwd: string | null): Promise<HubInventory>;
  hubPlanInstall(serverId: string, projectCwd: string | null): Promise<HubInstallPlan[]>;
  hubInstall(serverId: string, agents: HubAgent[], projectCwd: string | null): Promise<Array<{ agent: HubAgent; ok: boolean; message: string }>>;
  /** Moves the project's instructions to AGENTS.md and imports it from CLAUDE.md and GEMINI.md. */
  hubUnify(projectCwd: string): Promise<{ created: string[]; changed: string[] }>;
  /** Saves a conversation with its subagents; resolves to the file path, or null if cancelled. */
  exportSession(sessionId: string, format: ExportFormat): Promise<string | null>;
  backupStatus(): Promise<BackupStatus>;
  /** Asks for a folder and turns the backup on (first run starts right away). */
  backupChoose(): Promise<BackupStatus>;
  backupRun(): Promise<BackupStatus>;
  backupSetAuto(auto: boolean): Promise<BackupStatus>;
  backupOpen(): Promise<void>;
  onBackupStatus(listener: (status: BackupStatus) => void): () => void;
  /** Menu bar commands (new conversation, modes, settings…). */
  onAppCommand(listener: (command: string) => void): () => void;
  /** Shows a native context menu at the pointer; resolves to the chosen item's id, or null. */
  showMenu(items: MenuItem[]): Promise<string | null>;
  /** Reveals a file or folder in Finder / Explorer. */
  revealPath(path: string): Promise<void>;
  /** Copies text to the clipboard. */
  copyText(text: string): Promise<void>;
  /** Subscription plans and recent usage (Claude, Codex) from local data; `refresh` skips the one-minute cache. */
  planUsage(refresh?: boolean): Promise<PlanUsage>;
  /** Agent runs in this project with changes still to review. */
  reviews(projectCwd: string): Promise<AgentReview[]>;
  reviewFile(reviewId: string, path: string): Promise<ReviewFileContent>;
  /**
   * Keeps a change: the whole file, or the new baseline text when keeping some blocks (`basedOn` =
   * the baseline it was computed from). Resolves to the updated review (null = nothing left).
   */
  reviewKeep(reviewId: string, path: string, baseline?: string, basedOn?: string): Promise<AgentReview | null>;
  /** Undoes a change on disk: the whole file, or writes `content` (`basedOn` = the file text it was computed from). */
  reviewUndo(reviewId: string, path: string, content?: string, basedOn?: string): Promise<AgentReview | null>;
  reviewDismiss(reviewId: string): Promise<void>;
  tasks(projectCwd: string): Promise<ArenaTask[]>;
  createTask(projectCwd: string, prompt: string): Promise<ArenaTask>;
  planTask(taskId: string, planner: AgentChoice): Promise<ArenaTask>;
  editTask(taskId: string, edit: TaskEdit): Promise<ArenaTask>;
  startTask(taskId: string, contestants: AgentChoice[]): Promise<ArenaTask>;
  stopTask(taskId: string): Promise<ArenaTask>;
  taskDiff(taskId: string, contestantId: string, path: string): Promise<{ oldText: string | null; newText: string | null }>;
  mergeTask(taskId: string, contestantId: string, squash: boolean): Promise<ArenaTask>;
  discardTask(taskId: string): Promise<ArenaTask>;
  removeTask(taskId: string): Promise<void>;
  onTaskChanged(listener: (task: ArenaTask) => void): () => void;
  listDir(dir: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<FileContent>;
  writeFile(path: string, text: string): Promise<void>;
  /** Creates an empty file or folder `name` in `dir`; resolves to its path. */
  createEntry(dir: string, name: string, kind: 'file' | 'folder'): Promise<string>;
  /** Renames a file or folder in place; resolves to the new path. */
  renameEntry(path: string, name: string): Promise<string>;
  /** Moves a file or folder of a project to the Trash. */
  trashEntry(path: string): Promise<void>;
  gitStatus(cwd: string): Promise<GitChange[]>;
  botConfigs(): Promise<BotConfig[]>;
  /** Creates (no id) or updates a bot configuration; returns the saved one. */
  saveBotConfig(config: Omit<BotConfig, 'id'> & { id?: string }): Promise<BotConfig>;
  deleteBotConfig(id: string): Promise<void>;
  /** Saves ready-made configurations (names and roles in the app's language) with one agent. */
  addStarterBots(agent: AgentChoice, starters: Record<string, { name: string; role: string }>): Promise<BotConfig[]>;
  /** The organization's settings. */
  orgSettings(): Promise<OrgSettings>;
  saveOrgSettings(settings: Partial<OrgSettings>): Promise<OrgSettings>;
  /** Creates the coordinator (and the starter agents) the first time. */
  ensureOrg(agent: AgentChoice, starters: Record<string, { name: string; role: string }>): Promise<BotConfig[]>;
  botTeams(): Promise<BotTeam[]>;
  startTeam(request: StartTeamRequest): Promise<BotTeam>;
  /** Sends a message to one bot of a team (you, not the coordinator). */
  messageBot(teamId: string, botId: string, text: string): Promise<void>;
  /** Stops a bot and the bots it created; no bot id = the whole team. */
  stopBot(teamId: string, botId?: string): Promise<void>;
  deleteTeam(teamId: string): Promise<void>;
  onBotTeamChanged(listener: (team: BotTeam) => void): () => void;
  /** Commits the chosen files; pushes when `push` (a failed push still leaves the commit). */
  gitCommit(cwd: string, files: string[], message: string, push: boolean): Promise<{ commit: string; pushed: boolean; pushError: string | null }>;
  /** A picture from a conversation, as a data: URL (null when it's gone). */
  transcriptImage(sessionId: string, agentId: string, offset: number, n: number): Promise<string | null>;
  /** Project files and folders matching `query` (relative paths), for @-mentions. */
  searchFiles(cwd: string, query: string): Promise<string[]>;
  /** Custom "/" commands of a CLI, for when no agent is running yet. */
  slashCommands(harnessId: string, cwd: string | null): Promise<SlashCommand[]>;
  gitHead(cwd: string, path: string): Promise<string | null>;
  terminalAvailable(): Promise<{ ok: boolean; error: string | null }>;
  /** Installed shells, the user's login shell first. */
  terminalShells(): Promise<Array<{ path: string; label: string }>>;
  /** Starts a terminal (with `shell` if it's installed, else the login shell). */
  createTerminal(cwd: string, cols: number, rows: number, shell?: string): Promise<{ id: string; shell: string }>;
  /** Which of these paths (as printed in a terminal whose project is `cwd`) are files in your projects; absolute paths or null. */
  terminalLinks(cwd: string, candidates: string[]): Promise<Array<string | null>>;
  writeTerminal(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  killTerminal(id: string): void;
  onTerminalData(listener: (message: { id: string; data: string }) => void): () => void;
  onTerminalExit(listener: (message: { id: string; code: number }) => void): () => void;
  /** Opens a file dialog and returns the parsed VS Code theme JSON, or null if cancelled. */
  /** Opens a file dialog: a theme .json, or a .vsix with one or more themes; null if cancelled. */
  importTheme(): Promise<unknown[] | null>;
  /** Theme extensions on Open VSX (open-vsx.org). */
  searchThemes(query: string): Promise<Array<{ namespace: string; name: string; displayName: string; description: string; version: string; downloads: number; verified: boolean }>>;
  /** Downloads a theme extension from Open VSX and returns its color themes. */
  installTheme(namespace: string, name: string): Promise<unknown[]>;
  /** Tells the main process the first screen is on screen (used by --capture). */
  rendered(): void;
}

export const Channels = {
  info: 'app:info',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  projects: 'index:projects',
  openFolder: 'projects:open-folder',
  chooseFolder: 'projects:choose-folder',
  createProject: 'projects:create',
  marketingLoad: 'marketing:load',
  marketingSave: 'marketing:save',
  marketingDrafts: 'marketing:drafts',
  boardLoad: 'board:load',
  boardSave: 'board:save',
  actionsList: 'actions:list',
  actionsCreate: 'actions:create',
  sessions: 'index:sessions',
  recentSessions: 'index:recent-sessions',
  session: 'index:session',
  agentTree: 'index:agent-tree',
  transcript: 'index:transcript',
  search: 'index:search',
  setFavorite: 'index:favorite',
  renameSession: 'index:rename',
  hideSession: 'index:hide',
  hiddenSessions: 'index:hidden',
  trashSession: 'index:trash',
  revealSession: 'index:reveal',
  indexStatus: 'index:status',
  progress: 'index:progress',
  changed: 'index:changed',
  rendered: 'app:rendered',
  runnerCatalog: 'runner:catalog',
  setProviderCredential: 'providers:set-credential',
  startRun: 'runner:start',
  sendToRun: 'runner:send',
  stopRun: 'runner:stop',
  interruptRun: 'runner:interrupt',
  respondToRun: 'runner:respond',
  answerRun: 'runner:answer',
  configureRun: 'runner:configure',
  runnerEvent: 'runner:event',
  previewUrl: 'preview:url',
  previewBlocked: 'preview:blocked',
  hubInventory: 'hub:inventory',
  hubPlanInstall: 'hub:plan-install',
  hubInstall: 'hub:install',
  hubUnify: 'hub:unify',
  exportSession: 'export:session',
  backupStatus: 'backup:status',
  backupChoose: 'backup:choose',
  backupRun: 'backup:run',
  backupSetAuto: 'backup:auto',
  backupOpen: 'backup:open',
  backupChanged: 'backup:changed',
  planUsage: 'usage:plans',
  showMenu: 'menu:show',
  appCommand: 'app:command',
  revealPath: 'shell:reveal',
  copyText: 'clipboard:copy',
  reviews: 'reviews:list',
  reviewFile: 'reviews:file',
  reviewKeep: 'reviews:keep',
  reviewUndo: 'reviews:undo',
  reviewDismiss: 'reviews:dismiss',
  tasks: 'tasks:list',
  createTask: 'tasks:create',
  planTask: 'tasks:plan',
  editTask: 'tasks:edit',
  startTask: 'tasks:start',
  stopTask: 'tasks:stop',
  taskDiff: 'tasks:diff',
  mergeTask: 'tasks:merge',
  discardTask: 'tasks:discard',
  removeTask: 'tasks:remove',
  taskChanged: 'tasks:changed',
  listDir: 'fs:list',
  readFile: 'fs:read',
  writeFile: 'fs:write',
  gitStatus: 'git:status',
  searchFiles: 'workspace:searchFiles',
  gitCommit: 'git:commit',
  botConfigs: 'bots:configs',
  saveBotConfig: 'bots:saveConfig',
  deleteBotConfig: 'bots:deleteConfig',
  addStarterBots: 'bots:addStarters',
  orgSettings: 'bots:org',
  saveOrgSettings: 'bots:saveOrg',
  ensureOrg: 'bots:ensureOrg',
  botTeams: 'bots:teams',
  startTeam: 'bots:startTeam',
  messageBot: 'bots:message',
  stopBot: 'bots:stop',
  deleteTeam: 'bots:deleteTeam',
  renameTeam: 'bots:renameTeam',
  answerPlan: 'bots:answerPlan',
  botChanges: 'bots:changes',
  botDiff: 'bots:diff',
  applyBotWork: 'bots:apply',
  botTeamChanged: 'bots:teamChanged',
  transcriptImage: 'index:image',
  slashCommands: 'runner:slashCommands',
  gitHead: 'git:head',
  terminalAvailable: 'term:available',
  createTerminal: 'term:create',
  createEntry: 'fs:create',
  renameEntry: 'fs:rename',
  trashEntry: 'fs:trash',
  terminalShells: 'term:shells',
  terminalLinks: 'term:links',
  writeTerminal: 'term:write',
  resizeTerminal: 'term:resize',
  killTerminal: 'term:kill',
  terminalData: 'term:data',
  terminalExit: 'term:exit',
  importTheme: 'theme:import',
  searchThemes: 'theme:search',
  installTheme: 'theme:install',
} as const;
