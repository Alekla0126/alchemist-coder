import type { AgentChoice, BotConfig, OrgExecutionPolicy, StartTeamRequest } from '@shared/api';

/** Explicit new-assignment routing. Never edits staff or reuses a thread from another engine. */
export function organizationAssignment(input: { coordinator: BotConfig; requestId?: string; goal: string; cwd: string; agentOverride?: AgentChoice | null; durable?: OrgExecutionPolicy | null; budgetUsd: number | null; approvePlan: boolean; guidance: string }): StartTeamRequest {
  return {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    goal: input.goal,
    cwd: input.cwd,
    configId: input.coordinator.id,
    ...(input.agentOverride ? { agentOverride: { ...input.agentOverride } } : {}),
    ...(input.durable ? { durable: { ...input.durable } } : {}),
    budgetUsd: input.budgetUsd,
    approvePlan: input.approvePlan,
    guidance: input.guidance,
  };
}
