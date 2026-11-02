/** How long changed conversations gather before the lists reload: while you're in the app. */
export const CHANGED_FOCUSED_MS = 250;
/** …and while you're in another app with this window still on screen. */
export const CHANGED_AWAY_MS = 3000;

export interface ChangeQueueEnv {
  hidden: () => boolean;
  focused: () => boolean;
  flush: (ids: string[]) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/**
 * Agents write their transcripts many times a second, and each change reloads the project list, the
 * sessions and every view keyed on revision. This gathers them into one reload per burst: right away
 * while you're in the app, every few seconds while you're in another one, and none while the window
 * is hidden. `wake()` delivers whatever changed meanwhile, all at once.
 */
export function changeQueue(env: ChangeQueueEnv) {
  const schedule = env.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = env.cancel ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let pending = new Set<string>();
  let timer: unknown = null;
  const flush = () => {
    if (timer != null) cancel(timer);
    timer = null;
    if (env.hidden() || !pending.size) return;
    const ids = [...pending];
    pending = new Set();
    env.flush(ids);
  };
  return {
    push(ids: string[]) {
      for (const id of ids) pending.add(id);
      if (timer != null || env.hidden()) return;
      timer = schedule(flush, env.focused() ? CHANGED_FOCUSED_MS : CHANGED_AWAY_MS);
    },
    /** The window is back on screen or in front. */
    wake() {
      if (pending.size) flush();
    },
  };
}
