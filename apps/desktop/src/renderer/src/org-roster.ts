import type { AgentChoice, ModelTier, PermissionMode, RunnerCatalog, StarterAgent } from '@shared/api';
import { matchModel } from './format';
import type { MessageKey } from './i18n';

/**
 * The staff a new organization starts with: The Alchemist Code's own, a company of one person and
 * its agents, department by department. Each lead has its team; the model goes by what a mistake
 * costs (opus to decide and review, sonnet to do, haiku to measure and summarize), and the agents
 * that only read or judge ask before acting.
 */
export interface RosterAgent {
  key: string;
  /** Whose team it's on (a key); none: it reports to the coordinator. */
  lead?: string;
  tier: ModelTier;
  permission: PermissionMode;
  canSpawn?: boolean;
  ownWorktree?: boolean;
  /** A vacancy: it shows as suggested until you keep it. */
  proposed?: boolean;
}

export const ROSTER: RosterAgent[] = [
  { key: 'coordinator', tier: 'opus', permission: 'acceptEdits', canSpawn: true },
  // Health & stores
  { key: 'compliance', tier: 'opus', permission: 'default' },
  // App factory
  { key: 'factory', tier: 'sonnet', permission: 'acceptEdits', ownWorktree: true },
  // Growth
  { key: 'strategy', tier: 'opus', permission: 'acceptEdits' },
  { key: 'aso', lead: 'strategy', tier: 'sonnet', permission: 'acceptEdits', ownWorktree: true },
  { key: 'seo', lead: 'strategy', tier: 'sonnet', permission: 'acceptEdits' },
  { key: 'social', lead: 'strategy', tier: 'sonnet', permission: 'acceptEdits' },
  { key: 'writer', lead: 'strategy', tier: 'sonnet', permission: 'acceptEdits' },
  { key: 'analyst', lead: 'strategy', tier: 'haiku', permission: 'acceptEdits' },
  // Product & engineering
  { key: 'planner', tier: 'opus', permission: 'default', canSpawn: true },
  { key: 'coder', lead: 'planner', tier: 'sonnet', permission: 'acceptEdits' },
  { key: 'tester', lead: 'planner', tier: 'sonnet', permission: 'acceptEdits' },
  { key: 'reviewer', lead: 'planner', tier: 'opus', permission: 'default' },
  { key: 'uijudge', lead: 'planner', tier: 'sonnet', permission: 'default' },
  { key: 'researcher', lead: 'planner', tier: 'sonnet', permission: 'default' },
  // Finance & monetization
  { key: 'finance', tier: 'sonnet', permission: 'default' },
  // Studio (custom projects): a vacancy until you keep it
  { key: 'sales', tier: 'sonnet', permission: 'default', proposed: true },
];

/**
 * Each tier as one of the provider's models: "opus" on a Claude login, "claude-opus-…" with an API
 * key; a provider without that family (Codex, Gemini) keeps the agent's model.
 */
export function tierModels(catalog: RunnerCatalog | null, agent: AgentChoice): (tier: ModelTier) => string | undefined {
  const models = catalog?.providers.find((p) => p.id === agent.providerId)?.models ?? [];
  return (tier) => matchModel(models, tier);
}

/** The staff in the app's language, as the main process takes it (ensureOrg, renewStaff). */
export function rosterOf(t: (key: MessageKey) => string, modelOf: (tier: ModelTier) => string | undefined = () => undefined): Record<string, StarterAgent> {
  return Object.fromEntries(
    ROSTER.map((a) => [
      a.key,
      {
        name: t(`bots.starter.${a.key}.name` as MessageKey),
        role: t(`bots.starter.${a.key}.role` as MessageKey),
        tier: a.tier,
        ...(modelOf(a.tier) ? { model: modelOf(a.tier) } : {}),
        permissionMode: a.permission,
        canSpawn: a.canSpawn === true,
        ownWorktree: a.ownWorktree === true,
        ...(a.lead ? { lead: a.lead } : {}),
        ...(a.proposed ? { proposed: true } : {}),
      } satisfies StarterAgent,
    ]),
  );
}

/** How many departments the staff has: the coordinator's direct reports, each with its team. */
export const ROSTER_DEPARTMENTS = ROSTER.filter((a) => a.key !== 'coordinator' && !a.lead).length;
