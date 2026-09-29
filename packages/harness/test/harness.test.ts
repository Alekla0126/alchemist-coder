import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { ProviderAdapter, RunnerEvent } from '@alchemist-coder/core';
import { claudeCodeHarness, codexHarness, parseClaudeLine, parseCodexLine, type SpawnFn } from '../src/index.ts';

const provider: ProviderAdapter = {
  id: 'ollama', label: 'Ollama', edition: 'community', harnesses: ['claude-code', 'codex'],
  capabilities: { toolSearch: false, webFetch: true, webSearch: false, subagents: true },
  models: async () => [],
  env: async (model) => ({ ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_MODEL: model }),
  cliArgs: (h, model) => (h === 'codex' ? ['-c', 'model_provider="ollama"', '-m', model] : ['--model', model]),
};

/** A fake child process that replays canned stdout lines and records stdin/args. */
function fakeSpawn(lines: string[], calls: Array<{ args: string[]; env: Record<string, string> }>, stdinSink: string[]): SpawnFn {
  return ((_bin: string, args: string[], opts: { env: Record<string, string> }) => {
    calls.push({ args, env: opts.env });
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.on('data', (d) => stdinSink.push(String(d)));
    Object.assign(child, { stdout, stderr, stdin, kill: () => child.emit('exit', null) });
    setTimeout(() => {
      for (const l of lines) stdout.write(`${l}\n`);
      stdout.end();
      setTimeout(() => child.emit('exit', 0), 10);
    }, 5);
    return child;
  }) as unknown as SpawnFn;
}

const collect = (handle: { onEvent(l: (e: RunnerEvent) => void): () => void }) =>
  new Promise<RunnerEvent[]>((resolve) => {
    const events: RunnerEvent[] = [];
    handle.onEvent((e) => {
      events.push(e);
      if (e.type === 'status' && e.status !== 'running') resolve(events);
    });
  });

describe('stream parsers', () => {
  it('parses Claude stream-json, preferring partial deltas over full text', () => {
    const st = { streamed: false };
    expect(parseClaudeLine('{"type":"system","subtype":"init","session_id":"s1","model":"qwen"}', st)).toEqual([{ type: 'started', sessionId: 's1', model: 'qwen' }]);
    expect(parseClaudeLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}', st)).toEqual([{ type: 'text', text: 'Hi' }]);
    expect(parseClaudeLine('{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"},{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}', st)).toEqual([{ type: 'tool', name: 'Bash', summary: 'ls -la' }]);
    expect(parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"session_id":"s1","total_cost_usd":0}', st)).toEqual([{ type: 'result', ok: true, sessionId: 's1', costUsd: 0 }]);
    expect(parseClaudeLine('not json', st)).toEqual([]);
  });

  it('parses codex exec --json events', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"t1"}')).toEqual([{ type: 'started', sessionId: 't1' }]);
    expect(parseCodexLine('{"type":"item.started","item":{"type":"command_execution","command":"bash -lc ls"}}')).toEqual([{ type: 'tool', name: 'shell', summary: 'bash -lc ls' }]);
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}')).toEqual([{ type: 'text', text: 'Done' }]);
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"model not found"}}')[0]).toEqual({ type: 'error', message: 'model not found' });
  });
});

describe('harness adapters', () => {
  it('drives claude headless with resume and sends the prompt over stdin', async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const stdin: string[] = [];
    const lines = ['{"type":"system","subtype":"init","session_id":"abc"}', '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}', '{"type":"result","subtype":"success","session_id":"abc"}'];
    const run = claudeCodeHarness({ spawn: fakeSpawn(lines, calls, stdin) }).run({ cwd: '/tmp', prompt: 'Say OK', provider, model: 'qwen2.5-coder:7b', resumeSessionId: 'abc' });
    const events = await collect(run);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--resume=abc', '--model', 'qwen2.5-coder:7b']));
    expect(calls[0]!.env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(JSON.parse(stdin.join(''))).toEqual({ type: 'user', message: { role: 'user', content: 'Say OK' } });
    expect(events.map((e) => e.type)).toEqual(['status', 'started', 'text', 'result', 'status']);
    expect(events.at(-1)).toEqual({ type: 'status', status: 'done' });
  });

  it('resumes the codex thread for follow-up turns', async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const lines = ['{"type":"thread.started","thread_id":"t-9"}', '{"type":"item.completed","item":{"type":"agent_message","text":"Hi"}}', '{"type":"turn.completed"}'];
    const run = codexHarness({ spawn: fakeSpawn(lines, calls, []) }).run({ cwd: '/tmp', prompt: 'hello', provider, model: 'gpt-oss:20b' });
    await collect(run);
    expect(calls[0]!.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-c', 'model_provider="ollama"', '-m', 'gpt-oss:20b', 'hello']));
    const second = collect(run);
    run.send('and now?');
    await second;
    expect(calls[1]!.args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(calls[1]!.args.slice(-3)).toEqual(['--', 't-9', 'and now?']);
    // A prompt that looks like a flag stays a prompt.
    const third = collect(run);
    run.send('--dangerously-bypass-approvals-and-sandbox');
    await third;
    expect(calls[2]!.args.slice(-3)).toEqual(['--', 't-9', '--dangerously-bypass-approvals-and-sandbox']);
  });
});
