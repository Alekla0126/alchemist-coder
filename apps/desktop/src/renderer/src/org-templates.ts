import type { MessageKey } from './i18n';

/** A saved way of giving an assignment: goal, guidance for the coordinator, plan review, budget. */
export interface Template {
  id: string;
  name: string;
  goal: string;
  guidance: string;
  reviewPlan: boolean;
  budget: string;
}

const TEMPLATES_KEY = 'alchemist.teamTemplates';
const DEFAULT_KEY = 'alchemist.defaultTemplate';

/** The Alchemist Code's way of working: what every assignment starts with, until you make another template the default. */
export const HOUSE_TEMPLATE = 'starter:alchemist';
const STARTERS = ['alchemist', 'build', 'security', 'research'] as const;

/** The templates that come with the app, the house one first. Its name is the company's, the same in every language. */
export function starterTemplates(t: (key: MessageKey) => string): Template[] {
  return STARTERS.map((k) => ({
    id: `starter:${k}`,
    name: k === 'alchemist' ? 'The Alchemist Code' : t(`bots.tpl.${k}.name`),
    goal: '',
    guidance: t(`bots.tpl.${k}.role`),
    reviewPlan: true,
    budget: '',
  }));
}

export const loadTemplates = (): Template[] => {
  try {
    const v = JSON.parse(localStorage.getItem(TEMPLATES_KEY) ?? '[]') as Array<Partial<Template> & { role?: string }>;
    // Templates from the Bots era kept the coordinator's role: it is this assignment's guidance now.
    return Array.isArray(v) ? v.map((x) => ({ id: String(x.id), name: String(x.name ?? ''), goal: x.goal ?? '', guidance: x.guidance ?? x.role ?? '', reviewPlan: x.reviewPlan !== false, budget: x.budget ?? '' })) : [];
  } catch {
    return [];
  }
};
export const saveTemplates = (list: Template[]) => localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list.slice(0, 30)));

/** The template a new assignment starts with: the one you made the default, else the house one. "No template" is a choice too. */
export function defaultTemplate(all: Template[]): Template | null {
  const id = localStorage.getItem(DEFAULT_KEY);
  if (id === '') return null;
  // A default you've since deleted falls back to the house one.
  return all.find((x) => x.id === id) ?? all.find((x) => x.id === HOUSE_TEMPLATE) ?? null;
}

/** Makes a template the one assignments start with (null: start with none). */
export const setDefaultTemplate = (id: string | null) => localStorage.setItem(DEFAULT_KEY, id ?? '');
