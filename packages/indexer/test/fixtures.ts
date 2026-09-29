import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CWD = '/tmp/demo-proj';
export const SESSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
export const CODEX_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const base = { sessionId: SESSION, cwd: CWD, gitBranch: 'main', version: '2.1.257' };
const usage = (input: number, output: number, extra: object = {}) => ({ input_tokens: input, output_tokens: output, ...extra });

export function buildFixtures() {
  const root = mkdtempSync(join(tmpdir(), 'ac-index-'));
  const claudeRoot = join(root, 'claude', 'projects');
  const codexRoot = join(root, 'codex');
  const projectDir = join(claudeRoot, '-tmp-demo-proj');
  const subDir = join(projectDir, SESSION, 'subagents');
  mkdirSync(subDir, { recursive: true });

  const m1Usage = usage(100, 50, { cache_read_input_tokens: 1000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 } });
  writeFileSync(
    join(projectDir, `${SESSION}.jsonl`),
    jsonl([
      { ...base, type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: '# Refactor the export pipeline\nplease' } },
      { ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-09-01T10:00:05.000Z', message: { id: 'm1', model: 'claude-opus-5', stop_reason: 'tool_use', usage: m1Usage, content: [{ type: 'text', text: "I'll plan it first." }] } },
      { ...base, type: 'assistant', uuid: 'a2', timestamp: '2026-09-01T10:00:06.000Z', message: { id: 'm1', model: 'claude-opus-5', stop_reason: 'tool_use', usage: m1Usage, content: [{ type: 'tool_use', id: 'T1', name: 'Agent', input: { subagent_type: 'Plan', description: 'Design architecture', prompt: 'Design it' } }] } },
      { ...base, type: 'assistant', uuid: 'a3', timestamp: '2026-09-01T10:00:07.000Z', message: { id: 'm1', model: 'claude-opus-5', stop_reason: 'tool_use', usage: m1Usage, content: [{ type: 'tool_use', id: 'T2', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Migrate PDF renderer', prompt: 'Migrate it' } }] } },
      { ...base, type: 'user', uuid: 'u2', timestamp: '2026-09-01T10:01:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T1', content: [{ type: 'text', text: 'Plan ready' }] }] }, toolUseResult: { status: 'completed', totalDurationMs: 50000 } },
      { ...base, type: 'user', uuid: 'u3', timestamp: '2026-09-01T10:01:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T2', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'bbb' } },
      { ...base, type: 'user', uuid: 'u4', timestamp: '2026-09-01T10:05:00.000Z', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>x1</task-id>\n<tool-use-id>T2</tool-use-id>\n<status>completed</status>\n<summary>Agent "Migrate PDF renderer" finished</summary>\n</task-notification>' } },
      { ...base, type: 'assistant', uuid: 'a5', timestamp: '2026-09-01T10:05:02.000Z', message: { id: 'm3', model: 'claude-opus-5', stop_reason: 'tool_use', usage: usage(1, 1), content: [{ type: 'tool_use', id: 'T4', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Benchmark renderers', prompt: 'Bench' } }] } },
      { ...base, type: 'user', uuid: 'u5', timestamp: '2026-09-01T10:05:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T4', content: 'Async agent launched successfully.' }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'eee' } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-01T10:05:08.000Z', sessionId: SESSION, content: '<task-notification>\n<task-id>eee</task-id>\n<tool-use-id>T4</tool-use-id>\n<status>failed</status>\n<summary>Agent "Benchmark renderers" failed</summary>\n</task-notification>' },
      { ...base, type: 'attachment', uuid: 'at1', timestamp: '2026-09-01T10:05:09.000Z', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>eee</task-id>\n<tool-use-id>T4</tool-use-id>\n<status>failed</status>\n<summary>Agent "Benchmark renderers" failed</summary>\n</task-notification>' } },
      { ...base, type: 'assistant', uuid: 'a4', timestamp: '2026-09-01T10:05:10.000Z', message: { id: 'm2', model: 'claude-opus-5', stop_reason: 'end_turn', usage: usage(10, 5), content: [{ type: 'text', text: 'All done: fonts now load through loadFont().' }] } },
      { type: 'ai-title', aiTitle: 'Export pipeline refactor', sessionId: SESSION },
      { type: 'custom-title', customTitle: 'My export refactor', sessionId: SESSION },
    ]),
  );

  const sub = (agentId: string, records: object[], meta: object) => {
    writeFileSync(join(subDir, `agent-${agentId}.jsonl`), jsonl(records.map((r) => ({ ...base, isSidechain: true, agentId, ...r }))));
    writeFileSync(join(subDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  };
  sub('aaa', [
    { type: 'user', uuid: 's1', timestamp: '2026-09-01T10:00:10.000Z', message: { role: 'user', content: 'Design it' } },
    { type: 'assistant', uuid: 's2', timestamp: '2026-09-01T10:00:50.000Z', message: { id: 'p1', model: 'claude-opus-5', stop_reason: 'end_turn', usage: usage(200, 80), content: [{ type: 'text', text: 'Plan: three steps.' }] } },
  ], { agentType: 'Plan', description: 'Design architecture', toolUseId: 'T1', spawnDepth: 1 });
  sub('bbb', [
    { type: 'user', uuid: 'g1', timestamp: '2026-09-01T10:01:02.000Z', message: { role: 'user', content: 'Migrate it' } },
    { type: 'assistant', uuid: 'g2', timestamp: '2026-09-01T10:02:00.000Z', message: { id: 'q1', model: 'claude-opus-5', stop_reason: 'tool_use', usage: usage(300, 90), content: [{ type: 'tool_use', id: 'T3', name: 'Agent', input: { subagent_type: 'Explore', description: 'Map render tests', prompt: 'Find tests' } }] } },
    { type: 'assistant', uuid: 'g3', timestamp: '2026-09-01T10:04:00.000Z', message: { id: 'q2', model: 'claude-opus-5', stop_reason: 'end_turn', usage: usage(50, 20), content: [{ type: 'text', text: 'Migrated.' }] } },
  ], { agentType: 'general-purpose', description: 'Migrate PDF renderer', toolUseId: 'T2', spawnDepth: 1 });
  sub('ccc', [
    { type: 'user', uuid: 'e1', timestamp: '2026-09-01T10:02:01.000Z', message: { role: 'user', content: 'Find tests' } },
    { type: 'assistant', uuid: 'e2', timestamp: '2026-09-01T10:02:30.000Z', message: { id: 'r1', model: 'claude-haiku-4-5', stop_reason: 'tool_use', usage: usage(40, 10), content: [{ type: 'tool_use', id: 'B1', name: 'Bash', input: { command: 'rg render test' } }] } },
  ], { agentType: 'Explore', description: 'Map render tests', toolUseId: 'T3', parentAgentId: 'bbb', spawnDepth: 2 });
  sub('eee', [
    { type: 'user', uuid: 'x1', timestamp: '2026-09-01T10:05:04.000Z', message: { role: 'user', content: 'Bench' } },
    { type: 'assistant', uuid: 'x2', timestamp: '2026-09-01T10:05:06.000Z', message: { id: 'y1', model: 'claude-opus-5', stop_reason: 'max_tokens', usage: usage(5, 5), content: [{ type: 'text', text: 'Benchmarking…' }] } },
  ], { agentType: 'general-purpose', description: 'Benchmark renderers', toolUseId: 'T4', spawnDepth: 1 });
  sub('ddd', [
    { type: 'user', uuid: 'w1', timestamp: '2026-09-01T10:03:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Try pdf-v2' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] } },
    { type: 'assistant', uuid: 'w2', timestamp: '2026-09-01T10:03:30.000Z', message: { id: 'v1', model: 'claude-opus-5', stop_reason: 'end_turn', usage: usage(10, 10), content: [{ type: 'text', text: 'Works on the branch.' }, { type: 'tool_use', id: 'E1', name: 'Edit', input: { file_path: '/tmp/wt/src/pdf.ts', old_string: 'a', new_string: 'b' } }] } },
  ], { agentType: 'workflow-subagent', worktreeBranch: 'feat/pdf-v2', worktreePath: '/tmp/wt', spawnDepth: 1 });

  const rootDir = join(claudeRoot, '-');
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(
    join(rootDir, 'cccccccc-3333-4333-8333-cccccccccccc.jsonl'),
    jsonl([
      { type: 'user', uuid: 'z1', sessionId: 'cccccccc-3333-4333-8333-cccccccccccc', cwd: '/', timestamp: '2026-09-03T10:00:00.000Z', entrypoint: 'sdk-ts', message: { role: 'user', content: [{ type: 'text', text: '' }] } },
      { type: 'assistant', uuid: 'z2', sessionId: 'cccccccc-3333-4333-8333-cccccccccccc', cwd: '/', timestamp: '2026-09-03T10:00:01.000Z', message: { id: 'zz', model: 'claude-opus-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired' }] } },
    ]),
  );

  const codexDir = join(codexRoot, 'sessions', '2026', '09', '02');
  mkdirSync(codexDir, { recursive: true });
  const codexPath = join(codexDir, `rollout-2026-09-02T10-00-00-${CODEX_ID}.jsonl`);
  writeFileSync(
    codexPath,
    jsonl([
      { timestamp: '2026-09-02T10:00:00.000Z', type: 'session_meta', payload: { id: CODEX_ID, cwd: CWD, cli_version: '0.150.1' } },
      { timestamp: '2026-09-02T10:00:00.100Z', type: 'turn_context', payload: { cwd: CWD, model: 'gpt-5.6-sol' } },
      { timestamp: '2026-09-02T10:00:00.200Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
      { timestamp: '2026-09-02T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the OCR crash' }] } },
      { timestamp: '2026-09-02T10:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":"pytest ocr"}' } },
      { timestamp: '2026-09-02T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '1 failed' } },
      { timestamp: '2026-09-02T10:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the tesseract call.' }] } },
      { timestamp: '2026-09-02T10:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 40 } } } },
      { timestamp: '2026-09-02T10:00:06.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ]),
  );

  const eventCodexPath = join(codexDir, 'rollout-2026-09-02T11-00-00-dddddddd-4444-4444-8444-dddddddddddd.jsonl');
  writeFileSync(
    eventCodexPath,
    jsonl([
      { timestamp: '2026-09-02T11:00:00.000Z', type: 'session_meta', payload: { id: 'dddddddd-4444-4444-8444-dddddddddddd', cwd: CWD } },
      { timestamp: '2026-09-02T11:00:01.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Generate the weekly wallpapers' }] } } },
      { timestamp: '2026-09-02T11:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done: 7 wallpapers.' }] } },
    ]),
  );

  // Everything happened a while ago, except the nested Explore agent which is still writing.
  const past = new Date('2026-09-01T10:10:00.000Z');
  for (const p of [join(projectDir, `${SESSION}.jsonl`), ...['aaa', 'bbb', 'ddd', 'eee'].map((a) => join(subDir, `agent-${a}.jsonl`)), codexPath, eventCodexPath]) utimesSync(p, past, past);
  const live = new Date('2026-09-01T10:20:00.000Z');
  utimesSync(join(subDir, 'agent-ccc.jsonl'), live, live);

  // Empty on purpose: tests never read the machine's real Gemini or Grok history.
  return { root, claudeRoot, codexRoot, geminiRoot: join(root, 'gemini-tmp'), grokRoot: join(root, 'grok-sessions'), dbPath: join(root, 'index.db'), liveNow: live.getTime() + 5_000 };
}
