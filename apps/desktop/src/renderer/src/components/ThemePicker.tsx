import { useEffect, useRef, useState } from 'react';
import { listThemes, saveCustomTheme, type VsTheme } from '../theme';
import { useStore, useT } from '../store';

export function ThemePicker() {
  const t = useT();
  const current = useStore((s) => s.settings.theme);
  const setTheme = useStore((s) => s.setTheme);
  const captureSearch = useStore((s) => s.info?.capture?.themeSearch ?? null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const themes = listThemes();
  const label = themes.find((th) => th.id === current)?.label ?? current;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const markCaptureReady = useStore((s) => s.markCaptureReady);
  // --capture --theme-search: open straight into a search (app info arrives after the first render).
  useEffect(() => {
    if (captureSearch == null) return;
    setOpen(true);
    setSearching(true);
    setQuery(captureSearch);
  }, [captureSearch]);
  const [results, setResults] = useState<Awaited<ReturnType<typeof window.alchemist.searchThemes>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);

  /** Saves every theme a file or extension brings and switches to the first. */
  const adopt = async (list: unknown[] | null) => {
    if (!list?.length) return;
    const ids = (list as VsTheme[]).map((th) => saveCustomTheme(th));
    await setTheme(ids[0]!);
    return ids.length;
  };

  const importTheme = async () => {
    setError(null);
    try {
      if (await adopt(await window.alchemist.importTheme())) setOpen(false);
    } catch {
      setError(t('theme.importError'));
    }
  };

  useEffect(() => {
    if (!searching) return;
    const timer = setTimeout(() => {
      setError(null);
      window.alchemist
        .searchThemes(query)
        .then((r) => {
          setResults(r);
          if (captureSearch != null) markCaptureReady();
        })
        .catch(() => setError('search'));
    }, 250);
    return () => clearTimeout(timer);
  }, [searching, query]);

  const install = async (namespace: string, name: string, label: string) => {
    setBusy(`${namespace}.${name}`);
    setError(null);
    try {
      const n = await adopt(await window.alchemist.installTheme(namespace, name));
      setInstalled(t('theme.installed', { name: label, n: n ?? 0 }));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : t('theme.importError'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="theme-picker" ref={ref}>
      <button className="chip theme-chip" onClick={() => setOpen(!open)} title={t('theme.label')}>
        ◐ {label}
      </button>
      {open && (
        <div className="menu">
          {themes.map((th) => (
            <button key={th.id} className={`menu-item ${th.id === current ? 'on' : ''}`} onClick={() => void setTheme(th.id).then(() => setOpen(false))}>
              <span className={`swatch ${th.type}`} />
              {th.label}
              {th.custom && <small>VS Code</small>}
            </button>
          ))}
          <div className="menu-sep" />
          {searching ? (
            <div className="theme-search">
              <input autoFocus value={query} placeholder={t('theme.searchPlaceholder')} onChange={(e) => setQuery(e.target.value)} />
              <div className="theme-results">
                {results === null && <span className="spin" />}
                {results?.length === 0 && <div className="menu-empty">{t('theme.noResults')}</div>}
                {results?.map((r) => (
                  <button key={`${r.namespace}.${r.name}`} className="menu-item theme-result" disabled={!!busy} onClick={() => void install(r.namespace, r.name, r.displayName)} title={r.description}>
                    <span className="theme-result-name">
                      {r.displayName}
                      {r.verified && <span className="verified">✓</span>}
                    </span>
                    <small>
                      {busy === `${r.namespace}.${r.name}` ? '…' : `${r.namespace} · ${r.downloads.toLocaleString()}`}
                    </small>
                  </button>
                ))}
              </div>
              {installed && <div className="menu-ok">✓ {installed}</div>}
              <div className="menu-note">{t('theme.openvsxNote')}</div>
            </div>
          ) : (
            <button className="menu-item" onClick={() => setSearching(true)}>
              ⌕ {t('theme.search')}
            </button>
          )}
          <button className="menu-item" onClick={() => void importTheme()}>
            ＋ {t('theme.import')}
          </button>
          {error && <div className="menu-error">{error === 'search' ? t('theme.searchError') : error}</div>}
        </div>
      )}
    </div>
  );
}
