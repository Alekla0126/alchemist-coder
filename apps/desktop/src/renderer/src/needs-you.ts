import type { Mode } from '@shared/api';

/**
 * Where each thing that needs you is shown, so the title bar's «Needs you» takes you right there:
 * the conversation (on its main agent's tab, where the approval card is), a new conversation's
 * composer, a bot's assignment, an Arena task, Marketing, a plan to review or an automation's
 * question. With several waiting, it goes to the next one you aren't already looking at.
 */
export type Place =
  | { kind: 'session'; key: string; sessionId: string }
  | { kind: 'compose'; key: string; projectId: number }
  | { kind: 'bot'; key: string; teamId: string; botId: string }
  | { kind: 'arena'; key: string; taskId: string }
  | { kind: 'marketing'; key: string }
  | { kind: 'plan'; key: string; teamId: string; botId: string | null }
  | { kind: 'automation'; key: string; automationId: string };

/** The parts of the app's state this reads (a subset of the store's). */
export interface NeedsYouState {
  runs: Record<string, { runId: string; target: string; status: string; cwd?: string }>;
  projects: Array<{ id: number; cwd: string }>;
  botTeams: Array<{ id: string; plan?: { status: string } | null; bots: Array<{ id: string; runId: string | null }> }>;
  tasks: Record<string, { id: string; planner: { runId: string | null } | null; contestants: Array<{ runId: string | null }> }>;
  automations: Array<{ automation: { id: string }; runs: Array<{ asks: unknown[] }> }>;
  settings: { mode: Mode };
  selection: { sessionId: string; agentId: string } | null;
  composeProjectId: number | null;
  activeTeamId: string | null;
  activeBotId: string | null;
  activeTaskId: string | null;
  activeAutomationId: string | null;
}

/** Everything waiting for you, each with the place it's answered in; runs first, then plans and automations. */
export function waitingPlaces(s: NeedsYouState): Place[] {
  const places: Place[] = [];
  for (const run of Object.values(s.runs)) {
    if (run.status !== 'waiting') continue;
    const team = s.botTeams.find((t) => t.bots.some((b) => b.runId === run.runId));
    if (team) {
      places.push({ kind: 'bot', key: `run:${run.runId}`, teamId: team.id, botId: team.bots.find((b) => b.runId === run.runId)!.id });
      continue;
    }
    const task = Object.values(s.tasks).find((t) => t.planner?.runId === run.runId || t.contestants.some((c) => c.runId === run.runId));
    if (task) {
      places.push({ kind: 'arena', key: `run:${run.runId}`, taskId: task.id });
      continue;
    }
    if (run.target.startsWith('s:')) places.push({ kind: 'session', key: `run:${run.runId}`, sessionId: run.target.slice(2) });
    else if (run.target.startsWith('mk:')) places.push({ kind: 'marketing', key: `run:${run.runId}` });
    else if (run.target.startsWith('p:')) places.push({ kind: 'compose', key: `run:${run.runId}`, projectId: Number(run.target.slice(2)) });
    else {
      // Started elsewhere, in a project folder: its composer.
      const project = s.projects.find((p) => p.cwd === run.cwd);
      if (project) places.push({ kind: 'compose', key: `run:${run.runId}`, projectId: project.id });
    }
  }
  for (const team of s.botTeams) {
    if (team.plan?.status === 'pending') places.push({ kind: 'plan', key: `plan:${team.id}`, teamId: team.id, botId: team.bots[0]?.id ?? null });
  }
  for (const a of s.automations) {
    if (a.runs[0]?.asks.length) places.push({ kind: 'automation', key: `auto:${a.automation.id}`, automationId: a.automation.id });
  }
  return places;
}

/** You're looking at this place right now. */
export function isShown(place: Place, s: NeedsYouState): boolean {
  const mode = s.settings.mode;
  switch (place.kind) {
    case 'session':
      return (mode === 'agents' || mode === 'split') && s.selection?.sessionId === place.sessionId && s.selection.agentId === 'main';
    case 'compose':
      return mode === 'agents' && !s.selection && s.composeProjectId === place.projectId;
    case 'bot':
      return mode === 'bots' && s.activeTeamId === place.teamId && s.activeBotId === place.botId;
    case 'arena':
      return mode === 'arena' && s.activeTaskId === place.taskId;
    case 'marketing':
      return mode === 'marketing';
    case 'plan':
      return mode === 'bots' && s.activeTeamId === place.teamId;
    case 'automation':
      return mode === 'bots' && s.activeAutomationId === place.automationId;
  }
}

/** Where the button goes: the first waiting place you aren't on (or the first, if you're on all of them). */
export function nextPlace(s: NeedsYouState): Place | null {
  const places = waitingPlaces(s);
  return places.find((p) => !isShown(p, s)) ?? places[0] ?? null;
}
