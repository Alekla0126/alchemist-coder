import { create } from 'zustand';
import type { BoardData, BoardTask } from '@shared/api';
import { useStore } from './store';
import { toast } from './ui';

/** A task handed to an agent: the next conversation started from `target` becomes its conversation. */
interface PendingStart {
  taskId: string;
  target: string;
  /** The run already on that target (a new one is what counts). */
  before: string | null;
  at: number;
}

interface BoardState {
  data: BoardData | null;
  pending: PendingStart | null;
  load(): Promise<void>;
  update(fn: (d: BoardData) => BoardData): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let loading: Promise<void> | null = null;
/** When this window last got the board from the app: the app's changes after that survive our saves. */
let seenAt = 0;

/** Saves what's on screen now; the app answers with the board merged with its own changes. */
async function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const data = useBoard.getState().data;
  if (!data) return;
  try {
    const merged = await window.alchemist.boardSave(data, seenAt);
    seenAt = Date.now();
    useBoard.setState({ data: merged });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

/** The board's tasks and placements, saved a moment after each change. */
export const useBoard = create<BoardState>((set, get) => ({
  data: null,
  pending: null,
  load() {
    if (get().data) return Promise.resolve();
    loading ??= window.alchemist
      .boardLoad()
      .then((data) => {
        seenAt = Date.now();
        set({ data });
        // An automation added or moved cards: take them (saving ours first, so nothing is lost).
        window.alchemist.onBoardChanged((next) => {
          if (timer) return void flush();
          seenAt = Date.now();
          set({ data: next });
        });
      })
      .catch((e) => {
        loading = null;
        toast(e instanceof Error ? e.message : String(e));
      });
    return loading;
  },
  update(fn) {
    const current = get().data;
    if (!current) return;
    const data = fn(current);
    set({ data });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 400);
  },
}));

/** Opens a new conversation in the task's project with the task written in the message box. */
export async function startTask(task: BoardTask, prompt: string) {
  const s = useStore.getState();
  const project = s.projects.find((p) => p.cwd === task.cwd);
  if (!project) return false;
  await s.openProject(project.id);
  if (s.settings.mode !== 'agents' && s.settings.mode !== 'split') s.setMode('agents');
  s.setCompose(project.id);
  const target = `p:${project.id}`;
  useBoard.setState({ pending: { taskId: task.id, target, before: useStore.getState().runByTarget[target] ?? null, at: Date.now() } });
  s.fillComposer(prompt, false);
  return true;
}

// When that conversation starts, the task follows it.
useStore.subscribe((s) => {
  const pending = useBoard.getState().pending;
  if (!pending) return;
  if (Date.now() - pending.at > 60 * 60 * 1000) return useBoard.setState({ pending: null });
  const runId = s.runByTarget[pending.target];
  const sessionId = runId && runId !== pending.before ? s.runs[runId]?.sessionId : null;
  if (!sessionId) return;
  useBoard.setState({ pending: null });
  void useBoard
    .getState()
    .load()
    .then(() => useBoard.getState().update((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === pending.taskId ? { ...t, sessionId, phase: 'implementing', updatedAt: Date.now() } : t)) })));
});
