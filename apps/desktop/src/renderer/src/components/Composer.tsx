import { keys } from '../keys';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary, SlashCommand } from '@alchemist-coder/core';
import type { MenuItem, PermissionMode } from '@shared/api';
import type { PromptImage } from '@alchemist-coder/core';
import { LiveRun } from './LiveRun';
import { Suggest, type SuggestItem } from './Suggest';
import { useContextFill } from './ContextMeter';
import { matchModel } from '../format';
import { drafts, queues } from '../composer-state';
import { sourceOf } from '../sources';
import { useStore, useT } from '../store';
import { confirmAction, openMenu, toast } from '../ui';

const PREFS_KEY = 'alchemist.composer';
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MODE_ICON: Record<string, string> = { default: '✋', acceptEdits: '✎', plan: '☰', bypassPermissions: '⚠', 'read-only': '👁', auto: '✎', 'full-access': '⚠' };
/** Codex's own ACP modes, named like the app's. */
const AGENT_MODE_LABEL: Record<string, 'readOnly' | PermissionMode> = { 'read-only': 'readOnly', auto: 'acceptEdits', 'full-access': 'bypassPermissions' };
const ALLOW_ALL = new Set(['bypassPermissions', 'full-access']);
/** "Allow all" asks once per launch. */
let allowAllConfirmed = false;

/** A composer setting as a pill: what's chosen, and a menu to change it. */
function Pill({ icon, label, title, disabled, danger, onClick }: { icon?: string; label: string; title: string; disabled?: boolean; danger?: boolean; onClick?: () => void }) {
  return (
    <button className={`cpill ${danger ? 'danger' : ''}`} disabled={disabled} title={title} aria-label={`${title}: ${label}`} aria-haspopup="menu" onClick={onClick}>
      {icon && <span className="cpill-ic">{icon}</span>}
      <span className="cpill-label">{label}</span>
      <span className="cpill-caret">▾</span>
    </button>
  );
}

interface Prefs {
  harnessId?: string;
  providerId?: string;
  model?: string;
  permissionMode?: PermissionMode;
}

const PICKS_KEY = 'alchemist.sessionModels';
type Picks = Record<string, { providerId: string; model: string }>;
const loadSessionPicks = (): Picks => {
  try {
    return JSON.parse(localStorage.getItem(PICKS_KEY) ?? '{}') as Picks;
  } catch {
    return {};
  }
};
const saveSessionPicks = (picks: Picks) => {
  // Only the latest 300 conversations are remembered.
  const entries = Object.entries(picks).slice(-300);
  localStorage.setItem(PICKS_KEY, JSON.stringify(Object.fromEntries(entries)));
};

/** 'enter' (default): Enter sends, Shift+Enter adds a line. 'mod-enter': ⌘/Ctrl+Enter sends. */
export const SEND_KEY = 'alchemist.sendKey';
let lastPrompt = '';
let detectStarted = false;

const loadPrefs = (): Prefs => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Prefs;
  } catch {
    return {};
  }
};

export function Composer({ projectId, session }: { projectId: number; session?: SessionSummary | null }) {
  const t = useT();
  const catalog = useStore((s) => s.catalog);
  // A catalog from last launch draws the pills, but warnings wait for real detection.
  const detected = useStore((s) => s.catalogFresh);
  const info = useStore((s) => s.info);
  const loadCatalog = useStore((s) => s.loadCatalog);
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const target = session ? `s:${session.id}` : `p:${projectId}`;
  const run = useStore((s) => (s.runByTarget[target] ? s.runs[s.runByTarget[target]!] : undefined));
  const startRun = useStore((s) => s.startRun);
  const sendToRun = useStore((s) => s.sendToRun);
  const stopRun = useStore((s) => s.stopRun);
  const interruptRun = useStore((s) => s.interruptRun);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [prompt, setPromptState] = useState(() => drafts.get(target) ?? '');
  const [queue, setQueueState] = useState<string[]>(() => queues.get(target) ?? []);
  /** "Edit in a fork" from a message: Send starts a new conversation instead. */
  const [forkNext, setForkNext] = useState(false);
  const ctx = useContextFill(session);
  const fillPct = ctx?.size ? Math.round((ctx.used / ctx.size) * 100) : 0;
  const box = useRef<HTMLTextAreaElement>(null);
  const setPrompt = (v: string) => {
    drafts.set(target, v);
    setPromptState(v);
  };
  const setQueue = (q: string[]) => {
    queues.set(target, q);
    setQueueState(q);
  };
  useEffect(() => {
    setPromptState(drafts.get(target) ?? '');
    setQueueState(queues.get(target) ?? []);
  }, [target]);
  // "Use as prompt" from a message in the conversation.
  const fill = useStore((s) => s.composerFill);
  useEffect(() => {
    if (!fill) return;
    if (fill.send) {
      useStore.setState({ composerFill: null });
      if (busy) setQueue([...queue, fill.text]);
      else void submit(fill.text);
      return;
    }
    setPrompt(fill.text);
    setForkNext(!!fill.fork && !!session);
    requestAnimationFrame(() => box.current?.focus());
  }, [fill?.nonce]);
  // Grows with what you type, up to about 40% of the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [prompt]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  // Pasted or dropped images, sent with the next message.
  const [images, setImages] = useState<PromptImage[]>([]);
  useEffect(() => {
    setImages([]);
    setForkNext(false);
  }, [target]);
  const addImages = (files: File[]) => {
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type as PromptImage['mediaType'])) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        toast(t('run.imageTooBig', { name: file.name || 'image' }));
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result).split(',')[1] ?? '';
        if (data) setImages((list) => (list.length >= 6 ? list : [...list, { mediaType: file.type as PromptImage['mediaType'], data }]));
      };
      reader.readAsDataURL(file);
    }
  };

  // The catalog may be last launch's (instant pills): detect for real once per launch.
  useEffect(() => {
    if (detectStarted) return;
    detectStarted = true;
    void loadCatalog();
  }, [loadCatalog]);
  useEffect(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)), [prefs]);

  // A conversation can only be continued by the CLI that created it.
  const harnessId = session ? session.source : (prefs.harnessId ?? catalog?.harnesses.find((h) => h.installed)?.id ?? 'claude-code');
  const harness = catalog?.harnesses.find((h) => h.id === harnessId);
  // Only providers that can drive the chosen agent (e.g. Gemini models need Gemini CLI).
  const providers = useMemo(() => (catalog?.providers ?? []).filter((p) => p.harnesses.includes(harnessId)), [catalog, harnessId]);
  // A conversation keeps its own model: the one picked for it here, else the one it last used.
  const [sessionPicks, setSessionPicks] = useState(loadSessionPicks);
  const pick = session ? sessionPicks[session.id] : undefined;
  const wantProvider = pick?.providerId ?? prefs.providerId;
  const provider = providers.find((p) => p.id === wantProvider && p.available) ?? providers.find((p) => p.available) ?? providers[0];
  const model =
    provider?.models.find((m) => m.id === pick?.model)?.id ??
    (session && provider ? matchModel(provider.models, session.models.at(-1)) : undefined) ??
    provider?.models.find((m) => m.id === prefs.model)?.id ??
    provider?.models[0]?.id ??
    '';
  const choose = (providerId: string, modelId: string) => {
    if (!session) return setPrefs({ ...prefs, providerId, model: modelId });
    const next = { ...sessionPicks, [session.id]: { providerId, model: modelId } };
    setSessionPicks(next);
    saveSessionPicks(next);
  };
  const permissionMode = prefs.permissionMode ?? 'acceptEdits';
  const busy = run?.status === 'running' || run?.status === 'starting' || run?.status === 'waiting';
  const canContinue = run?.status === 'idle';
  const needsKey = !!provider?.credential && !provider.credential.isSet && !provider.credential.optional;
  const ready = !!harness?.installed && !!provider?.available && !needsKey && !!model && !!project;
  const saveSecret = async () => {
    if (!provider || !secret.trim()) return;
    try {
      await window.alchemist.setProviderCredential(provider.id, secret.trim());
      setSecret('');
      await loadCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    }
  };

  const setCompose = useStore((s) => s.setCompose);
  /** A new conversation that starts with this one's full context; the original stays as it was. */
  const fork = async () => {
    const text = prompt.trim();
    if (!text || !session || !ready || !provider || !project) return;
    setError(null);
    try {
      await startRun(`p:${projectId}`, { cwd: project.cwd, harnessId, providerId: provider.id, model, prompt: text, resumeSessionId: session.id, fork: true, permissionMode, images });
      setPrompt('');
      setForkNext(false);
      if (images.length) setImages([]);
      setCompose(projectId);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    }
  };

  const submit = async (queued?: string) => {
    const text = (queued ?? prompt).trim();
    if (!text) return;
    if (busy && !queued) {
      if (images.length) return toast(t('run.imagesWait'));
      // The agent is working: this goes out as soon as it finishes the current turn.
      setQueue([...queue, text]);
      setPrompt('');
      return;
    }
    setError(null);
    lastPrompt = text;
    try {
      const sent = queued ? [] : images;
      if (run && canContinue) await sendToRun(run.runId, text, sent);
      else {
        if (!ready || !provider || !project) return;
        await startRun(target, {
          cwd: project.cwd,
          harnessId,
          providerId: provider.id,
          model,
          prompt: text,
          resumeSessionId: session?.id ?? run?.sessionId ?? undefined,
          permissionMode,
          images: sent,
        });
      }
      setPrompt('');
      if (sent.length) setImages([]);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    }
  };

  // Send the next queued message when the agent is free again.
  useEffect(() => {
    if (!canContinue || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void submit(next);
  }, [canContinue]);

  // While the agent's process is alive, its model and mode are changed on it directly.
  const configure = useStore((s) => s.configureRun);
  const live = !!run?.config && (busy || canContinue);
  const liveModel = live ? run!.config!.options.find((o) => o.id === 'model' && o.choices.length > 1) : undefined;
  const liveModes = live && run!.config!.modes.length > 0 ? run!.config!.modes : null;
  const modeLabel = (id: string, fallback?: string) =>
    MODES.includes(id as PermissionMode) ? t(`perm.${id as PermissionMode}`) : AGENT_MODE_LABEL[id] ? t(`perm.${AGENT_MODE_LABEL[id]!}`) : (fallback ?? id);
  const currentMode = liveModes ? (run!.config!.mode ?? permissionMode) : permissionMode;
  const labelOf = (m: { id: string; label: string }) => (m.id === 'default' ? t('run.defaultModel') : m.label);
  const found = provider?.models.find((m) => m.id === model);
  const modelName = found ? labelOf(found) : model || (detected ? t('run.noModels') : '…');
  const modelPill = liveModel ? (liveModel.choices.find((c) => c.value === liveModel.value)?.label ?? liveModel.value) : modelName || t('run.noModels');
  const providerName = (p: { id: string; label: string }) => (p.id === 'claude-login' ? t('provider.claudeLogin') : p.label);
  const modelTitle = liveModel ? t('run.modelLive') : provider ? `${t('run.model')} · ${providerName(provider)}` : t('run.model');

  const pickAgent = async () => {
    const items: MenuItem[] = (catalog?.harnesses ?? []).map((h) => ({
      id: `h:${h.id}`,
      label: h.installed ? h.label : `${h.label} · ${t('settings.notInstalled')}`,
      enabled: h.installed,
      checked: h.id === harnessId,
    }));
    items.push({ type: 'separator' }, { id: 'redetect', label: t('run.redetect') }, { id: 'settings', label: `${t('settings.agents')}…` });
    const id = await openMenu(items);
    if (id === 'redetect') void loadCatalog();
    if (id === 'settings') useStore.setState({ settingsOpen: true, settingsSection: 'agents' });
    else if (id?.startsWith('h:')) setPrefs({ ...prefs, harnessId: id.slice(2) });
  };

  const pickModel = async () => {
    if (liveModel && run) {
      const id = await openMenu(liveModel.choices.slice(0, 40).map((c, i) => ({ id: `c:${i}`, label: c.label, checked: c.value === liveModel.value })));
      const choice = id ? liveModel.choices[Number(id.slice(2))] : undefined;
      if (choice) void configure(run.runId, { option: { id: liveModel.id, value: choice.value } }).catch(() => {});
      return;
    }
    // Model ids can hold any character, menu ids can't: items are picked by position.
    const models = (pi: number): MenuItem[] => providers[pi]!.models.slice(0, 40).map((m, mi) => ({ id: `m:${pi}:${mi}`, label: labelOf(m), checked: providers[pi]!.id === provider?.id && m.id === model }));
    const items: MenuItem[] =
      providers.length === 1
        ? [{ id: 'hdr', label: providerName(providers[0]!), enabled: false }, ...models(0)]
        : providers.map((p, pi) => ({ id: `p:${pi}`, label: p.available ? providerName(p) : `${providerName(p)} · ${t('run.offline')}`, enabled: p.available && p.models.length > 0, submenu: models(pi) }));
    items.push({ type: 'separator' }, { id: 'settings', label: `${t('settings.providers')}…` });
    const id = await openMenu(items);
    if (id === 'settings') return useStore.setState({ settingsOpen: true, settingsSection: 'agents' });
    const [kind, pi, mi] = id?.split(':') ?? [];
    const p = providers[Number(pi)];
    const m = p?.models[Number(mi)];
    if (kind === 'm' && p && m) choose(p.id, m.id);
  };

  const pickMode = async () => {
    const options = liveModes ?? MODES.map((m) => ({ id: m, label: t(`perm.${m}`) }));
    const id = await openMenu(options.map((m) => ({ id: `mode:${m.id}`, label: modeLabel(m.id, m.label), checked: m.id === currentMode })));
    if (!id) return;
    const value = id.slice(5);
    if (ALLOW_ALL.has(value) && !allowAllConfirmed) {
      const ok = await confirmAction({ title: t('perm.allowAllTitle'), message: t('perm.allowAllBody'), confirmLabel: t('perm.bypassPermissions'), cancelLabel: t('dialog.cancel'), danger: true });
      if (!ok) return;
      allowAllConfirmed = true;
    }
    if (liveModes && run) void configure(run.runId, { mode: value }).catch(() => {});
    if (MODES.includes(value as PermissionMode)) setPrefs({ ...prefs, permissionMode: value as PermissionMode });
  };

  // @ for files, / (at the start) for commands.
  type Pick = SuggestItem & { insert?: string; run?: () => void };
  const [suggest, setSuggest] = useState<{ kind: '@' | '/'; start: number; end: number; items: Pick[]; index: number } | null>(null);
  const suggestSeq = useRef(0);
  const [diskCommands, setDiskCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    let alive = true;
    void window.alchemist
      .slashCommands(harnessId, project?.cwd ?? null)
      .then((c) => alive && setDiskCommands(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [harnessId, project?.cwd]);
  const appCommands = (): Pick[] =>
    [
      session && { id: 'app:new', label: '/new', detail: t('slash.new'), icon: '⚗', badge: 'Alchemist', run: () => setCompose(projectId) },
      !session && catalog && { id: 'app:agent', label: '/agent', detail: t('slash.agent'), icon: '⚗', badge: 'Alchemist', run: () => void pickAgent() },
      catalog && { id: 'app:model', label: '/model', detail: t('slash.model'), icon: '⚗', badge: 'Alchemist', run: () => void pickModel() },
      { id: 'app:permissions', label: '/permissions', detail: t('slash.permissions'), icon: '⚗', badge: 'Alchemist', run: () => void pickMode() },
    ].filter((x): x is Exclude<typeof x, false | null | undefined> => !!x);
  /** Built-in commands' descriptions in the app's language (the main process sends English). */
  const builtinText = (harness: string, name: string, fallback: string) => {
    const key = `slash.builtin.${harness === 'codex' ? 'codex' : 'claude'}.${name}`;
    const text = t(key as never);
    return text === key ? fallback : text;
  };
  const closeSuggest = () => {
    suggestSeq.current++;
    setSuggest(null);
  };
  const updateSuggest = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at && project) {
      const query = at[2]!;
      const start = caret - query.length - 1;
      const seq = ++suggestSeq.current;
      void window.alchemist
        .searchFiles(project.cwd, query)
        .then((files) => {
          if (seq !== suggestSeq.current) return;
          const items = files.map((f) => ({ id: f, label: f.replace(/\/$/, '').split('/').pop()! + (f.endsWith('/') ? '/' : ''), detail: f, icon: f.endsWith('/') ? '▸' : '▤', insert: `@${f} ` }));
          setSuggest(items.length ? { kind: '@', start, end: caret, items, index: 0 } : null);
        })
        .catch(() => setSuggest(null));
      return;
    }
    const slash = /^\/([\w:.-]*)$/.exec(before);
    if (slash) {
      const q = slash[1]!.toLowerCase();
      const agentCommands = run?.commands?.length ? run.commands : diskCommands;
      const all: Pick[] = [
        ...agentCommands.map((c) => ({
          id: `c:${c.name}`,
          label: `/${c.name}`,
          detail: (c.source === 'builtin' ? builtinText(harnessId, c.name, c.description) : c.description) + (c.hint ? ` · ${c.hint}` : ''),
          icon: c.source === 'skill' || c.source === 'plugin' ? '✦' : '/',
          badge: c.source === 'skill' ? t('slash.skill') : c.source === 'plugin' ? t('slash.plugin') : c.source === 'builtin' ? (harness?.label ?? harnessId) : undefined,
          insert: `/${c.name} `,
        })),
        ...appCommands(),
      ];
      const name = (x: Pick) => x.label.slice(1).toLowerCase();
      const items = [...all.filter((x) => name(x).startsWith(q)), ...all.filter((x) => !name(x).startsWith(q) && name(x).includes(q))].slice(0, 60);
      suggestSeq.current++;
      setSuggest(items.length ? { kind: '/', start: 0, end: caret, items, index: 0 } : null);
      return;
    }
    if (suggest) closeSuggest();
  };
  // Commands that arrive while the list is open (from disk, or announced by the agent) join it.
  useEffect(() => {
    if (prompt.startsWith('/') && !prompt.includes(' ')) updateSuggest(prompt, box.current?.selectionStart ?? prompt.length);
  }, [diskCommands, run?.commands]);
  const acceptSuggest = (i: number) => {
    const s = suggest;
    const item = s?.items[i];
    if (!s || !item) return;
    closeSuggest();
    const rest = prompt.slice(0, s.start) + prompt.slice(s.end);
    if (item.run) {
      setPrompt(rest);
      item.run();
      return;
    }
    const next = prompt.slice(0, s.start) + (item.insert ?? '') + prompt.slice(s.end);
    setPrompt(next);
    const caret = s.start + (item.insert ?? '').length;
    requestAnimationFrame(() => box.current?.setSelectionRange(caret, caret));
  };

  // --compose-text (screenshots): type it and show what it suggests.
  const captureText = info?.capture?.composeText;
  useEffect(() => {
    if (!captureText || session || !catalog) return;
    setPrompt(captureText);
    updateSuggest(captureText, captureText.length);
    setTimeout(() => useStore.getState().markCaptureReady(), 1200);
  }, [captureText, !!catalog]);

  const sendKey = localStorage.getItem(SEND_KEY) === 'mod-enter' ? 'mod-enter' : 'enter';
  const canFork = !!session && !!prompt.trim() && ready;
  const sendMenu = async () => {
    const id = await openMenu([
      { id: 'send', label: t('run.send'), accelerator: sendKey === 'enter' ? 'Enter' : 'CmdOrCtrl+Enter' },
      { id: 'fork', label: t('run.forkLong'), accelerator: 'CmdOrCtrl+Shift+Enter', enabled: canFork },
    ]);
    if (id === 'send') void submit();
    if (id === 'fork') void fork();
  };
  const noLocalModel = detected && catalog && !providers.some((p) => p.available && p.models.length > 0);
  return (
    <div className="composer">
      {run && (busy || run.errors.length > 0 || run.notices.length > 0 || run.config || run.usage) && <LiveRun run={run} compact />}
      {detected && catalog && !harness?.installed && <p className="composer-hint">{t('run.noHarness', { name: harness?.label ?? harnessId })}</p>}
      {fillPct >= 80 && session?.source === 'claude-code' && (
        <p className="composer-hint">
          {t('context.full', { pct: fillPct })}{' '}
          <button className="link small" onClick={() => (setPrompt('/compact'), box.current?.focus())}>
            /compact
          </button>
        </p>
      )}
      {noLocalModel && (
        <p className="composer-hint">
          {t('run.noModel')} <code>ollama pull qwen2.5-coder:7b</code>
        </p>
      )}
      {needsKey && provider?.credential && (
        <div className="credential">
          <span>🔒 {provider.credential.label}</span>
          <input type="password" value={secret} placeholder={provider.credential.placeholder ?? ''} onChange={(e) => setSecret(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void saveSecret()} />
          <button className="btn-send" disabled={!secret.trim()} onClick={() => void saveSecret()}>
            {t('run.saveKey')}
          </button>
          <small>{t('run.keyHint')}</small>
        </div>
      )}
      {queue.length > 0 && (
        <div className="queue">
          <span className="queue-label">{t('run.queued')}</span>
          {queue.map((q, i) => (
            <span key={i} className="queue-chip" title={t('run.editQueued')}>
              {/* Click to edit it again in the input. */}
              <span
                className="queue-text"
                onClick={() => {
                  setQueue(queue.filter((_, j) => j !== i));
                  setPrompt(q);
                  box.current?.focus();
                }}
              >
                {q.length > 60 ? `${q.slice(0, 60)}…` : q}
              </span>
              <button onClick={() => setQueue(queue.filter((_, j) => j !== i))} title={t('run.unqueue')}>
                ×
              </button>
            </span>
          ))}
          {/* After an error or a stop the agent won't free up on its own: let the user send it. */}
          {!busy && (
            <button
              className="btn-ghost small"
              onClick={() => {
                const [next, ...rest] = queue;
                setQueue(rest);
                if (next) void submit(next);
              }}
            >
              {t('run.sendNow')}
            </button>
          )}
        </div>
      )}
      <div
        className="composer-box"
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
          if (!files.length) return;
          e.preventDefault();
          addImages(files);
        }}
      >
        {forkNext && (
          <div className="fork-note">
            ⑂ {t('run.forkNote')}
            <button className="link small" onClick={() => setForkNext(false)}>
              {t('run.forkCancel')}
            </button>
          </div>
        )}
        {images.length > 0 && (
          <div className="attachments">
            {images.map((img, i) => (
              <span key={i} className="attachment">
                <img src={`data:${img.mediaType};base64,${img.data}`} alt="" />
                <button onClick={() => setImages(images.filter((_, j) => j !== i))} title={t('run.removeImage')} aria-label={t('run.removeImage')}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {suggest && (
          <Suggest
            items={suggest.items}
            index={suggest.index}
            title={suggest.kind === '@' ? t('slash.files') : t('slash.commands')}
            onPick={acceptSuggest}
            onHover={(index) => setSuggest({ ...suggest, index })}
          />
        )}
        <textarea
          ref={box}
          value={prompt}
          placeholder={session ? t('run.placeholderContinue') : t('run.placeholderNew', { project: project?.name ?? '' })}
          onChange={(e) => {
            setPrompt(e.target.value);
            updateSuggest(e.target.value, e.target.selectionStart);
          }}
          onBlur={() => suggest && closeSuggest()}
          onPaste={(e) => {
            const files = [...e.clipboardData.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f);
            if (!files.length) return;
            e.preventDefault();
            addImages(files);
          }}
          aria-autocomplete="list"
          onKeyDown={(e) => {
            // Never send in the middle of composing an accented character or IME input.
            if (e.nativeEvent.isComposing) return;
            if (suggest) {
              const n = suggest.items.length;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setSuggest({ ...suggest, index: (suggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
                return;
              }
              if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
                e.preventDefault();
                acceptSuggest(suggest.index);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                closeSuggest();
                return;
              }
            }
            const mod = e.metaKey || e.ctrlKey;
            if (e.key === 'Enter' && mod && e.shiftKey) {
              e.preventDefault();
              if (canFork) void fork();
              return;
            }
            if (e.key === 'Enter' && (sendKey === 'enter' ? !e.shiftKey && !e.altKey : mod)) {
              e.preventDefault();
              if (forkNext && canFork) void fork();
              else void submit();
            }
            if (e.key === 'ArrowUp' && !prompt && lastPrompt) {
              e.preventDefault();
              setPrompt(lastPrompt);
            }
            if (e.key === 'Escape' && busy && run?.config) void interruptRun(run.runId);
          }}
          rows={2}
        />
        <div className="composer-bar">
          {!catalog ? (
            <>
              {!session && <Pill label="…" title={t('run.agent')} disabled />}
              <Pill label="…" title={t('run.model')} disabled />
            </>
          ) : (
            <>
              {!session && <Pill icon={sourceOf(harnessId).glyph} label={harness?.label ?? harnessId} title={t('run.agent')} onClick={() => void pickAgent()} />}
              <Pill label={modelPill} title={modelTitle} disabled={!liveModel && !providers.length} onClick={() => void pickModel()} />
            </>
          )}
          <Pill
            icon={MODE_ICON[currentMode] ?? '✋'}
            label={modeLabel(currentMode, liveModes?.find((m) => m.id === currentMode)?.label)}
            title={t('run.permissions')}
            danger={ALLOW_ALL.has(currentMode)}
            onClick={() => void pickMode()}
          />
          <span className="composer-sp" />
          {busy && run?.config && (
            <button className="btn-ghost" onClick={() => void interruptRun(run.runId)} title="Esc">
              ⏸ {t('run.interrupt')}
            </button>
          )}
          {busy ? (
            <>
              {prompt.trim() && (
                <button className="btn-ghost" onClick={() => void submit()} title={t('run.queueHint')}>
                  ⏎ {t('run.queue')}
                </button>
              )}
              <button className="btn-stop" onClick={() => run && void stopRun(run.runId)}>
                ■ {t('run.stop')}
              </button>
            </>
          ) : (
            <>
              <span className={`split-send ${session ? 'has-more' : ''}`}>
                {forkNext ? (
                  <button className="btn-send" disabled={!canFork} onClick={() => void fork()} title={t('run.forkHint')}>
                    ⑂ {t('run.fork')} {sendKey === 'enter' ? '↵' : keys('⌘↵')}
                  </button>
                ) : (
                  <button className="btn-send" disabled={!prompt.trim() || (!canContinue && !ready)} onClick={() => void submit()}>
                    {t('run.send')} {sendKey === 'enter' ? '↵' : keys('⌘↵')}
                  </button>
                )}
                {session && (
                  <button className="btn-send more" disabled={!prompt.trim()} onClick={() => void sendMenu()} title={t('run.moreSend')} aria-label={t('run.moreSend')}>
                    ▾
                  </button>
                )}
              </span>
            </>
          )}
        </div>
      </div>
      {error && <div className="live-error">{error}</div>}
      {/* Only when nothing can run: the upsell note isn't useful next to a working provider. */}
      {!catalog && <p className="composer-note">{t('run.detecting')}</p>}
      {detected && catalog && info?.edition !== 'pro' && !provider?.available && <p className="composer-note">{t('run.localOnly')}</p>}
    </div>
  );
}
