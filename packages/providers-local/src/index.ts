import { isLocalEndpoint, type Capabilities, type ModelSpec, type ProviderAdapter } from '@alchemist-coder/core';

export interface LocalProviderOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// Tool Search needs a server-side feature local servers don't implement; web search is an Anthropic server tool.
const LOCAL_CAPABILITIES: Capabilities = { toolSearch: false, webFetch: true, webSearch: false, subagents: true };

export class EndpointNotAllowedError extends Error {
  constructor(url: string) {
    super(`The Community edition only connects to models on this machine or your local network (got ${url}).`);
    this.name = 'EndpointNotAllowedError';
  }
}

function normalize(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!isLocalEndpoint(trimmed)) throw new EndpointNotAllowedError(trimmed);
  return trimmed;
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<any> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** Codex's ACP adapter reads session config overrides from CODEX_CONFIG (JSON). */
function codexEnv(provider: string, model: string): Record<string, string> {
  return { CODEX_CONFIG: JSON.stringify({ model_provider: provider, model }) };
}

/** Env that points Claude Code at an Anthropic-compatible local server and keeps cloud keys out. */
function claudeEnv(baseUrl: string, token: string, model: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

export function ollamaProvider(options: LocalProviderOptions = {}): ProviderAdapter {
  const baseUrl = normalize(options.baseUrl ?? 'http://localhost:11434');
  const fetchImpl = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 2500;
  return {
    id: 'ollama',
    label: 'Ollama',
    edition: 'community',
    harnesses: ['claude-code', 'codex'],
    capabilities: LOCAL_CAPABILITIES,
    baseUrl,
    async models(): Promise<ModelSpec[]> {
      const data = await getJson(fetchImpl, `${baseUrl}/api/tags`, timeout);
      return (Array.isArray(data?.models) ? data.models : []).map((m: { name: string; size?: number }) => ({
        id: m.name,
        label: m.size ? `${m.name} · ${gigabytes(m.size)}` : m.name,
      }));
    },
    async env(model, harnessId) {
      return harnessId === 'codex' ? codexEnv('ollama', model) : claudeEnv(baseUrl, 'ollama', model);
    },
    cliArgs(harnessId, model) {
      return harnessId === 'codex' ? ['-c', 'model_provider="ollama"', '-m', model] : ['--model', model];
    },
    async status() {
      try {
        const v = await getJson(fetchImpl, `${baseUrl}/api/version`, timeout);
        return { available: true, detail: typeof v?.version === 'string' ? `Ollama ${v.version}` : 'Ollama' };
      } catch {
        return { available: false, detail: `Ollama is not running at ${baseUrl}` };
      }
    },
  };
}

export function lmStudioProvider(options: LocalProviderOptions = {}): ProviderAdapter {
  const baseUrl = normalize(options.baseUrl ?? 'http://localhost:1234');
  const fetchImpl = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 2500;
  return {
    id: 'lmstudio',
    label: 'LM Studio',
    edition: 'community',
    harnesses: ['claude-code', 'codex'],
    capabilities: LOCAL_CAPABILITIES,
    baseUrl,
    async models() {
      const data = await getJson(fetchImpl, `${baseUrl}/v1/models`, timeout);
      return (Array.isArray(data?.data) ? data.data : []).map((m: { id: string }) => ({ id: m.id, label: m.id }));
    },
    async env(model, harnessId) {
      return harnessId === 'codex' ? codexEnv('lmstudio', model) : claudeEnv(baseUrl, 'lmstudio', model);
    },
    cliArgs(harnessId, model) {
      return harnessId === 'codex' ? ['-c', 'model_provider="lmstudio"', '-m', model] : ['--model', model];
    },
    async status() {
      try {
        await getJson(fetchImpl, `${baseUrl}/v1/models`, timeout);
        return { available: true, detail: 'LM Studio' };
      } catch {
        return { available: false, detail: `LM Studio is not running at ${baseUrl}` };
      }
    },
  };
}
