import { useSyncExternalStore } from 'react';

/**
 * One clock for every "5 min ago" on screen. It ticks every 30 s while something shows a time, so
 * a relative time keeps up by itself (a list left open stops saying "now" an hour later), without
 * each row running its own timer. With nothing listening it stops.
 */
const TICK_MS = 30_000;

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    // The clock may have been stopped a while: catch up before the first tick.
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time in steps of 30 s, from one shared timer (for relative times on many rows; `useNow` in WorkingOrb ticks every second for one live duration). */
export function useClock(): number {
  return useSyncExternalStore(subscribe, () => now);
}
