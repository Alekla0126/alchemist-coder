import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AlchemistExtension, ProviderAdapter, SecretStore } from '@alchemist-coder/core';
import type { ClaudeLimits } from '../shared/api';

export interface ProModule {
  extension: AlchemistExtension;
  /** Decides the edition from a signed license; must work offline within the grace period. */
  isPro(host: { userData: string; secrets: SecretStore }): Promise<boolean>;
}

/**
 * The official build ships a closed-source Pro extension next to the app. Community builds
 * (from this repository) have none, so everything here is optional by design.
 */
export function loadProModule(resourcesPath: string): ProModule | null {
  const candidates = [process.env.AC_PRO_EXTENSION, join(resourcesPath, 'extensions', 'pro.cjs')].filter((p): p is string => !!p);
  const path = candidates.find((p) => existsSync(p));
  if (!path) return null;
  try {
    const mod = createRequire(import.meta.url)(path) as Partial<ProModule> & { default?: Partial<ProModule> };
    const m = (mod.extension ? mod : mod.default) as Partial<ProModule> | undefined;
    if (typeof m?.extension !== 'function' || typeof m.isPro !== 'function') return null;
    return m as ProModule;
  } catch (error) {
    console.error('[pro] failed to load extension', error);
    return null;
  }
}

/**
 * A module someone bundles into their own copy of the app, for themselves only (it's never part
 * of a release): extra providers, allowed in the Community edition too, and their Claude plan's
 * usage percentages. Everything is optional.
 */
export interface PersonalModule {
  providers?(): ProviderAdapter[];
  claudeLimits?(claudeVersion: string): Promise<ClaudeLimits>;
}

/** Loads resources/extensions/personal.cjs (or AC_PERSONAL_MODULE in development), if there is one. */
export function loadPersonalModule(resourcesPath: string): PersonalModule | null {
  const candidates = [process.env.AC_PERSONAL_MODULE, join(resourcesPath, 'extensions', 'personal.cjs')].filter((p): p is string => !!p);
  const path = candidates.find((p) => existsSync(p));
  if (!path) return null;
  try {
    const mod = createRequire(import.meta.url)(path) as PersonalModule & { default?: PersonalModule };
    const m = mod.providers || mod.claudeLimits ? mod : mod.default;
    if (!m || (typeof m.providers !== 'function' && typeof m.claudeLimits !== 'function')) return null;
    return m;
  } catch (error) {
    console.error('[personal] failed to load module', error);
    return null;
  }
}
