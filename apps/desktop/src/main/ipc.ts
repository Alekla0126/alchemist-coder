import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { slashCommands } from './slash-commands';
import type { BotManager } from './bots';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { installFromOpenVsx, parseJsonc, searchThemes, themesFromVsix } from '@alchemist-coder/themes';
import type { IndexReader } from '@alchemist-coder/indexer';
import type { IndexProgress, QuestionAnswer } from '@alchemist-coder/core';
import { Channels, type AppInfo, type ExportFormat } from '../shared/api';
import type { SettingsStore } from './settings';
import type { RunnerManager } from './runner';
import type { TaskManager } from './tasks';
import type { PreviewServer } from './preview';
import type { ExtensionsHub } from './hub';
import type { BackupService } from './backup';
import type { ReviewManager } from './reviews';
import type { UsageService } from './usage';
import { showMenu } from './menus';
import { conversationFiles } from './session-files';
import type { TerminalManager } from './terminals';
import { browsableRoot, type Workspace } from './workspace';
import { createProjectFolder } from './new-project';
import { loadMarketing, readDrafts, saveMarketing } from './marketing';

const text = (value: unknown, name: string, max = 512): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
};
const optionalId = (value: unknown): number | null => (Number.isInteger(value) ? (value as number) : null);
const count = (value: unknown, fallback: number, max: number): number =>
  Number.isInteger(value) && (value as number) >= 0 ? Math.min(value as number, max) : fallback;

export interface IpcDeps {
  info: () => AppInfo;
  settings: SettingsStore;
  bots: BotManager;
  /** After the renderer changed settings (e.g. the language, for the menu bar). */
  onSettingsChanged?: (patch: Record<string, unknown>) => void;
  reader: () => IndexReader | null;
  progress: () => IndexProgress;
  onRendered: () => void;
  runner: RunnerManager;
  tasks: TaskManager;
  preview: PreviewServer;
  hub: ExtensionsHub;
  backup: BackupService;
  reviews: ReviewManager;
  usage: UsageService;
  exportSession: (sessionId: string, format: ExportFormat) => Promise<string | null>;
  workspace: Workspace;
  terminals: TerminalManager;
}

/** Every handler validates its arguments: the renderer is treated as untrusted. */
export function registerIpc(deps: IpcDeps): void {
  const withReader = <T>(fallback: T, fn: (r: IndexReader) => T): T => {
    const r = deps.reader();
    return r ? fn(r) : fallback;
  };
  ipcMain.handle(Channels.info, () => deps.info());
  ipcMain.handle(Channels.getSettings, () => deps.settings.get());
  ipcMain.handle(Channels.setSettings, (_e, patch: unknown) => {
    // The backup folder is only set through its own folder picker.
    const { backupDir: _dir, backupAuto: _auto, ...rest } = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    const result = deps.settings.update(rest);
    deps.onSettingsChanged?.(rest);
    return result;
  });
  ipcMain.handle(Channels.projects, () => withReader([], (r) => r.listProjects()));
  const addProject = (cwd: string) => {
    const r = deps.reader();
    if (!r) throw new Error('The index is still loading; try again in a moment');
    return r.addProject(cwd, basename(cwd) || cwd);
  };
  const pickFolder = async (e: Electron.IpcMainInvokeEvent, title: unknown, defaultPath?: unknown) => {
    const options = { title: typeof title === 'string' ? title.slice(0, 120) : undefined, defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const win = BrowserWindow.fromWebContents(e.sender);
    const choice = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return choice.canceled ? null : (choice.filePaths[0] ?? null);
  };
  ipcMain.handle(Channels.openFolder, async (e, title: unknown) => {
    const path = await pickFolder(e, title);
    if (!path) return null;
    if (!browsableRoot(path)) throw new Error("Alchemist doesn't open your whole home folder or system folders; choose a project inside them");
    return addProject(path);
  });
  ipcMain.handle(Channels.chooseFolder, (e, title: unknown, defaultPath: unknown) => pickFolder(e, title, defaultPath));
  // Marketing lives in each project's marketing/ folder; only folders of your projects are touched.
  ipcMain.handle(Channels.marketingLoad, (_e, cwd: unknown) => loadMarketing(deps.workspace.projectFolder(cwd)));
  ipcMain.handle(Channels.marketingSave, (_e, cwd: unknown, data: unknown) => {
    if (JSON.stringify(data ?? null).length > 8_000_000) throw new Error('Too much marketing content to save at once');
    return saveMarketing(deps.workspace.projectFolder(cwd), data);
  });
  ipcMain.handle(Channels.marketingDrafts, (_e, cwd: unknown) => readDrafts(deps.workspace.projectFolder(cwd)));
  ipcMain.handle(Channels.createProject, async (_e, parent: unknown, name: unknown, git: unknown) =>
    addProject(await createProjectFolder(text(parent, 'folder', 4096), text(name, 'project name', 200), git === true)),
  );
  ipcMain.handle(Channels.sessions, (_e, projectId: unknown, favoritesOnly: unknown) =>
    // History lists everything (it pages as you scroll); the old cap of 500 hid the rest.
    withReader([], (r) => r.listSessions({ projectId: optionalId(projectId), favoritesOnly: favoritesOnly === true, limit: 5000 })),
  );
  // A handful per project (the index has them by project and date): cheap even with many projects open.
  ipcMain.handle(Channels.recentSessions, (_e, projectIds: unknown, perProject: unknown) =>
    withReader({}, (r) => {
      const ids = Array.isArray(projectIds) ? projectIds.filter((id): id is number => Number.isInteger(id)).slice(0, 60) : [];
      const limit = count(perProject, 8, 40);
      return Object.fromEntries(ids.map((id) => [id, r.listSessions({ projectId: id, limit })]));
    }),
  );
  ipcMain.handle(Channels.session, (_e, id: unknown) => withReader(null, (r) => r.getSession(text(id, 'session id'))));
  ipcMain.handle(Channels.agentTree, (_e, id: unknown) => withReader(null, (r) => r.getAgentTree(text(id, 'session id'))));
  ipcMain.handle(Channels.transcript, (_e, sessionId: unknown, agentId: unknown, offset: unknown, limit: unknown) =>
    withReader({ entries: [], total: 0, offset: 0, nextOffset: null }, (r) =>
      // -1 = the last page (conversations open at their latest message).
      r.getTranscript(text(sessionId, 'session id'), text(agentId, 'agent id'), offset === -1 ? -1 : count(offset, 0, 10_000_000), count(limit, 300, 3000)),
    ),
  );
  ipcMain.handle(Channels.search, (_e, query: unknown, projectId: unknown) =>
    withReader([], (r) => r.search(text(query, 'query', 300), { projectId: optionalId(projectId), limit: 200 })),
  );
  ipcMain.handle(Channels.setFavorite, (_e, id: unknown, favorite: unknown) =>
    withReader(undefined, (r) => r.setFavorite(text(id, 'session id'), favorite === true)),
  );
  ipcMain.handle(Channels.renameSession, (_e, id: unknown, title: unknown) =>
    withReader(undefined, (r) => r.setTitle(text(id, 'session id'), typeof title === 'string' ? title : null)),
  );
  ipcMain.handle(Channels.hideSession, (_e, id: unknown, hidden: unknown) => withReader(undefined, (r) => r.setHidden(text(id, 'session id'), hidden === true)));
  ipcMain.handle(Channels.hiddenSessions, () => withReader([], (r) => r.hiddenSessions()));
  ipcMain.handle(Channels.revealSession, (_e, id: unknown) =>
    withReader(undefined, (r) => {
      const [file] = conversationFiles(r.sessionFile(text(id, 'session id')));
      if (!file) throw new Error('This conversation has no file on disk any more');
      shell.showItemInFolder(file);
    }),
  );
  ipcMain.handle(Channels.trashSession, async (_e, id: unknown) => {
    const r = deps.reader();
    if (!r) throw new Error('The index is still loading');
    const sessionId = text(id, 'session id');
    // Hidden first: with the backup on, the index would otherwise bring the kept copy back.
    r.setHidden(sessionId, true);
    for (const path of conversationFiles(r.sessionFile(sessionId))) await shell.trashItem(path);
  });
  ipcMain.handle(Channels.indexStatus, () => deps.progress());
  ipcMain.handle(Channels.runnerCatalog, () => deps.runner.catalog());
  ipcMain.handle(Channels.setProviderCredential, (_e, providerId: unknown, value: unknown) =>
    deps.runner.setCredential(text(providerId, 'provider id', 60), typeof value === 'string' ? value : null),
  );
  ipcMain.handle(Channels.startRun, async (_e, request: unknown) => {
    // Snapshot the project first, so its review shows exactly what this run changes.
    const r = (request ?? {}) as Record<string, unknown>;
    const prepared = await deps.reviews.prepare(r.cwd).catch(() => null);
    const started = deps.runner.start(request as never, {});
    if (prepared) deps.reviews.track(started.runId, prepared, r);
    return started;
  });
  ipcMain.handle(Channels.sendToRun, (_e, runId: unknown, value: unknown, images: unknown) => deps.runner.send(text(runId, 'run id', 100), String(value ?? ''), images));
  ipcMain.handle(Channels.stopRun, (_e, runId: unknown) => deps.runner.stop(text(runId, 'run id', 100)));
  ipcMain.handle(Channels.interruptRun, (_e, runId: unknown) => deps.runner.interrupt(text(runId, 'run id', 100)));
  ipcMain.handle(Channels.respondToRun, (_e, runId: unknown, requestId: unknown, choiceId: unknown) =>
    deps.runner.respond(text(runId, 'run id', 100), text(requestId, 'request id', 100), typeof choiceId === 'string' && choiceId.length <= 200 ? choiceId : null),
  );
  ipcMain.handle(Channels.answerRun, (_e, runId: unknown, requestId: unknown, answer: unknown) =>
    deps.runner.answer(text(runId, 'run id', 100), text(requestId, 'request id', 100), questionAnswer(answer)),
  );
  ipcMain.handle(Channels.configureRun, (_e, runId: unknown, change: unknown) => deps.runner.configure(text(runId, 'run id', 100), change));
  ipcMain.handle(Channels.previewUrl, (_e, root: unknown, path: unknown) => deps.preview.url(root ?? null, path));
  ipcMain.handle(Channels.hubInventory, (_e, cwd: unknown) => deps.hub.inventory(cwd ?? null));
  ipcMain.handle(Channels.hubPlanInstall, (_e, id: unknown, cwd: unknown) => deps.hub.plan(text(id, 'server id', 120), cwd ?? null));
  ipcMain.handle(Channels.hubInstall, (_e, id: unknown, agents: unknown, cwd: unknown) => deps.hub.install(text(id, 'server id', 120), agents, cwd ?? null));
  ipcMain.handle(Channels.hubUnify, (_e, cwd: unknown) => deps.hub.unify(cwd));
  ipcMain.handle(Channels.exportSession, (_e, id: unknown, format: unknown) =>
    deps.exportSession(text(id, 'session id', 120), (['md', 'html', 'json'] as const).find((f) => f === format) ?? 'md'),
  );
  ipcMain.handle(Channels.showMenu, (e, items: unknown) => showMenu(e.sender, items));
  // Reveal (never open) and only paths inside your projects.
  ipcMain.handle(Channels.revealPath, (_e, path: unknown) => shell.showItemInFolder(deps.workspace.resolveInside(path)));
  ipcMain.handle(Channels.copyText, (_e, value: unknown) => {
    if (typeof value === 'string' && value.length <= 1_000_000) clipboard.writeText(value);
  });
  ipcMain.handle(Channels.planUsage, (_e, refresh: unknown) => deps.usage.get(refresh === true));
  ipcMain.handle(Channels.reviews, (_e, cwd: unknown) => deps.reviews.list(cwd));
  ipcMain.handle(Channels.reviewFile, (_e, id: unknown, path: unknown) => deps.reviews.file(id, path));
  const textArg = (v: unknown) => (v === undefined || (typeof v === 'string' && v.length <= 8e6) ? v : null);
  ipcMain.handle(Channels.reviewKeep, (_e, id: unknown, path: unknown, baseline: unknown, basedOn: unknown) => deps.reviews.keep(id, path, textArg(baseline), textArg(basedOn)));
  ipcMain.handle(Channels.reviewUndo, (_e, id: unknown, path: unknown, content: unknown, basedOn: unknown) => deps.reviews.undo(id, path, textArg(content), textArg(basedOn)));
  ipcMain.handle(Channels.reviewDismiss, (_e, id: unknown) => deps.reviews.dismiss(id));
  ipcMain.handle(Channels.backupStatus, () => deps.backup.status());
  ipcMain.handle(Channels.backupChoose, async (e) => {
    const current = deps.settings.get().backupDir;
    const options = { title: 'Backup folder', defaultPath: current ?? undefined, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const win = BrowserWindow.fromWebContents(e.sender);
    const choice = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return choice.canceled || !choice.filePaths[0] ? deps.backup.status() : deps.backup.enable(choice.filePaths[0]);
  });
  ipcMain.handle(Channels.backupRun, () => deps.backup.run());
  ipcMain.handle(Channels.backupSetAuto, (_e, auto: unknown) => deps.backup.setAuto(auto === true));
  ipcMain.handle(Channels.backupOpen, () => {
    // Reveal, never open: opening a path can launch it (a folder named *.app is an app).
    const dir = deps.backup.root();
    if (dir) shell.showItemInFolder(join(dir, 'README.md'));
  });
  ipcMain.handle(Channels.tasks, (_e, cwd: unknown) => deps.tasks.list(cwd));
  ipcMain.handle(Channels.createTask, (_e, cwd: unknown, prompt: unknown) => deps.tasks.create(cwd, prompt));
  ipcMain.handle(Channels.planTask, (_e, id: unknown, planner: unknown) => deps.tasks.plan(text(id, 'task id', 80), planner as never));
  ipcMain.handle(Channels.editTask, (_e, id: unknown, edit: unknown) => deps.tasks.edit(text(id, 'task id', 80), edit as never));
  ipcMain.handle(Channels.startTask, (_e, id: unknown, choices: unknown) => deps.tasks.start(text(id, 'task id', 80), choices as never));
  ipcMain.handle(Channels.stopTask, (_e, id: unknown) => deps.tasks.stop(text(id, 'task id', 80)));
  ipcMain.handle(Channels.taskDiff, (_e, id: unknown, contestantId: unknown, path: unknown) => deps.tasks.diff(text(id, 'task id', 80), contestantId, path));
  ipcMain.handle(Channels.mergeTask, (_e, id: unknown, contestantId: unknown, squash: unknown) => deps.tasks.merge(text(id, 'task id', 80), contestantId, squash));
  ipcMain.handle(Channels.discardTask, (_e, id: unknown) => deps.tasks.discard(text(id, 'task id', 80)));
  ipcMain.handle(Channels.removeTask, (_e, id: unknown) => deps.tasks.remove(text(id, 'task id', 80)));
  const { workspace, terminals } = deps;
  ipcMain.handle(Channels.listDir, (_e, dir: unknown) => workspace.list(dir));
  ipcMain.handle(Channels.readFile, (_e, path: unknown) => workspace.read(path));
  ipcMain.handle(Channels.writeFile, (_e, path: unknown, value: unknown) => workspace.write(path, value));
  ipcMain.handle(Channels.createEntry, (_e, dir: unknown, name: unknown, kind: unknown) => workspace.create(dir, name, kind === 'folder' ? 'folder' : 'file'));
  ipcMain.handle(Channels.renameEntry, (_e, path: unknown, name: unknown) => workspace.rename(path, name));
  ipcMain.handle(Channels.trashEntry, (_e, path: unknown) => shell.trashItem(workspace.trashable(path)));
  ipcMain.handle(Channels.gitStatus, (_e, cwd: unknown) => workspace.gitStatus(cwd));
  ipcMain.handle(Channels.botConfigs, () => deps.bots.listConfigs());
  ipcMain.handle(Channels.saveBotConfig, (_e, config: unknown) => deps.bots.saveConfig(config));
  ipcMain.handle(Channels.addStarterBots, (_e, agent: unknown, starters: unknown) => {
    const list = starters && typeof starters === 'object' ? (starters as Record<string, { name?: unknown; role?: unknown }>) : {};
    const clean = Object.fromEntries(Object.entries(list).map(([k, v]) => [k, { name: String(v?.name ?? '').slice(0, 60), role: String(v?.role ?? '').slice(0, 4000) }]));
    return deps.bots.addStarters(agent, clean);
  });
  ipcMain.handle(Channels.orgSettings, () => deps.bots.orgSettings());
  ipcMain.handle(Channels.saveOrgSettings, (_e, settings: unknown) => deps.bots.saveOrgSettings(settings));
  ipcMain.handle(Channels.ensureOrg, (_e, agent: unknown, starters: unknown) => {
    const list = starters && typeof starters === 'object' ? (starters as Record<string, { name?: unknown; role?: unknown }>) : {};
    const clean = Object.fromEntries(Object.entries(list).slice(0, 12).map(([k, v]) => [k, { name: String(v?.name ?? '').slice(0, 60), role: String(v?.role ?? '').slice(0, 4000) }]));
    return deps.bots.ensureOrg(agent, clean);
  });
  ipcMain.handle(Channels.deleteBotConfig, (_e, id: unknown) => deps.bots.deleteConfig(text(id, 'config id', 60)));
  ipcMain.handle(Channels.botTeams, () => deps.bots.listTeams());
  ipcMain.handle(Channels.startTeam, (_e, request: unknown) => deps.bots.startTeam(request));
  ipcMain.handle(Channels.messageBot, (_e, teamId: unknown, botId: unknown, value: unknown) => deps.bots.message(text(teamId, 'team id', 60), text(botId, 'bot id', 20), String(value ?? '')));
  ipcMain.handle(Channels.stopBot, (_e, teamId: unknown, botId: unknown) => deps.bots.stop(text(teamId, 'team id', 60), typeof botId === 'string' ? text(botId, 'bot id', 20) : undefined));
  ipcMain.handle(Channels.botChanges, (_e, teamId: unknown, botId: unknown) => deps.bots.changesOf(text(teamId, 'team id', 60), text(botId, 'bot id', 20)));
  ipcMain.handle(Channels.botDiff, (_e, teamId: unknown, botId: unknown) => deps.bots.diffOf(text(teamId, 'team id', 60), text(botId, 'bot id', 20)));
  ipcMain.handle(Channels.applyBotWork, (_e, teamId: unknown, botId: unknown) => deps.bots.apply(text(teamId, 'team id', 60), text(botId, 'bot id', 20)));
  ipcMain.handle(Channels.answerPlan, (_e, teamId: unknown, answer: unknown) => deps.bots.answerPlan(text(teamId, 'team id', 60), answer));
  ipcMain.handle(Channels.renameTeam, (_e, teamId: unknown, title: unknown) => deps.bots.rename(text(teamId, 'team id', 60), String(title ?? '')));
  ipcMain.handle(Channels.deleteTeam, (_e, teamId: unknown) => deps.bots.deleteTeam(text(teamId, 'team id', 60)));
  ipcMain.handle(Channels.gitCommit, (_e, cwd: unknown, files: unknown, message: unknown, push: unknown) => workspace.commit(cwd, files, message, push));
  ipcMain.handle(Channels.transcriptImage, (_e, sessionId: unknown, agentId: unknown, offset: unknown, n: unknown) => {
    if (!Number.isInteger(offset) || !Number.isInteger(n) || (n as number) < 0 || (n as number) > 50) return null;
    const img = withReader(null, (r) => r.image(text(sessionId, 'session id', 100), text(agentId, 'agent id', 100), offset as number, n as number));
    return img ? `data:${img.mediaType};base64,${img.data}` : null;
  });
  ipcMain.handle(Channels.searchFiles, (_e, cwd: unknown, query: unknown) => workspace.searchFiles(cwd, query).catch(() => []));
  ipcMain.handle(Channels.slashCommands, (_e, harnessId: unknown, cwd: unknown) =>
    slashCommands(String(harnessId), typeof cwd === 'string' && workspace.isProjectFolder(cwd) ? cwd : null).catch(() => []),
  );
  ipcMain.handle(Channels.gitHead, (_e, cwd: unknown, path: unknown) => workspace.gitHead(cwd, path));
  ipcMain.handle(Channels.terminalAvailable, () => terminals.available());
  ipcMain.handle(Channels.terminalShells, () => terminals.shells().map(({ path, label }) => ({ path, label })));
  ipcMain.handle(Channels.createTerminal, (_e, cwd: unknown, cols: unknown, rows: unknown, shell: unknown) => {
    const { id, shell: used } = terminals.create(workspace.projectFolder(cwd), Number(cols), Number(rows), shell);
    return { id, shell: used.label };
  });
  ipcMain.handle(Channels.terminalLinks, (_e, cwd: unknown, candidates: unknown) => workspace.resolveLinks(cwd, candidates));
  ipcMain.on(Channels.writeTerminal, (_e, id: unknown, data: unknown) => {
    if (typeof id === 'string' && typeof data === 'string' && data.length < 1_000_000) terminals.write(id, data);
  });
  ipcMain.on(Channels.resizeTerminal, (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id === 'string') terminals.resize(id, Number(cols), Number(rows));
  });
  ipcMain.on(Channels.killTerminal, (_e, id: unknown) => {
    if (typeof id === 'string') terminals.kill(id);
  });
  ipcMain.handle(Channels.importTheme, async () => {
    const result = await dialog.showOpenDialog({ title: 'Import a VS Code theme', filters: [{ name: 'VS Code theme or extension', extensions: ['json', 'jsonc', 'vsix'] }], properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const st = await stat(file);
    if (!st.isFile() || st.size > 25 * 1024 * 1024) throw new Error('This file is too large to be a theme');
    if (file.toLowerCase().endsWith('.vsix')) return themesFromVsix(await readFile(file));
    const json = parseJsonc(await readFile(file, 'utf8')) as Record<string, unknown> | null;
    if (!json || typeof json !== 'object' || (!json.colors && !json.tokenColors)) throw new Error('This file is not a VS Code color theme');
    return [json];
  });
  ipcMain.handle(Channels.searchThemes, (_e, query: unknown) => searchThemes(typeof query === 'string' ? query.trim() : ''));
  ipcMain.handle(Channels.installTheme, (_e, namespace: unknown, name: unknown) => installFromOpenVsx(text(namespace, 'publisher', 100), text(name, 'extension', 100)));
  ipcMain.on(Channels.rendered, () => deps.onRendered());
}

/** A question's answer from the renderer: accept with plain values, decline, or null (cancel). */
function questionAnswer(value: unknown): QuestionAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { action?: unknown; content?: unknown };
  if (v.action === 'decline') return { action: 'decline' };
  if (v.action !== 'accept') return null;
  const content: NonNullable<QuestionAnswer['content']> = {};
  if (v.content && typeof v.content === 'object') {
    for (const [k, x] of Object.entries(v.content as Record<string, unknown>).slice(0, 40)) {
      if (!/^[\w.-]{1,80}$/.test(k)) continue;
      if (typeof x === 'string') content[k] = x.slice(0, 4000);
      else if (typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) content[k] = x;
      else if (Array.isArray(x)) content[k] = x.filter((y): y is string => typeof y === 'string').slice(0, 50).map((y) => y.slice(0, 500));
    }
  }
  return { action: 'accept', content };
}
