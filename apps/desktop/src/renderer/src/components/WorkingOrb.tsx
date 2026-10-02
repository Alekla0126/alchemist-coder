import { useEffect, useState, type CSSProperties } from 'react';
import { duration } from '../format';

export type WorkingState = 'running' | 'waiting';

/** The current time, every second while `active`. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** A ring that turns around a glowing core while an agent works; amber and still while it waits for you. */
export function WorkingOrb({ state = 'running', size = 16, label }: { state?: WorkingState; size?: number; label?: string }) {
  return <span className={`orb ${state}`} style={{ '--orb': `${size}px` } as CSSProperties} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} title={label} />;
}

/** The line at the end of a conversation while it works: the orb, what the agent is doing and for how long. */
export function WorkingRow({ state, label, since }: { state: WorkingState; label: string; since: number | null }) {
  const now = useNow(state === 'running' && since != null);
  return (
    <div className={`working-row ${state}`} role="status">
      <WorkingOrb state={state} size={20} />
      <span className="working-label">{label}</span>
      {since != null && (
        <span className="working-time" aria-hidden>
          {duration(Math.max(0, now - since))}
        </span>
      )}
    </div>
  );
}
