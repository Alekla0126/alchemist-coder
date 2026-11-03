import type { AgentChoice, RunnerCatalog } from '@shared/api';
import { useStore, useT } from '../store';

/** What the composer last used (it stores its picks in localStorage). */
function lastUsed(): AgentChoice | null {
  try {
    const p = JSON.parse(localStorage.getItem('alchemist.composer') ?? '{}') as Partial<AgentChoice>;
    return p.harnessId && p.providerId && p.model ? { harnessId: p.harnessId, providerId: p.providerId, model: p.model } : null;
  } catch {
    return null;
  }
}

/** The composer's last pick if it can run, else the first installed agent with a usable provider. */
export function defaultChoice(catalog: RunnerCatalog | null, skip: AgentChoice[] = []): AgentChoice | null {
  if (!catalog) return null;
  const last = lastUsed();
  if (last && isRunnable(catalog, last) && !skip.some((s) => s.harnessId === last.harnessId && s.providerId === last.providerId)) return last;
  const options: AgentChoice[] = [];
  for (const h of catalog.harnesses.filter((x) => x.installed)) {
    for (const p of catalog.providers.filter((x) => x.available && x.harnesses.includes(h.id))) {
      const m = p.models[0];
      if (m && (!p.credential || p.credential.isSet || p.credential.optional)) options.push({ harnessId: h.id, providerId: p.id, model: m.id });
    }
  }
  // Prefer an agent not picked yet, so "add agent" builds a real comparison.
  return options.find((o) => !skip.some((s) => s.harnessId === o.harnessId && s.providerId === o.providerId)) ?? options[0] ?? null;
}

/** Agent CLI → provider → model, filtered to combinations that can actually run. */
export function AgentPicker({ value, onChange, onRemove, showEffort = false }: { value: AgentChoice; onChange: (c: AgentChoice) => void; onRemove?: () => void; showEffort?: boolean }) {
  const t = useT();
  const catalog = useStore((s) => s.catalog);
  const harnesses = catalog?.harnesses ?? [];
  const providers = (catalog?.providers ?? []).filter((p) => p.harnesses.includes(value.harnessId));
  const provider = providers.find((p) => p.id === value.providerId);
  const model = provider?.models.find((m) => m.id === value.model);
  const efforts = model?.reasoningEfforts;
  const needsKey = !!provider?.credential && !provider.credential.isSet && !provider.credential.optional;
  const setHarness = (harnessId: string) => {
    const p = (catalog?.providers ?? []).find((x) => x.available && x.harnesses.includes(harnessId));
    onChange({ harnessId, providerId: p?.id ?? '', model: p?.models[0]?.id ?? '' });
  };
  const setProvider = (providerId: string) => {
    const p = providers.find((x) => x.id === providerId);
    onChange({ harnessId: value.harnessId, providerId, model: p?.models[0]?.id ?? '' });
  };
  return (
    <div className="agent-picker">
      <select aria-label={t('run.agent')} value={value.harnessId} onChange={(e) => setHarness(e.target.value)} title={t('run.agent')}>
        {harnesses.map((h) => (
          <option key={h.id} value={h.id} disabled={!h.installed}>
            {h.label}
          </option>
        ))}
      </select>
      <select aria-label={t('run.provider')} value={value.providerId} onChange={(e) => setProvider(e.target.value)} title={t('run.provider')}>
        {providers.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.available}>
            {p.id === 'claude-login' ? t('provider.claudeLogin') : p.label}
            {p.available ? '' : ` · ${t('run.offline')}`}
          </option>
        ))}
        {!providers.length && <option value="">{t('run.noModels')}</option>}
      </select>
      <select aria-label={t('run.model')} value={value.model} onChange={(e) => onChange({ harnessId: value.harnessId, providerId: value.providerId, model: e.target.value, ...(showEffort && value.harnessId === 'codex' ? { effort: provider?.models.find((m) => m.id === e.target.value)?.defaultReasoningEffort } : {}) })} title={t('run.model')}>
        {!model && value.model && <option value={value.model} disabled>{value.model} · {t('org.codex.unavailable')}</option>}
        {(provider?.models ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.id === 'default' ? t('run.defaultModel') : m.label}
          </option>
        ))}
        {!provider?.models.length && <option value="">{t('run.noModels')}</option>}
      </select>
      {showEffort && value.harnessId === 'codex' && <label className="org-codex-effort">
        <span>{t('chip.effort')}</span>
        <select aria-label={t('chip.effort')} value={value.effort ?? ''} disabled={!efforts?.length} onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}>
          <option value="">{t('org.codex.inheritEffort')}</option>
          {value.effort && !efforts?.some((e) => e.id === value.effort) && <option value={value.effort} disabled>{value.effort} · {t('org.codex.unavailable')}</option>}
          {efforts?.map((e) => <option key={e.id} value={e.id}>{e.id}</option>)}
        </select>
      </label>}
      {needsKey && <span className="picker-warn">🔒 {t('arena.needsKey')}</span>}
      {onRemove && (
        <button className="icon-btn" onClick={onRemove} title={t('arena.removeAgent')}>
          ×
        </button>
      )}
    </div>
  );
}

export function isRunnable(catalog: RunnerCatalog | null, c: AgentChoice): boolean {
  const h = catalog?.harnesses.find((x) => x.id === c.harnessId);
  const p = catalog?.providers.find((x) => x.id === c.providerId);
  return !!h?.installed && !!p?.available && p.harnesses.includes(c.harnessId) && !!c.model && (c.harnessId !== 'codex' || c.providerId !== 'openai' || p.models.some((m) => m.id === c.model && (!c.effort || m.reasoningEfforts?.some((e) => e.id === c.effort)))) && (!p.credential || p.credential.isSet || p.credential.optional);
}
