import { describe, expect, it } from 'vitest';
import type { BotMember, BotTeam } from '../src/shared/api';
import { organizationTasks } from '../src/renderer/src/org-navigation';

const bot = (id: string, status: BotMember['status'], task = id) => ({ id, status, task }) as BotMember;
const team = (id: string, updatedAt: number, bots: BotMember[]) => ({ id, updatedAt, bots }) as BotTeam;

describe('organization task navigation', () => {
  it('keeps exact team and agent destinations even when task labels repeat', () => {
    const first = team('a', 10, [bot('same', 'working', 'Review')]);
    const second = team('b', 20, [bot('same', 'waiting', 'Review')]);
    const tasks = organizationTasks([first, second]);
    expect(tasks.map(({ team, bot }) => [team.id, bot.id])).toEqual([['b', 'same'], ['a', 'same']]);
    expect(tasks[0]!.team).toBe(second);
    expect(tasks[0]!.bot).toBe(second.bots[0]);
  });

  it('prioritizes attention and current work while retaining completed history without changing records', () => {
    const teams = [team('old', 10, [bot('done', 'done'), bot('empty', 'idle', '  ')]), team('new', 20, [bot('working', 'working'), bot('waiting', 'waiting'), bot('error', 'error')])];
    const before = JSON.stringify(teams);
    expect(organizationTasks(teams).map(({ bot }) => bot.id)).toEqual(['waiting', 'working', 'error', 'done']);
    expect(JSON.stringify(teams)).toBe(before);
    expect(organizationTasks([])).toEqual([]);
  });
});
