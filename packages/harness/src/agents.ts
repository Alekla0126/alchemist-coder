import type { HarnessAdapter } from '@alchemist-coder/core';
import { acpHarness, type AcpLaunch } from './acp.ts';
import { detectBinary } from './detect.ts';
import type { SpawnFn } from './process.ts';

// Pinned so an adapter update can't change behaviour under the user; bump deliberately.
export const CLAUDE_ACP = '@agentclientprotocol/claude-agent-acp@0.81.2';
export const CODEX_ACP = '@agentclientprotocol/codex-acp@1.13.1';
export const GROK_CLI = '@xai-official/grok@1.0.41';

const versionOf = (pkg: string) => pkg.slice(pkg.lastIndexOf('@') + 1);

/** Runs an npm package through npx (downloaded once into the npm cache). */
function viaNpx(pkg: string, args: string[] = []): () => Promise<AcpLaunch | null> {
  return async () => ((await detectBinary('npx')).installed ? { command: 'npx', args: ['-y', pkg, ...args], version: versionOf(pkg) } : null);
}

/**
 * The ACP agent while Node's npx is there, else the CLI's own headless mode. Looked up again on every
 * detection, so installing Node.js (or a PATH that arrives late) switches without a restart.
 */
export function npxOrHeadless(acp: HarnessAdapter, headless: HarnessAdapter, hasNpx: boolean, hasBinary = detectBinary): HarnessAdapter {
  let useAcp = hasNpx;
  return {
    id: acp.id,
    label: acp.label,
    async detect() {
      useAcp = (await hasBinary('npx')).installed;
      return (useAcp ? acp : headless).detect();
    },
    run: (options) => (useAcp ? acp : headless).run(options),
  };
}

interface AgentOptions {
  spawn?: SpawnFn;
}

/** Claude Code through Anthropic's ACP adapter (Claude Agent SDK). */
export function claudeAgent(options: AgentOptions = {}): HarnessAdapter {
  return acpHarness(
    {
      id: 'claude-code',
      label: 'Claude Code',
      resolve: viaNpx(CLAUDE_ACP),
      modes: {
        default: { modes: ['default'] },
        acceptEdits: { modes: ['acceptEdits'] },
        plan: { modes: ['plan'] },
        bypassPermissions: { modes: ['bypassPermissions'] },
      },
    },
    options,
  );
}

/** OpenAI Codex through its ACP adapter (bundles a compatible Codex). */
export function codexAgent(options: AgentOptions = {}): HarnessAdapter {
  return acpHarness(
    {
      id: 'codex',
      label: 'Codex',
      resolve: viaNpx(CODEX_ACP),
      modes: {
        // read-only asks before every edit and command; agent edits the workspace on its own.
        default: { modes: ['read-only'], options: { collaboration_mode: 'default' } },
        acceptEdits: { modes: ['agent'], options: { collaboration_mode: 'default' } },
        plan: { modes: ['read-only'], options: { collaboration_mode: 'plan' } },
        bypassPermissions: { modes: ['agent-full-access'], options: { collaboration_mode: 'default' } },
      },
      authMethod: (env) => (env.CODEX_API_KEY || env.OPENAI_API_KEY ? { id: 'api-key', eager: true } : { id: 'chat-gpt', eager: false }),
    },
    options,
  );
}

/** Google's Gemini CLI, which speaks ACP natively (`gemini --acp`). */
export function geminiAgent(options: AgentOptions & { bin?: string } = {}): HarnessAdapter {
  const bin = options.bin ?? 'gemini';
  return acpHarness(
    {
      id: 'gemini',
      label: 'Gemini CLI',
      async resolve() {
        const d = await detectBinary(bin);
        return d.installed ? { command: bin, args: ['--acp'], version: d.version } : null;
      },
      modes: {
        default: { modes: ['default'] },
        acceptEdits: { modes: ['autoEdit'] },
        plan: { modes: ['plan'] },
        bypassPermissions: { modes: ['yolo'] },
      },
      // Google no longer serves personal "Code Assist" OAuth to third-party clients: API key or Vertex.
      authMethod: (env) => (env.GEMINI_API_KEY ? { id: 'gemini-api-key', eager: true } : env.GOOGLE_GENAI_USE_VERTEXAI ? { id: 'vertex-ai', eager: true } : null),
    },
    options,
  );
}

/** xAI's Grok Build (`grok agent stdio`), from PATH or through npx. */
export function grokAgent(options: AgentOptions & { bin?: string } = {}): HarnessAdapter {
  const bin = options.bin ?? 'grok';
  const npx = viaNpx(GROK_CLI, ['agent', 'stdio']);
  return acpHarness(
    {
      id: 'grok',
      label: 'Grok Build',
      async resolve() {
        const d = await detectBinary(bin);
        return d.installed ? { command: bin, args: ['agent', 'stdio'], version: d.version } : npx();
      },
      modes: {
        default: { modes: ['default', 'ask'] },
        acceptEdits: { modes: ['auto-edit', 'autoEdit', 'acceptEdits', 'default'] },
        plan: { modes: ['plan'] },
        bypassPermissions: { modes: ['yolo', 'always-approve', 'bypassPermissions'] },
      },
      args: ({ model, permissionMode }) => [
        ...(model && model !== 'default' ? ['-m', model] : []),
        ...(permissionMode === 'bypassPermissions' ? ['--always-approve'] : []),
      ],
      // With XAI_API_KEY the CLI needs no sign-in; otherwise it opens grok.com in the browser.
      authMethod: (env) => (env.XAI_API_KEY ? null : { id: 'grok.com', eager: false }),
    },
    options,
  );
}
