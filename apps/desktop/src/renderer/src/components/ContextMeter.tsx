import { contextWindowFor } from '../format';
import { useStore } from '../store';

/** How full a conversation's context is: from the live run when there is one, else from its last reply. */
export function useContextFill(session: { id: string; contextTokens: number; contextWindow: number | null; models: string[] } | null | undefined) {
  const live = useStore((s) => (session ? s.runs[s.runByTarget[`s:${session.id}`] ?? '']?.usage : undefined));
  if (live && live.contextTokens > 0) return { used: live.usedTokens, size: live.contextTokens };
  if (!session?.contextTokens) return null;
  const size = contextWindowFor(session.models.at(-1), session.contextWindow, session.contextTokens);
  return size ? { used: session.contextTokens, size } : { used: session.contextTokens, size: null };
}
