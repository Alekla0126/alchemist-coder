import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { projectNameError } from '../shared/project-name';
import { browsableRoot } from './workspace';

export { projectNameError };

/**
 * A new, empty project folder `name` inside `parent`, optionally with a git repository. Refuses
 * folders that already exist and places the app won't browse (the home folder itself, the disk).
 */
export async function createProjectFolder(parent: string, name: string, git: boolean): Promise<string> {
  const problem = projectNameError(name);
  if (problem) throw new Error(`Invalid project name (${problem})`);
  if (!isAbsolute(parent) || !existsSync(parent) || !statSync(parent).isDirectory()) throw new Error('Choose an existing folder for the project');
  const cwd = join(parent, name.trim());
  if (existsSync(cwd)) throw new Error('A folder with that name already exists there');
  mkdirSync(cwd);
  if (!browsableRoot(cwd)) {
    rmdirSync(cwd);
    throw new Error("Create the project inside a folder, not at the top of the disk");
  }
  // Without git installed the project still works; it just starts without a repository.
  if (git) await new Promise<void>((resolve) => execFile('git', ['init', '-q'], { cwd, timeout: 20_000 }, () => resolve()));
  return cwd;
}
