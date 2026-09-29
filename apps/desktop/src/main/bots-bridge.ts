import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The MCP server a bot's agent starts (stdio). It only relays: tools are listed and run by the
 * app's main process, over a local HTTP call that carries the bot's own token.
 */
const SOURCE = String.raw`'use strict';
const http = require('http');
const target = new URL(process.env.AC_BOTS_URL || 'http://127.0.0.1:0');
const token = process.env.AC_BOTS_TOKEN || '';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) void handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
function call(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-bots-token': token } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Alchemist Coder sent an unreadable reply')); }
        });
      },
    );
    req.on('error', () => reject(new Error('Alchemist Coder is not reachable (was the app closed?)')));
    req.end(body);
  });
}
async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'alchemist_bots', version: '1.0.0' } } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
      const r = await call('tools/list', {});
      return send({ jsonrpc: '2.0', id, result: { tools: r.tools || [] } });
    }
    if (method === 'tools/call') {
      const r = await call('tools/call', params || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(r.text || '') }], isError: !!r.isError } });
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: (e && e.message) || String(e) } });
  }
}
`;

/** Writes the bridge next to the app's data (rewritten each launch) and returns its path. */
export function writeBridge(dir: string): string {
  const file = join(dir, 'bots-mcp.cjs');
  writeFileSync(file, SOURCE, { mode: 0o644 });
  return file;
}
