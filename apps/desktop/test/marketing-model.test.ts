import { describe, expect, it } from 'vitest';
import type { MarketingPiece } from '../src/shared/api';
import { CHANNEL_SPECS, charCount, extractPiece, generationPrompt, overLimits, parseSections, publishUrl, threadPosts } from '../src/renderer/src/marketing-model';

const brand = { product: 'Castbook', pitch: 'A fishing log that works offline', audience: 'anglers', tone: 'calm, practical', say: '', avoid: 'hype', claims: 'Offline log; GPS spots', links: '', languages: 'es, en' };
const piece = (p: Partial<MarketingPiece>): MarketingPiece => ({ id: 'p', channel: 'x', title: '', brief: '', body: '', status: 'idea', date: null, language: '', createdAt: 0, updatedAt: 0, ...p });

describe('marketing model', () => {
  it('counts like the networks do', () => {
    expect(charCount('hola 🎣')).toBe(6);
    // On X a link counts as 23 characters, whatever its length.
    expect(charCount('see https://example.com/a/very/long/path/that/goes/on', 'x')).toBe(4 + 23);
  });

  it('splits threads and reads structured sections', () => {
    expect(threadPosts('one\n---\ntwo\n\n---\n\nthree\n---\n')).toEqual(['one', 'two', 'three']);
    const s = parseSections('## Name\nCastbook\n## subtitle\nYour fishing log\n## Keywords\nfish,log', CHANNEL_SPECS.appstore.fields!);
    expect(s).toMatchObject({ Name: 'Castbook', Subtitle: 'Your fishing log', Keywords: 'fish,log', Description: '' });
  });

  it('warns about what is over the limit', () => {
    expect(overLimits(piece({ channel: 'x', body: 'x'.repeat(281) }))).toEqual(['x']);
    expect(overLimits(piece({ channel: 'thread', body: 'ok\n---\n' + 'y'.repeat(300) }))).toEqual(['#2']);
    expect(overLimits(piece({ channel: 'appstore', body: '## Name\nCastbook: the fishing log for everyone\n## Subtitle\nok' }))).toEqual(['Name']);
  });

  it('asks the agent for the channel format, the brand and honesty', () => {
    const prompt = generationPrompt(piece({ channel: 'appstore', title: 'Launch listing' }), brand);
    expect(prompt).toContain('# Brand guide — Castbook');
    expect(prompt).toContain('## Name (at most 30 characters)');
    expect(prompt).toContain('Never invent features, numbers, prices, reviews, awards or dates');
    expect(prompt).toContain('describe no feature beyond that list');
    expect(prompt).toContain('Language: es');
    expect(prompt).toContain('between <piece> and </piece>');
    expect(prompt).not.toMatch(/\n\n\n/);
  });

  it("takes the piece out of the agent's reply", () => {
    expect(extractPiece('Sure!\n<piece>\nCastbook is out.\n</piece>\nHope it helps')).toBe('Castbook is out.');
    expect(extractPiece('```markdown\n# Title\n```')).toBe('# Title');
    expect(extractPiece('plain')).toBe('plain');
  });

  it("opens the network's composer with the text", () => {
    expect(publishUrl(piece({ channel: 'thread', body: 'first & best\n---\nsecond' }))).toBe('https://x.com/intent/post?text=first%20%26%20best');
    expect(publishUrl(piece({ channel: 'linkedin', body: 'Hi' }))).toBe('https://www.linkedin.com/feed/?shareActive=true&text=Hi');
    expect(publishUrl(piece({ channel: 'instagram', body: 'Hi' }))).toBeNull();
  });
});
