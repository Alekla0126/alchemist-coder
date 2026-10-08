import { create } from 'zustand';

const KEY = 'alchemist.welcomed';

/** The welcome: shown once on a new computer, and from Help → Welcome. */
export const useWelcome = create<{ open: boolean }>(() => ({ open: false }));

/** The app's first launch on this computer, not welcomed yet (people who used it before never see it unasked). */
export function shouldWelcome(firstRun: boolean): boolean {
  try {
    return firstRun && !localStorage.getItem(KEY);
  } catch {
    return false;
  }
}

export function closeWelcome() {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    // shown again next launch
  }
  useWelcome.setState({ open: false });
}
