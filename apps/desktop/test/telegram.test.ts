import { describe, expect, it } from 'vitest';
import { TelegramBot, type TelegramBotOptions } from '../src/main/telegram';

const TOKEN = '123456789:AAH-secret_token_value';
const ME = 42;
const OTHER = 99;

type Reply = { status?: number; body: unknown } | ((signal: AbortSignal | undefined) => Promise<Response>);

/** Never answers until aborted, like a long poll with nothing new. */
const hang = (signal: AbortSignal | undefined) =>
  new Promise<Response>((_, reject) => {
    const fail = () => reject(signal?.reason ?? new Error('aborted'));
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });

/** A Bot API stand-in: records every call and plays scripted replies per method. */
function fakeTelegram() {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown>; signal?: AbortSignal }> = [];
  const scripts = new Map<string, Reply[]>();
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop() ?? '';
    const signal = init?.signal ?? undefined;
    calls.push({ method, url: String(url), body: JSON.parse(String(init?.body ?? '{}')), signal });
    const next = scripts.get(method)?.shift();
    if (typeof next === 'function') return next(signal);
    if (!next && method === 'getUpdates') return hang(signal);
    const reply = next ?? { body: { ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return {
    fetch: fakeFetch,
    calls,
    of: (method: string) => calls.filter((c) => c.method === method),
    script(method: string, ...replies: Reply[]) {
      scripts.set(method, [...(scripts.get(method) ?? []), ...replies]);
    },
  };
}

function setup(opts: Partial<TelegramBotOptions> = {}) {
  const tg = fakeTelegram();
  const answers: Array<[string, string, string]> = [];
  const chats: Array<[number, string]> = [];
  const errors: string[] = [];
  const bot = new TelegramBot({
    token: TOKEN,
    chatId: ME,
    fetch: tg.fetch,
    onAnswer: (askId, choiceId, by) => void answers.push([askId, choiceId, by]),
    onChat: (chatId, name) => void chats.push([chatId, name]),
    onError: (message) => void errors.push(message),
    pollSeconds: 0,
    backoff: { min: 5, max: 20 },
    ...opts,
  });
  return { bot, tg, answers, chats, errors };
}

const ok = (result: unknown) => ({ body: { ok: true, result } });

const tap = (updateId: number, chatId: number, data: string, messageId = 7) => ({
  update_id: updateId,
  callback_query: { id: `cq-${updateId}`, from: { id: chatId, first_name: 'Ana' }, message: { message_id: messageId, chat: { id: chatId, type: 'private' } }, data },
});

const deploy = { id: 'a1', text: 'Deploy to production?', choices: [{ id: 'yes', label: 'Aprobar' }, { id: 'no', label: 'Rechazar' }] };

async function until(cond: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('check', () => {
  it('returns the bot username', async () => {
    const { bot, tg } = setup();
    tg.script('getMe', ok({ id: 1, is_bot: true, username: 'mi_alchemist_bot' }));
    expect(await bot.check()).toEqual({ ok: true, username: 'mi_alchemist_bot' });
    expect(tg.calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it('reports a bad token (401) without leaking it', async () => {
    const { bot, tg } = setup();
    tg.script('getMe', { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
    const result = await bot.check();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/token/i);
    expect(result.error).not.toContain(TOKEN);
  });

  it('scrubs the token from network errors that echo the URL', async () => {
    const { bot, tg } = setup();
    tg.script('getMe', async () => {
      throw new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/getMe`);
    });
    const result = await bot.check();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('rejects something that is not a token without calling Telegram', async () => {
    const { bot, tg } = setup({ token: 'not a token/../x' });
    expect((await bot.check()).ok).toBe(false);
    expect(tg.calls).toHaveLength(0);
  });
});

describe('pair', () => {
  it('takes the private chat of the latest message', async () => {
    const { bot, tg, chats } = setup({ chatId: null });
    tg.script(
      'getUpdates',
      ok([
        { update_id: 1, message: { message_id: 1, chat: { id: 7, type: 'private', first_name: 'Old' }, text: '/start' } },
        { update_id: 2, message: { message_id: 2, chat: { id: 8, type: 'private', first_name: 'Ana', last_name: 'Pérez' }, text: '/start' } },
        { update_id: 3, message: { message_id: 3, chat: { id: -100, type: 'group', title: 'Team' }, text: 'hi' } },
        tap(4, 8, 'x|y'),
      ]),
    );
    expect(await bot.pair()).toEqual({ chatId: 8, name: 'Ana Pérez' });
    expect(bot.chatId).toBe(8);
    expect(chats).toEqual([[8, 'Ana Pérez']]);
    // A peek: nothing confirmed, nothing waited for.
    expect(tg.calls[0]?.body.offset).toBeUndefined();
    expect(tg.calls[0]?.body.timeout).toBe(0);
  });

  it('returns null when nobody wrote to the bot', async () => {
    const { bot, tg, chats } = setup({ chatId: null });
    tg.script('getUpdates', ok([]));
    expect(await bot.pair()).toBeNull();
    expect(bot.chatId).toBeNull();
    expect(chats).toEqual([]);
  });
});

describe('send', () => {
  it('does nothing until paired', async () => {
    const { bot, tg } = setup({ chatId: null });
    expect(await bot.send('hola')).toBe(false);
    expect(tg.calls).toHaveLength(0);
  });

  it('sends to the paired chat, cut to 4096 characters', async () => {
    const { bot, tg } = setup();
    expect(await bot.send('x'.repeat(5000))).toBe(true);
    const body = tg.of('sendMessage')[0]?.body;
    expect(body?.chat_id).toBe(ME);
    expect(String(body?.text)).toHaveLength(4096);
    expect(String(body?.text).endsWith('…')).toBe(true);
  });

  it('returns false on errors and reports them', async () => {
    const { bot, tg, errors } = setup();
    tg.script('sendMessage', { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });
    expect(await bot.send('hola')).toBe(false);
    expect(errors).toEqual(['Telegram error 400: Bad Request: chat not found']);
  });
});

describe('ask', () => {
  it('sends one row of buttons carrying ask|choice', async () => {
    const { bot, tg } = setup();
    expect(await bot.ask(deploy)).toBe(true);
    expect(tg.of('sendMessage')[0]?.body).toEqual({
      chat_id: ME,
      text: 'Deploy to production?',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Aprobar', callback_data: 'a1|yes' },
            { text: 'Rechazar', callback_data: 'a1|no' },
          ],
        ],
      },
    });
  });

  it('throws when callback data would pass 64 bytes (counted in bytes)', async () => {
    const { bot, tg } = setup();
    // 31 two-byte letters + "|x" is exactly 64 bytes; one more letter is too many.
    expect(await bot.ask({ id: 'ñ'.repeat(31), text: 'ok', choices: [{ id: 'x', label: 'X' }] })).toBe(true);
    await expect(bot.ask({ id: 'ñ'.repeat(32), text: 'too long', choices: [{ id: 'x', label: 'X' }] })).rejects.toThrow(/64/);
    await expect(bot.ask({ id: 'a|b', text: 'bad id', choices: [{ id: 'x', label: 'X' }] })).rejects.toThrow(/\|/);
    expect(tg.of('sendMessage')).toHaveLength(1);
  });
});

describe('poll loop', () => {
  it('delivers a tap from the paired chat once and ignores other chats', async () => {
    const { bot, tg, answers } = setup();
    tg.script('sendMessage', ok({ message_id: 7 }));
    await bot.ask(deploy);
    tg.script('getUpdates', ok([tap(10, OTHER, 'a1|yes'), tap(11, ME, 'a1|yes')]), ok([tap(12, ME, 'a1|no')]));
    bot.start();
    await until(() => tg.of('getUpdates').length >= 3);
    await bot.stop();

    expect(answers).toEqual([['a1', 'yes', 'Ana']]);
    expect(tg.calls.map((c) => c.method)).toEqual([
      'sendMessage',
      'getUpdates',
      'answerCallbackQuery', // the other chat's tap: answered, nothing else
      'answerCallbackQuery',
      'editMessageText',
      'getUpdates',
      'answerCallbackQuery', // the second tap on the same question
      'getUpdates',
    ]);
    // Every tap is answered so no spinner is left on the phone.
    expect(tg.of('answerCallbackQuery').map((c) => c.body.callback_query_id)).toEqual(['cq-10', 'cq-11', 'cq-12']);
    expect(tg.of('answerCallbackQuery')[0]?.body.text).toBeUndefined();
    expect(tg.of('answerCallbackQuery')[2]?.body.text).toMatch(/pendiente/);
    expect(tg.of('editMessageText').map((c) => c.body)).toEqual([
      { chat_id: ME, message_id: 7, text: 'Deploy to production?\n\n✓ Aprobar', reply_markup: { inline_keyboard: [] } },
    ]);
    const polls = tg.of('getUpdates').map((c) => c.body);
    expect(polls[0]).toEqual({ timeout: 0, allowed_updates: ['message', 'callback_query'] });
    expect(polls.slice(1).map((b) => b.offset)).toEqual([12, 13]);
  });

  it('reports the tap after the phone was updated', async () => {
    let seenWhenAnswered: string[] = [];
    const { bot, tg } = setup({ onAnswer: () => void (seenWhenAnswered = tg.calls.map((c) => c.method)) });
    tg.script('sendMessage', ok({ message_id: 7 }));
    await bot.ask(deploy);
    tg.script('getUpdates', ok([tap(1, ME, 'a1|no')]));
    await bot.pollOnce();
    expect(seenWhenAnswered).toEqual(['sendMessage', 'getUpdates', 'answerCallbackQuery', 'editMessageText']);
    expect(tg.of('editMessageText')[0]?.body.text).toBe('Deploy to production?\n\n✓ Rechazar');
  });

  it('ignores taps for unknown asks, stale messages and unknown choices', async () => {
    const { bot, tg, answers } = setup();
    tg.script('sendMessage', ok({ message_id: 7 }));
    await bot.ask(deploy);
    tg.script('getUpdates', ok([tap(1, ME, 'zz|yes'), tap(2, ME, 'a1|yes', 6), tap(3, ME, 'a1|maybe'), tap(4, ME, 'garbage')]));
    await bot.pollOnce();
    expect(answers).toEqual([]);
    expect(tg.of('answerCallbackQuery')).toHaveLength(4);
    expect(tg.of('editMessageText')).toHaveLength(0);
  });

  it('ignores every tap while not paired', async () => {
    const { bot, tg, answers } = setup({ chatId: null });
    tg.script('getUpdates', ok([tap(1, ME, 'a1|yes')]));
    await bot.pollOnce();
    expect(answers).toEqual([]);
    expect(tg.of('answerCallbackQuery')).toHaveLength(1);
  });

  it('stop() ends a waiting long poll right away', async () => {
    const { bot, tg } = setup({ pollSeconds: 25 });
    bot.start();
    await until(() => tg.of('getUpdates').length === 1);
    expect(tg.of('getUpdates')[0]?.body.timeout).toBe(25);
    const started = Date.now();
    await bot.stop();
    expect(Date.now() - started).toBeLessThan(100);
    expect(tg.of('getUpdates')[0]?.signal?.aborted).toBe(true);
    expect(bot.polling).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(tg.of('getUpdates')).toHaveLength(1);
  });

  it('stops for good on a bad token (401) and says so', async () => {
    const { bot, tg, errors } = setup();
    tg.script('getUpdates', { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
    bot.start();
    await until(() => errors.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(bot.polling).toBe(false);
    expect(tg.of('getUpdates')).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/token/i);
    expect(errors.join()).not.toContain(TOKEN);
  });

  it('backs off on 409 and network errors, then carries on', async () => {
    const { bot, tg, answers, errors } = setup();
    tg.script('sendMessage', ok({ message_id: 7 }));
    await bot.ask(deploy);
    tg.script(
      'getUpdates',
      { status: 409, body: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' } },
      async () => {
        throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getUpdates`);
      },
      ok([tap(5, ME, 'a1|yes')]),
    );
    bot.start();
    await until(() => answers.length === 1);
    await bot.stop();
    expect(tg.of('getUpdates').length).toBeGreaterThanOrEqual(3);
    // Once per streak of failures, not on every retry.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/409/);
  });
});

describe('resolve', () => {
  it('takes the buttons away and says it was answered in the app', async () => {
    const { bot, tg, answers } = setup();
    tg.script('sendMessage', ok({ message_id: 7 }));
    await bot.ask(deploy);
    expect(await bot.resolve('a1', 'Aprobar')).toBe(true);
    expect(tg.of('editMessageText').map((c) => c.body)).toEqual([
      { chat_id: ME, message_id: 7, text: 'Deploy to production?\n\n✓ Aprobar (en la app)', reply_markup: { inline_keyboard: [] } },
    ]);
    // A late tap on the phone no longer counts.
    tg.script('getUpdates', ok([tap(1, ME, 'a1|no')]));
    await bot.pollOnce();
    expect(answers).toEqual([]);
    expect(await bot.resolve('a1', 'Aprobar')).toBe(false);
    expect(tg.of('editMessageText')).toHaveLength(1);
  });

  it('keeps the outcome line when the question is very long', async () => {
    const { bot, tg } = setup();
    tg.script('sendMessage', ok({ message_id: 7 }));
    await bot.ask({ ...deploy, text: 'y'.repeat(5000) });
    await bot.resolve('a1', 'Rechazar');
    const text = String(tg.of('editMessageText')[0]?.body.text);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.endsWith('\n\n✓ Rechazar (en la app)')).toBe(true);
  });
});
