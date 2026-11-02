import type { BotConfig, BotTeam, OrgGroup, OrgSettings } from '@shared/api';
import { isInside } from './paths';

/**
 * Organizations (Claude Coder, LinkedIn…) as groups of project folders, to look at the organization
 * by: they only choose what the sidebar and the office show. Messages between agents don't read them.
 */

/** Where the organization you look at is kept between launches ('' = all). */
export const ORG_GROUP_KEY = 'alchemist.orgGroup';

/** The organization chosen to look at, if it still exists. */
export const groupOf = (org: OrgSettings | null, id: string): OrgGroup | null => (id ? (org?.groups?.find((g) => g.id === id) ?? null) : null);

/** An assignment shows under an organization when its folder is in one of its folders; with none chosen, always. */
export const teamInGroup = (team: BotTeam, group: OrgGroup | null) => !group || group.projects.some((p) => isInside(team.cwd, p));

/** An agent shows under an organization when one of its projects is in it; the coordinator and agents for every project, always. */
export const memberInGroup = (c: BotConfig, group: OrgGroup | null) =>
  !group || c.kind === 'coordinator' || !c.projects?.length || c.projects.some((p) => group.projects.some((g) => isInside(p, g) || isInside(g, p)));

/** A new organization's id from its name, unlike the others: "Side projects" → "side-projects", then "side-projects-2". */
export function newGroupId(name: string, groups: OrgGroup[]): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'org';
  let id = base;
  for (let n = 2; groups.some((g) => g.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** The organizations with `cwd` added to or taken out of one of them. */
export const toggleFolder = (groups: OrgGroup[], id: string, cwd: string): OrgGroup[] =>
  groups.map((g) => (g.id !== id ? g : { ...g, projects: g.projects.includes(cwd) ? g.projects.filter((p) => p !== cwd) : [...g.projects, cwd] }));
