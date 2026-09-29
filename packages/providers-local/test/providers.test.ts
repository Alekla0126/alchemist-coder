import { describe, expect, it } from 'vitest';
import { EndpointNotAllowedError, lmStudioProvider, ollamaProvider } from '../src/index.ts';

const fakeFetch = (routes: Record<string, unknown>) =>
  (async (url: string | URL | Request) => {
    const key = String(url);
    if (!(key in routes)) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;

describe('local providers', () => {
  it('refuse cloud endpoints in the Community edition', () => {
    expect(() => ollamaProvider({ baseUrl: 'https://api.moonshot.ai/anthropic' })).toThrow(EndpointNotAllowedError);
    expect(() => lmStudioProvider({ baseUrl: 'http://192.168.1.40:1234/' })).not.toThrow();
  });

  it('lists Ollama models and reports status', async () => {
    const p = ollamaProvider({ fetch: fakeFetch({ 'http://localhost:11434/api/tags': { models: [{ name: 'qwen2.5-coder:7b', size: 4.7e9 }] }, 'http://localhost:11434/api/version': { version: '0.34.4' } }) });
    expect(await p.models()).toEqual([{ id: 'qwen2.5-coder:7b', label: 'qwen2.5-coder:7b · 4.7 GB' }]);
    expect(await p.status!()).toEqual({ available: true, detail: 'Ollama 0.34.4' });
    const down = ollamaProvider({ fetch: fakeFetch({}) });
    expect((await down.status!()).available).toBe(false);
  });

  it('points Claude Code at the local server and blanks cloud keys', async () => {
    const env = await ollamaProvider().env('qwen2.5-coder:7b');
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_API_KEY: '', ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen2.5-coder:7b', ENABLE_TOOL_SEARCH: 'false' });
    expect(ollamaProvider().cliArgs!('codex', 'gpt-oss:20b')).toEqual(['-c', 'model_provider="ollama"', '-m', 'gpt-oss:20b']);
  });

  it('configures the Codex ACP adapter through CODEX_CONFIG', async () => {
    const env = await ollamaProvider().env('gpt-oss:20b', 'codex');
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({ model_provider: 'ollama', model: 'gpt-oss:20b' });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
