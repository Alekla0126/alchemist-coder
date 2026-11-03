import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { readPolicy } from './policy.ts';
import { httpProjectionSource } from './source.ts';
import { createOrgMcp } from './server.ts';

// Does not register itself in Codex/ChatGPT, create grants, open a listener or run a workflow.
const policy=()=>readPolicy(process.env.TAC_MCP_CONFIG);
try {
  policy();
  const handle=serveStdio(()=>createOrgMcp({policy,source:httpProjectionSource(),audit:record=>{process.stderr.write(JSON.stringify(record)+'\n');}}));
  process.once('SIGINT',()=>void handle.close());process.once('SIGTERM',()=>void handle.close());
} catch {process.stderr.write('{"code":"mcp_start_unavailable"}\n');process.exitCode=1;}
