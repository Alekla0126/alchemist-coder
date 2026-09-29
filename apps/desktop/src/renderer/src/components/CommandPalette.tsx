import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '@alchemist-coder/core';
import type { Mode } from '@shared/api';
import { sourceOf } from '../sources';
import { listThemes } from '../theme';
import { toggleSidebar } from '../layout';
import { useStore, useT } from '../store';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const MODES: Array<[Mode, string]> = [
  ['agents', '⌘1'],
  ['arena', '⌘2'],
  ['code', '⌘3'],
  ['split', '⌘4'],
  ['terminal', '⌘5'],
  ['history', '⌘6'],
  ['bots', '⌘7'],
];

/** Accent-insensitive "every word appears" match. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const matches = (text: string, q: string) => fold(q).split(/\s+/).filter(Boolean).every((w) => fold(text).includes(w));

/** ⌘K: every command and every conversation, by typing. */
export function CommandPalette() {
  const t = useT();
  const s = useStore();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const close = () => useStore.setState({ paletteOpen: false });
  useEffect(() => input.current?.focus(), []);

  const projectId = s.settings.activeProjectId;
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      ...(projectId != null ? [{ id: 'new', label: t('palette.newConversation'), hint: '⌘N', run: () => (s.settings.mode !== 'split' && s.setMode('agents'), s.setCompose(projectId)) }] : []),
      ...(projectId != null ? [{ id: 'terminal', label: t('palette.newTerminal'), hint: '⌘T', run: () => void s.openTerminalWith(projectId, '') }] : []),
      ...MODES.map(([m, key]) => ({ id: `mode:${m}`, label: t('palette.goTo', { where: t(`mode.${m}`) }), hint: key, run: () => s.setMode(m) })),
      { id: 'settings', label: t('settings.title'), hint: '⌘,', run: () => useStore.setState({ settingsOpen: true }) },
      { id: 'usage', label: t('usage.title'), run: () => useStore.setState({ settingsOpen: true, settingsSection: 'usage' }) },
      { id: 'sidebar', label: t('shortcut.sidebar'), hint: '⌘B', run: toggleSidebar },
      ...(['en', 'es'] as const).filter((l) => l !== s.locale).map((l) => ({ id: `lang:${l}`, label: `${t('settings.language')}: ${l === 'en' ? 'English' : 'Español'}`, run: () => s.setLocale(l) })),
      // Only found by typing: there are many.
      ...listThemes()
        .filter((th) => th.id !== s.settings.theme)
        .map((th) => ({ id: `theme:${th.id}`, label: `${t('settings.theme')}: ${th.label}`, hint: th.type === 'light' ? '☀' : '☾', run: () => void s.setTheme(th.id) })),
      { id: 'open-project', label: t('palette.openProject'), hint: '⌘O', run: () => s.setPickerOpen(true) },
      ...s.settings.openProjectIds
        .map((id) => s.projects.find((p) => p.id === id))
        .filter((p) => p != null)
        .map((p) => ({ id: `project:${p.id}`, label: t('palette.switchProject', { name: p.name }), hint: p.cwd.replace(/^\/Users\/[^/]+/, '~'), run: () => void s.setActiveProject(p.id) })),
      ...(projectId != null
        ? (s.sessions[projectId] ?? []).slice(0, 200).map((c) => ({
            id: `session:${c.id}`,
            label: `${sourceOf(c.source).glyph} ${c.title}`,
            hint: t('palette.conversation'),
            run: () => (void s.select(c.id, 'main'), s.settings.mode === 'history' && s.setMode('agents')),
          }))
        : []),
    ];
    return list;
  }, [projectId, s.sessions, s.projects, s.settings, t]);

  // Files of this project, by name.
  const project = s.projects.find((p) => p.id === projectId);
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!project || query.trim().length < 2) return setFiles([]);
    let alive = true;
    const timer = setTimeout(() => void window.alchemist.searchFiles(project.cwd, query.trim()).then((f) => alive && setFiles(f.filter((x) => !x.endsWith('/')).slice(0, 8))), 100);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, project?.cwd]);

  // Beyond this project: full-text search across every conversation.
  useEffect(() => {
    if (query.trim().length < 3) return setHits([]);
    const timer = setTimeout(() => void window.alchemist.search(query, null).then((h) => setHits(h.slice(0, 8))), 160);
    return () => clearTimeout(timer);
  }, [query]);

  const shown: Command[] = [
    ...(query
      ? commands.filter((c) => matches(`${c.label} ${c.hint ?? ''}`, query))
      : commands.filter((c) => !c.id.startsWith('session:') && !c.id.startsWith('theme:')).concat(commands.filter((c) => c.id.startsWith('session:')).slice(0, 8))
    ).slice(0, 40),
    ...files.map((f) => ({ id: `file:${f}`, label: `▤ ${f.split('/').pop()}`, hint: f, run: () => project && (s.openFileAt(project.id, `${project.cwd.replace(/\/+$/, '')}/${f}`), s.settings.mode !== 'split' && s.setMode('code')) })),
    ...hits
      .filter((h) => !commands.some((c) => c.id === `session:${h.sessionId}`))
      .map((h) => ({ id: `hit:${h.sessionId}`, label: `${sourceOf(h.source).glyph} ${h.title}`, hint: h.projectName, run: () => (void s.select(h.sessionId, h.agentId), s.setMode('agents')) })),
  ];
  useEffect(() => setIndex(0), [query]);
  const pick = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('palette.title')}>
        <input
          ref={input}
          value={query}
          placeholder={t('palette.placeholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') (e.preventDefault(), setIndex((i) => Math.min(i + 1, shown.length - 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setIndex((i) => Math.max(i - 1, 0)));
            if (e.key === 'Enter') pick(shown[index]);
          }}
        />
        <div className="palette-list" role="listbox">
          {shown.map((c, i) => (
            <button key={c.id} role="option" aria-selected={i === index} className={i === index ? 'on' : ''} onMouseEnter={() => setIndex(i)} onClick={() => pick(c)}>
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </button>
          ))}
          {!shown.length && <p className="empty">{t('search.noResults')}</p>}
        </div>
      </div>
    </div>
  );
}
