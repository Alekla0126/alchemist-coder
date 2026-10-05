import type { Locale } from '../../shared/api';
import { en } from './en';
import { es } from './es';
import { ptBR } from './pt-BR';
import { fr } from './fr';
import { de } from './de';
import { it } from './it';
import { ru } from './ru';
import { ja } from './ja';
import { ko } from './ko';
import { zhCN } from './zh-CN';
import { hi } from './hi';

export type MainWords = typeof en;

const words: Record<Locale, MainWords> = { en, es, 'pt-BR': ptBR, fr, de, it, ru, ja, ko, 'zh-CN': zhCN, hi };

/** The main process's texts in a language. */
export const mainWords = (locale: Locale): MainWords => words[locale] ?? en;
