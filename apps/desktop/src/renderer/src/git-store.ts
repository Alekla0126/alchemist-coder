import { create } from 'zustand';
import type { GitOverview } from '@shared/api';

/** Each project's repository at a glance, shared by the Git panel and the status bar. */
export const useGit = create<{
  byCwd: Record<string, GitOverview>;
  busy: Record<string, string | null>;
  load(cwd: string): Promise<void>;
}>((set) => ({
  byCwd: {},
  busy: {},
  async load(cwd) {
    try {
      const overview = await window.alchemist.gitOverview(cwd);
      set((s) => ({ byCwd: { ...s.byCwd, [cwd]: overview } }));
    } catch {
      // Not one of your projects any more, or git missing: the panel says so on its next try.
    }
  },
}));

/** Changes by kind, in the words the panel uses. */
export function changeCounts(o: GitOverview) {
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let conflicted = 0;
  for (const f of o.files) {
    if (f.status.includes('U')) conflicted++;
    else if (f.status === '?' || f.status.includes('A')) added++;
    else if (f.status.includes('D')) deleted++;
    else modified++;
  }
  return { modified, added, deleted, conflicted, total: o.files.length };
}
