import { describe, expect, it } from 'vitest';
import { installStep } from '../src/main/install';
import { delimiter, join } from 'node:path';
import { commonBinDirs, mergePath } from '../src/main/shell-path';

describe('installing a missing agent', () => {
  const missing = { installed: false, hasNpx: false, hasBrew: false, platform: 'darwin' as const };

  it('asks for Node.js when npx is missing, with the command each system has', () => {
    expect(installStep('claude-code', { ...missing, hasBrew: true })).toEqual({ what: 'node', command: 'brew install node', url: 'https://nodejs.org/en/download' });
    expect(installStep('claude-code', missing)?.command).toBeNull();
    expect(installStep('codex', { ...missing, platform: 'win32' })?.command).toBe('winget install -e --id OpenJS.NodeJS.LTS');
    expect(installStep('grok', { ...missing, platform: 'linux' })).toMatchObject({ what: 'node', command: null });
  });

  it('installs Gemini CLI with npm once Node.js is there, and suggests nothing for what is installed', () => {
    expect(installStep('gemini', { ...missing, hasNpx: true })).toMatchObject({ what: 'cli', command: 'npm install -g @google/gemini-cli' });
    expect(installStep('claude-code', { ...missing, installed: true })).toBeNull();
  });
});

describe('finding CLIs from the Dock', () => {
  it('looks in the usual install folders, the newest nvm Node only', () => {
    const dirs = commonBinDirs('darwin', '/Users/me', {}, () => ['v20.11.0', 'v24.14.1', 'v9.0.0']);
    expect(dirs.slice(0, 3)).toEqual(['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']);
    expect(dirs).toContain(join('/Users/me', '.nvm', 'versions', 'node', 'v24.14.1', 'bin'));
    expect(dirs.filter((d) => d.includes('.nvm'))).toHaveLength(1);
    expect(commonBinDirs('linux', '/home/me', {}, () => { throw new Error('no nvm'); })).toContain('/snap/bin');
  });

  it('keeps the login shell’s order, each folder once', () => {
    const list = (...dirs: string[]) => dirs.join(delimiter);
    expect(mergePath(list('/a', '/b'), list('/usr/bin', '/a'), list('/b', '/c'))).toBe(list('/a', '/b', '/usr/bin', '/c'));
  });
});
