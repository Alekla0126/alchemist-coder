// Handshake-only probe: initialize + new session, no prompt (costs nothing).
// Usage: node scripts/acp-probe.mjs <command> [args...]
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const [cmd, ...args] = process.argv.slice(2);
const cwd = mkdtempSync(join(tmpdir(), 'acp-probe-'));
const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const conn = new ClientSideConnection(() => ({
  requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  sessionUpdate: async () => {},
}), stream);
const timer = setTimeout(() => { console.log('TIMEOUT', stderr.slice(-400)); child.kill(); process.exit(1); }, 90_000);
try {
  const init = await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  console.log('protocol', init.protocolVersion, '| agent', JSON.stringify(init.agentInfo ?? null), '| auth', JSON.stringify((init.authMethods ?? []).map((a) => a.id)));
  console.log('caps', JSON.stringify(init.agentCapabilities ?? {}).slice(0, 300));
  try {
    const s = await conn.newSession({ cwd, mcpServers: [] });
    console.log('session ok', s.sessionId?.slice(0, 12), '| modes', JSON.stringify(s.modes?.availableModes?.map((m) => m.id) ?? null), '| config', JSON.stringify((s.configOptions ?? []).map((c) => c.id)));
    for (const c of s.configOptions ?? []) console.log('  config', c.id, c.type, '=', JSON.stringify(c.currentValue), c.type === 'select' ? JSON.stringify(c.options.flatMap((o) => o.options ?? [o]).map((o) => o.value)).slice(0, 300) : '');
  } catch (e) {
    console.log('newSession error:', e?.message ?? JSON.stringify(e), JSON.stringify(e?.data ?? null).slice(0, 300)); console.log('stderr:', stderr.slice(-900));
  }
} catch (e) {
  console.log('initialize error:', e?.message ?? JSON.stringify(e), stderr.slice(-300));
}
clearTimeout(timer);
child.kill();
process.exit(0);
