import { compactNumber, contextWindowFor } from '../format';
import { useStore, useT } from '../store';

/** How full a conversation's context is: from the live run when there is one, else from its last reply. */
export function useContextFill(session: { id: string; contextTokens: number; contextWindow: number | null; models: string[] } | null | undefined) {
  const live = useStore((s) => (session ? s.runs[s.runByTarget[`s:${session.id}`] ?? '']?.usage : undefined));
  if (live && live.contextTokens > 0) return { used: live.usedTokens, size: live.contextTokens };
  if (!session?.contextTokens) return null;
  const size = contextWindowFor(session.models.at(-1), session.contextWindow, session.contextTokens);
  return size ? { used: session.contextTokens, size } : { used: session.contextTokens, size: null };
}

/** A small ring and a percentage; the tooltip says the numbers. */
export function ContextMeter({ used, size }: { used: number; size: number | null }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  if (!size) return <span className="ctx-meter" title={t('context.tokens', { used: compactNumber(used, locale) })}>{compactNumber(used, locale)}</span>;
  const pct = Math.min(100, Math.round((used / size) * 100));
  return (
    <span className={`ctx-meter ${pct >= 80 ? 'high' : pct >= 50 ? 'mid' : ''}`} title={t('context.of', { used: compactNumber(used, locale), size: compactNumber(size, locale), pct })}>
      <i style={{ background: `conic-gradient(currentColor ${pct * 3.6}deg, var(--line-2) 0)` }} />
      {t('context.short', { pct })}
    </span>
  );
}
