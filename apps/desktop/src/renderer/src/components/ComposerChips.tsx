import type { AgentOption } from '@alchemist-coder/core';
import type { MenuItem } from '@shared/api';
import { shortTokens } from '../format';
import { useStore, useT } from '../store';
import { openMenu, toast } from '../ui';
import { Icon, type IconName } from './Icon';

type T = ReturnType<typeof useT>;

/** A composer setting as a chip (Nimbalyst's look): an icon, what's chosen, and a menu to change it. */
export function Chip({
  icon,
  glyph,
  label,
  title,
  disabled,
  fixed,
  tone,
  className,
  onClick,
}: {
  icon?: IconName;
  glyph?: string;
  label: string;
  title: string;
  disabled?: boolean;
  /** Shown but not changeable (no menu). */
  fixed?: boolean;
  tone?: 'danger' | 'warn';
  className?: string;
  onClick?: () => void;
}) {
  return (
    <button
      className={`cchip ${tone ?? ''} ${fixed ? 'fixed' : ''} ${className ?? ''}`}
      disabled={disabled}
      // A fixed chip still takes the focus, so its explanation can be read.
      aria-disabled={fixed || undefined}
      title={title}
      aria-label={`${title}: ${label}`}
      aria-haspopup={fixed ? undefined : 'menu'}
      onClick={fixed ? undefined : onClick}
    >
      {icon && <Icon name={icon} size={13} />}
      {glyph && <span className="cchip-glyph">{glyph}</span>}
      <span className="cchip-label">{label}</span>
      {!fixed && <Icon name="chevronDown" size={12} className="cchip-caret" />}
    </button>
  );
}

/** AGENT or PLAN, one click to switch (plan: the agent explores and proposes, and changes nothing). */
export function ModeTag({ plan, onToggle, disabled }: { plan: boolean; onToggle: () => void; disabled?: boolean }) {
  const t = useT();
  return (
    <button className={`mode-tag ${plan ? 'plan' : 'agent'}`} onClick={onToggle} disabled={disabled} aria-label={plan ? t('chip.planTip') : t('chip.agentTip')} title={plan ? t('chip.planTip') : t('chip.agentTip')}>
      {plan ? t('chip.plan') : t('chip.agent')}
    </button>
  );
}

/** How full the context is: a ring, the tokens and the share; amber past 80%, red past 90%. */
export function ContextChip({ used, size, onCompact }: { used: number; size: number | null; onCompact?: () => void }) {
  const t = useT();
  const pct = size ? Math.min(100, Math.round((used / size) * 100)) : null;
  const tone = pct == null ? '' : pct >= 90 ? 'critical' : pct >= 80 ? 'warn' : '';
  const tokens = size ? `${shortTokens(used)}/${shortTokens(size)}` : shortTokens(used);
  const detail = size ? t('context.of', { used: shortTokens(used), size: shortTokens(size), pct: pct! }) : t('context.tokens', { used: shortTokens(used) });
  const menu = async () => {
    const items: MenuItem[] = [{ id: 'info', label: detail, enabled: false }];
    if (pct != null && pct >= 50) items.push({ id: 'hint', label: t('chip.contextHint'), enabled: false });
    if (onCompact) items.push({ type: 'separator' }, { id: 'compact', label: t('chip.compact') });
    if ((await openMenu(items)) === 'compact') onCompact?.();
  };
  return (
    <button className={`cchip ctx-chip ${tone}`} onClick={() => void menu()} title={detail} aria-label={detail} aria-haspopup="menu">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden className="ctx-ring">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2.2" />
        {pct != null && <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray={`${(pct / 100) * 37.7} 37.7`} strokeLinecap="round" transform="rotate(-90 8 8)" />}
      </svg>
      <span className="ctx-tokens">{tokens}</span>
      {pct != null && <span className="ctx-pct">{`${pct}%`}</span>}
    </button>
  );
}

// ---------- reasoning effort ----------

const EFFORT_KEY = 'alchemist.effortChoices';
type EffortChoices = Array<{ value: string; label: string }>;

/** The live session's effort option (ACP "thought_level"), when the agent has one. */
export const effortOptionOf = (options: AgentOption[] | undefined) => options?.find((o) => o.category === 'thought_level') ?? options?.find((o) => o.id === 'effort' || o.id === 'reasoning_effort');

/** Levels seen on a real session, kept per agent and model so the chip can show before the next one starts. */
export function cachedEffort(harnessId: string, model: string): EffortChoices | null {
  try {
    const all = JSON.parse(localStorage.getItem(EFFORT_KEY) ?? '{}') as Record<string, EffortChoices>;
    return all[`${harnessId}|${model}`] ?? null;
  } catch {
    return null;
  }
}

export function rememberEffort(harnessId: string, model: string, choices: EffortChoices) {
  try {
    const all = JSON.parse(localStorage.getItem(EFFORT_KEY) ?? '{}') as Record<string, EffortChoices>;
    const key = `${harnessId}|${model}`;
    if (JSON.stringify(all[key]) === JSON.stringify(choices)) return;
    all[key] = choices.slice(0, 12);
    const entries = Object.entries(all).slice(-60);
    localStorage.setItem(EFFORT_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // no storage
  }
}

/**
 * The levels to offer before a session has said which it takes (Nimbalyst keeps a table too):
 * Claude's larger models go up to max, Sonnet and the CLI default to high, Codex models to high.
 * Haiku has none. A level the model turns out not to take is skipped, and the agent says so.
 */
export function effortTable(harnessId: string, model: string): EffortChoices | null {
  const m = model.toLowerCase();
  const levels =
    harnessId === 'claude-code'
      ? /haiku/.test(m)
        ? null
        : /opus|fable/.test(m)
          ? ['low', 'medium', 'high', 'xhigh', 'max']
          : ['low', 'medium', 'high']
      : harnessId === 'codex'
        ? ['low', 'medium', 'high']
        : null;
  return levels ? [{ value: 'default', label: 'Default' }, ...levels.map((value) => ({ value, label: value }))] : null;
}

/** "high" → "Alto", in the app's language; unknown levels keep the agent's own name. */
export function effortLabel(t: T, value: string, fallback?: string) {
  const key = `effort.${value}`;
  const text = t(key as never);
  return text === key ? (fallback ?? value) : text;
}

// ---------- action prompts ----------

const BUILTIN = ['review', 'tests', 'explain', 'bugs', 'commit'] as const;

/**
 * ⚡ Actions: ready-made prompts to drop into the message box. The app's own, then the project's
 * ai-actions.md (the file Nimbalyst reads too), and a way to create or edit that file.
 */
export async function pickAction(t: T, cwd: string, projectId: number, insert: (text: string) => void) {
  const file = await window.alchemist.actionsList(cwd).catch(() => ({ exists: false, path: '', actions: [] }));
  const items: MenuItem[] = [
    { id: 'h:app', label: t('chip.actionsApp'), enabled: false },
    ...BUILTIN.map((k) => ({ id: `b:${k}`, label: t(`action.${k}` as never) })),
  ];
  if (file.actions.length) items.push({ type: 'separator' }, { id: 'h:file', label: 'ai-actions.md', enabled: false }, ...file.actions.map((a, i) => ({ id: `f:${i}`, label: a.label })));
  items.push({ type: 'separator' }, { id: 'edit', label: file.exists ? t('chip.actionsEdit') : t('chip.actionsCreate') });
  const id = await openMenu(items);
  if (!id) return;
  if (id.startsWith('b:')) return insert(t(`action.${id.slice(2)}.prompt` as never));
  if (id.startsWith('f:')) return insert(file.actions[Number(id.slice(2))]!.body);
  if (id === 'edit') {
    try {
      const path = await window.alchemist.actionsCreate(cwd, t('chip.actionsExample'));
      useStore.getState().openFileAt(projectId, path);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }
}
