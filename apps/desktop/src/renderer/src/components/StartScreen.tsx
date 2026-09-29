import { tildify } from '../paths';
import { openFolderAsProject, openNewProject } from './NewProject';
import { keys } from '../keys';
import { relativeTime } from '../format';
import { showSessionMenu } from '../actions/session';
import { sourceOf } from '../sources';
import { useStore, useT } from '../store';
import { LogoMark } from './Logo';

/** Long paths keep their start and their end ("~/Code/…/apps/web"). */
const middle = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.floor(max / 2) - 1)}…${s.slice(s.length - Math.ceil(max / 2) + 1)}`);

const HINTS: Array<[string, string]> = [
  ['⌘N', 'shortcut.newConversation'],
  ['⌘K', 'shortcut.palette'],
  ['⌘⇧F', 'shortcut.search'],
  ['⌘B', 'shortcut.sidebar'],
];

/** What the agent panel shows before you pick a conversation: start one, or go back to one. */
export function StartScreen() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const project = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId));
  const sessions = useStore((s) => (s.settings.activeProjectId != null ? s.sessions[s.settings.activeProjectId] : undefined));
  const select = useStore((s) => s.select);
  const setCompose = useStore((s) => s.setCompose);
  const setPickerOpen = useStore((s) => s.setPickerOpen);
  const projects = useStore((s) => s.projects);
  const home = useStore((s) => s.info?.home ?? '');
  const running = (sessions ?? []).filter((s) => s.runningAgents > 0 || s.status === 'running');
  const recent = [...(sessions ?? [])]
    .filter((s) => !running.includes(s))
    .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
    .slice(0, 6);
  if (!project) {
    return (
      <div className="start">
        <div className="start-logo">
          <LogoMark size={72} />
        </div>
        <h2>{t('start.noProject')}</h2>
        <div className="start-actions">
          <button className="btn-send" onClick={openNewProject}>
            + {t('plus.newProject')} <kbd>{keys('⌘⇧N')}</kbd>
          </button>
          <button className="btn-ghost" onClick={() => void openFolderAsProject(t)}>
            {t('plus.openFolder')}
          </button>
          {projects.length > 0 && (
            <button className="btn-ghost" onClick={() => setPickerOpen(true)}>
              {t('plus.find')} <kbd>{keys('⌘O')}</kbd>
            </button>
          )}
        </div>
      </div>
    );
  }
  const row = (s: (typeof recent)[number], live: boolean) => (
    <button key={s.id} className="start-row" onClick={() => void select(s.id, 'main')} onContextMenu={(e) => (e.preventDefault(), void showSessionMenu(s))}>
      <span className="src" title={sourceOf(s.source).label}>
        {sourceOf(s.source).glyph}
      </span>
      <span className="start-title">{s.title}</span>
      {live ? <span className="start-live">● {t('status.running')}</span> : <span className="start-when">{relativeTime(s.lastTs, locale)}</span>}
    </button>
  );
  return (
    <div className="start">
      <div className="start-logo">
          <LogoMark size={72} />
        </div>
      <h2>{project.name}</h2>
      <p className="start-path" title={project.cwd}>
        {middle(tildify(project.cwd, home), 72)}
      </p>
      <button className="btn-send start-new" onClick={() => setCompose(project.id)}>
        ＋ {t('run.new')} <kbd>{keys('⌘N')}</kbd>
      </button>
      {running.length > 0 && (
        <section className="start-sec">
          <h3>{t('start.running')}</h3>
          {running.slice(0, 4).map((s) => row(s, true))}
        </section>
      )}
      {recent.length > 0 && (
        <section className="start-sec">
          <h3>{t('start.recent')}</h3>
          {recent.map((s) => row(s, false))}
        </section>
      )}
      <div className="start-hints">
        {HINTS.map(([key, label]) => (
          <span key={key}>
            <kbd>{keys(key)}</kbd> {t(label as never)}
          </span>
        ))}
      </div>
    </div>
  );
}
