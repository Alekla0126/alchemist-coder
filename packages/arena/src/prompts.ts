/** Asks an agent in plan mode for a plan the user can edit before anyone writes code. */
export function planningPrompt(task: string): string {
  return [
    'Write an implementation plan for the task below. Do not change any files yet.',
    'Look at the code you need, then reply with the plan in Markdown: a short goal, numbered steps',
    '(each naming the files involved) and how to verify the result. Keep it concise.',
    '',
    'Task:',
    task.trim(),
  ].join('\n');
}

/** The prompt every contestant receives: the task plus the plan the user approved. */
export function executionPrompt(task: string, plan: string | null, contestants: number): string {
  const lines = [
    contestants > 1
      ? 'You are one of several agents solving the same task in separate git worktrees. Work only inside the current folder.'
      : 'Work only inside the current folder.',
    '',
    'Task:',
    task.trim(),
  ];
  if (plan?.trim()) lines.push('', 'Approved plan (follow it; if a step turns out to be wrong, adapt and say why):', plan.trim());
  lines.push('', 'When you finish, reply with a short summary of what you changed and how you verified it.');
  return lines.join('\n');
}

/**
 * Picks the plan out of what a planner produced: the plan it submitted for approval (Claude's and
 * Grok's ExitPlanMode) wins over its chat text.
 */
export function extractPlan(submitted: string | null, reply: string): string {
  const s = submitted?.trim();
  if (s) return s;
  return reply.trim();
}

/** Short human title for a task, from its first line. */
export function taskTitle(task: string): string {
  const first = task.trim().split('\n')[0] ?? '';
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}
