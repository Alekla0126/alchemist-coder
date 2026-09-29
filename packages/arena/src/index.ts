export { git, GitError, repoRoot, headCommit, currentBranch, dirtyFiles } from './git.ts';
export { copyEntry, entryInTree, fileInTree, replaceInTree, snapshotTree, treeChanges, type TreeChange } from './snapshot.ts';
export {
  commitAll,
  createWorktree,
  fileVersions,
  listChanges,
  mergeBranch,
  MergeConflictError,
  removeWorktree,
  runsOnItsOwn,
  runTests,
  slug,
  WORKTREES_DIR,
  type FileChange,
  type TestResult,
  type Worktree,
} from './worktrees.ts';
export { executionPrompt, extractPlan, planningPrompt, taskTitle } from './prompts.ts';
