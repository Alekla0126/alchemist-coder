import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES, matchLocale } from '../src/shared/api';
import { en } from '../src/renderer/src/locales/en';
import { en as mainEn } from '../src/main/locales/en';
import { translate } from '../src/renderer/src/i18n';

const dir = (p: string) => join(__dirname, '..', 'src', p);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<\/?([a-z]+)\b[^>]*>/g)].map((m) => m[0].replace(/\s.*>/, '>')).sort();
const shortcuts = (s: string) => [...s.matchAll(/[⌘⇧⌥⌃↵⌫]/g)].map((m) => m[0]).sort();
const FORMS = ['zero', 'one', 'two', 'few', 'many'];

/** Every language the app ships has a renderer and a main-process file. */
const shipped = readdirSync(dir('renderer/src/locales')).map((f) => f.replace(/\.ts$/, ''));

describe('languages', () => {
  it('every language in the list has its texts, and only those', () => {
    expect([...shipped].sort()).toEqual([...LOCALES].sort());
    expect(readdirSync(dir('main/locales')).filter((f) => f !== 'index.ts').map((f) => f.replace(/\.ts$/, '')).sort()).toEqual([...LOCALES].sort());
  });

  it('picks the closest language to the system one', () => {
    expect(matchLocale('es-MX')).toBe('es');
    expect(matchLocale('pt-PT')).toBe('pt-BR');
    expect(matchLocale('zh-TW')).toBe('zh-CN');
    expect(matchLocale('de-AT')).toBe('de');
    expect(matchLocale('sv-SE')).toBe('en');
  });

  it('counts in each language’s own plural forms', () => {
    expect(translate('en', 'status.runningAgents', { n: 1 })).toBe('1 agent working');
    expect(translate('en', 'status.runningAgents', { n: 3 })).toBe('3 agents working');
    expect(translate('es', 'status.runningAgents', { n: 1 })).toBe('1 agente trabajando');
  });

  for (const locale of shipped.filter((l) => l !== 'en')) {
    describe(locale, async () => {
      const app = Object.values(await import(`../src/renderer/src/locales/${locale}.ts`))[0] as Record<string, string>;
      const main = Object.values(await import(`../src/main/locales/${locale}.ts`))[0] as typeof mainEn;

      it('has every text of the app, each keeping its {variables}, tags and shortcuts', () => {
        const problems: string[] = [];
        for (const [key, source] of Object.entries(en)) {
          const text = app[key];
          if (typeof text !== 'string' || !text.trim()) {
            problems.push(`${key}: missing`);
            continue;
          }
          // A count's form may write the number as {n} where English writes "1".
          const vars = (s: string) => placeholders(s).filter((v) => !(/\.(zero|one|two|few|many)$/.test(key) && v === 'n'));
          if (vars(text).join() !== vars(source).join()) problems.push(`${key}: variables ${placeholders(text)} ≠ ${placeholders(source)}`);
          if (tags(text).join() !== tags(source).join()) problems.push(`${key}: tags differ`);
          if (shortcuts(text).join() !== shortcuts(source).join()) problems.push(`${key}: shortcuts differ`);
        }
        // Beyond English's keys, only a count's other forms ("<key>.few") of a key that takes {n}.
        for (const key of Object.keys(app)) {
          if (key in en) continue;
          const base = key.replace(/\.(\w+)$/, '');
          const form = key.slice(base.length + 1);
          if (!FORMS.includes(form) || !(base in en) || !placeholders((en as Record<string, string>)[base]!).includes('n')) problems.push(`${key}: not a key of the app`);
        }
        expect(problems).toEqual([]);
      });

      it('has the menu, automations’ and notifications’ texts, in the same shape', () => {
        const shape = (o: unknown): unknown =>
          typeof o === 'function' ? `fn/${o.length}` : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : typeof o;
        expect(shape(main)).toEqual(shape(mainEn));
        // Each phrase built from values comes out whole, with the values in it.
        const walk = (o: Record<string, unknown>, path: string) => {
          for (const [k, v] of Object.entries(o)) {
            if (typeof v === 'string') expect(v.trim(), `${path}.${k}`).not.toBe('');
            else if (typeof v === 'function') {
              const args = Array.from({ length: v.length }, (_, i) => (i === 0 ? 'X1' : 2));
              const out = String(v(...args));
              expect(out.includes('X1') || v.length === 0 || typeof args[0] !== 'string', `${path}.${k}`).toBe(true);
            } else if (v && typeof v === 'object') walk(v as Record<string, unknown>, `${path}.${k}`);
          }
        };
        walk(main as unknown as Record<string, unknown>, locale);
      });
    });
  }
});
