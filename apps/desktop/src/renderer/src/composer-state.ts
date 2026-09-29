/** Unsent text per conversation, so switching around doesn't lose it. */
export const drafts = new Map<string, string>();
/** Messages written while the agent was busy, sent one by one as it finishes each turn. */
export const queues = new Map<string, string[]>();

/** A new conversation got its id: its draft and queue move from `p:<project>` to `s:<session>`. */
export function moveComposerState(from: string, to: string) {
  for (const map of [drafts, queues] as Array<Map<string, unknown>>) {
    if (!map.has(from) || map.has(to)) continue;
    map.set(to, map.get(from));
    map.delete(from);
  }
}
