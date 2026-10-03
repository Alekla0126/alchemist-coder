import { keys as shortcutText } from '../keys';
import { useEffect, useState } from 'react';
import type { PermissionMode } from '@shared/api';
import { useStore, useT } from '../store';
import { toast } from '../ui';
import { SEND_KEY } from './Composer';
import { NOTIFY_KEY } from '../store';
import { BackupCard } from './HistoryView';
import { ThemePicker } from './ThemePicker';
import { UsageDetails } from './UsageMeter';
import { AutomationSettingsCard } from './Automations';

type Section = 'general' | 'agents' | 'automations' | 'usage' | 'backup' | 'shortcuts' | 'about';
const SECTIONS: Array<[Section, string]> = [
  ['general', '⚙'],
  ['agents', '🧩'],
  ['automations', '⚡'],
  ['usage', '📊'],
  ['backup', '🛟'],
  ['shortcuts', '⌨'],
  ['about', 'ℹ'],
];
const COMPOSER_PREFS = 'alchemist.composer';
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function General() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  const [sendKey, setSendKey] = useState(localStorage.getItem(SEND_KEY) === 'mod-enter' ? 'mod-enter' : 'enter');
  const prefs = (() => {
    try {
      return JSON.parse(localStorage.getItem(COMPOSER_PREFS) ?? '{}') as { permissionMode?: PermissionMode };
    } catch {
      return {};
    }
  })();
  const [mode, setMode] = useState<PermissionMode>(prefs.permissionMode ?? 'acceptEdits');
  const [notify, setNotify] = useState(localStorage.getItem(NOTIFY_KEY) !== 'off');
  return (
    <>
      <div className="set-row">
        <div>
          <b>{t('settings.language')}</b>
        </div>
        <div className="lang" role="group">
          {(['en', 'es'] as const).map((l) => (
            <button key={l} className={l === locale ? 'on' : ''} onClick={() => setLocale(l)}>
              {l === 'en' ? 'English' : 'Español'}
            </button>
          ))}
        </div>
      </div>
      <div className="set-row">
        <div>
          <b>{t('settings.theme')}</b>
          <p>{t('settings.themeHint')}</p>
        </div>
        <ThemePicker />
      </div>
      <div className="set-row">
        <div>
          <b>{t('settings.sendKey')}</b>
          <p>{t('settings.sendKeyHint')}</p>
        </div>
        <select
          value={sendKey}
          onChange={(e) => {
            setSendKey(e.target.value);
            localStorage.setItem(SEND_KEY, e.target.value);
          }}
        >
          <option value="enter">{t('settings.sendEnter')}</option>
          <option value="mod-enter">{t('settings.sendModEnter')}</option>
        </select>
      </div>
      <div className="set-row">
        <div>
          <b>{t('settings.permissionMode')}</b>
          <p>{t('settings.permissionModeHint')}</p>
        </div>
        <select
          value={mode}
          onChange={(e) => {
            const value = e.target.value as PermissionMode;
            setMode(value);
            localStorage.setItem(COMPOSER_PREFS, JSON.stringify({ ...prefs, permissionMode: value }));
          }}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {t(`perm.${m}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="set-row">
        <div>
          <b>{t('settings.notify')}</b>
          <p>{t('settings.notifyHint')}</p>
        </div>
        <input
          type="checkbox"
          className="set-switch"
          checked={notify}
          onChange={(e) => {
            setNotify(e.target.checked);
            localStorage.setItem(NOTIFY_KEY, e.target.checked ? 'on' : 'off');
          }}
        />
      </div>
    </>
  );
}

/** Signing in happens in the CLI itself, in a terminal. Claude's only in the personal build. */
const LOGIN: Record<string, { command: string; personal?: boolean }> = {
  'claude-code': { command: 'claude auth login', personal: true },
  codex: { command: 'codex login' },
};

function Agents() {
  const t = useT();
  const catalog = useStore((s) => s.catalog);
  const loadCatalog = useStore((s) => s.loadCatalog);
  const personal = useStore((s) => s.info?.personal ?? false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  useEffect(() => {
    void loadCatalog();
    // Coming back from signing in in the terminal.
    const again = () => void loadCatalog();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [loadCatalog]);
  const logIn = (command: string) => {
    const s = useStore.getState();
    const projectId = s.settings.activeProjectId ?? s.projects[0]?.id;
    if (projectId == null) return toast(t('settings.needsProject'));
    useStore.setState({ settingsOpen: false });
    void s.openTerminalWith(projectId, command, t('settings.logIn').replace('…', ''));
    toast(t('settings.logInHint'));
  };
  if (!catalog) return <span className="spin" />;
  const save = async (providerId: string, value: string | null) => {
    try {
      await window.alchemist.setProviderCredential(providerId, value);
      setKeys((k) => ({ ...k, [providerId]: '' }));
      await loadCatalog();
      toast(value ? t('settings.keySaved') : t('settings.keyRemoved'));
    } catch (e) {
      toast(errorText(e));
    }
  };
  return (
    <>
      <div className="set-h4-row">
        <h4>{t('settings.clis')}</h4>
        <button className="btn-ghost small" onClick={() => void loadCatalog()}>
          ↻ {t('run.redetect')}
        </button>
      </div>
      {catalog.harnesses.map((h) => {
        const login = LOGIN[h.id];
        const canLogIn = h.installed && login && (!login.personal || personal);
        // Claude's sign-in is only shown where it can be used.
        const signedIn = login?.personal && !personal ? null : h.signedIn;
        const versions = [h.cliVersion && `CLI ${h.cliVersion}`, h.version && (h.cliVersion ? t('settings.adapter', { v: h.version }) : h.version)].filter(Boolean);
        return (
          <div key={h.id} className="set-row">
            <div>
              <b>{h.label}</b>
              <p title={h.cliPath ?? undefined}>{h.installed ? [t('settings.installed'), ...versions].join(' · ') : t('settings.notInstalled')}</p>
              {h.installed && h.cliPath && <p className="set-path">{h.cliPath.replace(/^\/Users\/[^/]+/, '~')}</p>}
              {h.installed && h.id === 'gemini' && <p>{t('settings.geminiKey')}</p>}
              {h.installed && signedIn != null && (
                <p className={signedIn ? '' : 'set-warn'}>{signedIn ? (h.account ? t('settings.signedInAs', { account: h.account }) : t('settings.signedIn')) : t('settings.signedOut')}</p>
              )}
            </div>
            <div className="set-key">
              {canLogIn && (
                <button className={signedIn ? 'btn-ghost small' : 'btn-send'} onClick={() => logIn(login.command)}>
                  {signedIn ? t('settings.switchAccount') : t('settings.logIn')}
                </button>
              )}
              <span className={`set-dot ${h.installed ? (signedIn === false ? 'off' : 'ok') : 'off'}`}>{h.installed ? '●' : '○'}</span>
            </div>
          </div>
        );
      })}
      <h4>{t('settings.providers')}</h4>
      {catalog.providers.map((p) => (
        <div key={p.id} className="set-row set-provider">
          <div>
            <b>
              {p.label} {p.edition === 'pro' && <span className="set-pro">Pro</span>}
            </b>
            <p>{p.available ? t('settings.available', { n: p.models.length }) : (p.detail ?? t('settings.unavailable'))}</p>
          </div>
          {p.credential ? (
            <div className="set-key">
              {p.credential.isSet ? (
                <>
                  <span className="set-dot ok">● {t('settings.keySet')}</span>
                  <button className="btn-ghost small danger" onClick={() => void save(p.id, null)}>
                    {t('settings.removeKey')}
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="password"
                    placeholder={p.credential.placeholder ?? p.credential.label}
                    value={keys[p.id] ?? ''}
                    onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && keys[p.id]?.trim() && void save(p.id, keys[p.id]!.trim())}
                  />
                  <button className="btn-send" disabled={!keys[p.id]?.trim()} onClick={() => void save(p.id, keys[p.id]!.trim())}>
                    {t('run.saveKey')}
                  </button>
                </>
              )}
            </div>
          ) : (
            <span className={`set-dot ${p.available ? 'ok' : 'off'}`}>{p.available ? '●' : '○'}</span>
          )}
        </div>
      ))}
      {catalog.providers.some((p) => p.credential && !p.credential.isSet) && <p className="composer-note">{t('run.keyHint')}</p>}
    </>
  );
}

function Usage() {
  const load = useStore((s) => s.loadPlanUsage);
  useEffect(() => void load(), [load]);
  return (
    <div className="set-usage">
      <UsageDetails />
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['⌘K', 'shortcut.palette'],
  ['⌘N', 'shortcut.newConversation'],
  ['⌘B', 'shortcut.sidebar'],
  ['⌘⌥B', 'shortcut.agentPanel'],
  ['⌘T', 'shortcut.newTerminal'],
  ['⌘O', 'shortcut.openProject'],
  ['⌘W', 'shortcut.closeTab'],
  ['⌘1 … ⌘9', 'shortcut.modes'],
  ['⌘⇧F', 'shortcut.search'],
  ['⌘,', 'shortcut.settings'],
  ['⌘S', 'shortcut.save'],
  ['↵ / ⇧↵', 'shortcut.send'],
  ['⌘⇧↵', 'shortcut.fork'],
  ['↑', 'shortcut.recall'],
  ['Esc', 'shortcut.interrupt'],
  ['⌘ + click', 'shortcut.link'],
];

function Shortcuts() {
  const t = useT();
  return (
    <div className="set-shortcuts">
      {SHORTCUTS.map(([keys, label]) => (
        <div key={label} className="set-row">
          <span>{t(label as never)}</span>
          <kbd>{shortcutText(keys)}</kbd>
        </div>
      ))}
    </div>
  );
}

function About() {
  const t = useT();
  const info = useStore((s) => s.info);
  return (
    <>
      <div className="set-row">
        <b>{t('settings.version')}</b>
        <span>v{info?.version}</span>
      </div>
      <div className="set-row">
        <b>{t('settings.edition')}</b>
        <span>{info?.edition === 'pro' ? 'Pro' : t('status.edition')}</span>
      </div>
      <div className="set-row">
        <b>{t('settings.license')}</b>
        <a href="https://github.com/Alekla0126/alchemist-coder" target="_blank" rel="noreferrer">
          AGPL-3.0
        </a>
      </div>
      <div className="set-row">
        <b>{t('settings.website')}</b>
        <a href="https://coder.alekla.com" target="_blank" rel="noreferrer">
          coder.alekla.com
        </a>
      </div>
      <p className="composer-note">
        {t('settings.privacy')}
        {info?.personal && ` ${t('settings.privacyPersonal')}`}
      </p>
    </>
  );
}

/** Everything configurable, in one place (⌘,). */
export function Settings() {
  const t = useT();
  const [section, setSection] = useState<Section>(() => useStore.getState().settingsSection ?? useStore.getState().info?.capture?.settings ?? 'general');
  useEffect(() => () => useStore.setState({ settingsSection: null }), []);
  const close = () => useStore.setState({ settingsOpen: false });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.dialog') && close();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);
  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="settings" role="dialog" aria-modal="true" aria-label={t('settings.title')}>
        <nav className="settings-nav">
          <h2>{t('settings.title')}</h2>
          {SECTIONS.map(([id, icon]) => (
            <button key={id} className={id === section ? 'on' : ''} onClick={() => setSection(id)}>
              <span>{icon}</span> {t(`settings.${id}`)}
            </button>
          ))}
        </nav>
        <section className="settings-body">
          <div className="settings-head">
            <h3>{t(`settings.${section}`)}</h3>
            <button className="icon-btn" onClick={close} title={t('dialog.close')}>
              ×
            </button>
          </div>
          {section === 'general' && <General />}
          {section === 'agents' && <Agents />}
          {section === 'automations' && <AutomationSettingsCard />}
          {section === 'usage' && <Usage />}
          {section === 'backup' && <BackupCard />}
          {section === 'shortcuts' && <Shortcuts />}
          {section === 'about' && <About />}
        </section>
      </div>
    </div>
  );
}
