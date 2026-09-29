import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BackupStatus } from '../src/shared/api';
import { BackupService } from '../src/main/backup';
import { SettingsStore } from '../src/main/settings';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'backup-svc-')));
const claudeHome = join(root, 'claude-home');
const codexHome = join(root, 'codex-home');
mkdirSync(join(claudeHome, 'projects', '-tmp-app'), { recursive: true });
writeFileSync(join(claudeHome, 'projects', '-tmp-app', 'a1.jsonl'), '{"type":"user"}\n');
mkdirSync(join(codexHome, 'sessions', '2026', '09', '27'), { recursive: true });
writeFileSync(join(codexHome, 'sessions', '2026', '09', '27', 'rollout-x-11111111-2222-3333-4444-555555555555.jsonl'), '{"type":"session_meta"}\n');
const geminiTmp = join(root, 'gemini-tmp');
mkdirSync(join(geminiTmp, 'app', 'chats'), { recursive: true });
mkdirSync(join(geminiTmp, 'app', 'logs'), { recursive: true });
writeFileSync(join(geminiTmp, 'app', 'chats', 'session-2026-09-27T10-00-abc.jsonl'), '{"sessionId":"abc"}\n');
writeFileSync(join(geminiTmp, 'app', '.project_root'), '/tmp/app');
writeFileSync(join(geminiTmp, 'app', 'logs', 'shell_history'), 'secret command'); // not a conversation: skipped
const grokSessions = join(root, 'grok-sessions');
mkdirSync(join(grokSessions, '%2Ftmp%2Fapp', 'g-1'), { recursive: true });
writeFileSync(join(grokSessions, '%2Ftmp%2Fapp', 'g-1', 'updates.jsonl'), '{}\n');
writeFileSync(join(grokSessions, '%2Ftmp%2Fapp', 'g-1', 'summary.json'), '{}');
writeFileSync(join(grokSessions, 'session_search.sqlite'), ''); // Grok's own index: skipped
const sources = () => ({ claudeRoot: join(claudeHome, 'projects'), codexRoot: codexHome, geminiRoot: geminiTmp, grokRoot: grokSessions });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('BackupService', () => {
  it('turns on, tells the indexer, backs up and reports its status', async () => {
    const settings = new SettingsStore(join(root, 'settings.json'));
    const roots: Array<string | null> = [];
    const updates: BackupStatus[] = [];
    const service = new BackupService(settings, (dir) => roots.push(dir), (s) => updates.push(s), sources);
    const off = await service.status();
    expect(off).toMatchObject({ dir: null, files: 0, lastRun: null });
    expect(off.sourceBytes).toBeGreaterThan(0);

    const dest = join(root, 'Backup');
    await service.enable(dest);
    expect(roots).toEqual([dest]);
    expect(settings.get()).toMatchObject({ backupDir: dest, backupAuto: true });
    // The first run starts on its own; wait for it to finish.
    for (let i = 0; i < 100 && (updates.length === 0 || updates.at(-1)!.running); i++) await new Promise((r) => setTimeout(r, 50));
    const done = await service.status();
    expect(done).toMatchObject({ dir: dest, running: false, files: 6, error: null });
    expect(existsSync(join(dest, 'gemini', 'app', 'chats', 'session-2026-09-27T10-00-abc.jsonl'))).toBe(true);
    expect(existsSync(join(dest, 'grok', '%2Ftmp%2Fapp', 'g-1', 'summary.json'))).toBe(true);
    expect(existsSync(join(dest, 'gemini', 'app', 'logs'))).toBe(false);
    expect(done.lastCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(done.lastRun).toBeGreaterThan(Date.now() - 60_000);
    expect(updates.some((u) => u.running)).toBe(true);

    expect((await service.setAuto(false)).auto).toBe(false);
    service.stop();
  });

  it('keeps to its own folder', async () => {
    const settings = new SettingsStore(join(root, 'settings-2.json'));
    const service = new BackupService(settings, () => {}, () => {}, sources);
    await expect(service.enable(join(claudeHome, 'projects', 'backup'))).rejects.toThrow(/outside/);
    await expect(service.enable(root)).rejects.toThrow(/outside/);
    // A folder with other things in it gets a backup folder of its own.
    const docs = join(root, 'Documents');
    mkdirSync(docs);
    writeFileSync(join(docs, 'taxes.pdf'), 'x');
    const status = await service.enable(docs);
    expect(status.dir).toBe(join(docs, 'Alchemist Coder Backup'));
    for (let i = 0; i < 100 && (await service.status()).running; i++) await new Promise((r) => setTimeout(r, 50));
    service.stop();
    // settings.json pointing somewhere else (hand-edited) is not backed up into.
    settings.update({ backupDir: docs });
    expect(service.root()).toBeNull();
    expect((await service.run()).error).toMatch(/no longer an Alchemist backup/);
    expect(existsSync(join(docs, 'claude'))).toBe(false);
    expect(existsSync(join(docs, '.git'))).toBe(false);
  });
});
