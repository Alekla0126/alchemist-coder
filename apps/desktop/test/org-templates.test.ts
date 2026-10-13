import { beforeEach, describe, expect, it } from 'vitest';
import { translate } from '../src/renderer/src/i18n';
import { defaultTemplate, HOUSE_TEMPLATE, setDefaultTemplate, starterTemplates, type Template } from '../src/renderer/src/org-templates';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
});

const mine: Template = { id: 'tpl-1', name: 'Weekly review', goal: 'Review the week', guidance: 'Only read.', reviewPlan: false, budget: '5' };

describe('the templates an assignment starts from', () => {
  it("The Alchemist Code's comes first, under the company's name in every language", () => {
    for (const locale of ['en', 'es', 'ja'] as const) {
      const starters = starterTemplates((key) => translate(locale, key));
      expect(starters[0]).toMatchObject({ id: HOUSE_TEMPLATE, name: 'The Alchemist Code', reviewPlan: true, goal: '' });
      expect(starters[0].guidance).toContain('The Alchemist Code');
      expect(starters.map((s) => s.id)).toEqual(['starter:alchemist', 'starter:build', 'starter:security', 'starter:research']);
    }
  });

  it('is the default until you make another one the default, or choose none', () => {
    const all = [...starterTemplates((key) => translate('es', key)), mine];
    expect(defaultTemplate(all)?.id).toBe(HOUSE_TEMPLATE);
    setDefaultTemplate('tpl-1');
    expect(defaultTemplate(all)).toBe(mine);
    setDefaultTemplate(null);
    expect(defaultTemplate(all)).toBeNull();
  });

  it('comes back when the template you made the default is deleted', () => {
    const all = starterTemplates((key) => translate('en', key));
    setDefaultTemplate('tpl-1');
    expect(defaultTemplate(all)?.id).toBe(HOUSE_TEMPLATE);
  });
});
