/** Unsent text per conversation, so switching around doesn't lose it. */
import type { RunnerCatalog } from '@shared/api';

/** Keep a Codex conversation's saved selection visible. Missing access requires a user choice. */
export function codexComposerSelection(providers: RunnerCatalog['providers'], providerId: string | undefined, model: string | undefined) {
  const provider = providers.find((p) => p.id === (providerId ?? 'openai') && p.harnesses.includes('codex'));
  return { provider, model: model ?? '', valid: !!provider?.available && provider.models.some((m) => m.id === model) };
}

export const drafts = new Map<string, string>();
/** Messages written while the agent was busy, sent one by one as it finishes each turn. */
export const queues = new Map<string, string[]>();

const draining = new Set<string>();
/** Remove only an accepted head; errors, changed conversations and edits keep their pending text. */
export async function sendQueuedMessage(target: string, send: (text: string) => Promise<boolean>): Promise<string[] | null> {
  if (draining.has(target)) return null;
  const head = queues.get(target)?.[0];
  if (!head) return null;
  draining.add(target);
  try {
    if (!await send(head)) return null;
    const current = queues.get(target) ?? [];
    if (current[0] !== head) return null;
    const remaining = current.slice(1);
    queues.set(target, remaining);
    return remaining;
  } finally { draining.delete(target); }
}

/** A new conversation got its id: its draft and queue move from `p:<project>` to `s:<session>`. */
export function moveComposerState(from: string, to: string) {
  for (const map of [drafts, queues] as Array<Map<string, unknown>>) {
    if (!map.has(from) || map.has(to)) continue;
    map.set(to, map.get(from));
    map.delete(from);
  }
}
