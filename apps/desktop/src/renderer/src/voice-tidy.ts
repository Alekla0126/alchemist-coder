/**
 * What you dictated, ready to send: without the hesitations and stutters of speech, nor the lines
 * Whisper makes up over silence ("Subtítulos realizados por la comunidad de Amara.org"). Nothing is
 * reworded and no model is asked, so it costs no tokens; the agent then reads fewer of them.
 */

/** Sounds that only mean "I'm thinking", by language (a word that means something stays: "um" is Portuguese for "a"). */
const HESITATIONS: Record<string, string[]> = {
  en: ['um+', 'uh+m*', 'erm+', 'h?m{2,}', 'ah+'],
  es: ['e+h+m*', 'e+m+', 'h?m{2,}', 'a+h+'],
  pt: ['hu+m+', 'ã+h+', 'h?m{2,}'],
  fr: ['eu+h+', 'heu+', 'h?m{2,}'],
  de: ['ä+h+m*', 'ö+h+m*', 'h?m{2,}'],
  it: ['e+h+m*', 'e+m+', 'h?m{2,}'],
  ru: ['э+м*', 'м{2,}'],
};
/** Whisper's lines over silence: credits and sign-offs from the videos it learned from. */
const MADE_UP = [
  /amara\.org/i,
  /^(subt[ií]tulos?|legendas?|sous-titres|untertitel|sottotitoli|subtitles)\b.*\b(por|by|par|von|di|da|pela|im auftrag)\b/i,
  /^¡?(gracias por ver(?: el v[ií]deo)?|thanks? (?:you )?(?:so much )?for watching|obrigad[oa] por assistir|merci d'avoir regardé|vielen dank fürs zuschauen|grazie per la visione)[.!¡]*$/i,
  /^¡?(suscr[ií]bete(?: al canal)?|please subscribe|inscreva-se(?: no canal)?)[.!]*$/i,
];
/** Said twice on purpose: "muy muy", "no no". */
const ON_PURPOSE = new Set(['no', 'sí', 'si', 'very', 'muy', 'so', 'tan', 'más', 'mas', 'more', 'bye', 'ja', 'ha', 'yes', 'non', 'nein', 'да', 'нет', 'sim', 'não']);

export interface Tidied {
  text: string;
  /** Words taken out. */
  removed: number;
  /** Words there were. */
  words: number;
}

const wordsIn = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;

export function tidySpeech(raw: string, language: string | null): Tidied {
  const words = wordsIn(raw);
  let text = raw.replace(/\s+/g, ' ').trim();
  // Made-up lines go only where Whisper puts them: the whole text or its last sentences.
  const sentences = text.split(/(?<=[.!?…])\s+/);
  while (sentences.length && MADE_UP.some((r) => r.test(sentences[sentences.length - 1]!.trim()))) sentences.pop();
  text = sentences.join(' ');
  const lang = (language ?? '').toLowerCase().split('-')[0]!;
  // A lone "M," is how Whisper writes a hum in most languages.
  const sounds = [...new Set([...(HESITATIONS[lang] ?? []), 'h?m{2,}', 'm(?=,)'])];
  // A hesitation between commas or at an edge goes with its comma: "quiero, eh, un botón" → "quiero un botón".
  const hesitation = new RegExp(`(^|[\\s,;:¿¡(])(?:${sounds.join('|')})(?:[,;…]|\\.{3})?(?=[\\s,.;:!?…)]|$)`, 'giu');
  text = text.replace(hesitation, '$1');
  // A stutter: the same word twice in a row, without a pause between ("que que", "the the").
  text = text.replace(/(^|[^\p{L}\p{N}])([\p{L}\p{N}]+)(?:\s+\2)+(?=[^\p{L}\p{N}]|$)/giu, (all, before: string, word: string) => (ON_PURPOSE.has(word.toLowerCase()) ? all : before + word));
  text = text
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/^[\s,;:.…]+/, '')
    .replace(/([¿¡(])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // What's left of a sentence starts with a capital, as it did.
  if (text && /^\p{Ll}/u.test(text) && /^\p{Lu}/u.test(raw.trim())) text = text[0]!.toUpperCase() + text.slice(1);
  return { text, removed: Math.max(0, words - wordsIn(text)), words };
}
