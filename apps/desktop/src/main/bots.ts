import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { commitAll, createWorktree, git, headCommit, listChanges, repoRoot } from '@alchemist-coder/arena';
import type { SessionMcpServer } from '@alchemist-coder/core';
import type { AgentChoice, BotConfig, BotMember, BotStatus, BotTeam, OrgSettings, PermissionMode, PlannedBot, RunnerEventMessage, StartTeamRequest, TeamEventKind, TeamOrigin, TeamPlan } from '../shared/api';
import type { RunnerManager } from './runner';

/** Coordinator (0), the bots it creates (1), and theirs (2). */
export const MAX_DEPTH = 2;
export const MAX_BOTS = 10;
const MAX_TEAMS = 40;
const REPLY_CHARS = 12_000;
const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const ENDED: BotStatus[] = ['done', 'error', 'stopped'];
const ACTIVE_STATUSES: BotStatus[] = ['starting', 'working', 'waiting'];
export const SERVER_NAME = 'alchemist_bots';

interface Caller {
  teamId: string;
  botId: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: Record<string, ToolDef> = {
  list_bot_configs: {
    name: 'list_bot_configs',
    description: 'The saved bot configurations you can create bots from: name, role, agent and model, and whether they may create bots themselves.',
    inputSchema: { type: 'object', properties: {} },
  },
  create_bot: {
    name: 'create_bot',
    description:
      'Create a bot that starts working on `task` right away, in the same project folder. Use `config` (a configuration name from list_bot_configs), or define it directly: `role` and `model` are optional. Returns its id; then call wait_for_bot to get its answer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short name, e.g. "Tester".' },
        task: { type: 'string', description: 'What it should do, with everything it needs to know.' },
        config: { type: 'string', description: 'A saved configuration to use (name or id).' },
        role: { type: 'string', description: 'Its role and standing instructions, when not using a configuration.' },
        model: { type: 'string', description: 'A model id of your own provider, when not using a configuration.' },
        can_create_bots: { type: 'boolean', description: 'Let it create bots itself (only if you may, and within the depth limit).' },
        own_worktree: { type: 'boolean', description: 'Give it its own copy of the project (a git worktree) so it cannot clash with other bots. Then use bot_changes and apply_bot_work.' },
      },
      required: ['name', 'task'],
    },
  },
  message_bot: {
    name: 'message_bot',
    description: 'Send a follow-up message to one of your bots (it answers after its current turn). Then call wait_for_bot.',
    inputSchema: { type: 'object', properties: { bot_id: { type: 'string' }, text: { type: 'string' } }, required: ['bot_id', 'text'] },
  },
  wait_for_bot: {
    name: 'wait_for_bot',
    description: 'Wait until one of your bots finishes its current turn and return its answer. If it is still working when the time is up, it says so: call it again.',
    inputSchema: { type: 'object', properties: { bot_id: { type: 'string' }, timeout_seconds: { type: 'number', description: 'Default 120, at most 600.' } }, required: ['bot_id'] },
  },
  list_bots: {
    name: 'list_bots',
    description: "The team's bots: id, name, who created it, status and the start of its latest answer.",
    inputSchema: { type: 'object', properties: {} },
  },
  bot_changes: {
    name: 'bot_changes',
    description: 'What one of your bots with its own copy (own_worktree) changed there: files with lines added and removed.',
    inputSchema: { type: 'object', properties: { bot_id: { type: 'string' } }, required: ['bot_id'] },
  },
  apply_bot_work: {
    name: 'apply_bot_work',
    description: "Bring the changes one of your bots made in its own copy into the project folder (as uncommitted edits). Fails without touching anything if they clash with the folder's current state.",
    inputSchema: { type: 'object', properties: { bot_id: { type: 'string' } }, required: ['bot_id'] },
  },
  propose_plan: {
    name: 'propose_plan',
    description:
      "Only when the team reviews plans first: send the user your plan (the bots you'll create and their tasks) and then call wait_for_plan. You can't create bots until the user approves it.",
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'How you will reach the goal, in two or three sentences.' },
        bots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              task: { type: 'string' },
              config: { type: 'string', description: 'A saved configuration name, if you will use one.' },
              role: { type: 'string' },
              own_worktree: { type: 'boolean' },
            },
            required: ['name', 'task'],
          },
        },
        estimate_usd: { type: 'number', description: 'Your rough guess of what the whole team will cost, if you can tell.' },
      },
      required: ['summary', 'bots'],
    },
  },
  wait_for_plan: {
    name: 'wait_for_plan',
    description: 'Wait for the user to approve (maybe with edits) or reject your plan. If they are still deciding when the time is up, it says so: call it again.',
    inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'number', description: 'Default 120, at most 600.' } } },
  },
  finish_team: {
    name: 'finish_team',
    description:
      "Coordinator only: tell the user the goal is done. `summary`: what was done and by whom, what is left in bots' own copies, and anything still open. If you need the user's input instead, ask in your reply and don't call this.",
    inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
  stop_bot: {
    name: 'stop_bot',
    description: 'Stop one of your bots (and the bots it created).',
    inputSchema: { type: 'object', properties: { bot_id: { type: 'string' } }, required: ['bot_id'] },
  },
};

/** What the coordinator is told about your answer to its plan. */
function planAnswer(plan: TeamPlan): string {
  if (plan.status === 'pending') return 'The user is still reviewing the plan. Call wait_for_plan again.';
  if (plan.status === 'changes') return `The user wants changes to the plan: ${plan.feedback || '(no details)'}\nPropose a new plan with propose_plan, then call wait_for_plan.`;
  const list = plan.bots.map((x, i) => `${i + 1}. ${x.name}${x.config ? ` (config ${x.config})` : ''}${x.ownWorktree ? ' [own_worktree]' : ''}: ${x.task}${x.role && !x.config ? `\n   role: ${x.role}` : ''}`).join('\n');
  return `The user approved the plan${plan.feedback ? ` and adds: ${plan.feedback}` : ''}. Create exactly these bots with create_bot (same names and tasks):\n${list}`;
}

/** A team's name from its goal: the first sentence or line, at most 60 characters. */
export function teamTitle(goal: string): string {
  const first = goal.trim().split(/\n|(?<=[.!?])\s/)[0]!.trim();
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);
const str = (v: unknown, max = 20_000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** What the organization's coordinator knows about it: its rules, its agents here, and this assignment's guidance. */
interface OrgContext {
  name: string;
  instructions: string;
  roster: string;
  guidance: string;
}

function coordinatorPrompt(goal: string, role: string, cwd: string, approvePlan = false, org?: OrgContext): string {
  return [
    org ? `You are the coordinator of the organization "${org.name}" in Alchemist Coder. The user gives you assignments; you plan them and give the work to the organization's agents.` : 'You are the coordinator bot of a team in Alchemist Coder.',
    role ? `Your role: ${role}` : null,
    org?.instructions ? `Organization instructions (for you and every agent):\n${org.instructions}` : null,
    org ? `The assignment: ${goal}` : `The goal: ${goal}`,
    org?.guidance ? `For this assignment: ${org.guidance}` : null,
    org
      ? org.roster
        ? `The organization's agents for this project (use them with create_bot and config = the agent's name; prefer them, and define a new agent with role only when none fits):\n${org.roster}${/leads a team/.test(org.roster) ? "\nAn agent that leads a team hands work to its team itself: give the lead the whole piece of work that fits its team, instead of creating its members yourself." : ''}`
        : "The organization has no agents for this project yet: define them in create_bot with role. They join the organization as proposed agents the user can keep."
      : null,
    '',
    `You can create other bots with the tools of the "${SERVER_NAME}" MCP server: list_bot_configs, create_bot, message_bot, wait_for_bot, list_bots, bot_changes, apply_bot_work, stop_bot and finish_team.`,
    'Split the work into clear tasks, give each bot everything it needs in its task, wait for their answers, check them, and ask for fixes when needed.',
    `Bots work in the project folder (${cwd}) unless you give them their own copy with own_worktree: then check their result with bot_changes and bring it in with apply_bot_work. Give bots in the shared folder separate files or steps so they don't overwrite each other.`,
    `At most ${MAX_BOTS} bots per team. When the goal is done, call finish_team with a short summary of what was done and by whom (and anything left open), then end your turn. If you need the user's input instead, ask in your reply and don't call finish_team.`,
    'Write your plan, the tasks you give bots and your summary in the same language as the goal.',
    approvePlan
      ? 'IMPORTANT: the user reviews your plan first. Before creating any bot, call propose_plan with the bots you intend to create (name, task, and config or role), then call wait_for_plan until they answer. Create exactly the approved bots, with the approved names and tasks. If they ask for changes, propose a new plan.'
      : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function workerPrompt(bot: BotMember, parentName: string, orgInstructions = '', team: BotConfig[] = []): string {
  return [
    `You are "${bot.name}", a bot in a team coordinated by "${parentName}" in Alchemist Coder.`,
    bot.role && `Your role: ${bot.role}`,
    orgInstructions && `Organization instructions:\n${orgInstructions}`,
    `Your task: ${bot.task}`,
    team.length && bot.canSpawn
      ? `You lead a team. Hand parts of your task to its members with create_bot (config: their name) from the "${SERVER_NAME}" MCP tools, wait for them, check their work, and answer with the combined result:\n${team.map((m) => `- ${m.name}: ${m.role.slice(0, 200) || 'no role set'}`).join('\n')}`
      : bot.canSpawn
        ? `If it helps, you can create helper bots with the "${SERVER_NAME}" MCP tools.`
        : '',
    bot.worktree ? `You work in your own copy of the project (${bot.worktree.path}). Your changes reach the main folder only when "${parentName}" applies them, so finish them completely there.` : '',
    'When you finish, reply with what you did and anything the coordinator needs to know (files changed, open problems).',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Copies the project's uncommitted edits and new files into a copy of it; returns how many. */
async function copyUncommitted(root: string, dest: string): Promise<number> {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  let n = 0;
  for (let i = 0; i < parts.length && n < 3000; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    // A rename or copy is followed by the path it came from.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
    const file = entry.slice(3);
    const from = join(root, file);
    const to = join(dest, file);
    if (existsSync(from)) {
      if (!statSync(from).isFile()) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    } else rmSync(to, { force: true });
    n++;
  }
  return n;
}

/** One organization agent doing a task by itself (an automation's step): no team, no bots to create. */
function soloPrompt(config: BotConfig, task: string, orgName: string, orgInstructions: string, worktree: string | null, readOnly: boolean): string {
  return [
    `You are "${config.name}", an agent of the organization "${orgName}" in Alchemist Coder. An automation gave you this task; nobody is watching live, so work on it until it's done.`,
    config.role && `Your role: ${config.role}`,
    orgInstructions && `Organization instructions:\n${orgInstructions}`,
    `Your task: ${task}`,
    readOnly ? "Don't change any file: read, think and answer." : '',
    worktree ? `You work in your own copy of the project (${worktree}); the user decides whether your changes reach the main folder, so finish them completely there.` : '',
    'End your turn with a short summary of what you did and anything left open, in the language of the task.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Bot teams: a coordinator works on a goal and creates bots (from saved configurations or defined
 * on the spot) through the app's own MCP tools; bots allowed to can create their own. Each bot is
 * an ordinary agent run. Runs don't survive a restart; teams and configurations do.
 */
/** A picture you chose (a small image, already resized by the app) or one of the app's own; anything else is dropped. */
export function avatarOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (/^emoji:\S{1,16}$/u.test(v)) return v;
  if (v.length <= 400_000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)) return v;
  return null;
}

export class BotManager {
  private configs: BotConfig[] = [];
  private teams: BotTeam[] = [];
  private org: OrgSettings = { name: 'My organization', instructions: '' };
  private readonly tokens = new Map<string, Caller>();
  private readonly runs = new Map<string, Caller>();
  private readonly turnText = new Map<string, string>();
  /** Where the turn's text was when the bot last used a tool: what follows is its final message. */
  private readonly turnMark = new Map<string, number>();
  /** The name each tool call started with, by run and call: its updates come without it. */
  private readonly toolNames = new Map<string, string>();
  private readonly waiters = new Map<string, Array<() => void>>();
  /** Others in the app that follow assignments (the automations). */
  private readonly watchers = new Set<(team: BotTeam) => void>();
  private server: Server | null = null;
  private port = 0;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly files: { configs: string; teams: string; org?: string },
    private readonly runner: RunnerManager,
    private readonly bridge: { command: string; script: string },
    private readonly resolveProject: (cwd: unknown) => string,
    private readonly emit: (team: BotTeam) => void,
  ) {
    this.configs = this.read<BotConfig[]>(files.configs) ?? [];
    try {
      const o = JSON.parse(readFileSync(this.orgFile, 'utf8')) as Partial<OrgSettings>;
      this.org = { name: str(o.name, 80) || this.org.name, instructions: str(o.instructions) };
    } catch {
      // first run: the default name, no instructions
    }
    // Runs end with the app: bots still going when it quit are stopped.
    this.teams = (this.read<BotTeam[]>(files.teams) ?? []).map((t) => {
      const cut = t.bots.some((b) => ACTIVE_STATUSES.includes(b.status));
      return {
        ...t,
        title: t.title || teamTitle(t.goal),
        stoppedReason: t.stoppedReason ?? (cut ? 'appClosed' : null),
        bots: t.bots.map((b) => (ENDED.includes(b.status) || b.status === 'idle' ? { ...b, runId: null } : { ...b, status: 'stopped' as const, runId: null, doing: null })),
      };
    });
    runner.observe((m) => this.onRunEvent(m));
  }

  /** A turn ended: its calls' names aren't needed any more. */
  private forgetTools(runId: string) {
    for (const key of this.toolNames.keys()) if (key.startsWith(`${runId}:`)) this.toolNames.delete(key);
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
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1));
    renameSync(`${file}.tmp`, file);
  }

  private saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      this.write(this.files.teams, this.teams.slice(0, MAX_TEAMS));
    } catch {
      // kept in memory; saved next time
    }
  }

  /** The local endpoint the bridges call (random port, loopback only). */
  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => void this.onRequest(req, res));
    this.server.requestTimeout = 0;
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  stopAll() {
    for (const t of this.teams) for (const b of t.bots) if (b.runId) this.runner.stop(b.runId);
    this.server?.close();
  }

  // ---------- configurations ----------

  listConfigs(): BotConfig[] {
    return structuredClone(this.configs);
  }

  private get orgFile() {
    return this.files.org ?? `${this.files.configs}.org.json`;
  }

  orgSettings(): OrgSettings {
    return { ...this.org };
  }

  saveOrgSettings(input: unknown): OrgSettings {
    const o = (input ?? {}) as Partial<OrgSettings>;
    if (typeof o.name === 'string') this.org.name = str(o.name, 80) || this.org.name;
    if (typeof o.instructions === 'string') this.org.instructions = str(o.instructions);
    this.write(this.orgFile, this.org);
    return this.orgSettings();
  }

  /** The organization's coordinator, if it has one. */
  private coordinator(): BotConfig | undefined {
    return this.configs.find((c) => c.kind === 'coordinator');
  }

  /** The first time: a coordinator with the given agent, and the starter agents. */
  ensureOrg(agentInput: unknown, starters: Record<string, { name: string; role: string }>): BotConfig[] {
    const agent = agentInput as AgentChoice | undefined;
    if (!agent?.harnessId || !agent.providerId || !agent.model) throw new Error('Choose an agent and a model');
    if (!this.coordinator()) {
      const lead = starters.coordinator ?? { name: 'Coordinator', role: '' };
      this.saveConfig({ name: lead.name || 'Coordinator', role: lead.role, agent, permissionMode: 'acceptEdits', canSpawn: true, kind: 'coordinator' });
    }
    const { coordinator: _lead, ...rest } = starters;
    return this.addStarters(agent, rest);
  }

  /** Whether an agent works in the project at `cwd` (no projects = all of them). */
  private inProject(c: BotConfig, cwd: string) {
    const here = cwd.replace(/\/+$/, '');
    return !c.projects?.length || c.projects.some((p) => here === p || here.startsWith(`${p}/`) || p.startsWith(`${here}/`));
  }

  saveConfig(input: unknown): BotConfig {
    const c = (input ?? {}) as Partial<BotConfig>;
    const name = str(c.name, 60);
    if (!name) throw new Error('Give the bot a name');
    const agent = c.agent as AgentChoice | undefined;
    if (!agent?.harnessId || !agent.providerId || !agent.model) throw new Error('Choose an agent and a model');
    const config: BotConfig = {
      id: typeof c.id === 'string' && this.configs.some((x) => x.id === c.id) ? c.id : `cfg-${randomBytes(4).toString('hex')}`,
      name,
      role: str(c.role, 8000),
      agent: { harnessId: String(agent.harnessId), providerId: String(agent.providerId), model: String(agent.model) },
      permissionMode: PERMISSION_MODES.includes(c.permissionMode as PermissionMode) ? (c.permissionMode as PermissionMode) : 'acceptEdits',
      canSpawn: c.canSpawn === true,
      ownWorktree: c.ownWorktree === true,
      kind: c.kind === 'coordinator' ? 'coordinator' : 'member',
      projects: Array.isArray(c.projects) ? c.projects.filter((p): p is string => typeof p === 'string' && p.startsWith('/')).slice(0, 50).map((p) => p.replace(/\/+$/, '').slice(0, 1000)) : [],
      proposed: c.proposed === true,
      avatar: avatarOf(c.avatar),
    };
    // A team is one level deep, like the teams themselves: a top-level agent leads, its team reports to it.
    const lead = typeof c.leadId === 'string' ? this.configs.find((x) => x.id === c.leadId) : undefined;
    if (lead && config.kind !== 'coordinator') {
      if (lead.id === config.id) throw new Error("An agent can't be on its own team.");
      if (lead.kind === 'coordinator') config.leadId = null;
      else if (lead.leadId) throw new Error(`${lead.name} is on ${this.configs.find((x) => x.id === lead.leadId)?.name ?? 'another'}'s team: only top-level agents lead a team.`);
      else if (this.configs.some((x) => x.leadId === config.id)) throw new Error(`${config.name} leads a team, so it can't join another one.`);
      else config.leadId = lead.id;
    }
    // One coordinator: it can always create agents, and naming another one hands the role over.
    if (config.kind === 'coordinator') {
      config.canSpawn = true;
      config.proposed = false;
      for (const x of this.configs) if (x.kind === 'coordinator' && x.id !== config.id) x.kind = 'member';
    }
    const i = this.configs.findIndex((x) => x.id === config.id);
    if (i >= 0) this.configs[i] = config;
    else this.configs.push(config);
    this.write(this.files.configs, this.configs);
    return structuredClone(config);
  }

  /** Adds the starter configurations (with the given agent) that aren't saved yet. */
  addStarters(agentInput: unknown, names: Record<string, { name: string; role: string }>): BotConfig[] {
    const agent = agentInput as AgentChoice | undefined;
    if (!agent?.harnessId || !agent.providerId || !agent.model) throw new Error('Choose an agent and a model');
    for (const [key, s] of Object.entries(names).slice(0, 10)) {
      if (this.configs.some((c) => c.name.toLowerCase() === s.name.toLowerCase())) continue;
      this.saveConfig({ name: s.name, role: s.role, agent, permissionMode: ['planner', 'reviewer', 'researcher', 'uijudge'].includes(key) ? 'default' : 'acceptEdits', canSpawn: key === 'planner' });
    }
    return this.listConfigs();
  }

  deleteConfig(id: string) {
    if (this.configs.find((c) => c.id === id)?.kind === 'coordinator') throw new Error("The coordinator can't be removed: change its agent or instructions instead.");
    this.configs = this.configs.filter((c) => c.id !== id);
    // Its team stays in the organization, reporting to the coordinator.
    for (const c of this.configs) if (c.leadId === id) c.leadId = null;
    this.write(this.files.configs, this.configs);
  }

  /** The agents on a lead's team. */
  private teamOf(leadId: string | null | undefined): BotConfig[] {
    return leadId ? this.configs.filter((c) => c.leadId === leadId && !c.proposed) : [];
  }

  private findConfig(ref: string): BotConfig | undefined {
    const r = ref.trim().toLowerCase();
    return this.configs.find((c) => c.id === ref) ?? this.configs.find((c) => c.name.toLowerCase() === r);
  }

  // ---------- teams ----------

  listTeams(): BotTeam[] {
    return structuredClone(this.teams);
  }

  startTeam(input: unknown): BotTeam {
    const r = (input ?? {}) as Partial<StartTeamRequest>;
    const goal = str(r.goal);
    if (!goal) throw new Error('Write the goal first');
    const cwd = this.resolveProject(r.cwd);
    const base = typeof r.configId === 'string' ? this.configs.find((c) => c.id === r.configId) : undefined;
    const inline = r.coordinator;
    if (!base && !inline) throw new Error('Choose or define the coordinator');
    const agent = base?.agent ?? inline!.agent;
    if (!agent?.harnessId || !agent.providerId || !agent.model) throw new Error('Choose an agent and a model for the coordinator');
    const now = Date.now();
    const budget = Number(r.budgetUsd);
    const team: BotTeam = { id: `team-${randomBytes(4).toString('hex')}`, title: teamTitle(goal), goal, cwd, createdAt: now, updatedAt: now, bots: [], budgetUsd: Number.isFinite(budget) && budget > 0 ? Math.min(budget, 10_000) : null };
    const coordinator: BotMember = {
      id: 'b1',
      name: base?.name ?? (str(inline?.name, 60) || 'Coordinator'),
      configId: base?.id ?? null,
      role: base?.role ?? str(inline?.role, 8000),
      agent: { harnessId: agent.harnessId, providerId: agent.providerId, model: agent.model },
      permissionMode: base?.permissionMode ?? (PERMISSION_MODES.includes(inline?.permissionMode as PermissionMode) ? (inline!.permissionMode as PermissionMode) : 'acceptEdits'),
      canSpawn: true,
      parentId: null,
      depth: 0,
      runId: null,
      status: 'starting',
      task: goal,
      lastReply: '',
      costUsd: null,
      createdAt: now,
    };
    team.bots.push(coordinator);
    this.teams.unshift(team);
    team.approvePlan = r.approvePlan === true;
    const org: OrgContext | undefined =
      base?.kind === 'coordinator'
        ? {
            name: this.org.name,
            instructions: this.org.instructions,
            roster: this.configs
              .filter((c) => c.kind !== 'coordinator' && !c.proposed && this.inProject(c, cwd))
              .map((c) => {
                const members = this.teamOf(c.id).map((m) => m.name);
                const lead = c.leadId ? this.configs.find((x) => x.id === c.leadId)?.name : undefined;
                return `- ${c.name}: ${c.role.replace(/\s+/g, ' ').slice(0, 200) || 'no role set'} (${c.agent.model}, permissions ${c.permissionMode}${c.ownWorktree ? ', own copy' : ''}${members.length ? `; leads a team: ${members.join(', ')}` : ''}${lead ? `; on ${lead}'s team` : ''})`;
              })
              .join('\n'),
            guidance: str(r.guidance, 4000),
          }
        : undefined;
    this.launch(team, coordinator, coordinatorPrompt(goal, coordinator.role, cwd, team.approvePlan, org));
    this.changed(team);
    return structuredClone(team);
  }

  /** You approving the coordinator's plan (maybe edited), or asking for changes. */
  answerPlan(teamId: string, input: unknown) {
    const team = this.teams.find((t) => t.id === teamId);
    if (!team?.plan || team.plan.status !== 'pending') throw new Error('No plan is waiting for you');
    const a = (input ?? {}) as { approve?: unknown; bots?: unknown; feedback?: unknown };
    const feedback = str(a.feedback, 4000);
    if (a.approve === true) {
      const edited = Array.isArray(a.bots)
        ? (a.bots as Array<Partial<PlannedBot>>).slice(0, MAX_BOTS - 1).map((x) => ({ name: str(x?.name, 60), task: str(x?.task, 8000), config: str(x?.config, 100), role: str(x?.role, 4000), ownWorktree: x?.ownWorktree === true })).filter((x) => x.name && x.task)
        : team.plan.bots;
      if (!edited.length) throw new Error('Keep at least one bot, or ask for changes instead');
      team.plan = { ...team.plan, bots: edited, status: 'approved', feedback };
      this.log(team, 'you', 'approved', String(edited.length));
    } else {
      if (!feedback) throw new Error('Say what should change');
      team.plan = { ...team.plan, status: 'changes', feedback };
      this.log(team, 'you', 'changes', feedback);
    }
    const lead = team.bots[0]!;
    // A coordinator no longer inside wait_for_plan (its turn ended, it was stopped, or the app
    // restarted) hears the answer as a message, in the same conversation.
    if (ACTIVE_STATUSES.includes(lead.status)) this.wake(`plan:${team.id}`);
    else {
      if (team.stoppedReason === 'appClosed') team.stoppedReason = null;
      this.sendTo(team, lead, planAnswer(team.plan));
    }
    this.changed(team);
  }

  rename(teamId: string, title: string) {
    const team = this.teams.find((t) => t.id === teamId);
    if (!team) return;
    team.title = title.trim().slice(0, 80) || teamTitle(team.goal);
    this.changed(team);
  }

  deleteTeam(teamId: string) {
    const team = this.teams.find((t) => t.id === teamId);
    if (!team) return;
    this.stop(teamId);
    // Their copies go; their branches stay, so work that was never applied can still be recovered with git.
    for (const b of team.bots) {
      const wt = b.worktree;
      if (!wt) continue;
      void (async () => {
        if (existsSync(wt.path)) await git(wt.root, ['worktree', 'remove', '--force', wt.path]).catch(() => '');
        await git(wt.root, ['worktree', 'prune']).catch(() => '');
      })();
    }
    this.teams = this.teams.filter((t) => t.id !== teamId);
    this.saveSoon();
  }

  /** You messaging a bot directly (from the app). */
  message(teamId: string, botId: string, text: string) {
    const { team, bot } = this.member(teamId, botId);
    const t = str(text);
    if (!t) return;
    this.log(team, 'you', 'message', `${bot.id}|${t}`);
    // Talking to the coordinator again reopens a finished team; continuing picks up after a restart.
    if (bot.depth === 0) team.finished = null;
    if (team.stoppedReason === 'appClosed') team.stoppedReason = null;
    this.sendTo(team, bot, t);
  }

  /** Stops a bot and everything it created; no bot = the whole team. */
  stop(teamId: string, botId?: string) {
    const team = this.teams.find((t) => t.id === teamId);
    if (!team) return;
    const ids = botId ? this.subtree(team, botId) : team.bots.map((b) => b.id);
    // A coordinator waiting for your plan answer stops waiting too.
    if (!botId || botId === team.bots[0]?.id) this.wake(`plan:${team.id}`);
    for (const b of team.bots) {
      if (!ids.includes(b.id) || ENDED.includes(b.status)) continue;
      if (b.runId) this.runner.stop(b.runId);
      b.status = 'stopped';
      b.doing = null;
      this.log(team, b.id, 'stopped');
      this.wake(b.runId);
    }
    this.changed(team);
  }

  private member(teamId: string, botId: string) {
    const team = this.teams.find((t) => t.id === teamId);
    const bot = team?.bots.find((b) => b.id === botId);
    if (!team || !bot) throw new Error('No such bot');
    return { team, bot };
  }

  private subtree(team: BotTeam, botId: string): string[] {
    const out = [botId];
    for (let i = 0; i < out.length; i++) for (const b of team.bots) if (b.parentId === out[i]) out.push(b.id);
    return out;
  }

  /** Adds a line to the team's activity (the oldest go past 200). */
  private log(team: BotTeam, botId: string, kind: TeamEventKind, detail = '') {
    const list = team.activity ?? (team.activity = []);
    list.push({ at: Date.now(), botId, kind, detail: detail.slice(0, 300) });
    if (list.length > 200) list.splice(0, list.length - 200);
  }

  private changed(team: BotTeam) {
    team.updatedAt = Date.now();
    this.saveSoon();
    this.emit(structuredClone(team));
    for (const fn of this.watchers) fn(structuredClone(team));
  }

  /** Follows every change to every assignment; returns the way to stop. */
  watch(fn: (team: BotTeam) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /** The assignment and bot a run belongs to, if it's a bot's. */
  botOfRun(runId: string): { team: BotTeam; botId: string } | null {
    const caller = this.runs.get(runId);
    const team = caller && this.teams.find((t) => t.id === caller.teamId);
    return team ? { team: structuredClone(team), botId: caller.botId } : null;
  }

  team(teamId: string): BotTeam | undefined {
    const team = this.teams.find((t) => t.id === teamId);
    return team ? structuredClone(team) : undefined;
  }

  /**
   * An automation's step: one organization agent works alone on a task, as an assignment of its own
   * (so it shows, asks and stops like any other), in its own copy of the project when asked and the
   * project uses git.
   */
  async startSolo(input: { configId: string; cwd: string; task: string; title?: string; ownWorktree?: boolean; readOnly?: boolean; permissionMode?: PermissionMode; noCopyPermission?: PermissionMode; origin?: TeamOrigin | null }): Promise<BotTeam> {
    const config = this.configs.find((c) => c.id === input.configId);
    if (!config) throw new Error('That agent is no longer in the organization');
    const task = str(input.task);
    if (!task) throw new Error('The step has no task');
    const cwd = this.resolveProject(input.cwd);
    const now = Date.now();
    const team: BotTeam = { id: `team-${randomBytes(4).toString('hex')}`, title: str(input.title, 120) || teamTitle(task), goal: task, cwd, createdAt: now, updatedAt: now, bots: [], budgetUsd: null, origin: input.origin ?? null };
    const bot: BotMember = {
      id: 'b1',
      name: config.name,
      configId: config.id,
      role: config.role,
      agent: { ...config.agent },
      permissionMode: input.permissionMode ?? config.permissionMode,
      canSpawn: false,
      parentId: null,
      depth: 0,
      runId: null,
      status: 'starting',
      task,
      lastReply: '',
      costUsd: null,
      createdAt: now,
    };
    team.bots.push(bot);
    this.teams.unshift(team);
    // Not a git project: it works in the folder itself, asking first when told to.
    const workIn = input.ownWorktree && !input.readOnly ? await this.makeWorktree(team, bot).catch(() => cwd) : cwd;
    if (input.ownWorktree && !bot.worktree && input.noCopyPermission) bot.permissionMode = input.noCopyPermission;
    this.launch(team, bot, soloPrompt(config, task, this.org.name, this.org.instructions, bot.worktree?.path ?? null, input.readOnly === true), workIn);
    this.changed(team);
    return structuredClone(team);
  }

  /** What a bot changed in its own copy since it was last applied. */
  private async workChanges(bot: BotMember) {
    if (!bot.worktree) return [];
    if (!existsSync(bot.worktree.path)) throw new Error(`${bot.name}'s copy is gone (its branch ${bot.worktree.branch} may still have the work)`);
    return listChanges(bot.worktree.path, bot.worktree.base);
  }

  /**
   * Brings a bot's work from its own copy into the project folder as uncommitted edits, all or
   * nothing; what was applied becomes the copy's new starting point.
   */
  private async applyWork(team: BotTeam, target: BotMember, byName: string, byId: string): Promise<string> {
    const wt = target.worktree;
    if (!wt) return `${target.name} works in the shared folder: nothing to apply.`;
    if (ACTIVE_STATUSES.includes(target.status)) throw new Error(`${target.name} is still working. Wait for it first.`);
    await git(wt.path, ['add', '-A']);
    const patch = await git(wt.path, ['diff', '--cached', '--binary', wt.base]);
    if (!patch.trim()) return `${target.name} has no new changes to apply.`;
    try {
      await git(wt.root, ['apply', '--whitespace=nowarn', '-'], { input: patch });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`Nothing was applied: ${target.name}'s changes clash with the folder as it is now (${why}). Ask it to redo them on top of the current files, or apply them by hand.`);
    }
    const commit = await commitAll(wt.path, `Applied by ${byName}`);
    if (commit) wt.base = commit;
    const files = patch.match(/^diff --git /gm)?.length ?? 0;
    this.log(team, byId, 'applied', `${target.id}|${files}`);
    this.changed(team);
    return `Applied ${target.name}'s changes (${files} file${files === 1 ? '' : 's'}) to the project folder as uncommitted edits.`;
  }

  /** You, from the results card: a bot's pending work in its copy, and applying it. */
  async changesOf(teamId: string, botId: string) {
    const { bot } = this.member(teamId, botId);
    return this.workChanges(bot);
  }

  /** The patch a bot's copy would apply (text files; binaries are named only), for you to read first. */
  async diffOf(teamId: string, botId: string): Promise<string> {
    const { bot } = this.member(teamId, botId);
    const wt = bot.worktree;
    if (!wt) return '';
    if (!existsSync(wt.path)) throw new Error(`${bot.name}'s copy is gone (its branch ${wt.branch} may still have the work)`);
    await git(wt.path, ['add', '-A']);
    const patch = await git(wt.path, ['diff', '--cached', '--no-color', '--no-ext-diff', wt.base]);
    return patch.length > 400_000 ? `${patch.slice(0, 400_000)}\n…` : patch;
  }

  async apply(teamId: string, botId: string): Promise<string> {
    const { team, bot } = this.member(teamId, botId);
    return this.applyWork(team, bot, 'you', 'you');
  }

  /** A copy of the project for one bot: a branch and worktree at the current commit. */
  private async makeWorktree(team: BotTeam, bot: BotMember): Promise<string> {
    const root = await repoRoot(team.cwd);
    if (!root) throw new Error("The project isn't a git repository, so bots can't get their own copy.");
    const base = await headCommit(root);
    const wt = await createWorktree(root, `bots-${team.id}`, bot.id, base);
    // It starts from the project as it is now, uncommitted edits included (work other agents already
    // brought in is there); only what it does from here on counts as its changes.
    const copied = await copyUncommitted(root, wt.path).catch(() => 0);
    const start = copied ? ((await commitAll(wt.path, 'The project as it was when this agent started').catch(() => null)) ?? base) : base;
    bot.worktree = { path: wt.path, branch: wt.branch, base: start, root };
    // The same subfolder inside the copy as the team works in.
    return join(wt.path, relative(root, team.cwd));
  }

  /** Starts a bot's run, with the bot tools when it may create bots. */
  private launch(team: BotTeam, bot: BotMember, prompt: string, cwd = team.cwd, resumeSessionId?: string) {
    const mcpServers: SessionMcpServer[] = [];
    if (bot.canSpawn && bot.depth < MAX_DEPTH && this.port) {
      const token = randomBytes(24).toString('hex');
      this.tokens.set(token, { teamId: team.id, botId: bot.id });
      mcpServers.push({
        name: SERVER_NAME,
        command: this.bridge.command,
        args: [this.bridge.script],
        env: { ELECTRON_RUN_AS_NODE: '1', AC_BOTS_URL: `http://127.0.0.1:${this.port}`, AC_BOTS_TOKEN: token },
        trusted: true,
      });
    }
    try {
      const { runId } = this.runner.start({ cwd, harnessId: bot.agent.harnessId, providerId: bot.agent.providerId, model: bot.agent.model, prompt, permissionMode: bot.permissionMode, resumeSessionId }, { mcpServers });
      bot.runId = runId;
      bot.status = 'working';
      bot.error = null;
      this.runs.set(runId, { teamId: team.id, botId: bot.id });
      this.turnText.set(runId, '');
      this.turnMark.delete(runId);
    } catch (error) {
      bot.status = 'error';
      bot.lastReply = error instanceof Error ? error.message : String(error);
      bot.error = clip(bot.lastReply, 600);
    }
  }

  private sendTo(team: BotTeam, bot: BotMember, text: string) {
    const live = !!bot.runId && !ENDED.includes(bot.status) && this.runs.has(bot.runId);
    if (!live) {
      // Finished (or from before a restart): the same conversation picks up where it left off.
      if (!bot.sessionId) throw new Error(`${bot.name} has ended and can't be continued; create a new bot instead.`);
      const cwd = bot.worktree && existsSync(bot.worktree.path) ? join(bot.worktree.path, relative(bot.worktree.root, team.cwd)) : team.cwd;
      bot.status = 'starting';
      this.launch(team, bot, text, cwd, bot.sessionId);
      this.changed(team);
      if ((bot.status as BotStatus) === 'error') throw new Error(`${bot.name} couldn't continue: ${bot.lastReply}`);
      return;
    }
    this.turnText.set(bot.runId!, '');
    this.turnMark.delete(bot.runId!);
    bot.status = 'working';
    bot.error = null;
    this.runner.send(bot.runId!, text);
    this.changed(team);
  }

  /**
   * A turn's answer: the message after its last tool call when that says enough (the narration
   * before tools isn't part of it), else everything it wrote.
   */
  private finalText(runId: string): string {
    const all = this.turnText.get(runId) ?? '';
    const last = all.slice(this.turnMark.get(runId) ?? 0).trim();
    return last.length >= 60 ? last : all.trim();
  }

  private wake(runId: string | null) {
    if (!runId) return;
    for (const w of this.waiters.get(runId) ?? []) w();
    this.waiters.delete(runId);
  }

  private onRunEvent({ runId, event }: RunnerEventMessage) {
    const who = this.runs.get(runId);
    if (!who) return;
    const team = this.teams.find((t) => t.id === who.teamId);
    const bot = team?.bots.find((b) => b.id === who.botId);
    if (!team || !bot) return;
    const before = bot.status;
    switch (event.type) {
      case 'started':
        if (event.sessionId && bot.sessionId !== event.sessionId) {
          bot.sessionId = event.sessionId;
          this.changed(team);
        }
        break;
      case 'text':
        this.turnText.set(runId, (this.turnText.get(runId) ?? '') + event.text);
        break;
      case 'permission':
        bot.status = 'waiting';
        this.log(team, bot.id, 'waiting', event.title);
        break;
      case 'question':
        bot.status = 'waiting';
        this.log(team, bot.id, 'waiting', event.fields[0]?.title || event.message);
        break;
      case 'permissionClosed':
      case 'questionClosed':
        if (bot.status === 'waiting') bot.status = 'working';
        break;
      case 'usage':
        if (event.costUsd != null) bot.costUsd = event.costUsd;
        break;
      case 'tool': {
        this.turnMark.set(runId, (this.turnText.get(runId) ?? '').length);
        // A call's updates only carry what changed: they come named after their kind ("other", "tool"), with the tool in the title at most.
        const key = `${runId}:${event.id ?? ''}`;
        const unnamed = event.name === 'tool' || event.name === event.kind;
        const toolName = !unnamed ? event.name : ((event.id ? this.toolNames.get(key) : undefined) ?? (/^mcp__\w+__\w+$/.test(event.summary) ? event.summary : ''));
        if (!unnamed && event.id) this.toolNames.set(key, event.name);
        // An update that says nothing new about what the bot is doing.
        if (!toolName) break;
        const own = /^mcp__alchemist_bots__(\w+)$/.exec(toolName);
        if (own) {
          // The app's own tools, shown in words by the app: "@wait_for_bot:Tester".
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(event.input ?? '{}') as Record<string, unknown>;
          } catch {
            input = {};
          }
          const target = typeof input.bot_id === 'string' ? (team.bots.find((b) => b.id === input.bot_id)?.name ?? input.bot_id) : typeof input.name === 'string' ? input.name : '';
          if (event.input || !bot.doing?.startsWith(`@${own[1]}:`)) bot.doing = `@${own[1]}:${target}`.slice(0, 160);
        } else {
          const name = toolName.startsWith('mcp__') ? (toolName.split('__').at(-1) ?? toolName) : toolName;
          const summary = event.summary && event.summary !== event.name && event.summary !== toolName ? event.summary : '';
          // An update without a title keeps what the call said when it started ("Bash: npm test").
          // "Read pendientes.txt", not "Read: Read pendientes.txt": some titles already start with the tool.
          const said = summary.toLowerCase().startsWith(`${name.toLowerCase()} `) ? summary : `${name}${summary ? `: ${summary}` : ''}`;
          if (summary || !unnamed) bot.doing = said.slice(0, 160);
        }
        break;
      }
      case 'result':
        bot.doing = null;
        this.forgetTools(runId);
        this.log(team, bot.id, event.ok ? 'finished' : 'failed');
        bot.lastReply = clip(this.finalText(runId), REPLY_CHARS) || bot.lastReply;
        if (event.costUsd != null) bot.costUsd = event.costUsd;
        if (!ENDED.includes(bot.status)) bot.status = event.ok ? 'idle' : 'error';
        this.wake(runId);
        break;
      case 'error':
        bot.error = clip(event.message.trim(), 600);
        break;
      case 'status':
        if (event.status === 'running' && bot.status === 'idle') bot.status = 'working';
        if (event.status === 'done' || event.status === 'error' || event.status === 'interrupted') {
          bot.doing = null;
          this.forgetTools(runId);
          if (event.status === 'error' && bot.status !== 'error') this.log(team, bot.id, 'failed');
          const text = this.finalText(runId);
          if (text) bot.lastReply = clip(text, REPLY_CHARS);
          if (!ENDED.includes(bot.status)) bot.status = event.status === 'done' ? 'done' : event.status === 'error' ? 'error' : 'stopped';
          this.wake(runId);
        }
        break;
    }
    if (bot.status !== before || event.type === 'result' || event.type === 'tool' || event.type === 'permission' || event.type === 'question') this.changed(team);
    if ((event.type === 'usage' || event.type === 'result') && team.budgetUsd && !team.stoppedReason) {
      const spent = team.bots.reduce((a, x) => a + (x.costUsd ?? 0), 0);
      if (spent >= team.budgetUsd) {
        team.stoppedReason = `budget:${spent.toFixed(2)}`;
        this.stop(team.id);
      }
    }
  }

  // ---------- the bot tools ----------

  private async onRequest(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const caller = this.tokens.get(String(req.headers['x-bots-token'] ?? ''));
    if (req.method !== 'POST' || req.url !== '/mcp' || !caller) return reply(403, { text: 'Not allowed', isError: true });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 200_000) return reply(413, { text: 'Too large', isError: true });
    }
    let body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { text: 'Bad request', isError: true });
    }
    if (body.method === 'tools/list') return reply(200, { tools: this.toolsFor(caller) });
    if (body.method !== 'tools/call') return reply(400, { text: 'Unknown method', isError: true });
    try {
      const text = await this.callTool(caller, String(body.params?.name ?? ''), body.params?.arguments ?? {});
      reply(200, { text, isError: false });
    } catch (error) {
      reply(200, { text: error instanceof Error ? error.message : String(error), isError: true });
    }
  }

  /** Every bot with the tools may use all of them; the checks happen per call. */
  private toolsFor(_caller: Caller): ToolDef[] {
    return Object.values(TOOLS);
  }

  /** Runs one tool for `caller`. Bots only see and control the bots they created (the coordinator: all). */
  async callTool(caller: Caller, name: string, args: Record<string, unknown>): Promise<string> {
    const { team, bot: me } = this.member(caller.teamId, caller.botId);
    const mine = (id: unknown) => {
      const target = team.bots.find((b) => b.id === String(id ?? ''));
      if (!target) throw new Error(`No bot "${String(id)}" in this team. Call list_bots.`);
      if (me.depth > 0 && !this.subtree(team, me.id).includes(target.id)) throw new Error(`${target.name} isn't one of your bots.`);
      if (target.id === me.id) throw new Error("That's you.");
      return target;
    };
    switch (name) {
      case 'list_bot_configs': {
        const here = this.configs.filter((c) => c.kind !== 'coordinator' && this.inProject(c, team.cwd));
        if (!here.length) return 'No saved configurations for this project: define bots directly with role (and model) in create_bot.';
        const nameOf = (id: string | null | undefined) => this.configs.find((x) => x.id === id)?.name;
        // A lead sees its own team first; the coordinator sees who leads whom.
        const mineFirst = me.configId ? [...here.filter((c) => c.leadId === me.configId), ...here.filter((c) => c.leadId !== me.configId)] : here;
        return mineFirst
          .map((c) => {
            const team = this.teamOf(c.id).map((x) => x.name);
            const on = nameOf(c.leadId);
            return `- ${c.name} (id ${c.id}): ${c.role.slice(0, 200) || 'no role set'} · ${c.agent.harnessId} / ${c.agent.model} · permissions ${c.permissionMode}${c.canSpawn || team.length ? ' · may create bots' : ''}${team.length ? ` · leads a team: ${team.join(', ')}` : ''}${on ? ` · on ${on}'s team` : ''}${c.proposed ? ' · proposed (not kept yet)' : ''}`;
          })
          .join('\n');
      }
      case 'propose_plan': {
        if (me.depth > 0) throw new Error('Only the coordinator proposes the plan.');
        const bots: PlannedBot[] = (Array.isArray(args.bots) ? (args.bots as Array<Record<string, unknown>>) : []).slice(0, MAX_BOTS - 1).map((x) => ({
          name: str(x?.name, 60),
          task: str(x?.task, 8000),
          config: str(x?.config, 100),
          role: str(x?.role, 4000),
          ownWorktree: x?.own_worktree === true,
        })).filter((x) => x.name && x.task);
        if (!bots.length) throw new Error('A plan needs at least one bot with a name and a task.');
        const estimate = Number(args.estimate_usd);
        team.plan = { summary: str(args.summary, 4000), bots, estimateUsd: Number.isFinite(estimate) && estimate > 0 ? estimate : null, status: 'pending', feedback: '', revision: (team.plan?.revision ?? 0) + 1 };
        this.log(team, me.id, 'plan', String(bots.length));
        this.changed(team);
        if (!team.approvePlan) {
          team.plan.status = 'approved';
          return 'Noted (this team does not review plans): go ahead and create the bots.';
        }
        return 'The plan is with the user now. Call wait_for_plan to get their answer.';
      }
      case 'wait_for_plan': {
        const plan = team.plan;
        if (!plan) throw new Error('There is no plan yet: call propose_plan first.');
        const seconds = Math.min(600, Math.max(5, Number(args.timeout_seconds) || 120));
        if (plan.status === 'pending') {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, seconds * 1000);
            const list = this.waiters.get(`plan:${team.id}`) ?? [];
            list.push(() => (clearTimeout(timer), resolve()));
            this.waiters.set(`plan:${team.id}`, list);
          });
        }
        return planAnswer(team.plan!);
      }
      case 'create_bot': {
        if (team.stoppedReason) throw new Error('The team reached its spending cap and was stopped.');
        if (team.approvePlan && me.depth === 0 && team.plan?.status !== 'approved') {
          throw new Error(team.plan?.status === 'pending' ? 'The user has not approved the plan yet: call wait_for_plan.' : 'This team reviews plans first: call propose_plan, then wait_for_plan.');
        }
        if (team.bots.length >= MAX_BOTS) throw new Error(`This team already has ${MAX_BOTS} bots, the most it can have. Reuse one with message_bot.`);
        const childName = str(args.name, 60);
        const task = str(args.task);
        if (!childName || !task) throw new Error('create_bot needs a name and a task.');
        const ref = str(args.config, 100);
        const config = ref ? this.findConfig(ref) : undefined;
        if (ref && !config) throw new Error(`No configuration "${ref}". Call list_bot_configs, or define the bot with role.`);
        if (config?.kind === 'coordinator') throw new Error("That's the organization's coordinator (you). Pick one of its agents, or define a new one with role.");
        const depth = me.depth + 1;
        // A lead creates its team's bots, so it may always create bots.
        const wantsSpawn = config ? config.canSpawn || this.teamOf(config.id).length > 0 : args.can_create_bots === true;
        const wantsCopy = config ? config.ownWorktree === true : args.own_worktree === true;
        const model = !config && str(args.model, 120) && /^[\w.:/@-]{1,120}$/.test(str(args.model, 120)) ? str(args.model, 120) : null;
        const child: BotMember = {
          id: `b${team.bots.length + 1}`,
          name: childName,
          configId: config?.id ?? null,
          role: config?.role ?? str(args.role, 8000),
          agent: config ? { ...config.agent } : { ...me.agent, model: model ?? me.agent.model },
          // A bot defined on the spot gets its creator's permissions, never more.
          permissionMode: config?.permissionMode ?? me.permissionMode,
          canSpawn: wantsSpawn && me.canSpawn && depth < MAX_DEPTH,
          parentId: me.id,
          depth,
          runId: null,
          status: 'starting',
          task,
          lastReply: '',
          costUsd: null,
          createdAt: Date.now(),
        };
        let cwd = team.cwd;
        let note = '';
        if (wantsCopy) {
          try {
            cwd = await this.makeWorktree(team, child);
          } catch (error) {
            note = ` It works in the shared folder: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        // Defined on the spot: it joins the organization as a proposed agent you can keep or dismiss.
        if (!config && this.coordinator() && !this.configs.some((c) => c.name.toLowerCase() === childName.toLowerCase())) {
          const root = (await repoRoot(team.cwd).catch(() => null)) ?? team.cwd;
          const kept = this.saveConfig({ name: childName, role: child.role, agent: child.agent, permissionMode: child.permissionMode, canSpawn: child.canSpawn, ownWorktree: wantsCopy, kind: 'member', projects: [root], proposed: true });
          child.configId = kept.id;
        }
        team.bots.push(child);
        this.log(team, me.id, 'created', `${child.id}|${task}`);
        this.launch(team, child, workerPrompt(child, me.name, this.org.instructions, config ? this.teamOf(config.id) : []), cwd);
        this.changed(team);
        if (child.status === 'error') throw new Error(`${child.name} couldn't start: ${child.lastReply}`);
        const copy = child.worktree ? ' in its own copy of the project (use bot_changes and apply_bot_work when it is done)' : '';
        return `Created ${child.name} (id ${child.id})${config ? ` from the configuration ${config.name}` : ''}${copy}. It is working on its task now; call wait_for_bot with bot_id "${child.id}" to get its answer.${note}`;
      }
      case 'message_bot': {
        const target = mine(args.bot_id);
        const text = str(args.text);
        if (!text) throw new Error('message_bot needs text.');
        this.sendTo(team, target, text);
        this.log(team, me.id, 'message', `${target.id}|${text}`);
        return `Sent to ${target.name}. Call wait_for_bot with bot_id "${target.id}" for its answer.`;
      }
      case 'wait_for_bot': {
        const target = mine(args.bot_id);
        const seconds = Math.min(600, Math.max(5, Number(args.timeout_seconds) || 120));
        if (target.status === 'working' || target.status === 'starting' || target.status === 'waiting') {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, seconds * 1000);
            const list = this.waiters.get(target.runId ?? '') ?? [];
            list.push(() => (clearTimeout(timer), resolve()));
            this.waiters.set(target.runId ?? '', list);
          });
        }
        if (target.status === 'working' || target.status === 'starting') return `${target.name} is still working. Call wait_for_bot again.`;
        if (target.status === 'waiting') return `${target.name} is waiting for the user to approve something in Alchemist Coder. Call wait_for_bot again later.`;
        return `${target.name} (${target.status}):\n${target.lastReply || '(no answer)'}${target.error ? `\nIts turn failed: ${target.error}` : ''}`;
      }
      case 'list_bots': {
        const visible = me.depth === 0 ? team.bots : team.bots.filter((b) => this.subtree(team, me.id).includes(b.id));
        return visible
          .map((b) => `- ${b.id} ${b.name}${b.parentId ? ` (created by ${b.parentId})` : ' (coordinator)'} · ${b.status}${b.lastReply ? ` · ${b.lastReply.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`)
          .join('\n');
      }
      case 'bot_changes': {
        const target = mine(args.bot_id);
        if (!target.worktree) return `${target.name} works in the shared folder: its changes are already there.`;
        const changes = await this.workChanges(target);
        if (!changes.length) return `${target.name} hasn't changed anything in its copy yet.`;
        return changes.map((c) => `${c.status[0]!.toUpperCase()} ${c.path}${c.binary ? ' (binary)' : ` +${c.added} −${c.removed}`}${c.autoRun ? ' ⚠ runs on its own (hooks, CI): check it' : ''}`).join('\n');
      }
      case 'apply_bot_work': {
        const target = mine(args.bot_id);
        return this.applyWork(team, target, me.name, me.id);
      }
      case 'finish_team': {
        if (me.depth > 0) throw new Error('Only the coordinator finishes the team; reply to your coordinator instead.');
        const summary = str(args.summary, 8000);
        if (!summary) throw new Error('finish_team needs a summary.');
        team.finished = { summary, at: Date.now() };
        this.log(team, me.id, 'done');
        this.changed(team);
        return 'The user now sees the team as finished, with your summary. End your turn with a one-line reply.';
      }
      case 'stop_bot': {
        const target = mine(args.bot_id);
        this.stop(team.id, target.id);
        return `Stopped ${target.name}.`;
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }
}
