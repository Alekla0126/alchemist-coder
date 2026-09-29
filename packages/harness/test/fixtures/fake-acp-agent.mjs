// A tiny ACP agent for tests: streams a thought, text, an edit that needs permission, a plan and usage.
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';

// FAKE_MODES / FAKE_START_MODE: which modes it offers and starts in (like a CLI set to bypassPermissions).
const available = (process.env.FAKE_MODES ?? 'default,acceptEdits,plan').split(',');
const state = { authed: false, mode: process.env.FAKE_START_MODE ?? 'default', model: 'opus[1m]', cancelled: false };
const modes = () => ({ currentModeId: state.mode, availableModes: available.map((id) => ({ id, name: id })) });
const config = () => [
  { id: 'model', name: 'Model', type: 'select', currentValue: state.model, options: [{ value: 'opus[1m]', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] },
  { id: 'effort', name: 'Effort', type: 'select', currentValue: 'low', options: [{ group: 'g', name: 'All', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] },
];

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((conn) => ({
  async initialize({ clientCapabilities }) {
    state.forms = !!clientCapabilities?.elicitation?.form;
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [{ id: 'api-key', name: 'API key' }],
      agentCapabilities: { loadSession: true, sessionCapabilities: process.env.FAKE_NO_FORK === '1' ? { resume: {} } : { resume: {}, fork: {} } },
    };
  },
  async authenticate({ methodId }) {
    state.authed = methodId === 'api-key';
    return {};
  },
  async newSession() {
    if (process.env.FAKE_REQUIRE_AUTH === '1' && !state.authed) throw RequestError.authRequired();
    return { sessionId: 'fake-session-1', modes: modes(), configOptions: config() };
  },
  async unstable_forkSession({ sessionId }) {
    return { sessionId: `fork-of-${sessionId}`, modes: modes(), configOptions: config() };
  },
  async resumeSession() {
    return { modes: modes(), configOptions: config() };
  },
  async setSessionMode({ modeId }) {
    state.mode = modeId;
    return {};
  },
  async setSessionConfigOption({ configId, value }) {
    if (configId === 'model') state.model = value;
    return { configOptions: config() };
  },
  async cancel() {
    state.cancelled = true;
  },
  async prompt({ sessionId, prompt }) {
    const say = (update) => conn.sessionUpdate({ sessionId, update });
    const words = prompt.map((b) => b.text).join(' ');
    // "ask me": an AskUserQuestion, sent the way claude-agent-acp does (only to clients that take forms).
    if (words.includes('ask me')) {
      if (!state.forms) throw new Error('client does not take forms');
      const answer = await conn.createElicitation({
        mode: 'form',
        sessionId,
        message: 'Which color?',
        requestedSchema: {
          type: 'object',
          properties: {
            question_0: { type: 'string', title: 'Color', oneOf: [{ const: 'Red', title: 'Red', description: 'Warm' }, { const: 'Blue', title: 'Blue' }] },
            question_0_custom: { type: 'string', title: 'Other', _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } } },
          },
        },
      });
      await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer=${JSON.stringify(answer)}` } });
      return { stopReason: 'end_turn' };
    }
    await say({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } });
    await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `mode=${state.mode} model=${state.model} auth=${state.authed} prompt=${words}` } });
    await say({ sessionUpdate: 'plan', entries: [{ content: 'Edit a.txt', priority: 'high', status: 'in_progress' }] });
    // "go ahead" = the user approved the plan: the agent leaves plan mode on its own.
    if (words.includes('go ahead') && state.mode === 'plan') {
      state.mode = 'acceptEdits';
      await say({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' });
    }
    const diff = { type: 'diff', path: '/tmp/a.txt', oldText: 'old', newText: 'new' };
    await say({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.txt', kind: 'edit', status: 'pending', content: [diff] });
    const answer = await conn.requestPermission({
      sessionId,
      toolCall: { toolCallId: 't1', title: 'Edit a.txt', kind: 'edit', content: [diff, { type: 'content', content: { type: 'text', text: 'Why: fix the greeting' } }] },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    const allowed = answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'allow';
    await say({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed' });
    await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? ' | edited' : ' | denied' } });
    await say({ sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.042, currency: 'USD' } });
    return { stopReason: state.cancelled ? 'cancelled' : 'end_turn' };
  },
}), stream);
