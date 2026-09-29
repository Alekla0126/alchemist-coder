import type { MarketingBrand, MarketingChannel, MarketingPiece, MarketingStatus } from '@shared/api';
import { brandMarkdown } from '@shared/marketing';

/** A field of a structured piece (an App Store listing, an email), written as a "## Name" section. */
export interface ChannelField {
  /** The section heading in the text, always in English so agents and the parser agree. */
  key: string;
  limit?: number;
}

export interface ChannelSpec {
  id: MarketingChannel;
  icon: string;
  /** Characters allowed (per post for a thread). */
  limit?: number;
  fields?: ChannelField[];
  /** Posts separated by a line with only "---". */
  thread?: boolean;
  publish?: 'x' | 'linkedin';
  /** What the agent is asked to write. */
  ask: string;
}

export const CHANNEL_SPECS: Record<MarketingChannel, ChannelSpec> = {
  x: { id: 'x', icon: '𝕏', limit: 280, publish: 'x', ask: 'one post for X (Twitter): at most 280 characters, hashtags included (a link counts as 23)' },
  thread: { id: 'thread', icon: '𝕏', limit: 280, thread: true, publish: 'x', ask: 'a thread for X of 3 to 7 posts, each at most 280 characters; put a line with only --- between posts' },
  instagram: { id: 'instagram', icon: '◎', limit: 2200, ask: 'an Instagram caption: a strong first line (it shows before "more"), short paragraphs, then at most 8 relevant hashtags; at most 2200 characters' },
  linkedin: { id: 'linkedin', icon: 'in', limit: 3000, publish: 'linkedin', ask: 'a LinkedIn post: a first line that earns the "see more" click, then a clear, useful story; at most 3000 characters' },
  tiktok: { id: 'tiktok', icon: '♪', ask: 'a script for a 20-40 second TikTok or Reel: HOOK (first 2 seconds), numbered SCENES with what is on screen and what is said, and a CTA; then a caption line starting with "Caption:"' },
  email: { id: 'email', icon: '✉', fields: [{ key: 'Subject', limit: 60 }, { key: 'Preheader', limit: 100 }, { key: 'Body' }], ask: 'a marketing email' },
  landing: { id: 'landing', icon: '▭', fields: [{ key: 'Headline', limit: 70 }, { key: 'Subheadline', limit: 160 }, { key: 'Body' }, { key: 'Call to action', limit: 30 }], ask: 'landing page copy' },
  blog: { id: 'blog', icon: '¶', ask: 'a blog article in Markdown (600-1200 words) with a title, headings and a short conclusion, useful for search without keyword stuffing' },
  appstore: {
    id: 'appstore',
    icon: '◆',
    fields: [{ key: 'Name', limit: 30 }, { key: 'Subtitle', limit: 30 }, { key: 'Keywords', limit: 100 }, { key: 'Promotional text', limit: 170 }, { key: 'Description', limit: 4000 }],
    ask: 'an App Store listing (keywords: comma-separated, no spaces after commas, no words already in the name)',
  },
  play: { id: 'play', icon: '▶', fields: [{ key: 'Title', limit: 30 }, { key: 'Short description', limit: 80 }, { key: 'Full description', limit: 4000 }], ask: 'a Google Play listing' },
  seo: { id: 'seo', icon: '⌕', fields: [{ key: 'Title', limit: 60 }, { key: 'Description', limit: 160 }, { key: 'Slug', limit: 60 }], ask: 'web page metadata for search results (title, meta description, URL slug)' },
};

export const CHANNEL_ORDER: MarketingChannel[] = ['x', 'thread', 'instagram', 'linkedin', 'tiktok', 'email', 'landing', 'blog', 'appstore', 'play', 'seo'];
export const STATUS_ORDER: MarketingStatus[] = ['idea', 'draft', 'approved', 'scheduled', 'published'];

const URL = /https?:\/\/\S+/g;
/** Characters as people and networks count them (emoji are one); on X a link always counts as 23. */
export function charCount(text: string, channel?: MarketingChannel): number {
  const t = channel === 'x' || channel === 'thread' ? text.replace(URL, 'x'.repeat(23)) : text;
  return [...t].length;
}

/** A thread's posts (or the one post), trimmed, empty ones dropped. */
export function threadPosts(body: string): string[] {
  return body
    .split(/^\s*---\s*$/m)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The "## Name" sections of a structured piece, by field; text before any heading goes to the first. */
export function parseSections(body: string, fields: ChannelField[]): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(fields.map((f) => [f.key, '']));
  let current = fields[0]?.key ?? '';
  for (const line of body.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    const field = h && fields.find((f) => f.key.toLowerCase() === h[1]!.toLowerCase());
    if (field) {
      current = field.key;
      continue;
    }
    if (current) out[current] = out[current] ? `${out[current]}\n${line}` : line;
  }
  for (const k of Object.keys(out)) out[k] = out[k]!.trim();
  return out;
}

/** An empty structured piece, ready to fill in. */
export const sectionTemplate = (fields: ChannelField[]) => fields.map((f) => `## ${f.key}\n`).join('\n');

/** Over-limit parts of a piece, to warn before it goes out. */
export function overLimits(piece: Pick<MarketingPiece, 'channel' | 'body'>): string[] {
  const spec = CHANNEL_SPECS[piece.channel];
  if (spec.fields) {
    const s = parseSections(piece.body, spec.fields);
    return spec.fields.filter((f) => f.limit && charCount(s[f.key] ?? '') > f.limit).map((f) => f.key);
  }
  if (!spec.limit) return [];
  const posts = spec.thread ? threadPosts(piece.body) : [piece.body.trim()];
  return posts.flatMap((p, i) => (charCount(p, piece.channel) > spec.limit! ? [spec.thread ? `#${i + 1}` : spec.id] : []));
}

/**
 * What a writing agent gets: the brand, the channel's rules, the piece's topic and brief, and the
 * honesty rule. It works read-only (it may look at the project to get the facts right).
 */
export function generationPrompt(piece: MarketingPiece, brand: MarketingBrand): string {
  const spec = CHANNEL_SPECS[piece.channel];
  const format = spec.fields
    ? `Use exactly these sections, each starting with its heading line:\n${spec.fields.map((f) => `## ${f.key}${f.limit ? ` (at most ${f.limit} characters)` : ''}`).join('\n')}`
    : spec.thread
      ? 'Separate posts with a line containing only ---.'
      : '';
  return [
    'You are writing marketing copy for the project in this folder. If marketing/BRAND.md exists it is the same brand guide as below. To get the facts right you may look at the project (README, store listings, the app itself) with the Read, Glob and Grep tools only: no shell commands, no edits, no plans. Then answer directly.',
    '',
    brandMarkdown(brand).trim() || '(No brand guide yet: stay factual and plain.)',
    '',
    `Write ${spec.ask}.`,
    piece.title.trim() ? `Topic: ${piece.title.trim()}` : '',
    piece.brief.trim() ? `Brief: ${piece.brief.trim()}` : '',
    `Language: ${piece.language.trim() || firstLanguage(brand) || 'the language of the brand guide'}`,
    piece.body.trim() ? `Current draft to improve (keep what works):\n${piece.body.trim()}` : '',
    '',
    'Rules:',
    '- Only claim what the brand guide or the project shows. Never invent features, numbers, prices, reviews, awards or dates.',
    '- If the guide lists "Claims we can make", describe no feature beyond that list. Do not invent anecdotes, customer conversations, company history or other brands.',
    '- No filler, no clichés, no emoji walls.',
    format ? `- ${format}` : '',
    '',
    'Reply with the piece only, between <piece> and </piece>. No explanations before or after.',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

export const firstLanguage = (brand: MarketingBrand) => brand.languages.split(/[,/·\s]+/).find(Boolean) ?? '';

/** The piece out of the agent's reply: what's between <piece> tags, or the reply without fences. */
export function extractPiece(reply: string): string {
  const tagged = /<piece>\s*([\s\S]*?)\s*<\/piece>/i.exec(reply);
  if (tagged) return tagged[1]!.trim();
  const fenced = /```(?:\w+)?\n([\s\S]*?)\n```/.exec(reply);
  return (fenced ? fenced[1]! : reply).trim();
}

/** Where "Publish" goes: the network's own composer with the text in it (no account connected here). */
export function publishUrl(piece: Pick<MarketingPiece, 'channel' | 'body'>): string | null {
  const spec = CHANNEL_SPECS[piece.channel];
  if (spec.publish === 'x') return `https://x.com/intent/post?text=${encodeURIComponent(threadPosts(piece.body)[0] ?? '')}`;
  if (spec.publish === 'linkedin') return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(piece.body.trim())}`;
  return null;
}

export const newPieceId = () => `mk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
