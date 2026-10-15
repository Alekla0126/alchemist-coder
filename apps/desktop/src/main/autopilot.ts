import { autopilotAnswer, autopilotChoice, irreversible, type Autopilot } from '@alchemist-coder/core';
import type { MainWords } from './locales';

const clip = (s: string, max = 160) => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/**
 * Autopilot as the app runs it: on while your settings say so, it decides what each agent would
 * otherwise wait on you for, and says so in the conversation in your language. Allowing is silent
 * (the tool shows in the conversation anyway); refusing and answering are noted.
 */
export function appAutopilot(on: () => boolean, words: () => MainWords['autopilot']): Autopilot {
  return {
    permission({ title, command, choices }) {
      if (!on()) return null;
      const refuse = irreversible(`${title}\n${command ?? ''}`);
      const pick = autopilotChoice(choices, refuse);
      if (!pick) return null;
      return { choiceId: pick.id, note: refuse ? words().refused(clip(command || title)) : null };
    },
    question({ message, fields }) {
      if (!on()) return null;
      const answer = autopilotAnswer(fields);
      const w = words();
      const asked = clip(message || fields[0]?.title || fields[0]?.description || '…');
      if (answer.action === 'decline') return { answer, note: w.declined(asked) };
      if (fields.some((f) => f.forKey)) return { answer, note: w.decides(asked) };
      const picked = fields.flatMap((f) => {
        const v = answer.content?.[f.key];
        const values = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
        return values.map((x) => f.options.find((o) => o.value === x)?.title ?? x);
      });
      return { answer, note: picked.length ? w.picked(asked, clip(picked.join(', '), 120)) : w.decides(asked) };
    },
  };
}
