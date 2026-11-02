import { createInterface } from 'node:readline';
import type { CodexRuntimeSnapshot, ModelSpec } from '@alchemist-coder/core';
import { binaryPath } from './detect.ts';
import { killTree, spawn, type SpawnFn } from './process.ts';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const providerConfig = (value: string | undefined): ObjectValue => {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as ObjectValue;
  } catch { throw new Error('Invalid Codex provider configuration.'); }
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** No auth writes, thread reads, inference, reset credits, or experimental methods. */
export async function readCodexRuntime(options: { bin?: string; env?: Record<string, string>; spawn?: SpawnFn; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CodexRuntimeSnapshot> {
  const snapshot: CodexRuntimeSnapshot = { connected: false, error: null, models: [], account: null, accountError: null, limits: null, limitsError: null, checkedAt: Date.now() };
  const bin = options.bin ?? binaryPath(process.env.CODEX_PATH || 'codex');
  if (!bin) return { ...snapshot, error: 'Codex CLI is unavailable. Install it to read its model catalog.' };
  let child: ReturnType<SpawnFn> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let nextId = 0;
  let failed: Error | null = null;
  const pending = new Map<number, { resolve: (v: ObjectValue) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (error: Error) => {
    failed = error;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  const abort = () => fail(new Error('Codex catalog request cancelled.'));
  try {
    if (options.signal?.aborted) throw new Error('Codex catalog request cancelled.');
    const providerArgs = codexProviderArgs(options.env?.CODEX_CONFIG);
    const apiKey = !!(options.env?.OPENAI_API_KEY || options.env?.CODEX_API_KEY);
    if (apiKey) snapshot.usesApiKey = true;
    const routing = providerConfig(options.env?.CODEX_CONFIG);
    const customProvider = typeof routing.model_provider === 'string' && routing.model_provider !== 'openai';
    if (customProvider && !apiKey) snapshot.accountError = 'The configured provider does not report its account through Codex.';
    child = (options.spawn ?? spawn)(bin, ['app-server', ...providerArgs], { env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.on('error', fail);
    child.stdin?.on('error', fail);
    child.on('exit', () => fail(new Error('Codex App Server disconnected.')));
    // Drain diagnostics without exposing environment or authentication details to the renderer.
    child.stderr?.resume();
    lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      try {
        const v = object(JSON.parse(line));
        const p = typeof v.id === 'number' ? pending.get(v.id) : undefined;
        if (!p) return;
        pending.delete(v.id as number);
        clearTimeout(p.timer);
        if (v.error) p.reject(new Error(String(object(v.error).message ?? 'Codex request failed')));
        else p.resolve(object(v.result));
      } catch { /* Unknown notifications don't affect outstanding requests. */ }
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    const request = (method: string, params: ObjectValue = {}): Promise<ObjectValue> => new Promise((resolve, reject) => {
      if (failed) return reject(failed);
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} did not respond in time.`)); }, options.timeoutMs ?? 10_000);
      pending.set(id, { resolve, reject, timer });
      child!.stdin!.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (error) fail(error); });
    });
    await request('initialize', { clientInfo: { name: 'alchemist_coder', title: 'Alchemist Coder', version: '1.3.8' } });
    child.stdin!.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error('Codex returned an invalid model catalog.');
      for (const value of page.data) {
        const m = object(value);
        if (m.hidden === true || typeof m.model !== 'string' || !m.model || snapshot.models.some((x) => x.id === m.model)) continue;
        const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []).flatMap((value) => {
          const e = object(value);
          return typeof e.reasoningEffort === 'string' ? [{ id: e.reasoningEffort, label: typeof e.description === 'string' ? e.description : e.reasoningEffort }] : [];
        });
        const model: ModelSpec = { id: m.model, label: typeof m.displayName === 'string' ? m.displayName : m.model, reasoningEfforts: efforts };
        if (typeof m.defaultReasoningEffort === 'string') model.defaultReasoningEffort = m.defaultReasoningEffort;
        snapshot.models.push(model);
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Codex returned a repeated catalog cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    snapshot.connected = true;
    await Promise.all([
      (apiKey || customProvider ? Promise.resolve<ObjectValue>({}) : request('account/read', { refreshToken: false })).then((r) => {
        const a = object(r.account);
        if (typeof a.type === 'string') snapshot.account = { type: a.type, email: typeof a.email === 'string' ? a.email : null, plan: typeof a.planType === 'string' ? a.planType : null };
      }).catch((e) => { snapshot.accountError = message(e); }),
      (apiKey || customProvider ? Promise.resolve<ObjectValue>({}) : request('account/rateLimits/read')).then((r) => {
        const buckets = Object.values(object(r.rateLimitsByLimitId));
        if (!buckets.length && r.rateLimits) buckets.push(r.rateLimits);
        const limits: NonNullable<CodexRuntimeSnapshot['limits']> = [];
        for (const value of buckets) {
          const b = object(value);
          for (const key of ['primary', 'secondary']) {
            const w = object(b[key]);
            if (!finite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) continue;
            limits.push({ label: typeof b.limitName === 'string' ? b.limitName : typeof b.limitId === 'string' ? b.limitId : 'Codex', usedPercent: w.usedPercent, windowMinutes: finite(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : null, resetsAt: finite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt * 1000 : null });
          }
        }
        snapshot.limits = limits.length ? limits : null;
      }).catch((e) => { snapshot.limitsError = message(e); }),
    ]);
    if (failed) throw failed;
  } catch (e) {
    snapshot.connected = false;
    snapshot.error = message(e);
    snapshot.models = [];
  } finally {
    options.signal?.removeEventListener('abort', abort);
    lines?.close();
    if (child) killTree(child, process.platform !== 'win32');
  }
  return snapshot;
}


/** ACP interprets CODEX_CONFIG; the native App Server needs equivalent provider overrides as TOML.
 * Only non-secret provider routing fields are accepted here. Unsupported fields fail closed.
 */
export function codexProviderArgs(config: string | undefined): string[] {
  if (!config) return [];
  const c = providerConfig(config);
  const args: string[] = [];
  if (typeof c.model_provider === 'string') args.push('-c', `model_provider=${JSON.stringify(c.model_provider)}`);
  const safe = new Set(['name', 'base_url', 'env_key', 'wire_api', 'requires_openai_auth', 'supports_websockets', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms']);
  for (const [id, value] of Object.entries(object(c.model_providers))) {
    for (const [key, v] of Object.entries(object(value))) {
      if (!safe.has(key) || !['string', 'boolean', 'number'].includes(typeof v)) throw new Error('Codex provider routing cannot be inspected safely by this runtime.');
      if (key === 'base_url') {
        const url = new URL(String(v));
        if (url.username || url.password || url.search || url.hash) throw new Error('Codex provider URL contains unsupported authentication parameters.');
      }
      args.push('-c', `model_providers.${JSON.stringify(id)}.${key}=${JSON.stringify(v)}`);
    }
  }
  return args;
}
