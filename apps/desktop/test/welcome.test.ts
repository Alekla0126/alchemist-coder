import { beforeEach, describe, expect, it } from 'vitest';
import { closeWelcome, shouldWelcome, useWelcome } from '../src/renderer/src/welcome-state';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
});

describe('the welcome', () => {
  it('greets the app’s first launch on a computer, once, and never someone who used it before', () => {
    expect(shouldWelcome(false)).toBe(false);
    expect(shouldWelcome(true)).toBe(true);
    useWelcome.setState({ open: true });
    closeWelcome();
    expect(useWelcome.getState().open).toBe(false);
    expect(shouldWelcome(true)).toBe(false);
  });
});
