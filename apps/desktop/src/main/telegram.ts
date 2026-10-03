import { setTimeout as wait } from 'node:timers/promises';

/**
 * Reaches the user on their phone through their own Telegram bot (made with @BotFather). Talks to
 * the Bot API directly with long polling, so there is no server and no webhook: notices go out
 * with send(), questions with buttons with ask(), and taps come back through onAnswer.
 */

const API = 'https://api.telegram.org';
/** Telegram's limits: message text (UTF-16 units) and callback_data (bytes). */
export const TEXT_LIMIT = 4096;
export const CALLBACK_LIMIT = 64;
const ALLOWED_UPDATES = ['message', 'callback_query'];
const POLL_SECONDS = 25;
/** Extra time over the long-poll before a request counts as hung (sleep, network change). */
const SLACK_MS = 10_000;
const CALL_MS = 15_000;
const BACKOFF = { min: 2_000, max: 60_000 };
/** Questions remembered for their buttons; older ones are forgotten (24/7 runs). */
const MAX_ASKS = 200;

export interface TelegramChoice {
  id: string;
  label: string;
}

export interface TelegramAsk {
  id: string;
  text: string;
  choices: TelegramChoice[];
}

export interface TelegramBotOptions {
  token: string;
  chatId: number | null;
  fetch?: typeof fetch;
  onAnswer: (askId: string, choiceId: string, by: string) => void;
  onChat?: (chatId: number, name: string) => void;
  onError?: (message: string) => void;
  /** Long-poll seconds; tests use 0. */
  pollSeconds?: number;
  /** Retry delays in ms; tests shrink them. */
  backoff?: { min: number; max: number };
}

interface Chat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface Message {
  message_id: number;
  chat: Chat;
}

interface CallbackQuery {
  id: string;
  from: { id: number; first_name?: string };
  message?: Message;
  data?: string;
}

interface Update {
  update_id: number;
  message?: Message;
  callback_query?: CallbackQuery;
}

interface PendingAsk {
  messageId: number;
  text: string;
  choices: TelegramChoice[];
}

/** A failed Bot API call; status 0 means it never got an answer (network). */
class TelegramError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}

/** Cuts text to Telegram's limit without splitting an emoji in half. */
function clip(text: string, max = TEXT_LIMIT): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

const chatName = (chat: Chat) => [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'Telegram';

export class TelegramBot {
  /** The bot's own chat with you, once you sent it /start. */
  chatId: number | null;
  private readonly token: string;
  private readonly fetch: typeof fetch;
  private readonly opts: TelegramBotOptions;
  private readonly pollSeconds: number;
  private readonly backoff: { min: number; max: number };
  private readonly asks = new Map<string, PendingAsk>();
  /** Next update to read; Telegram forgets everything before it once we ask with it. */
  private offset = 0;
  private delay = 0;
  /** The latest private chat the poll loop saw, so pair() still works while polling. */
  private lastPrivate: Chat | null = null;
  private abort: AbortController | null = null;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(opts: TelegramBotOptions) {
    this.opts = opts;
    this.token = opts.token.trim();
    this.chatId = opts.chatId;
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.pollSeconds = opts.pollSeconds ?? POLL_SECONDS;
    this.backoff = opts.backoff ?? BACKOFF;
  }

  get polling(): boolean {
    return this.abort !== null;
  }

  /** Whether the token works, and the bot's @username. */
  async check(): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
    try {
      const me = await this.call<{ username?: string }>('getMe', {});
      return { ok: true, username: me.username ?? '' };
    } catch (err) {
      return { ok: false, error: this.describe(err) };
    }
  }

  /** Takes the private chat of the latest message sent to the bot (the user's /start) as ours. */
  async pair(): Promise<{ chatId: number; name: string } | null> {
    let chat = this.lastPrivate;
    // While polling, the loop already sees every message, and a second reader would clash (409).
    if (!this.polling) {
      try {
        // Reads without moving the offset, so the poll loop still gets every button tap.
        const updates = await this.call<Update[]>('getUpdates', { offset: this.offset || undefined, timeout: 0, allowed_updates: ALLOWED_UPDATES });
        for (const u of updates) if (u.message?.chat.type === 'private') chat = u.message.chat;
      } catch (err) {
        this.report(err);
      }
    }
    if (!chat) return null;
    const name = chatName(chat);
    this.chatId = chat.id;
    this.opts.onChat?.(chat.id, name);
    return { chatId: chat.id, name };
  }

  /** A plain notice. False when not paired or Telegram could not be reached. */
  async send(text: string): Promise<boolean> {
    if (this.chatId === null) return false;
    try {
      await this.call('sendMessage', { chat_id: this.chatId, text: clip(text) });
      return true;
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  /** A question with one button per choice; the tap comes back through onAnswer. */
  async ask(ask: TelegramAsk): Promise<boolean> {
    // Ids that do not fit are a bug in the caller, not a runtime condition.
    if (ask.id.includes('|')) throw new Error(`Telegram ask id "${ask.id}" must not contain "|".`);
    const buttons = ask.choices.map((choice) => {
      const data = `${ask.id}|${choice.id}`;
      const bytes = Buffer.byteLength(data, 'utf8');
      if (bytes > CALLBACK_LIMIT) throw new Error(`Telegram callback data "${data}" is ${bytes} bytes; the limit is ${CALLBACK_LIMIT}. Use shorter ask or choice ids.`);
      return { text: choice.label, callback_data: data };
    });
    if (this.chatId === null) return false;
    try {
      const sent = await this.call<Message>('sendMessage', { chat_id: this.chatId, text: clip(ask.text), reply_markup: { inline_keyboard: [buttons] } });
      this.asks.delete(ask.id);
      this.asks.set(ask.id, { messageId: sent.message_id, text: ask.text, choices: ask.choices });
      if (this.asks.size > MAX_ASKS) this.asks.delete(this.asks.keys().next().value as string);
      return true;
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  /** The question was answered in the app: take its buttons away on the phone too. */
  async resolve(askId: string, label: string): Promise<boolean> {
    const ask = this.asks.get(askId);
    if (!ask) return false;
    this.asks.delete(askId);
    return this.close(ask, `✓ ${label} (en la app)`);
  }

  start(): void {
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    this.loopDone = this.loop(abort.signal);
  }

  /** Ends polling right away; resolves once the loop has exited. */
  stop(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    return this.loopDone;
  }

  /** One round of the poll loop: read new updates and handle them. */
  async pollOnce(signal?: AbortSignal): Promise<void> {
    const updates = await this.call<Update[]>(
      'getUpdates',
      { offset: this.offset || undefined, timeout: this.pollSeconds, allowed_updates: ALLOWED_UPDATES },
      signal,
      this.pollSeconds * 1000 + SLACK_MS,
    );
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      if (u.callback_query) await this.onCallback(u.callback_query);
      else if (u.message?.chat.type === 'private') this.lastPrivate = u.message.chat;
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
        this.delay = 0;
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof TelegramError && err.status === 401) {
          // A bad token never fixes itself; retrying would only hammer Telegram.
          this.report(err);
          if (this.abort?.signal === signal) this.abort = null;
          break;
        }
        // Say it once per streak, not on every retry.
        if (this.delay === 0) this.report(err);
        this.delay = this.delay ? Math.min(this.delay * 2, this.backoff.max) : this.backoff.min;
        const retryAfter = err instanceof TelegramError ? err.retryAfter * 1000 : 0;
        await wait(Math.max(this.delay, retryAfter), undefined, { signal }).catch(() => {});
      }
    }
  }

  private async onCallback(cq: CallbackQuery): Promise<void> {
    const ours = this.chatId !== null && cq.message?.chat.id === this.chatId;
    const [askId = '', choiceId = ''] = splitOnce(cq.data ?? '');
    const ask = ours ? this.asks.get(askId) : undefined;
    const choice = ask?.choices.find((c) => c.id === choiceId);
    if (!ask || !choice || ask.messageId !== cq.message?.message_id) {
      // Always answer, or the button keeps spinning on the phone.
      await this.quiet('answerCallbackQuery', { callback_query_id: cq.id, text: ours ? 'Esta pregunta ya no está pendiente.' : undefined });
      return;
    }
    // Forget it before any await, so a double tap counts once.
    this.asks.delete(askId);
    await this.quiet('answerCallbackQuery', { callback_query_id: cq.id });
    await this.close(ask, `✓ ${choice.label}`);
    this.opts.onAnswer(askId, choiceId, cq.from.first_name ?? '');
  }

  /** Rewrites the question with its outcome and no buttons. */
  private close(ask: PendingAsk, outcome: string): Promise<boolean> {
    const tail = `\n\n${outcome}`;
    return this.quiet('editMessageText', {
      chat_id: this.chatId,
      message_id: ask.messageId,
      text: clip(ask.text, TEXT_LIMIT - tail.length) + tail,
      reply_markup: { inline_keyboard: [] },
    });
  }

  /** A call whose failure only costs a cosmetic detail on the phone. */
  private async quiet(method: string, body: Record<string, unknown>): Promise<boolean> {
    try {
      await this.call(method, body);
      return true;
    } catch {
      return false;
    }
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = CALL_MS): Promise<T> {
    // Anything else would end up in the URL path, and is not a token anyway.
    if (!/^\d+:[\w-]+$/.test(this.token)) throw new TelegramError(401, 'Not a bot token.');
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new TelegramError(0, timeout.aborted ? 'Telegram did not answer in time.' : `Could not reach Telegram: ${this.scrub(err)}`);
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null;
    if (!data) throw new TelegramError(res.ok ? 0 : res.status, `Telegram sent an unreadable answer (HTTP ${res.status}).`);
    if (res.ok && data.ok) return data.result as T;
    throw new TelegramError(data.error_code ?? res.status, this.scrub(data.description ?? `HTTP ${res.status}`), data.parameters?.retry_after ?? 0);
  }

  private describe(err: unknown): string {
    if (!(err instanceof TelegramError)) return this.scrub(err);
    if (err.status === 401 || err.status === 404) return `The bot token is not valid (${err.status}). Copy it again from @BotFather.`;
    if (err.status === 409) return 'Another program is already reading this bot (409). Close it or use a different bot.';
    return err.status ? `Telegram error ${err.status}: ${err.message}` : err.message;
  }

  private report(err: unknown): void {
    this.opts.onError?.(this.describe(err));
  }

  /** Never let the token out, even inside an error from fetch itself. */
  private scrub(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    return this.token ? text.replaceAll(this.token, '<token>') : text;
  }
}

function splitOnce(data: string): [string, string] | [] {
  const at = data.indexOf('|');
  return at < 0 ? [] : [data.slice(0, at), data.slice(at + 1)];
}
