import type { AgentChoice, BotConfig, StartTeamRequest } from '@shared/api';

/** Explicit new-assignment routing. Never edits staff or reuses a thread from another engine. */
export function organizationAssignment(input: { coordinator: BotConfig; goal: string; cwd: string; agentOverride?: AgentChoice | null; budgetUsd: number | null; approvePlan: boolean; guidance: string }): StartTeamRequest {
  return {
    goal: input.goal,
    cwd: input.cwd,
    configId: input.coordinator.id,
    ...(input.agentOverride ? { agentOverride: { ...input.agentOverride } } : {}),
    budgetUsd: input.budgetUsd,
    approvePlan: input.approvePlan,
    guidance: input.guidance,
  };
}
