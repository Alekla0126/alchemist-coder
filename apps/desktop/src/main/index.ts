import { app, BrowserWindow, session, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { IndexReader } from '@alchemist-coder/indexer';
import { ExtensionRegistry } from '@alchemist-coder/core';
import { claudeAgent, claudeCodeHarness, codexAgent, codexHarness, detectBinary, geminiAgent, grokAgent } from '@alchemist-coder/harness';
import { lmStudioProvider, ollamaProvider } from '@alchemist-coder/providers-local';
import type { IndexProgress } from '@alchemist-coder/core';
import { Channels, isLocale, matchLocale, type AppInfo, type Locale, type Mode } from '../shared/api';
import { registerIpc } from './ipc';
import { SettingsStore } from './settings';
import { RunnerManager } from './runner';
import { TaskManager } from './tasks';
import { BotManager } from './bots';
import { writeBridge } from './bots-bridge';
import { ExtensionsHub } from './hub';
import { BackupService } from './backup';
import { ReviewManager } from './reviews';
import { UsageService, defaultHomes } from './usage';
import { exportSession } from './export';
import { blockPreviewNetwork, lockPreviewFrames, PreviewServer, registerPreviewScheme } from './preview';
import { appMenu, editMenu } from './menus';
import { adoptLoginShellPath } from './shell-path';
import { TerminalManager } from './terminals';
import { BoardService } from './board';
import { AutomationHost } from './automation-host';
import { Workspace } from './workspace';
import { KeychainSecretStore } from './secrets';
import { loadPersonalModule, loadProModule } from './extensions';
import workerPath from './indexer-worker?modulePath';

registerPreviewScheme();

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const capturePath = arg('capture');
const profile = arg('profile');
if (profile) app.setPath('userData', resolve(profile));

let window: BrowserWindow | null = null;
let reader: IndexReader | null = null;
let progress: IndexProgress = { phase: 'scanning', done: 0, total: 0 };
let edition: 'community' | 'pro' = 'community';
/** Whether this copy bundles its owner's personal module (see extensions.ts). */
let personalBuild = false;

function appInfo(): AppInfo {
  const select = arg('select');
  const [sessionId, agentId] = select ? select.split(':') : [];
  // --arena="task" --arena-agents="h,p,m;h,p,m" [--arena-plan="h,p,m"] [--arena-tests="npm test"] [--arena-stop=review]
  const choice = (v: string) => {
    const [h, p, m] = v.split(',');
    return { harnessId: h ?? '', providerId: p ?? '', model: m ?? '' };
  };
  const arenaPrompt = arg('arena');
  // --run=<harness>,<provider>,<model>,<permissionMode> --prompt="…" [--run-cwd=/path]
  const [harnessId, providerId, model, permissionMode] = (arg('run') ?? '').split(',');
  return {
    version: app.getVersion(),
    edition,
    personal: personalBuild,
    platform: process.platform,
    systemLocale: app.getLocale(),
    home: app.getPath('home'),
    capture: capturePath
      ? {
          select: sessionId ? { sessionId, agentId: agentId || 'main' } : null,
          mode: (arg('mode') as Mode | undefined) ?? null,
          query: arg('query') ?? null,
          compose: process.argv.includes('--compose'),
          composeText: arg('compose-text') ?? null,
          theme: arg('theme') ?? null,
          project: arg('project') ?? null,
          openFile: arg('open-file') ?? null,
          preview: process.argv.includes('--preview'),
          sidebar: (['agents', 'files', 'git', 'extensions'] as const).find((x) => x === arg('sidebar')) ?? null,
          themeSearch: arg('theme-search') ?? null,
          terminalSplit: process.argv.includes('--terminal-split'),
          review: process.argv.includes('--review'),
          usage: process.argv.includes('--usage'),
          activity: process.argv.includes('--activity'),
          scrollTo: arg('scroll-to') ?? null,
          runUntil: arg('run-until') === 'subagent' ? 'subagent' : null,
          orgGoal: arg('org-goal') ?? null,
          automation: arg('automation') ?? null,
          automationPrompt: arg('automation-prompt') ?? null,
          automationRun: process.argv.includes('--automation-run'),
          automationAnswer: process.argv.includes('--automation-answer'),
          orgApprove: process.argv.includes('--org-approve'),
          settings: (['general', 'agents', 'automations', 'usage', 'backup', 'shortcuts', 'about'] as const).find((x) => x === arg('settings')) ?? null,
          botsView: ['team', 'config', 'member', 'agent', 'chart'].includes(arg('bots-view') ?? '') ? (arg('bots-view') as 'team' | 'config' | 'member' | 'agent' | 'chart') : null,
          team: (() => {
            const [h, p, m] = (arg('team-agent') ?? '').split(',');
            const goal = arg('team');
            return goal && h && p && m && arg('team-cwd') ? { goal, harnessId: h, providerId: p, model: m, cwd: arg('team-cwd')!, approvePlan: process.argv.includes('--team-plan'), org: process.argv.includes('--team-org') } : null;
          })(),
          run:
            harnessId && providerId && model
              ? { harnessId, providerId, model, permissionMode: (permissionMode as never) || 'default', prompt: arg('prompt') ?? 'Say hello.', cwd: arg('run-cwd') ?? null }
              : null,
          arena: arenaPrompt
            ? {
                prompt: arenaPrompt,
                planner: arg('arena-plan') ? choice(arg('arena-plan')!) : null,
                agents: (arg('arena-agents') ?? '').split(';').filter(Boolean).map(choice),
                tests: arg('arena-tests') ?? null,
                stopAt: arg('arena-stop') === 'review' ? 'review' : 'compare',
              }
            : null,
          locale: isLocale(arg('locale')) ? (arg('locale') as Locale) : null,
          newProject: process.argv.includes('--new-project'),
          drawer: process.argv.includes('--drawer'),
          boardNew: process.argv.includes('--board-new'),
          boardOpen: arg('board-open') ?? null,
          addAgent: process.argv.includes('--add-agent'),
          scope: arg('scope') === 'all' || arg('scope') === 'project' ? (arg('scope') as 'all' | 'project') : null,
          mkTab: arg('mk-tab') ?? null,
          mkGenerate: (() => {
            const [h, p, m] = (arg('mk-generate') ?? '').split(',');
            return h && p && m ? { harnessId: h, providerId: p, model: m } : null;
          })(),
        }
      : null,
  };
}

/** Events for the window; dropped once it's closed (runs and ptys can outlive it while quitting). */
function send(channel: string, payload: unknown) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
}

let indexerWorker: Worker | null = null;
/** Runs once the index is open: automations need to know your projects before they start. */
let onIndexOpen: (() => void) | null = null;

function startIndexer(dbPath: string, backupRoot: string | null) {
  const worker = new Worker(workerPath, { workerData: { dbPath, backupRoot } });
  indexerWorker = worker;
  worker.on('message', (m: { type: string; progress?: IndexProgress; ids?: string[]; message?: string }) => {
    if (m.type === 'db-ready') {
      reader = new IndexReader(dbPath);
      onIndexOpen?.();
      onIndexOpen = null;
    }
    else if (m.type === 'progress' && m.progress) {
      progress = m.progress;
      send(Channels.progress, progress);
    } else if (m.type === 'ready') {
      progress = { ...progress, phase: 'ready' };
      send(Channels.progress, progress);
    } else if (m.type === 'changed' && m.ids) send(Channels.changed, m.ids);
    else if (m.type === 'error') console.error('[indexer]', m.message);
  });
  worker.on('error', (e) => console.error('[indexer worker]', e));
}

async function capture() {
  if (!window || !capturePath) return;
  await new Promise((r) => setTimeout(r, 900));
  if (window.isDestroyed()) return;
  const image = await window.webContents.capturePage();
  mkdirSync(dirname(resolve(capturePath)), { recursive: true });
  writeFileSync(resolve(capturePath), image.toPNG());
  console.log(`captured ${resolve(capturePath)}`);
  app.quit();
}

const MIN_WIDTH = 560;

function createWindow(onClosed: () => void) {
  // --size=WxH (screenshots): the window at a given size, e.g. half a laptop screen.
  const [w, h] = (arg('size') ?? '').split('x').map(Number);
  const win = new BrowserWindow({
    width: w && w >= MIN_WIDTH ? w : 1440,
    height: h && h >= 480 ? h : 900,
    // Narrow enough to share the screen side by side with another window.
    minWidth: MIN_WIDTH,
    minHeight: 480,
    show: !capturePath,
    backgroundColor: '#0f1115',
    title: 'Alchemist Coder',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window = win;
  win.on('closed', () => {
    if (window === win) window = null;
    onClosed();
  });
  lockPreviewFrames(win.webContents, (url) => send(Channels.previewBlocked, url.slice(0, 300)));
  editMenu(win.webContents);
  // Links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (capturePath || process.env.AC_DEBUG) {
    win.webContents.on('console-message', (event) => {
      const e = event as unknown as { level?: string | number; message?: string };
      if (e.message) console.log(`[renderer:${e.level ?? 'log'}] ${e.message}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => console.error('[renderer gone]', details.reason));
  }
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock() && !capturePath) app.quit();
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

void app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  const settings = new SettingsStore(join(userData, 'settings.json'));
  adoptLoginShellPath();
  const secrets = new KeychainSecretStore(join(userData, 'secrets.json'));
  const pro = loadProModule(process.resourcesPath);
  edition = pro && (await pro.isPro({ userData, secrets }).catch(() => false)) ? 'pro' : 'community';
  const own = loadPersonalModule(process.resourcesPath);
  personalBuild = !!own;
  const registry = new ExtensionRegistry(edition, secrets);
  // Agents speak ACP (permissions, plans, diffs, modes). Without Node's npx, Claude Code and Codex
  // fall back to their headless stream-json mode.
  const hasNpx = (await detectBinary('npx')).installed;
  registry.registerHarness(hasNpx ? claudeAgent() : claudeCodeHarness());
  registry.registerHarness(hasNpx ? codexAgent() : codexHarness());
  registry.registerHarness(geminiAgent());
  registry.registerHarness(grokAgent());
  registry.registerProvider(ollamaProvider());
  registry.registerProvider(lmStudioProvider());
  const personal = own?.providers?.() ?? [];
  for (const p of personal) registry.registerProvider(p);
  if (pro) await registry.load(pro.extension).catch((e) => console.error('[pro] activation failed', e));
  const workspace = new Workspace(() => reader?.listProjects().map((p) => p.cwd) ?? []);
  const runner = new RunnerManager(registry, (message) => send(Channels.runnerEvent, message), new Set(personal.map((p) => p.id)), (cwd) => workspace.isProjectFolder(cwd));
  const hub = new ExtensionsHub((p) => workspace.resolveInside(p));
  const backup = new BackupService(settings, (dir) => indexerWorker?.postMessage({ type: 'backup-root', path: dir }), (status) => send(Channels.backupChanged, status));
  const preview = new PreviewServer((p) => workspace.resolveInside(p));
  preview.start();
  blockPreviewNetwork(session.defaultSession);
  const reviews = new ReviewManager(join(userData, 'reviews.json'), join(userData, 'reviews'), (cwd) => workspace.isProjectFolder(cwd));
  runner.observe((m) => reviews.onRunEvent(m));
  // Claude's real percentages only come from a personal module; the app itself never asks for them.
  const claudeLimits = own?.claudeLimits?.bind(own);
  const usage = new UsageService(
    defaultHomes(),
    claudeLimits ? async () => claudeLimits((await detectBinary('claude')).version ?? '2.1.0') : undefined,
    join(userData, 'claude-usage.json'),
  );
  // The first read of a week of transcripts takes a few seconds: do it before anyone asks.
  setTimeout(() => void usage.get().catch(() => {}), 20_000);
  const tasks = new TaskManager(join(userData, 'tasks.json'), runner, (cwd) => workspace.resolveInside(cwd), (task) => send(Channels.taskChanged, task));
  // Bot teams: bots reach the app's tools through a small MCP bridge run by Electron itself (as Node).
  const bots = new BotManager(
    { configs: join(userData, 'bot-configs.json'), teams: join(userData, 'bot-teams.json'), org: join(userData, 'org.json') },
    runner,
    { command: process.execPath, script: writeBridge(userData) },
    (cwd) => workspace.projectFolder(cwd),
    (team) => send(Channels.botTeamChanged, team),
  );
  await bots.start();
  const board = new BoardService(userData, (data) => send(Channels.boardChanged, data));
  // Automations run with the window closed too: a notification brings it back on the automation.
  const automations = new AutomationHost(userData, {
    bots,
    runner,
    board,
    secrets,
    send,
    channel: Channels.automationChanged,
    // The language you see the app in (a capture's --locale too).
    lang: () => (capturePath && isLocale(arg('locale')) ? (arg('locale') as Locale) : null) ?? settings.get().locale ?? matchLocale(app.getLocale()),
    show: (automationId) => {
      if (!window || window.isDestroyed()) opened();
      window?.show();
      window?.focus();
      setTimeout(() => send(Channels.appCommand, automationId ? `automation:${automationId}` : 'mode:bots'), window?.webContents.isLoading() ? 1500 : 0);
    },
  });
  const terminals = new TerminalManager((channel, payload) => send(channel === 'data' ? Channels.terminalData : Channels.terminalExit, payload));
  app.on('before-quit', () => {
    backup.stop();
    tasks.flush();
    bots.flush();
    bots.stopAll();
    automations.stop();
    runner.stopAll();
    terminals.killAll();
  });
  registerIpc({ info: appInfo, bots, settings, onSettingsChanged: (patch) => 'locale' in patch && buildMenu(), reader: () => reader, progress: () => progress, onRendered: () => void capture(), runner, tasks, preview, hub, backup, reviews, usage, exportSession: (id, format) => (reader ? exportSession(window, reader, id, format) : Promise.reject(new Error('The index is still loading'))), workspace, terminals, dataDir: userData, board, automations });
  startIndexer(join(userData, 'index.db'), backup.root());
  backup.start();
  const menuLocale = () => settings.get().locale ?? matchLocale(app.getLocale());
  const buildMenu = () =>
    appMenu((command) => send(Channels.appCommand, command), {
      debug: !!process.env.AC_DEBUG || !app.isPackaged,
      name: 'Alchemist Coder',
      siteUrl: 'https://coder.alekla.com',
      issuesUrl: 'https://github.com/Alekla0126/alchemist-coder/issues',
      openExternal: (url) => void shell.openExternal(url),
      locale: menuLocale(),
    });
  buildMenu();
  // Terminals belong to the window that shows them (macOS keeps the app running without one).
  const opened = () => createWindow(() => terminals.killAll());
  opened();
  if (reader) void automations.start();
  else onIndexOpen = () => void automations.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) opened();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || capturePath) app.quit();
});
