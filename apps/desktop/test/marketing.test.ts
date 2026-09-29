import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brandMarkdown, cleanMarketing, emptyBrand, loadMarketing, readDrafts, saveMarketing } from '../src/main/marketing';

const dirs: string[] = [];
const project = () => {
  const d = mkdtempSync(join(tmpdir(), 'ac-mk-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('marketing', () => {
  it('keeps only valid pieces and fields', () => {
    const data = cleanMarketing({
      brand: { product: 'Castbook', pitch: 'A fishing log', extra: 'dropped' },
      pieces: [
        { id: 'p1', channel: 'x', title: 'Launch', body: 'Hi', status: 'draft', date: '2026-10-01' },
        { id: '../bad', channel: 'x' },
        { id: 'p2', channel: 'fax', status: 'weird', date: 'tomorrow' },
      ],
    });
    expect(data.brand).toMatchObject({ product: 'Castbook', pitch: 'A fishing log', audience: '' });
    expect(data.brand).not.toHaveProperty('extra');
    expect(data.pieces.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(data.pieces[1]).toMatchObject({ channel: 'x', status: 'idea', date: null });
  });

  it('saves to marketing/ with a BRAND.md any agent can read, and loads it back', () => {
    const root = project();
    expect(loadMarketing(root).pieces).toEqual([]);
    saveMarketing(root, { brand: { product: 'Castbook', claims: 'Offline log, GPS spots' }, pieces: [{ id: 'a', channel: 'linkedin', title: 't', body: 'b', status: 'approved' }] });
    expect(loadMarketing(root).pieces[0]).toMatchObject({ id: 'a', channel: 'linkedin', status: 'approved' });
    const brand = readFileSync(join(root, 'marketing', 'BRAND.md'), 'utf8');
    expect(brand).toContain('# Brand guide — Castbook');
    expect(brand).toContain('never invent features, numbers, reviews, anecdotes or company history');
    expect(brandMarkdown(emptyBrand())).not.toContain('**');
  });

  it('refuses to write through a marketing/ link that leads out', () => {
    const root = project();
    const elsewhere = project();
    symlinkSync(elsewhere, join(root, 'marketing'), 'junction');
    expect(() => saveMarketing(root, {})).toThrow(/link/);
  });

  it("reads the team's drafts with their front matter", () => {
    const root = project();
    mkdirSync(join(root, 'marketing', 'drafts'), { recursive: true });
    writeFileSync(join(root, 'marketing', 'drafts', 'launch-post.md'), '---\nchannel: x\ntitle: "Launch post"\n---\nCastbook is out.\n');
    writeFileSync(join(root, 'marketing', 'drafts', 'notes.md'), 'Just notes');
    expect(readDrafts(root)).toEqual([
      { file: 'marketing/drafts/launch-post.md', title: 'Launch post', channel: 'x', body: 'Castbook is out.' },
      { file: 'marketing/drafts/notes.md', title: 'notes', channel: null, body: 'Just notes' },
    ]);
  });
});
