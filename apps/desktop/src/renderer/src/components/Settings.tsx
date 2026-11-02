import { keys as shortcutText } from '../keys';
import { useEffect, useState } from 'react';
import { LOCALE_NAMES, LOCALES, isLocale, type PermissionMode, type ProActivation } from '@shared/api';
import { useStore, useT } from '../store';
import { toast } from '../ui';
import { InstallButton } from './MissingAgent';
import { LOGIN, providerStatus, runSetupCommand } from '../agent-setup';
import { useEditorKeys } from '../editor/vim';
import { SEND_KEY } from './Composer';
import { NOTIFY_KEY } from '../store';
import { BackupCard } from './HistoryView';
import { ThemePicker } from './ThemePicker';
import { UsageDetails } from './UsageMeter';
import { AutomationSettingsCard } from './Automations';
import { VOICE_ENGINES, WHISPER_MODELS, type VoiceStatus } from '@shared/api';
import { loadVoicePrefs, saveVoicePrefs, type VoicePrefs } from '../voice';
import { engineName, voiceStatus } from './VoiceButton';
import { RuntimeConnectionsCard } from './RuntimeConnections';

type Section = 'general' | 'connections' | 'agents' | 'voice' | 'automations' | 'usage' | 'backup' | 'shortcuts' | 'about';
const SECTIONS: Array<[Section, string]> = [
  ['general', '⚙'],
  ['connections', '⇄'],
  ['agents', '🧩'],
  ['voice', '🎤'],
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
  const autopilot = useStore((s) => s.settings.autopilot);
  const setAutopilot = useStore((s) => s.setAutopilot);
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
  const vim = useEditorKeys((k) => k.vim);
  const setVim = useEditorKeys((k) => k.setVim);
  return (
    <>
      <div className="set-row">
        <div>
          <b>{t('settings.language')}</b>
        </div>
        {/* Each language named in itself, so anyone finds theirs. */}
        <select value={locale} aria-label={t('settings.language')} onChange={(e) => isLocale(e.target.value) && setLocale(e.target.value)}>
          {LOCALES.map((l) => (
            <option key={l} value={l} lang={l}>
              {LOCALE_NAMES[l]}
            </option>
          ))}
        </select>
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
          <b>{t('autopilot.name')}</b>
          <p>{t('autopilot.hint')}</p>
        </div>
        <input type="checkbox" className="set-switch" checked={autopilot} onChange={(e) => setAutopilot(e.target.checked)} />
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
      <div className="set-row">
        <div>
          <b>{t('settings.vim')}</b>
          <p>{t('settings.vimHint')}</p>
        </div>
        <input type="checkbox" className="set-switch" checked={vim} onChange={(e) => setVim(e.target.checked)} />
      </div>
    </>
  );
}

/** The microphone: which engine writes out what you say, Whisper's size, the language you speak, and tidying. */
function VoiceSettings() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const [prefs, setPrefs] = useState<VoicePrefs>(loadVoicePrefs);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  useEffect(() => void voiceStatus(true).then(setStatus), [prefs.model]);
  const save = (next: VoicePrefs) => {
    setPrefs(next);
    saveVoicePrefs(next);
  };
  const info = (id: (typeof VOICE_ENGINES)[number]) => status?.engines.find((e) => e.id === id);
  const missing = (id: (typeof VOICE_ENGINES)[number]) => {
    const e = info(id);
    return e && !e.available ? ` — ${t(`voice.why.${e.detail || 'missing'}` as never)}` : '';
  };
  const chosen = prefs.engine === 'auto' ? status?.auto : prefs.engine;
  const local = chosen === 'whisper' || chosen === 'whisper-cpp';
  return (
    <>
      <div className="set-row">
        <div>
          <b>{t('voice.engineLabel')}</b>
          <p>{status && !status.auto ? t('voice.noneHint') : t('voice.engineHint')}</p>
          {prefs.engine === 'auto' && status && <p className="set-path">{status.auto ? t('voice.autoUses', { engine: engineName(t, status.auto) }) : t('voice.noEngine')}</p>}
        </div>
        <select value={prefs.engine} aria-label={t('voice.engineLabel')} onChange={(e) => save({ ...prefs, engine: e.target.value as VoicePrefs['engine'] })}>
          <option value="auto">{engineName(t, 'auto')}</option>
          {VOICE_ENGINES.filter((id) => id !== 'dictation' || status?.platform === 'darwin').map((id) => (
            <option key={id} value={id}>
              {engineName(t, id)}
              {missing(id)}
            </option>
          ))}
        </select>
      </div>
      {local && (
        <div className="set-row">
          <div>
            <b>{t('voice.model')}</b>
            <p>{t('voice.modelHint')}</p>
          </div>
          <select value={prefs.model} aria-label={t('voice.model')} onChange={(e) => save({ ...prefs, model: e.target.value })}>
            {WHISPER_MODELS.map((m) => (
              <option key={m} value={m}>
                {t(`voice.size.${m}` as never)}
              </option>
            ))}
          </select>
        </div>
      )}
      {chosen !== 'dictation' && (
        <>
          <div className="set-row">
            <div>
              <b>{t('voice.language')}</b>
              <p>{t('voice.languageHint')}</p>
            </div>
            <select value={prefs.language} aria-label={t('voice.language')} onChange={(e) => save({ ...prefs, language: e.target.value as VoicePrefs['language'] })}>
              <option value="app">{t('voice.languageApp', { language: LOCALE_NAMES[locale] })}</option>
              <option value="auto">{t('voice.languageAuto')}</option>
            </select>
          </div>
          <div className="set-row">
            <div>
              <b>{t('voice.tidy')}</b>
              <p>{t('voice.tidyHint')}</p>
            </div>
            <input type="checkbox" className="set-switch" checked={prefs.tidy} aria-label={t('voice.tidy')} onChange={(e) => save({ ...prefs, tidy: e.target.checked })} />
          </div>
        </>
      )}
    </>
  );
}

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
    if (runSetupCommand(command, t('settings.logIn').replace('…', ''), t)) toast(t('settings.logInHint'));
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
              <p title={h.cliPath ?? undefined}>{h.installed ? [t('settings.installed'), ...versions].join(' · ') : h.install?.what === 'node' ? t('run.needsNode', { name: h.label }) : t('settings.notInstalled')}</p>
              {h.installed && h.cliPath && <p className="set-path">{h.cliPath.replace(/^\/Users\/[^/]+/, '~')}</p>}
              {h.installed && h.id === 'gemini' && <p>{t('settings.geminiKey')}</p>}
              {h.installed && signedIn != null && (
                <p className={signedIn ? '' : 'set-warn'}>{signedIn ? (h.account ? t('settings.signedInAs', { account: h.account }) : t('settings.signedIn')) : t('settings.signedOut')}</p>
              )}
            </div>
            <div className="set-key">
              {!h.installed && h.install && <InstallButton harness={h} step={h.install} small />}
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
            <p title={p.detail ?? undefined}>{providerStatus(p, t)}</p>
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

/** The reasons a key can be turned down that have their own words; anything else is 'other'. */
const KEY_ERRORS = ['malformed', 'signature', 'expired', 'device', 'revoked'];

/**
 * Pro, in a copy that carries the Pro module and isn't Pro yet: «Buy Pro» opens the payment link
 * (when the build has one), and the license key that arrives by email, or a beta invitation, is
 * pasted below. The edition is decided at launch, so once the key is kept it asks for a restart.
 */
function ProCode({ checkout, account }: { checkout: string | null | undefined; account?: boolean }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProActivation | null>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => window.alchemist.onProAccountResult((r) => { setResult(r); setWaiting(false); }), []);
  const openAccount = async () => {
    setResult(null);
    try {
      const opened = await window.alchemist.proAccountStart();
      setWaiting(opened);
      if (!opened) setResult({ ok: false, reason: 'other' });
    } catch { setWaiting(false); setResult({ ok: false, reason: 'other' }); }
  };
  const activate = async () => {
    setBusy(true);
    try {
      setResult(await window.alchemist.proActivate(code));
    } catch {
      setResult({ ok: false, reason: 'other' });
    } finally {
      setBusy(false);
    }
  };
  const until = result?.expiresAt ? new Date(result.expiresAt).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  return (
    <>
      {account && <div className="set-row"><div><b>{t('pro.account')}</b><p>{t('pro.accountHint')}</p>{waiting && <p role="status">{t('pro.accountWaiting')}</p>}</div><button className="btn-send small" onClick={() => void openAccount()}>{t('pro.accountOpen')}</button></div>}
      {checkout && !account && (
        <div className="set-row">
          <div>
            <b>{t('pro.buyTitle')}</b>
            <p>{t('pro.buyHint')}</p>
          </div>
          <a className="btn-send small pro-buy" href={checkout} target="_blank" rel="noreferrer">
            {t('pro.buy')}
          </a>
        </div>
      )}
      <div className="set-row pro-code">
        <div>
          <b>{t('pro.code')}</b>
          <p>{t('pro.codeHint')}</p>
          {result && !result.ok && <p className="pro-code-bad">{t(`pro.error.${KEY_ERRORS.includes(result.reason ?? '') ? result.reason : 'other'}` as never)}</p>}
          {result?.ok && <p className="pro-code-ok">{t(result.beta ? 'pro.okBeta' : 'pro.ok', { date: until })}</p>}
        </div>
        <div className="pro-code-actions">
          {result?.ok ? (
            <button className="btn-send small" onClick={() => void window.alchemist.relaunch()}>
              {t('pro.restart')}
            </button>
          ) : (
            <>
              <input value={code} placeholder={t('pro.placeholder')} spellCheck={false} onChange={(e) => (setCode(e.target.value), setResult(null))} onKeyDown={(e) => e.key === 'Enter' && code.trim() && void activate()} />
              <button className="btn-send small" disabled={!code.trim() || busy} onClick={() => void activate()}>
                {busy ? <span className="spin" /> : t('pro.activate')}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function About() {
  const t = useT();
  const info = useStore((s) => s.info);
  return (
    <>
      <div className="set-row">
        <b>{t('settings.version')}</b>
        <span>v{info?.version}{info?.buildLabel && ` · ${info.buildLabel}`}</span>
      </div>
      <div className="set-row">
        <b>{t('settings.edition')}</b>
        <span>{info?.edition === 'pro' ? 'Pro' : t('status.edition')}</span>
      </div>
      {info?.proModule && (info.edition !== 'pro' || info.proAccount) && <ProCode checkout={info.proCheckout} account={info.proAccount} />}
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
        {info?.edition === 'pro' && ` ${t('settings.privacyPro')}`}
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
          {section === 'connections' && <RuntimeConnectionsCard />}
          {section === 'agents' && <Agents />}
          {section === 'voice' && <VoiceSettings />}
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
