import { keys } from './keys';
import { matchLocale, type Locale } from '@shared/api';
import { en } from './locales/en';
import { es } from './locales/es';
import { ptBR } from './locales/pt-BR';
import { fr } from './locales/fr';
import { de } from './locales/de';
import { it } from './locales/it';
import { ru } from './locales/ru';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { zhCN } from './locales/zh-CN';
import { hi } from './locales/hi';

export type MessageKey = keyof typeof en;
/**
 * A language's texts: every key English has. A count's other forms go under "<key>.<form>", with
 * the language's own plural forms (Intl.PluralRules): "one" in English, also "few" and "many" in
 * Russian; Japanese, Chinese and Korean have none.
 */
export type Messages = Record<MessageKey, string> & { [form: `${string}.${'zero' | 'one' | 'two' | 'few' | 'many'}`]: string };


const dictionaries: Record<Locale, Messages> = { en, es, 'pt-BR': ptBR, fr, de, it, ru, ja, ko, 'zh-CN': zhCN, hi };

export function resolveLocale(preferred: Locale | null, system: string): Locale {
  return preferred ?? matchLocale(system);
}

const plurals = new Map<Locale, Intl.PluralRules>();
const pluralOf = (locale: Locale, n: number) => {
  let rules = plurals.get(locale);
  if (!rules) plurals.set(locale, (rules = new Intl.PluralRules(locale)));
  return rules.select(n);
};

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const dict = (dictionaries[locale] ?? en) as Record<string, string>;
  // "1 bot", not "1 bots": a count picks its form in the language ("<key>.one", "<key>.few"…).
  const form = typeof vars?.n === 'number' ? pluralOf(locale, vars.n) : 'other';
  const formText = form !== 'other' ? dict[`${key}.${form}`] : undefined;
  // A form written with the number itself ("1 agent") only fits that number; with {n} it fits them all.
  let s = (formText && (formText.includes('{n}') || vars?.n === 1) ? formText : undefined) ?? dict[key] ?? en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return keys(s);
}
