import { monsterUri } from './monster';

/** The app's own pictures for agents, one per kind of work, plus a few characters. */
export const AVATAR_EMOJI = ['⚗️', '🧑‍💻', '🧪', '🔍', '🧭', '🎨', '📐', '✍️', '📣', '📊', '🛡️', '🛠️', '🤖', '🦊', '🐙', '🦉', '🐝', '🦁'];

/** An agent's picture when you haven't chosen one: guessed from its name, in English or Spanish. */
const GUESSES: Array<[RegExp, string]> = [
  [/coordina|gerente|manager|lead/i, '⚗️'],
  [/program|coder|develop|ingenier/i, '🧑‍💻'],
  [/test|qa\b|prueba/i, '🧪'],
  [/revis|review|audit/i, '🔍'],
  [/investig|research|analista|analyst|explor|search|busca/i, '🧭'],
  [/juez|judge|dise[ñn]|design|ui\b|ux\b|interfaz/i, '🎨'],
  [/\bplan\b|planific|plann|arquitect|architect/i, '📐'],
  [/redact|writer|escrit|doc/i, '✍️'],
  [/market|redes|social|community|growth|seo|aso/i, '📣'],
  [/dato|data|m[ée]trica|metric/i, '📊'],
  [/segur|secur/i, '🛡️'],
  // Claude Code's all-round subagent.
  [/^general(-purpose)?$/i, '🤖'],
];

/**
 * What an agent shows: the picture you chose (an image, an emoji or a monster), else its own monster,
 * drawn from its name. Nameless, its initials.
 */
export function avatarSource(name: string, avatar: string | null | undefined): { kind: 'image'; src: string } | { kind: 'emoji'; emoji: string } | { kind: 'initials' } {
  if (avatar?.startsWith('data:image/')) return { kind: 'image', src: avatar };
  if (avatar?.startsWith('emoji:')) return { kind: 'emoji', emoji: avatar.slice(6) };
  if (avatar?.startsWith('monster:') && avatar.length > 8) return { kind: 'image', src: monsterUri(avatar.slice(8)) };
  return name.trim() ? { kind: 'image', src: monsterUri(name.trim()) } : { kind: 'initials' };
}

/** The picture of the first name that suggests one (a subagent's kind, then what it was asked to do). */
export function guessAvatar(...names: string[]): string | undefined {
  for (const name of names) {
    const guess = GUESSES.find(([re]) => re.test(name))?.[1];
    if (guess) return `emoji:${guess}`;
  }
  return undefined;
}

/** A picture you picked, cropped to a square and made small enough to keep with the agent. */
export async function resizeImage(file: Blob, size = 192): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.86);
}

/** Opens the system's file picker for one image; null when you cancel. */
export function chooseImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/heic';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
