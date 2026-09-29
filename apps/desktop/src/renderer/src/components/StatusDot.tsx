import type { AgentStatus } from '@alchemist-coder/core';
import { useT } from '../store';

export function StatusDot({ status }: { status: AgentStatus }) {
  const t = useT();
  const label = t(`status.${status}`);
  if (status === 'done') return <span className="status-icon done" title={label} aria-label={label}>✓</span>;
  if (status === 'error') return <span className="status-icon error" title={label} aria-label={label}>✕</span>;
  return <span className={`dot ${status}`} title={label} aria-label={label} />;
}
