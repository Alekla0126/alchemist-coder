import { useEffect } from 'react';
import type { RunnerCatalog } from '@shared/api';
import { keys } from '../keys';
import { sourceOf } from '../sources';
import { useStore, useT } from '../store';
import { LOGIN, runSetupCommand } from '../agent-setup';
import { LogoMark } from './Logo';
import { InstallButton } from './MissingAgent';
import { openFolderAsProject, openNewProject } from './NewProject';
import { closeWelcome as close, useWelcome } from '../welcome-state';

type Harness = RunnerCatalog['harnesses'][number];

/** One agent CLI: ready, or what it still needs (installing, signing in) with the button that does it. */
function AgentRow({ h }: { h: Harness }) {
  const t = useT();
  const personal = useStore((s) => s.info?.personal ?? false);
  const login = LOGIN[h.id];
  // Claude's sign-in is only offered where it can be used.
  const signedIn = login?.personal && !personal ? null : h.signedIn;
  const version = h.cliVersion ?? h.version;
  const state = !h.installed ? 'missing' : signedIn === false ? 'signedOut' : 'ready';
  return (
    <div className={`wl-row ${state}`}>
      <span className="wl-glyph">{sourceOf(h.id).glyph}</span>
      <div className="wl-what">
        <b>{h.label}</b>
        <span>
          {state === 'ready'
            ? [t('welcome.ready'), version].filter(Boolean).join(' · ')
            : state === 'signedOut'
              ? t('settings.signedOut')
              : h.install?.what === 'node'
                ? t('run.needsNode', { name: h.label })
                : t('settings.notInstalled')}
        </span>
      </div>
      {state === 'missing' && h.install && <InstallButton harness={h} step={h.install} small />}
      {state === 'signedOut' && login && (
        <button className="btn-send small" onClick={() => runSetupCommand(login.command, t('settings.logIn').replace('…', ''), t)}>
          {t('settings.logIn')}
        </button>
      )}
      {state === 'ready' && <span className="wl-ok">✓</span>}
    </div>
  );
}

/**
 * What a new user needs to get going, on one screen: the conversations already found, each agent CLI
 * (installed? signed in?) with the button that fixes it, the models agents can run on, and a project.
 */
export function Welcome() {
  const t = useT();
  const open = useWelcome((s) => s.open);
  const catalog = useStore((s) => s.catalog);
  const loadCatalog = useStore((s) => s.loadCatalog);
  const progress = useStore((s) => s.progress);
  const projects = useStore((s) => s.projects);
  const info = useStore((s) => s.info);
  const openProject = useStore((s) => s.openProject);
  useEffect(() => {
    if (!open) return;
    void loadCatalog();
    // Back from installing or signing in in the terminal.
    const again = () => void loadCatalog();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('focus', again);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('focus', again);
      window.removeEventListener('keydown', esc);
    };
  }, [open, loadCatalog]);
  if (!open) return null;
  const conversations = projects.reduce((n, p) => n + p.sessionCount, 0);
  const sources = [...new Set(projects.flatMap((p) => p.sources))].map((s) => sourceOf(s).label);
  const recent = [...projects].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))[0];
  const community = info?.edition !== 'pro' && !info?.personal;
  const models = (catalog?.providers ?? []).filter((p) => p.available);
  const local = (catalog?.providers ?? []).filter((p) => p.id === 'ollama' || p.id === 'lmstudio');
  const start = async (fn: () => unknown) => {
    close();
    await fn();
  };
  return (
    <div className="dialog-backdrop welcome-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog welcome" role="dialog" aria-label={t('welcome.title')}>
        <header className="wl-head">
          <LogoMark size={44} />
          <div>
            <h3>{t('welcome.title')}</h3>
            <p>{t('welcome.sub')}</p>
          </div>
        </header>

        <section className="wl-sec">
          <h4>
            <span className="wl-n">1</span> {t('welcome.history')}
          </h4>
          <p className="wl-note">
            {progress.phase !== 'ready' && !conversations
              ? t('index.scanning')
              : conversations
                ? `${t('index.sessions', { n: conversations })} · ${t('index.projects', { n: projects.length })}${sources.length ? ` · ${sources.join(', ')}` : ''}`
                : t('welcome.historyNone')}
          </p>
        </section>

        <section className="wl-sec">
          <h4>
            <span className="wl-n">2</span> {t('welcome.agents')}
          </h4>
          {!catalog ? (
            <span className="spin" />
          ) : (
            <div className="wl-grid">
              {catalog.harnesses.map((h) => (
                <AgentRow key={h.id} h={h} />
              ))}
            </div>
          )}
        </section>

        <section className="wl-sec">
          <h4>
            <span className="wl-n">3</span> {t('welcome.models')}
          </h4>
          {community && <p className="wl-note">{t('run.localOnly')}</p>}
          <div className="wl-grid">
            {catalog &&
              (community ? local : models).map((p) => (
                <div key={p.id} className={`wl-row ${p.available ? 'ready' : 'missing'}`}>
                  <span className="wl-glyph">◇</span>
                  <div className="wl-what">
                    <b>{p.label}</b>
                    {/* The full status on hover: it's cut to fit its column. */}
                    <span title={p.detail ?? undefined}>{p.available ? t('settings.available', { n: p.models.length }) : (p.detail ?? t('settings.unavailable'))}</span>
                  </div>
                  {p.available ? <span className="wl-ok">✓</span> : null}
                </div>
              ))}
          </div>
          {catalog && community && !local.some((p) => p.available && p.models.length) && (
            <p className="wl-note">
              {t('run.noModel')} <code>ollama pull qwen2.5-coder:7b</code>{' '}
              <a href="https://ollama.com/download" target="_blank" rel="noreferrer">
                {t('welcome.getOllama')}
              </a>
            </p>
          )}
        </section>

        <section className="wl-sec">
          <h4>
            <span className="wl-n">4</span> {t('welcome.project')}
          </h4>
          <div className="wl-actions">
            {recent && (
              <button className="btn-send" onClick={() => void start(() => openProject(recent.id))}>
                {t('welcome.openRecent', { name: recent.name })}
              </button>
            )}
            <button className={recent ? 'btn-ghost' : 'btn-send'} onClick={() => void start(() => openFolderAsProject(t))}>
              {t('plus.openFolder')}
            </button>
            <button className="btn-ghost" onClick={() => void start(openNewProject)}>
              {t('plus.newProject')} <kbd>{keys('⌘⇧N')}</kbd>
            </button>
          </div>
        </section>

        <footer className="wl-foot">
          <span>{t('welcome.again')}</span>
          <button className="btn-ghost" onClick={close}>
            {t('welcome.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}
