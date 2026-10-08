import { useStore, type useT } from './store';
import { toast } from './ui';

type T = ReturnType<typeof useT>;

/** Signing in happens in the CLI itself, in a terminal. Claude's only in the personal build. */
export const LOGIN: Record<string, { command: string; personal?: boolean }> = {
  'claude-code': { command: 'claude auth login', personal: true },
  codex: { command: 'codex login' },
};

/**
 * Runs a setup command (an install, a sign-in) in the app's terminal, where you see it and answer its
 * questions. With no project to open a terminal in yet, the command is copied for your own terminal.
 * Returns whether it runs here.
 */
export function runSetupCommand(command: string, title: string, t: T): boolean {
  const s = useStore.getState();
  const projectId = s.settings.activeProjectId ?? s.projects[0]?.id;
  if (projectId == null) {
    void window.alchemist.copyText(command);
    toast(t('setup.copied', { command }));
    return false;
  }
  useStore.setState({ settingsOpen: false });
  void s.openTerminalWith(projectId, command, title);
  return true;
}
