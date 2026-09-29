import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { slashCommands } from '../src/main/slash-commands';

const home = mkdtempSync(join(tmpdir(), 'slash-'));
const project = join(home, 'code', 'app');
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('slash commands', () => {
  it('finds Claude commands and skills, personal and per project', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    mkdirSync(join(home, '.claude', 'commands', 'git'), { recursive: true });
    mkdirSync(join(home, '.claude', 'skills', 'pdf'), { recursive: true });
    mkdirSync(join(project, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(home, '.claude', 'commands', 'review.md'), '---\ndescription: "Review the diff"\n---\nLook at it');
    writeFileSync(join(home, '.claude', 'commands', 'git', 'pr.md'), '# Open a PR\nBody');
    writeFileSync(join(home, '.claude', 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Read PDFs\n---\n');
    writeFileSync(join(project, '.claude', 'commands', 'review.md'), 'Project review');
    // Skills nested deeper (synced ones) and an installed plugin.
    mkdirSync(join(home, '.claude', 'skills', 'synced', 'abc', 'xlsx'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'synced', 'abc', 'xlsx', 'SKILL.md'), '---\nname: xlsx\ndescription: Spreadsheets\n---\n');
    const plugin = join(home, '.claude', 'plugins', 'cache', 'mk', 'design', '1.0');
    mkdirSync(join(plugin, 'commands'), { recursive: true });
    mkdirSync(join(plugin, 'skills', 'frontend'), { recursive: true });
    writeFileSync(join(plugin, 'commands', 'polish.md'), 'Polish the UI');
    writeFileSync(join(plugin, 'skills', 'frontend', 'SKILL.md'), '---\ndescription: Build UIs\n---\n');
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'design@mk': [{ scope: 'user', installPath: plugin }], 'other@mk': [{ scope: 'local', projectPath: '/elsewhere', installPath: plugin }] } }));
    const list = await slashCommands('claude-code', project, home);
    expect(list.find((c) => c.name === 'review')).toEqual({ name: 'review', description: 'Project review', source: 'command' });
    expect(list.find((c) => c.name === 'git:pr')?.description).toBe('Open a PR');
    expect(list.find((c) => c.name === 'pdf')).toEqual({ name: 'pdf', description: 'Read PDFs', source: 'skill' });
    expect(list.find((c) => c.name === 'xlsx')?.description).toBe('Spreadsheets');
    expect(list.find((c) => c.name === 'design:polish')).toEqual({ name: 'design:polish', description: 'Polish the UI', source: 'plugin' });
    expect(list.find((c) => c.name === 'design:frontend')?.description).toBe('Build UIs');
    expect(list.some((c) => c.name.startsWith('other:'))).toBe(false);
    expect(list.filter((c) => c.name === 'review')).toHaveLength(1);
    expect(list.find((c) => c.name === 'compact')?.source).toBe('builtin');
  });

  it('finds Codex prompts and Gemini TOML commands', async () => {
    delete process.env.CODEX_HOME;
    mkdirSync(join(home, '.codex', 'prompts'), { recursive: true });
    writeFileSync(join(home, '.codex', 'prompts', 'fix.md'), 'Fix the bug');
    mkdirSync(join(home, '.gemini', 'commands'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'commands', 'plan.toml'), 'description = "Make a plan"\nprompt = "…"');
    const codex = await slashCommands('codex', null, home);
    expect(codex).toContainEqual({ name: 'prompts:fix', description: 'Fix the bug', source: 'prompt' });
    expect(codex.find((c) => c.name === 'init')?.source).toBe('builtin');
    expect(await slashCommands('gemini', null, home)).toEqual([{ name: 'plan', description: 'Make a plan', source: 'command' }]);
    expect(await slashCommands('grok', null, home)).toEqual([]);
  });
});
