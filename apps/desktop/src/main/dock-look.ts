import type { Attention } from '../shared/api';

/** What the Dock or taskbar icon shows. */
export interface DockLook {
  /** The badge: how many things wait for you (0: none). */
  badge: number;
  /** A dot on the icon: amber when something waits for you, green while agents work. */
  dot: 'waiting' | 'working' | null;
  /** Bounce the Dock icon or flash the taskbar button: something new waits for you while you're elsewhere. */
  alert: boolean;
}

export function dockLook(previous: Attention | null, next: Attention, focused: boolean): DockLook {
  return {
    badge: next.waiting,
    dot: next.waiting > 0 ? 'waiting' : next.working > 0 ? 'working' : null,
    alert: next.notify && !focused && next.waiting > (previous?.waiting ?? 0),
  };
}
