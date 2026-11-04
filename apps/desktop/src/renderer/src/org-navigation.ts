import type { BotMember, BotTeam } from '@shared/api';

/** Existing assignment tasks, with their owner and destination; no synthetic board records. */
export function organizationTasks(teams: BotTeam[]): Array<{ team: BotTeam; bot: BotMember }> {
  const priority = { waiting: 0, working: 1, starting: 2, error: 3, idle: 4, stopped: 5, done: 6 };
  return teams.flatMap((team) => team.bots.filter((bot) => bot.task.trim()).map((bot) => ({ team, bot })))
    .sort((a, b) => priority[a.bot.status] - priority[b.bot.status] || b.team.updatedAt - a.team.updatedAt);
}
