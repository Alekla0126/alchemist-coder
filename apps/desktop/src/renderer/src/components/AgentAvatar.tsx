import type { CSSProperties } from 'react';
import { avatarSource } from '../avatar';
import { initials, projectGradient } from '../format';

export type AvatarState = 'working' | 'waiting' | 'error' | null;

/**
 * An agent's picture: the one you chose, one guessed from its name, or its initials on a color. A dot
 * in the corner says how it's doing (working, needs you, failed).
 */
export function AgentAvatar({ name, avatar, size = 24, state = null, label }: { name: string; avatar?: string | null; size?: number; state?: AvatarState; label?: string }) {
  const src = avatarSource(name, avatar);
  const style = { '--av': `${size}px`, background: src.kind === 'image' ? undefined : projectGradient(name) } as CSSProperties;
  return (
    <span className={`agent-av ${state ? `st-${state}` : ''}`} style={style} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} title={label}>
      {src.kind === 'image' ? <img src={src.src} alt="" draggable={false} /> : src.kind === 'emoji' ? <span className="agent-av-emoji">{src.emoji}</span> : <span className="agent-av-initials">{initials(name)}</span>}
      {state && <i className="agent-av-dot" />}
    </span>
  );
}
