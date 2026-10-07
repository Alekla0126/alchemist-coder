import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNewer, noted, updateCommand, versionOf } from '../src/main/cli-versions';

describe('CLI versions', () => {
  it('reads the version each CLI prints', () => {
    expect(versionOf('2.1.220 (Claude Code)')).toBe('2.1.220');
    expect(versionOf('codex-cli 0.150.1')).toBe('0.150.1');
    expect(versionOf('kimi, version 1.33.0')).toBe('1.33.0');
    expect(versionOf('0.117.0-alpha.24')).toBe('0.117.0-alpha.24');
    expect(versionOf('')).toBeNull();
  });

  it('compares versions part by part, a pre-release before its release', () => {
    expect(isNewer('1.35.0', '1.33.0')).toBe(true);
    expect(isNewer('2.1.289', '2.1.220')).toBe(true);
    expect(isNewer('0.150.1', '0.150.1')).toBe(false);
    expect(isNewer('0.150.10', '0.150.9')).toBe(true);
    expect(isNewer('0.117.0', '0.117.0-alpha.24')).toBe(true);
    expect(isNewer('1.0', '1.0.1')).toBe(false);
    expect(isNewer(null, '1.0.0')).toBe(false);
  });

  it('updates each CLI the way it was installed', () => {
    expect(updateCommand('claude', '/opt/homebrew/Caskroom/claude-code/2.1.220/claude')).toBe('brew upgrade --cask claude-code');
    expect(updateCommand('claude', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('npm install -g @anthropic-ai/claude-code@latest');
    expect(updateCommand('claude', '/Users/me/.local/share/claude/versions/2.1.289')).toBe('claude update');
    expect(updateCommand('codex', '/Users/me/.codex/packages/standalone/releases/0.150.1/bin/codex')).toBe('codex update');
    expect(updateCommand('codex', 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js')).toBe('npm install -g @openai/codex@latest');
    expect(updateCommand('kimi', '/Users/me/.local/share/uv/tools/kimi-cli/bin/kimi')).toBe('uv tool upgrade kimi-cli');
    expect(updateCommand('kimi', '/somewhere/else/kimi')).toBeNull();
  });

  it('uses the newest version the CLI noted itself while it is recent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'versions-'));
    const homes = { codexVersionFile: join(dir, 'version.json'), kimiVersionFile: join(dir, 'latest_version.txt') };
    const now = Date.parse('2026-10-07T20:00:00Z');
    writeFileSync(homes.codexVersionFile, JSON.stringify({ latest_version: '0.154.0', last_checked_at: '2026-10-06T20:00:00Z' }));
    writeFileSync(homes.kimiVersionFile, '1.35.0\n');
    utimesSync(homes.kimiVersionFile, new Date(now - 3600_000), new Date(now - 3600_000));
    expect(noted('codex', homes, now)).toBe('0.154.0');
    expect(noted('kimi', homes, now)).toBe('1.35.0');
    // Older than three days: asked again.
    writeFileSync(homes.codexVersionFile, JSON.stringify({ latest_version: '0.154.0', last_checked_at: '2026-09-11T20:00:00Z' }));
    expect(noted('codex', homes, now)).toBeNull();
    expect(noted('claude', homes, now)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
