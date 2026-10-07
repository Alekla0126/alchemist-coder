import type { InstallStep } from '../shared/api';

const NODE_URL = 'https://nodejs.org/en/download';

/** Node.js (with npm and npx): Homebrew's on a Mac that has it, winget's on Windows, else its download page. */
function nodeStep(platform: NodeJS.Platform, hasBrew: boolean): InstallStep {
  const command = platform === 'darwin' && hasBrew ? 'brew install node' : platform === 'win32' ? 'winget install -e --id OpenJS.NodeJS.LTS' : null;
  return { what: 'node', command, url: NODE_URL };
}

/**
 * What an agent that isn't found still needs. Claude Code, Codex and Grok Build run through npx (their
 * adapters download on first use), so all they need is Node.js; Gemini CLI installs with npm.
 */
export function installStep(harnessId: string, o: { installed: boolean; hasNpx: boolean; hasBrew: boolean; platform: NodeJS.Platform }): InstallStep | null {
  if (o.installed) return null;
  if (!o.hasNpx) return nodeStep(o.platform, o.hasBrew);
  if (harnessId === 'gemini') return { what: 'cli', command: 'npm install -g @google/gemini-cli', url: 'https://github.com/google-gemini/gemini-cli' };
  return null;
}
