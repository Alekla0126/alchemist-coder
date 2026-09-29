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
export function AgentPicker({ value, onChange, onRemove }: { value: AgentChoice; onChange: (c: AgentChoice) => void; onRemove?: () => void }) {
  const t = useT();
  const catalog = useStore((s) => s.catalog);
  const harnesses = catalog?.harnesses ?? [];
  const providers = (catalog?.providers ?? []).filter((p) => p.harnesses.includes(value.harnessId));
  const provider = providers.find((p) => p.id === value.providerId);
  const needsKey = !!provider?.credential && !provider.credential.isSet && !provider.credential.optional;
  const setHarness = (harnessId: string) => {
    const p = (catalog?.providers ?? []).find((x) => x.available && x.harnesses.includes(harnessId));
    onChange({ harnessId, providerId: p?.id ?? '', model: p?.models[0]?.id ?? '' });
  };
  const setProvider = (providerId: string) => {
    const p = providers.find((x) => x.id === providerId);
    onChange({ ...value, providerId, model: p?.models[0]?.id ?? '' });
  };
  return (
    <div className="agent-picker">
      <select value={value.harnessId} onChange={(e) => setHarness(e.target.value)} title={t('run.agent')}>
        {harnesses.map((h) => (
          <option key={h.id} value={h.id} disabled={!h.installed}>
            {h.label}
          </option>
        ))}
      </select>
      <select value={value.providerId} onChange={(e) => setProvider(e.target.value)} title={t('run.provider')}>
        {providers.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.available}>
            {p.id === 'claude-login' ? t('provider.claudeLogin') : p.label}
            {p.available ? '' : ` · ${t('run.offline')}`}
          </option>
        ))}
        {!providers.length && <option value="">{t('run.noModels')}</option>}
      </select>
      <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} title={t('run.model')}>
        {(provider?.models ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.id === 'default' ? t('run.defaultModel') : m.label}
          </option>
        ))}
        {!provider?.models.length && <option value="">{t('run.noModels')}</option>}
      </select>
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
  return !!h?.installed && !!p?.available && p.harnesses.includes(c.harnessId) && !!c.model && (!p.credential || p.credential.isSet || p.credential.optional);
}
