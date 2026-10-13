import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mentionFiles, type ProviderAdapter, type RunnerEvent } from '@alchemist-coder/core';
import { acpHarness, attachmentsDir, insideProject, mimeOf, safeName, stageData, stageFile, stageImage } from '../src/index.ts';

const project = () => mkdtempSync(join(tmpdir(), 'attach-project-'));
const outside = (name: string, body = 'hello') => {
  const dir = mkdtempSync(join(tmpdir(), 'attach-src-'));
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('attachments in the project', () => {
  it('names: no path, no control characters, kept short with their extension', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('C:\\Users\\me\\Report Q3.pdf')).toBe('Report Q3.pdf');
    expect(safeName('a\u0000b<c>.txt')).toBe('a_b_c_.txt');
    expect(safeName('.hidden')).toBe('hidden');
    expect(safeName('')).toBe('file');
    const long = safeName(`${'x'.repeat(300)}.xlsx`);
    expect(long.length).toBe(120);
    expect(long.endsWith('.xlsx')).toBe(true);
    expect([mimeOf('a.PDF'), mimeOf('b.csv'), mimeOf('c.unknown')]).toEqual(['application/pdf', 'text/csv', null]);
  });

  it('go in .alchemist/attachments, which git never sees', () => {
    const cwd = project();
    const dir = attachmentsDir(cwd);
    expect(dir).toBe(join(cwd, '.alchemist', 'attachments'));
    expect(readFileSync(join(cwd, '.alchemist', '.gitignore'), 'utf8')).toContain('*');
  });

  it('a file from elsewhere is copied in; one already in the project stays where it is', () => {
    const cwd = project();
    const src = outside('report.pdf', 'PDF');
    const staged = stageFile(cwd, src)!;
    expect(staged.path.startsWith(join(cwd, '.alchemist', 'attachments'))).toBe(true);
    expect(staged.path.endsWith('-report.pdf')).toBe(true);
    expect(readFileSync(staged.path, 'utf8')).toBe('PDF');
    expect(staged).toMatchObject({ name: 'report.pdf', mimeType: 'application/pdf', size: 3 });

    mkdirSync(join(cwd, 'docs'));
    writeFileSync(join(cwd, 'docs', 'spec.md'), '# Spec');
    expect(stageFile(cwd, join(cwd, 'docs', 'spec.md'))!.path).toBe(join(cwd, 'docs', 'spec.md'));
    expect(insideProject(cwd, join(cwd, '..', 'other'))).toBe(false);
  });

  it('two files with the same name never overwrite each other', () => {
    const cwd = project();
    const a = stageFile(cwd, outside('notes.txt', 'one'))!;
    const b = stageFile(cwd, outside('notes.txt', 'two'))!;
    expect(a.path).not.toBe(b.path);
    expect([readFileSync(a.path, 'utf8'), readFileSync(b.path, 'utf8')]).toEqual(['one', 'two']);
  });

  it('not a file, or a relative path: nothing', () => {
    const cwd = project();
    expect(stageFile(cwd, 'relative/thing.txt')).toBeNull();
    expect(stageFile(cwd, join(cwd, 'missing.txt'))).toBeNull();
    expect(stageFile(cwd, tmpdir())).toBeNull();
  });

  it('pasted contents and images become files too', () => {
    const cwd = project();
    const pasted = stageData(cwd, 'clip.csv', Buffer.from('a,b\n1,2\n'));
    expect(readFileSync(pasted.path, 'utf8')).toBe('a,b\n1,2\n');
    expect(pasted.mimeType).toBe('text/csv');
    const img = stageImage(cwd, { mediaType: 'image/png', data: PNG }, 0);
    expect(img.name).toBe('image-1.png');
    expect(existsSync(img.path)).toBe(true);
  });

  it('agents without ACP get the files named at the end of the message', () => {
    expect(mentionFiles('summarize', [])).toBe('summarize');
    expect(mentionFiles('summarize', [{ path: '/p/.alchemist/attachments/x-report.pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 3 }])).toBe(
      'summarize\n\nAttached files:\n- /p/.alchemist/attachments/x-report.pdf (application/pdf)',
    );
  });
});

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const provider = (env: Record<string, string>): ProviderAdapter => ({
  id: 'fake',
  label: 'Fake',
  edition: 'community',
  harnesses: ['fake'],
  capabilities: { toolSearch: false, webFetch: false, webSearch: false, subagents: false },
  models: async () => [],
  env: async () => env,
});

/** The fake agent's answer to one prompt (with FAKE_BLOCKS, the blocks it got). */
function reply(run: (h: ReturnType<typeof acpHarness>) => ReturnType<ReturnType<typeof acpHarness>['run']>): Promise<string> {
  const harness = acpHarness({ id: 'fake', label: 'Fake agent', resolve: async () => ({ command: process.execPath, args: [FAKE], version: '1.0.0' }), modes: { default: { modes: ['default'] }, acceptEdits: { modes: ['acceptEdits'] }, plan: { modes: ['plan'] }, bypassPermissions: { modes: ['yolo'] } } });
  const handle = run(harness);
  return new Promise((resolve, reject) => {
    const events: RunnerEvent[] = [];
    const timer = setTimeout(() => reject(new Error(`timeout: ${JSON.stringify(events)}`)), 15_000);
    handle.onEvent((e) => {
      events.push(e);
      if (e.type === 'result') {
        clearTimeout(timer);
        handle.stop();
        resolve(events.flatMap((x) => (x.type === 'text' ? [x.text] : [])).join(''));
      }
    });
  });
}

describe('what an ACP agent receives', () => {
  it('each file as a resource_link it can open; images as files when it cannot see them', async () => {
    const cwd = project();
    const file = stageFile(cwd, outside('data.xlsx', 'XLSX'))!;
    const text = await reply((h) =>
      h.run({ cwd, prompt: 'look at these', provider: provider({ FAKE_BLOCKS: '1' }), model: 'default', files: [file], images: [{ mediaType: 'image/png', data: PNG }] }),
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('text look at these');
    expect(lines[1]).toMatch(/^link data\.xlsx application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet 4 file:\/\/.+-data\.xlsx$/);
    // This fake doesn't take images: the picture came as a file in the project.
    expect(lines[2]).toMatch(/^link image-1\.png image\/png \d+ file:\/\/.+\/\.alchemist\/attachments\/.+-image-1\.png$/);
  });

  it('an agent that sees images gets them as images', async () => {
    const cwd = project();
    const text = await reply((h) => h.run({ cwd, prompt: 'this one', provider: provider({ FAKE_BLOCKS: '1', FAKE_IMAGES: '1' }), model: 'default', images: [{ mediaType: 'image/png', data: PNG }] }));
    expect(text.split('\n')).toEqual(['text this one', 'image image/png']);
  });
});
