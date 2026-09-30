import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listSubagents } from '../src/main/subagents';
import { subagentPrompt } from '../src/renderer/src/agents-edit';

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ac-sub-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('subagent types', () => {
  it("reads the project's and your .claude/agents, the project's winning on a clash", () => {
    const project = dir();
    const home = dir();
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: "Reviews diffs"\n---\nYou review.');
    writeFileSync(join(project, '.claude', 'agents', 'notes.md'), 'no front matter');
    writeFileSync(join(home, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: mine\n---\n');
    writeFileSync(join(home, '.claude', 'agents', 'tester.md'), '---\nname: tester\ndescription: Runs tests\n---\n');
    writeFileSync(join(home, '.claude', 'agents', 'bad.md'), '---\nname: rm -rf /\n---\n');
    const secret = join(dir(), 'secret.md');
    writeFileSync(secret, '---\nname: leaked\n---\n');
    symlinkSync(secret, join(home, '.claude', 'agents', 'linked.md'));
    expect(listSubagents(project, home)).toEqual([
      { name: 'notes', description: '', scope: 'project' },
      { name: 'reviewer', description: 'Reviews diffs', scope: 'project' },
      { name: 'tester', description: 'Runs tests', scope: 'user' },
    ]);
    expect(listSubagents(dir(), dir())).toEqual([]);
  });

  it('asks the main agent for one more subagent, in the background if you want', () => {
    const lines = { ask: 'Launch ({type}):', background: 'In the background.', report: 'Then report.' };
    expect(subagentPrompt(lines, { type: 'Explore', task: '  Find the i18n gaps  ', background: true })).toBe('Launch (Explore):\n\nFind the i18n gaps\n\nIn the background. Then report.');
    expect(subagentPrompt(lines, { type: 'general-purpose', task: 'x', background: false })).toBe('Launch (general-purpose):\n\nx\n\nThen report.');
  });
});
