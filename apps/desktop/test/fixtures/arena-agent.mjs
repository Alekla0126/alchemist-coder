// Fake ACP coding agent for Arena tests. In plan mode it submits a plan for approval (like
// Claude's ExitPlanMode); otherwise it writes hello.txt naming its worktree and finishes.
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

let mode = 'default';
let cwd = process.cwd();
const modes = () => ({ currentModeId: mode, availableModes: ['default', 'acceptEdits', 'plan'].map((id) => ({ id, name: id })) });

new AgentSideConnection((conn) => ({
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
  },
  async newSession(params) {
    cwd = params.cwd;
    return { sessionId: `s-${basename(cwd)}-${Date.now()}`, modes: modes() };
  },
  async setSessionMode({ modeId }) {
    mode = modeId;
    return {};
  },
  async cancel() {},
  async prompt({ sessionId, prompt }) {
    const say = (text) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
    const task = prompt.map((b) => b.text).join('\n');
    if (mode === 'plan') {
      await say('Let me look around first.');
      await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'exit', title: 'Ready to code?', kind: 'switch_mode', content: [{ type: 'content', content: { type: 'text', text: '## Plan\n1. Create hello.txt\n2. Check it exists' } }] },
        options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No, keep planning', kind: 'reject_once' }],
      });
      return { stopReason: 'end_turn' };
    }
    if (task.includes('EXPENSIVE')) {
      // Reports a big bill up front, then takes its time: the budget should stop it first.
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.05, currency: 'USD' } } });
      await new Promise((r) => setTimeout(r, 4000));
    }
    const followsPlan = task.includes('Create hello.txt') ? ' (followed the plan)' : '';
    writeFileSync(`${cwd}/hello.txt`, `hello from ${basename(cwd)}\n`);
    await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.01, currency: 'USD' } } });
    await say(`Created hello.txt${followsPlan}.`);
    return { stopReason: 'end_turn' };
  },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
