import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Mode, Settings } from '../shared/api';

const MODES: Mode[] = ['agents', 'arena', 'code', 'split', 'terminal', 'history'];

export const defaultSettings = (): Settings => ({ locale: null, theme: 'alchemist-dark', openProjectIds: [], activeProjectId: null, mode: 'agents', backupDir: null, backupAuto: true });

/** Only known keys with the right types survive: settings.json is user-editable. */
export function sanitize(input: unknown, base: Settings): Settings {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const ids = Array.isArray(o.openProjectIds) ? o.openProjectIds.filter((n): n is number => Number.isInteger(n)).slice(0, 24) : base.openProjectIds;
  return {
    locale: o.locale === 'en' || o.locale === 'es' || o.locale === null ? o.locale : base.locale,
    theme: typeof o.theme === 'string' && /^[\w.:-]{1,80}$/.test(o.theme) ? o.theme : base.theme,
    openProjectIds: ids,
    activeProjectId: Number.isInteger(o.activeProjectId) ? (o.activeProjectId as number) : o.activeProjectId === null ? null : base.activeProjectId,
    mode: MODES.includes(o.mode as Mode) ? (o.mode as Mode) : base.mode,
    backupDir: typeof o.backupDir === 'string' && isAbsolute(o.backupDir) ? o.backupDir : o.backupDir === null ? null : base.backupDir,
    backupAuto: typeof o.backupAuto === 'boolean' ? o.backupAuto : base.backupAuto,
  };
}

export class SettingsStore {
  private value: Settings;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // first run or unreadable file: start from defaults
    }
    this.value = sanitize(raw, defaultSettings());
  }

  get(): Settings {
    return this.value;
  }

  update(patch: unknown): Settings {
    this.value = sanitize({ ...this.value, ...(patch as object) }, this.value);
    writeFileSync(this.path, JSON.stringify(this.value, null, 2));
    return this.value;
  }
}
