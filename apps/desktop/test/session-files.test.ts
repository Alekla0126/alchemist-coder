import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { conversationFiles } from '../src/main/session-files';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'conv-files-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const claude = join(root, 'claude', 'projects');
const grok = join(root, 'grok', 'sessions');
const roots = [claude, grok];

describe('conversationFiles', () => {
  it('returns a Claude transcript with its subagents, and a whole Grok session folder', () => {
    mkdirSync(join(claude, '-app', 'abc', 'subagents'), { recursive: true });
    writeFileSync(join(claude, '-app', 'abc.jsonl'), '{}\n');
    expect(conversationFiles(join(claude, '-app', 'abc.jsonl'), roots)).toEqual([join(claude, '-app', 'abc.jsonl'), join(claude, '-app', 'abc')]);
    mkdirSync(join(grok, '%2Fapp', 'g1'), { recursive: true });
    writeFileSync(join(grok, '%2Fapp', 'g1', 'updates.jsonl'), '{}\n');
    expect(conversationFiles(join(grok, '%2Fapp', 'g1', 'updates.jsonl'), roots)).toEqual([join(grok, '%2Fapp', 'g1')]);
  });

  it('refuses anything outside the history folders, symlinks and missing files', () => {
    const outside = join(root, 'important.txt');
    writeFileSync(outside, 'keep');
    expect(conversationFiles(outside, roots)).toEqual([]);
    symlinkSync(outside, join(claude, '-app', 'link.jsonl'));
    expect(conversationFiles(join(claude, '-app', 'link.jsonl'), roots)).toEqual([]);
    expect(conversationFiles(join(claude, '-app', 'gone.jsonl'), roots)).toEqual([]);
    expect(conversationFiles(null, roots)).toEqual([]);
    // The history folder itself is never "a conversation".
    expect(conversationFiles(grok, roots)).toEqual([]);
  });
});
