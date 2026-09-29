import type { SessionSummary } from '@alchemist-coder/core';
import type { ExportFormat, MenuItem } from '@shared/api';
import { translate, type MessageKey } from '../i18n';
import { useStore } from '../store';
import { confirmAction, openMenu, promptText, toast } from '../ui';

const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(useStore.getState().locale, key, vars);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const SAFE_ID = /^[A-Za-z0-9][\w-]{3,120}$/;

/** The command that continues a conversation in its own CLI, when it has one. */
export function resumeCommand(s: Pick<SessionSummary, 'id' | 'source'>): string | null {
  if (!SAFE_ID.test(s.id)) return null;
  if (s.source === 'claude-code') return `claude --resume ${s.id}`;
  if (s.source === 'codex') return `codex resume ${s.id}`;
  return null;
}

const isRunning = (s: SessionSummary) => s.runningAgents > 0 || s.status === 'running';

function items(s: SessionSummary): MenuItem[] {
  const resume = resumeCommand(s);
  return [
    { id: 'open', label: t('menu.open') },
    { id: 'rename', label: t('menu.rename') },
    { id: 'pin', label: s.favorite ? t('menu.unpin') : t('menu.pin') },
    { type: 'separator' },
    {
      id: 'copy',
      label: t('menu.copy'),
      submenu: [
        { id: 'copy-title', label: t('menu.copyTitle') },
        { id: 'copy-id', label: t('menu.copyId') },
        ...(resume ? [{ id: 'copy-resume', label: t('menu.copyResume') }] : []),
      ],
    },
    { id: 'reveal', label: t('menu.revealTranscript'), enabled: !s.preserved },
    ...(resume ? [{ id: 'resume-terminal', label: t('menu.resumeTerminal'), enabled: !isRunning(s) }] : []),
    {
      id: 'export',
      label: t('menu.export'),
      submenu: [
        { id: 'export-md', label: 'Markdown' },
        { id: 'export-html', label: 'HTML' },
        { id: 'export-json', label: 'JSON' },
      ],
    },
    { type: 'separator' },
    { id: 'hide', label: t('menu.hide') },
    { id: 'trash', label: t('menu.trash'), enabled: !isRunning(s) && !s.preserved },
  ];
}

/** Runs one of the conversation menu's actions. */
export async function runSessionAction(s: SessionSummary, id: string): Promise<void> {
  const store = useStore.getState();
  try {
    switch (id) {
      case 'open':
        await store.select(s.id, 'main');
        if (store.settings.mode === 'history' || store.settings.mode === 'code' || store.settings.mode === 'terminal') store.setMode('agents');
        return;
      case 'rename': {
        const title = await promptText({ title: t('menu.renameTitle'), value: s.title, placeholder: t('menu.renameHint'), confirmLabel: t('menu.renameOk'), cancelLabel: t('dialog.cancel') });
        if (title === null) return;
        await window.alchemist.renameSession(s.id, title);
        return store.sessionsChanged(s.projectId, [s.id]);
      }
      case 'pin':
        return store.toggleFavorite(s);
      case 'copy-title':
        return window.alchemist.copyText(s.title);
      case 'copy-id':
        return window.alchemist.copyText(s.id);
      case 'copy-resume':
        return window.alchemist.copyText(resumeCommand(s) ?? '');
      case 'reveal':
        return window.alchemist.revealSession(s.id);
      case 'resume-terminal': {
        const cmd = resumeCommand(s);
        if (cmd) await store.openTerminalWith(s.projectId, cmd, s.source === 'codex' ? 'codex' : 'claude');
        return;
      }
      case 'export-md':
      case 'export-html':
      case 'export-json': {
        const file = await window.alchemist.exportSession(s.id, id.slice(7) as ExportFormat);
        if (file) toast(t('menu.exported', { file: file.split(/[\\/]/).pop() ?? file }));
        return;
      }
      case 'hide':
        await window.alchemist.hideSession(s.id, true);
        if (useStore.getState().selection?.sessionId === s.id) useStore.setState({ selection: null });
        await store.sessionsChanged(s.projectId);
        toast(t('menu.hidden', { title: s.title.slice(0, 60) }), {
          label: t('menu.undo'),
          run: () => void window.alchemist.hideSession(s.id, false).then(() => useStore.getState().sessionsChanged(s.projectId)),
        });
        return;
      case 'trash': {
        const ok = await confirmAction({ title: t('menu.trashTitle'), message: t('menu.trashBody', { title: s.title.slice(0, 80) }), confirmLabel: t('menu.trashOk'), cancelLabel: t('dialog.cancel'), danger: true });
        if (!ok) return;
        await window.alchemist.trashSession(s.id);
        if (useStore.getState().selection?.sessionId === s.id) useStore.setState({ selection: null });
        await store.sessionsChanged(s.projectId);
        toast(t('menu.trashed'));
        return;
      }
    }
  } catch (e) {
    toast(errorText(e));
  }
}

/** Shows the conversation's menu at the pointer (right-click or the ⋯ button). */
export async function showSessionMenu(s: SessionSummary): Promise<void> {
  const id = await openMenu(items(s));
  if (id) await runSessionAction(s, id);
}
