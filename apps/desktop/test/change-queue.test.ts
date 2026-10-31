import { describe, expect, it } from 'vitest';
import { CHANGED_AWAY_MS, CHANGED_FOCUSED_MS, changeQueue } from '../src/renderer/src/change-queue';

function setup(state: { hidden: boolean; focused: boolean }) {
  const flushed: string[][] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const q = changeQueue({
    hidden: () => state.hidden,
    focused: () => state.focused,
    flush: (ids) => flushed.push(ids),
    schedule: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    cancel: (t) => ((t as (typeof timers)[number]).live = false),
  });
  const fire = () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn()));
  return { q, flushed, timers, fire };
}

describe('changed conversations', () => {
  it('reload once per burst, soon while you are in the app', () => {
    const { q, flushed, timers, fire } = setup({ hidden: false, focused: true });
    q.push(['a']);
    q.push(['b', 'a']);
    q.push(['c']);
    expect(timers.map((t) => t.ms)).toEqual([CHANGED_FOCUSED_MS]);
    fire();
    expect(flushed).toEqual([['a', 'b', 'c']]);
  });

  it('wait longer while you are in another app, and come at once when you are back', () => {
    const { q, flushed, timers } = setup({ hidden: false, focused: false });
    q.push(['a']);
    expect(timers[0]!.ms).toBe(CHANGED_AWAY_MS);
    q.wake();
    expect(flushed).toEqual([['a']]);
    expect(timers[0]!.live).toBe(false);
  });

  it('do nothing while the window is hidden, then deliver everything that changed', () => {
    const state = { hidden: true, focused: false };
    const { q, flushed, timers } = setup(state);
    q.push(['a']);
    q.push(['b']);
    expect(timers).toHaveLength(0);
    q.wake();
    expect(flushed).toEqual([]);
    state.hidden = false;
    q.wake();
    expect(flushed).toEqual([['a', 'b']]);
    q.wake();
    expect(flushed).toHaveLength(1);
  });
});
