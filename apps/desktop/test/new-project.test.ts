import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectFolder, projectNameError } from '../src/main/new-project';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('new projects', () => {
  it('accepts names that work as folders on every OS', () => {
    expect(projectNameError('my-app')).toBeNull();
    expect(projectNameError('Mi app 2')).toBeNull();
    expect(projectNameError('  ')).toBe('empty');
    expect(projectNameError('a/b')).toBe('chars');
    expect(projectNameError('what?')).toBe('chars');
    expect(projectNameError('..')).toBe('reserved');
    expect(projectNameError('CON')).toBe('reserved');
    expect(projectNameError('x'.repeat(81))).toBe('long');
  });

  it('creates an empty folder with a git repository, and never reuses one', async () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'ac-new-')));
    dirs.push(parent);
    const cwd = await createProjectFolder(parent, ' landing ', true);
    expect(cwd).toBe(join(parent, 'landing'));
    expect(existsSync(join(cwd, '.git'))).toBe(true);
    await expect(createProjectFolder(parent, 'landing', false)).rejects.toThrow(/already exists/);
    await expect(createProjectFolder(join(parent, 'missing'), 'x', false)).rejects.toThrow(/existing folder/);
    expect(existsSync(join(await createProjectFolder(parent, 'plain', false), '.git'))).toBe(false);
  });
});
