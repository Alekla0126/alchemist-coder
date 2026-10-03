import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, Notification, powerSaveBlocker } from 'electron';
import type { SecretStore } from '@alchemist-coder/core';
import type { AutomationSettings, AutomationState, BotConfig, RunnerEventMessage } from '../shared/api';
import { AutomationManager, type Lang } from './automations';
import type { BoardService } from './board';
import type { BotManager } from './bots';
import type { RunnerManager } from './runner';
import { TelegramBot } from './telegram';

const TOKEN_KEY = 'telegram.token';
/** One answer from an agent can't take forever (designing a diagram). */
const ONE_SHOT_MS = 4 * 60_000;

interface Saved {
  chatId: number | null;
  chatName: string | null;
  keepAwake: boolean;
}

/**
 * Everything automations need from the app: the agents, the Board, your Mac's notifications, your
 * phone (Telegram), and staying awake while they run.
 */
export class AutomationHost {
  readonly manager: AutomationManager;
  private telegram: TelegramBot | null = null;
  private username: string | null = null;
  private saved: Saved = { chatId: null, chatName: null, keepAwake: true };
  private blocker: number | null = null;
  /** Agents' permission requests sent to your phone, by the key on its buttons. */
  private readonly permissions = new Map<string, { runId: string; requestId: string; choices: Array<{ id: string; label: string }> }>();
  /** A question's choices, by its key: the phone answers with their position. */
  private readonly choices = new Map<string, string[]>();

  constructor(
    private readonly dir: string,
    private readonly deps: {
      bots: BotManager;
      runner: RunnerManager;
      board: BoardService;
      secrets: SecretStore;
      send: (channel: string, payload: unknown) => void;
      channel: string;
      lang: () => Lang;
      /** Brings the window up on an automation (a notification was clicked). */
      show: (automationId: string | null) => void;
    },
  ) {
    try {
      this.saved = { ...this.saved, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>) };
    } catch {
      // first time
    }
    const { bots, runner, board } = deps;
    this.manager = new AutomationManager(
      { automations: join(dir, 'automations.json'), runs: join(dir, 'automation-runs.json') },
      {
        configs: () => bots.listConfigs(),
        startSolo: (input) => bots.startSolo(input),
        team: (id) => bots.team(id),
        watch: (fn) => bots.watch(fn),
        stopTeam: (id) => bots.stop(id),
        changes: (teamId, botId) => bots.changesOf(teamId, botId),
        apply: (teamId, botId) => bots.apply(teamId, botId),
        board,
        notify: (m) => this.notify(m.title, m.body, m.ask ? { key: m.ask.key, choices: m.ask.choices } : undefined, m.automationId),
        resolved: (key, choice) => void this.telegram?.resolve(key, choice),
        oneShot: (prompt, cwd, agent) => this.oneShot(prompt, cwd, agent),
        emit: (state) => {
          deps.send(deps.channel, state);
          this.stayAwake();
        },
        lang: deps.lang,
      },
    );
    // Agents of an automation asking for permission: to your phone too, with its buttons.
    runner.observe((m) => this.onRunEvent(m));
  }

  private get file() {
    return join(this.dir, 'automation-settings.json');
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify(this.saved));
    } catch {
      // kept in memory
    }
  }

  async start() {
    const token = await this.deps.secrets.get(TOKEN_KEY);
    if (token) await this.connect(token, false).catch(() => {});
    this.manager.start();
    this.stayAwake();
  }

  stop() {
    this.manager.stopAll();
    void this.telegram?.stop();
    if (this.blocker != null) powerSaveBlocker.stop(this.blocker);
    this.blocker = null;
  }

  settings(): AutomationSettings {
    return {
      telegram: { connected: !!this.telegram, username: this.username, chatName: this.saved.chatName, paired: this.saved.chatId != null },
      openAtLogin: app.getLoginItemSettings().openAtLogin,
      keepAwake: this.saved.keepAwake,
    };
  }

  setOptions(patch: { openAtLogin?: unknown; keepAwake?: unknown }): AutomationSettings {
    // Opening at login, and staying open with its window closed, keeps the automations going.
    if (typeof patch.openAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: patch.openAtLogin });
    if (typeof patch.keepAwake === 'boolean') {
      this.saved.keepAwake = patch.keepAwake;
      this.persist();
      this.stayAwake();
    }
    return this.settings();
  }

  /** While an automation is on or running, the Mac doesn't sleep (the screen still may). */
  private stayAwake() {
    const want = this.saved.keepAwake && this.manager.busy();
    if (want && this.blocker == null) this.blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!want && this.blocker != null) {
      powerSaveBlocker.stop(this.blocker);
      this.blocker = null;
    }
  }

  /** Checks the bot's token and starts listening for your answers; `null` disconnects. */
  async connect(token: string | null, save = true): Promise<{ ok: boolean; error?: string; settings: AutomationSettings }> {
    await this.telegram?.stop();
    this.telegram = null;
    this.username = null;
    if (!token) {
      if (save) {
        await this.deps.secrets.set(TOKEN_KEY, null);
        this.saved.chatId = null;
        this.saved.chatName = null;
        this.persist();
      }
      return { ok: true, settings: this.settings() };
    }
    const bot = new TelegramBot({
      token: token.trim(),
      chatId: this.saved.chatId,
      onAnswer: (key, choiceId) => this.onAnswer(key, choiceId),
      onChat: (chatId, name) => {
        this.saved.chatId = chatId;
        this.saved.chatName = name;
        this.persist();
      },
      onError: (message) => console.error('[telegram]', message),
    });
    const check = await bot.check();
    if (!check.ok) return { ok: false, error: check.error, settings: this.settings() };
    this.telegram = bot;
    this.username = check.username;
    if (save) await this.deps.secrets.set(TOKEN_KEY, token.trim());
    bot.start();
    return { ok: true, settings: this.settings() };
  }

  /** Finds your chat with the bot (after you sent it /start). */
  async pair(): Promise<AutomationSettings> {
    if (!this.telegram) throw new Error('Connect your Telegram bot first');
    const chat = await this.telegram.pair();
    if (!chat) throw new Error('Send /start to your bot in Telegram, then try again');
    return this.settings();
  }

  async test(): Promise<boolean> {
    const text = this.deps.lang() === 'es' ? '✓ Alchemist Coder: así te llegarán los avisos de tus automatizaciones.' : "✓ Alchemist Coder: this is how your automations' notices will reach you.";
    return (await this.telegram?.send(text)) ?? false;
  }

  /**
   * A message for you: a notification on the Mac (it opens the automation) and one on your phone. A
   * question carries its choices as buttons on the phone.
   */
  private notify(title: string, body: string, ask?: { key: string; choices: string[] }, automationId?: string | null) {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body: body.slice(0, 300), silent: !ask });
      n.on('click', () => this.deps.show(automationId ?? null));
      n.show();
    }
    if (!this.telegram || this.saved.chatId == null) return;
    const text = `${title}\n\n${body}`;
    if (ask) {
      this.choices.set(ask.key, ask.choices);
      void this.telegram.ask({ id: ask.key, text, choices: ask.choices.map((label, i) => ({ id: String(i), label })) }).catch(() => {});
    } else void this.telegram.send(text);
  }

  private onAnswer(key: string, choiceId: string) {
    const perm = this.permissions.get(key);
    if (perm) {
      this.permissions.delete(key);
      // The phone's buttons carry the choice's position.
      const choice = perm.choices[Number(choiceId)];
      if (choice) this.deps.runner.respond(perm.runId, perm.requestId, choice.id);
      return;
    }
    const label = this.choices.get(key)?.[Number(choiceId)];
    this.choices.delete(key);
    const [runId, askId] = key.split(':');
    if (label && runId && askId) this.manager.answer(runId, askId, label, true);
  }

  private onRunEvent({ runId, event }: RunnerEventMessage) {
    if (event.type !== 'permission' && event.type !== 'permissionClosed') return;
    const of = this.deps.bots.botOfRun(runId);
    if (!of?.team.origin) return;
    if (event.type === 'permissionClosed') {
      // Answered in the app: the phone's buttons go away.
      for (const [key, p] of this.permissions) {
        if (p.runId !== runId || p.requestId !== event.requestId) continue;
        this.permissions.delete(key);
        void this.telegram?.resolve(key, this.deps.lang() === 'es' ? 'respondido' : 'answered');
      }
      return;
    }
    const bot = of.team.bots.find((b) => b.id === of.botId);
    const key = `perm:${randomBytes(6).toString('hex')}`;
    const choices = event.choices.slice(0, 4).map((c) => ({ id: c.id, label: c.label }));
    this.permissions.set(key, { runId, requestId: event.requestId, choices });
    const es = this.deps.lang() === 'es';
    const title = `${of.team.origin.label}: ${bot?.name ?? (es ? 'Un agente' : 'An agent')} ${es ? 'pide permiso' : 'asks for permission'}`;
    if (Notification.isSupported()) {
      const n = new Notification({ title, body: event.title });
      n.on('click', () => this.deps.show(of.team.origin!.automationId));
      n.show();
    }
    if (this.telegram && this.saved.chatId != null) {
      // Choice ids can be long: the buttons carry their position.
      void this.telegram.ask({ id: key, text: `${title}\n\n${event.title}${event.content ? `\n\n${event.content.slice(0, 1500)}` : ''}`, choices: choices.map((c, i) => ({ id: String(i), label: c.label })) }).catch(() => {});
    }
  }

  /** One answer from an agent, read-only, no tools of the app (to draw a diagram from your words). */
  private oneShot(prompt: string, cwd: string, agent: BotConfig): Promise<string> {
    const { runner } = this.deps;
    return new Promise((resolve, reject) => {
      let text = '';
      let runId = '';
      const finish = (ok: boolean, why?: string) => {
        clearTimeout(timer);
        off();
        runner.stop(runId);
        if (ok) resolve(text);
        else reject(new Error(why || 'The agent stopped before answering'));
      };
      const timer = setTimeout(() => finish(false, 'The agent took too long to answer'), ONE_SHOT_MS);
      const off = runner.observe((m) => {
        if (m.runId !== runId) return;
        const e = m.event;
        if (e.type === 'text') text += e.text;
        // It only has to answer: anything it asks to do is refused.
        else if (e.type === 'permission') runner.respond(runId, e.requestId, e.choices.find((c) => c.kind.startsWith('reject'))?.id ?? null);
        else if (e.type === 'result') finish(e.ok || !!text, 'The agent failed to answer');
        else if (e.type === 'status' && (e.status === 'error' || e.status === 'interrupted')) finish(!!text);
      });
      try {
        runId = runner.start({ cwd, harnessId: agent.agent.harnessId, providerId: agent.agent.providerId, model: agent.agent.model, prompt, permissionMode: 'default' }).runId;
      } catch (e) {
        clearTimeout(timer);
        off();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  list(): AutomationState[] {
    return this.manager.list();
  }
}
