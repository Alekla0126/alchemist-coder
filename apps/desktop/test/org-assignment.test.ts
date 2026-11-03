import { expect, it } from 'vitest';
import type { BotConfig } from '../src/shared/api';
import { organizationAssignment } from '../src/renderer/src/org-assignment';

const ceo: BotConfig = { id: 'ceo', name: 'CEO', kind: 'coordinator', role: 'Coordinate', agent: { harnessId: 'claude-code', providerId: 'claude-login', model: 'default' }, permissionMode: 'acceptEdits', canSpawn: true };
const input = { coordinator: ceo, goal: 'Keep this unsent draft', cwd: '/p', budgetUsd: 2, approvePlan: true, guidance: 'Read the brand guide' };

it('makes a new assignment with an explicit engine instead of silently using the saved Claude CEO', () => {
  const override = { harnessId: 'codex', providerId: 'openai', model: 'future-codex', effort: 'low' };
  const request = organizationAssignment({ ...input, agentOverride: override });
  expect(request).toEqual({ goal: input.goal, cwd: '/p', configId: 'ceo', agentOverride: override, budgetUsd: 2, approvePlan: true, guidance: input.guidance });
  expect(request.agentOverride).not.toBe(override);
  expect(ceo.agent.harnessId).toBe('claude-code');
  expect('resumeSessionId' in request).toBe(false);
  expect('permissionMode' in request).toBe(false);
});

it('uses the saved CEO when no explicit override is selected', () => {
  expect(organizationAssignment({ ...input, agentOverride: null })).not.toHaveProperty('agentOverride');
});
