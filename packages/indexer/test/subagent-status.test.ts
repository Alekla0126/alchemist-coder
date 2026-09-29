import { describe, expect, it } from 'vitest';
import { subagentStatus } from '../src/indexer.ts';
import { newSummary } from '../src/summary.ts';

const T = Date.parse('2026-09-28T10:00:00Z');

function setup(ownLast: number, stop: string | null) {
  const main = newSummary();
  main.results.T1 = { isError: false, isAsync: true, status: 'async_launched', ts: T };
  main.notifications.T1 = 'completed';
  main.notifiedAt.T1 = T + 60_000;
  const own = newSummary();
  own.lastTs = ownLast;
  own.lastStopReason = stop;
  return { main, own };
}

describe('subagent status', () => {
  it('is done once its completion was reported', () => {
    const { main, own } = setup(T + 55_000, 'end_turn');
    expect(subagentStatus(undefined, main, { toolUseId: 'T1' }, own, T + 55_000, T + 70_000)).toBe('done');
  });

  it('runs again when resumed after reporting back, and finishes again', () => {
    const { main, own } = setup(T + 120_000, 'tool_use');
    expect(subagentStatus(undefined, main, { toolUseId: 'T1' }, own, T + 120_000, T + 125_000)).toBe('running');
    expect(subagentStatus(undefined, main, { toolUseId: 'T1' }, own, T + 120_000, T + 3_600_000)).toBe('interrupted');
    own.lastStopReason = 'end_turn';
    expect(subagentStatus(undefined, main, { toolUseId: 'T1' }, own, T + 120_000, T + 125_000)).toBe('done');
  });
});
