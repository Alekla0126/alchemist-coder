import { safeStorage } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import type { SecretStore } from '@alchemist-coder/core';

/**
 * API keys encrypted with the OS keychain (Keychain on macOS, DPAPI on Windows,
 * libsecret on Linux). If no keychain is available we refuse to store rather than
 * write secrets in plain text.
 */
export class KeychainSecretStore implements SecretStore {
  private cache: Record<string, string> | null = null;

  constructor(private readonly path: string) {}

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async get(key: string): Promise<string | null> {
    const blob = this.load()[key];
    if (!blob || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      return null;
    }
  }

  async set(key: string, value: string | null): Promise<void> {
    const all = { ...this.load() };
    if (value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('No system keychain available to store this secret safely.');
      all[key] = safeStorage.encryptString(value).toString('base64');
    } else delete all[key];
    writeFileSync(this.path, JSON.stringify(all, null, 2), { mode: 0o600 });
    this.cache = all;
  }

  async has(key: string): Promise<boolean> {
    return key in this.load();
  }
}
