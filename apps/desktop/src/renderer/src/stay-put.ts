/**
 * The app never moves you on its own: what changes elsewhere shows where it is (unread, a badge, a
 * pill) and waits for your click. These are the rules for the two places it used to move you.
 *
 * A new conversation, the first time the index reports it: the «New conversation» screen it was sent
 * from turns into it only while you're still on that screen. Anywhere else it shows up in the sidebar,
 * and that project's «New conversation» starts empty again.
 */

/** The parts of the app's state this reads (a subset of the store's). */
export interface ComposeFollowState {
  runs: Record<string, { runId: string; target: string; sessionId?: string | null }>;
  runByTarget: Record<string, string>;
  composeProjectId: number | null;
  selection: { sessionId: string } | null;
  activeProjectId: number | null;
}

export interface BornConversation {
  runId: string;
  /** `p:<projectId>`: the «New conversation» screen it was sent from. */
  target: string;
  sessionId: string;
  /** You're still on that screen: it becomes the conversation, in place. */
  follow: boolean;
}

/**
 * The new conversation among the sessions the index just reported, if any. Only the run a «New
 * conversation» screen is still bound to counts, so an older one writing again never pulls you anywhere.
 */
export function bornConversation(s: ComposeFollowState, changed: string[]): BornConversation | null {
  for (const run of Object.values(s.runs)) {
    if (!run.target.startsWith('p:') || !run.sessionId || !changed.includes(run.sessionId)) continue;
    if (s.runByTarget[run.target] !== run.runId) continue;
    const projectId = Number(run.target.slice(2));
    const follow = s.composeProjectId === projectId && s.activeProjectId === projectId && s.selection === null;
    return { runId: run.runId, target: run.target, sessionId: run.sessionId, follow };
  }
  return null;
}

/**
 * «New conversation» asked for again: the conversation its screen was holding lets go of it once it
 * exists (its run knows its session, so it also lives on as `s:<id>` and in the sidebar), and the screen
 * opens empty, with every agent to pick. Until then (no session yet) the screen keeps it, so a message
 * just sent is never lost. Returns the binding to drop, or null.
 */
export function heldConversation(s: Pick<ComposeFollowState, 'runs' | 'runByTarget'>, projectId: number): string | null {
  const target = `p:${projectId}`;
  const runId = s.runByTarget[target];
  return runId && s.runs[runId]?.sessionId ? target : null;
}

/**
 * The projects open while you haven't picked any yet (the first index): the most active ones, which
 * change as the index fills. The one you're on stays among them, so the index never switches it.
 */
export function provisionalProjects(mostActive: number[], activeProjectId: number | null, count = 4): number[] {
  const top = mostActive.slice(0, count);
  if (activeProjectId == null || top.includes(activeProjectId) || !mostActive.includes(activeProjectId)) return top;
  return [activeProjectId, ...top.slice(0, count - 1)];
}
