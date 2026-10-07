import type { InstallStep, RunnerCatalog } from '@shared/api';
import { useStore, useT } from '../store';
import { toast } from '../ui';

type T = ReturnType<typeof useT>;
type Harness = RunnerCatalog['harnesses'][number];

/** What the step installs, by name. */
export const installName = (step: InstallStep, agent: string) => (step.what === 'node' ? 'Node.js' : agent);

let watching: ReturnType<typeof setInterval> | null = null;

/** While an install runs in the terminal, looks again every few seconds until the agent is found (15 minutes at most). */
function watchInstall(harnessId: string, t: T) {
  if (watching) clearInterval(watching);
  const until = Date.now() + 15 * 60_000;
  watching = setInterval(() => {
    void useStore
      .getState()
      .loadCatalog()
      .then(() => {
        const found = useStore.getState().catalog?.harnesses.find((h) => h.id === harnessId)?.installed;
        if ((found || Date.now() > until) && watching) {
          clearInterval(watching);
          watching = null;
          if (found) toast(t('run.agentReady', { name: useStore.getState().catalog?.harnesses.find((h) => h.id === harnessId)?.label ?? harnessId }));
        }
      })
      .catch(() => {});
  }, 8000);
}

/** Runs the step's command in the app's terminal (you see it and answer its questions), or opens its download page. */
export function runInstall(harness: Harness, step: InstallStep, t: T) {
  const s = useStore.getState();
  const projectId = s.settings.activeProjectId ?? s.projects[0]?.id;
  if (!step.command || projectId == null) return void window.open(step.url, '_blank');
  useStore.setState({ settingsOpen: false });
  void s.openTerminalWith(projectId, step.command, t('run.installName', { name: installName(step, harness.label) }));
  toast(t('run.installHint'));
  watchInstall(harness.id, t);
}

/** The button that installs what an agent is missing. */
export function InstallButton({ harness, step, small }: { harness: Harness; step: InstallStep; small?: boolean }) {
  const t = useT();
  const name = installName(step, harness.label);
  return (
    <button className={small ? 'btn-send small' : 'btn-send'} onClick={() => runInstall(harness, step, t)} title={step.command ?? step.url}>
      {step.command ? t('run.installName', { name }) : t('run.downloadName', { name })}
    </button>
  );
}

/**
 * Over the message box when the conversation's agent isn't on this computer: what it needs, a button that
 * installs it, and the agents that are installed (a new conversation can switch to one).
 */
export function MissingAgent({ harnessId, catalog, onSwitch }: { harnessId: string; catalog: RunnerCatalog; onSwitch?: (harnessId: string) => void }) {
  const t = useT();
  const loadCatalog = useStore((s) => s.loadCatalog);
  const harness = catalog.harnesses.find((h) => h.id === harnessId);
  const name = harness?.label ?? harnessId;
  const step = harness?.install ?? null;
  const others = catalog.harnesses.filter((h) => h.installed && h.id !== harnessId);
  const version = (h: Harness) => h.cliVersion ?? h.version;
  return (
    <div className="composer-hint missing-agent">
      <p>{step?.what === 'node' ? t('run.needsNode', { name }) : t('run.noHarness', { name })}</p>
      {others.length > 0 && (
        <p className="missing-others">
          {t('run.installedAgents')}{' '}
          {others.map((h) =>
            onSwitch ? (
              <button key={h.id} className="link-btn" onClick={() => onSwitch(h.id)} title={t('run.useAgent', { name: h.label })}>
                {h.label} {version(h)}
              </button>
            ) : (
              <span key={h.id}>
                {h.label} {version(h)}
              </span>
            ),
          )}
        </p>
      )}
      <div className="missing-actions">
        {harness && step && <InstallButton harness={harness} step={step} small />}
        <button className="btn-ghost small" onClick={() => void loadCatalog()}>
          ↻ {t('run.redetect')}
        </button>
      </div>
    </div>
  );
}
