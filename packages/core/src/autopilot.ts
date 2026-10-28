import type { PermissionChoice, QuestionAnswer, QuestionField } from './extensions.ts';

/**
 * Autopilot: while it's on, nothing an agent asks waits for you. Permissions are allowed once (never
 * "always", so the CLI's own rules stay as they are), except a short list of things that can't be
 * undone, which are refused; questions go back to the agent to decide.
 */

/** What an agent reads when Autopilot gets its question: decide yourself. */
export const AUTOPILOT_ANSWER =
  "Autopilot: the user is away and can't answer. Decide yourself: choose what you would recommend, say which and why in your final message, and keep going.";

/** Can't be undone, or goes out to the world: refused even on Autopilot. A safety net, not a sandbox. */
const IRREVERSIBLE: RegExp[] = [
  // Root rights.
  /(^|[\s;&|(`])(sudo|doas)\s/,
  // Rewriting or deleting what's already pushed.
  /\bgit\s+push\b[^;&|\n]*\s(--force(-with-lease)?|-f|--delete|-d|--mirror|\+\S+)(\s|$)/,
  // Publishing.
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\bcargo\s+publish\b/,
  /\btwine\s+upload\b/,
  /\bgh\s+release\s+(create|upload|edit|delete)\b/,
  /\bfastlane\s+(\S+\s+)?(deliver|supply|pilot|upload\w*|release|deploy|publish|production)\b/,
  /\beas\s+submit\b/,
  // The stores through app-console (the store tools): with confirm, the change goes live.
  /\bappconsole\s+(play|appstore|admob)\s[^;&|\n]*--confirm\b/,
  /(play_(upload|upload_images|promote|rollout|update_listing|reply|grant|revoke|data_safety)|appstore_(create_version|update_listing|upload_screenshots|submit|release|reply)|admob_(create_app|create_ad_unit|map_ad_unit|create_mediation_group|update_mediation_group|ab_experiment))\b[\s\S]*\bconfirm=true\b/,
  /\bdocker\s+push\b/,
  // The disk and the machine.
  /\b(mkfs(\.\w+)?|shutdown|reboot|halt)\b/,
  /\bdiskutil\s+(erase\w*|partitionDisk|zeroDisk|secureErase)\b/,
  /\bdd\b[^;&|\n]*\bof=\/dev\//,
];

/** `rm` told to delete the disk or the home folder, in any part of a command line. */
function wipesEverything(command: string): boolean {
  for (const part of command.split(/;|&&|\|\||\||\n|`|\$\(/)) {
    const words = part.trim().split(/\s+/);
    const at = words.findIndex((w) => w === 'rm' || w.endsWith('/rm'));
    if (at < 0) continue;
    const args = words.slice(at + 1);
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
    if (recursive && args.some((a) => /^["']?(\/|~|\$HOME|\$\{HOME\})\/?\*?["']?$/.test(a))) return true;
  }
  return false;
}

/** Whether what a permission request describes (its title, its command) is on the never-alone list. */
export function irreversible(text: string): boolean {
  return wipesEverything(text) || IRREVERSIBLE.some((r) => r.test(text));
}

/** The option Autopilot picks: allow once (or reject once, for what it refuses). */
export function autopilotChoice(choices: PermissionChoice[], refuse: boolean): PermissionChoice | null {
  const order: Array<PermissionChoice['kind']> = refuse ? ['reject_once', 'reject_always'] : ['allow_once', 'allow_always'];
  for (const kind of order) {
    const c = choices.find((x) => x.kind === kind);
    if (c) return c;
  }
  return null;
}

/**
 * A question's answer while you're away. A choice with an "Other" box gets AUTOPILOT_ANSWER there and
 * nothing picked, so the agent decides with everything it knows; without one, its first option (agents
 * put the one they recommend first). Yes/no is yes. A required field it can't fill declines the form.
 */
export function autopilotAnswer(fields: QuestionField[]): QuestionAnswer {
  const content: Record<string, string | string[] | boolean | number> = {};
  const others = new Set(fields.flatMap((f) => (f.forKey ? [f.forKey] : [])));
  for (const f of fields) {
    if (f.forKey) {
      content[f.key] = AUTOPILOT_ANSWER;
      continue;
    }
    switch (f.kind) {
      case 'single':
        if (!others.has(f.key) && f.options[0]) content[f.key] = f.options[0].value;
        break;
      case 'multi':
        if (!others.has(f.key) && f.options[0]) content[f.key] = [f.options[0].value];
        break;
      case 'boolean':
        content[f.key] = true;
        break;
      case 'text':
        if (f.required) content[f.key] = AUTOPILOT_ANSWER;
        break;
      case 'number':
        break;
    }
    if (f.required && !(f.key in content) && !others.has(f.key)) return { action: 'decline' };
  }
  return { action: 'accept', content };
}
