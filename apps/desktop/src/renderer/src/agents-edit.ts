import { create } from 'zustand';

const KEY = 'alchemist.hiddenAgents';

/** The built-in subagent types of Claude Code, in the order they're offered. */
export const BUILTIN_SUBAGENTS = ['general-purpose', 'Explore', 'Plan'] as const;

function load(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string[]] => Array.isArray(e[1])));
  } catch {
    return {};
  }
}

/**
 * Subagents you took out of a conversation's tree. Only the list is changed: the conversation keeps
 * them, and "Show hidden" brings them back.
 */
export const useHiddenAgents = create<{
  hidden: Record<string, string[]>;
  hide(sessionId: string, agentId: string): void;
  showAll(sessionId: string): void;
}>((set, get) => ({
  hidden: load(),
  hide(sessionId, agentId) {
    const list = get().hidden[sessionId] ?? [];
    if (list.includes(agentId)) return;
    save({ ...get().hidden, [sessionId]: [...list, agentId] });
  },
  showAll(sessionId) {
    const { [sessionId]: _, ...rest } = get().hidden;
    save(rest);
  },
}));

function save(hidden: Record<string, string[]>) {
  // Only the latest 300 conversations are remembered.
  const trimmed = Object.fromEntries(Object.entries(hidden).slice(-300));
  useHiddenAgents.setState({ hidden: trimmed });
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // no storage
  }
}

/**
 * What the main agent is asked, in plain words, to launch one more subagent with the Task tool.
 * `lines` are the app's translations (so the message reads in your language in the conversation).
 */
export function subagentPrompt(
  lines: { ask: string; background: string; report: string },
  o: { type: string; task: string; background: boolean },
): string {
  return [lines.ask.replace('{type}', o.type), '', o.task.trim(), '', [o.background ? lines.background : '', lines.report].filter(Boolean).join(' ')].join('\n');
}

const NAMES_KEY = 'alchemist.agentNames';

function loadNames(): Record<string, Record<string, string>> {
  try {
    const raw = JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, Record<string, string>] => !!e[1] && typeof e[1] === 'object'));
  } catch {
    return {};
  }
}

/**
 * Names you give a conversation's agents ("Scribe" instead of "general"), kept in the app: the
 * conversation's files don't change. An empty name brings the original back.
 */
export const useAgentNames = create<{
  names: Record<string, Record<string, string>>;
  rename(sessionId: string, agentId: string, name: string): void;
}>((set, get) => ({
  names: loadNames(),
  rename(sessionId, agentId, name) {
    const own = { ...get().names[sessionId] };
    const clean = name.trim().slice(0, 60);
    if (clean) own[agentId] = clean;
    else delete own[agentId];
    const names = { ...get().names, [sessionId]: own };
    if (!Object.keys(own).length) delete names[sessionId];
    const trimmed = Object.fromEntries(Object.entries(names).slice(-300));
    set({ names: trimmed });
    try {
      localStorage.setItem(NAMES_KEY, JSON.stringify(trimmed));
    } catch {
      // no storage
    }
  },
}));
