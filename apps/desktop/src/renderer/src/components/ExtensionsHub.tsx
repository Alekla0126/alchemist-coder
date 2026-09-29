import { useEffect, useState } from 'react';
import type { HubAgent, HubInstallPlan, HubInventory, HubMcp, HubVia } from '@shared/api';
import { useStore, useT } from '../store';
import { confirmAction } from '../ui';

const AGENTS: Array<[HubAgent, string, string, string]> = [
  ['claude-code', 'C', 'claude', 'Claude Code'],
  ['codex', 'O', 'openai', 'Codex'],
  ['gemini', 'G', 'gemini', 'Gemini CLI'],
  ['grok', 'X', 'grok', 'Grok Build'],
];
const SKILLS_SHOWN = 12;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** C · O · G · X: filled = the agent's own config, outlined = imported (Grok reads Claude's), dim = missing. */
function Badges({ agents, installed }: { agents: Partial<Record<HubAgent, HubVia>>; installed: Record<HubAgent, boolean> }) {
  const t = useT();
  return (
    <span className="hub-badges">
      {AGENTS.map(([id, letter, cls, label]) => {
        const via = agents[id];
        const title = `${label}: ${via === 'own' ? t('hub.own') : via === 'compat' ? t('hub.compat') : t('hub.missing')}${installed[id] ? '' : ` · ${t('hub.notInstalled')}`}`;
        return (
          <i key={id} className={`hb ${cls} ${via ?? 'off'}`} title={title}>
            {letter}
          </i>
        );
      })}
    </span>
  );
}

function McpRow({ server, inv, cwd, reload }: { server: HubMcp; inv: HubInventory; cwd: string | null; reload: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<HubInstallPlan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ agent: HubAgent; ok: boolean; message: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const missing = AGENTS.filter(([id]) => !server.agents[id]).length;
  const label = (id: HubAgent) => AGENTS.find(([a]) => a === id)?.[3] ?? id;

  const preparePlan = async () => {
    setError(null);
    setResults(null);
    try {
      setPlan(await window.alchemist.hubPlanInstall(server.id, cwd));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const install = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      setResults(await window.alchemist.hubInstall(server.id, plan.filter((p) => p.description).map((p) => p.agent), cwd));
      setPlan(null);
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hub-item">
      <div className="hub-row" onClick={() => setOpen(!open)}>
        <span className="car">{open ? '▾' : '▸'}</span>
        <span className="hub-name">{server.name}</span>
        <span className="hub-kind">{server.transport}</span>
        {server.conflict && (
          <span className="hub-conflict" title={t('hub.conflictHint')}>
            ⚠
          </span>
        )}
        <Badges agents={server.agents} installed={inv.installed} />
      </div>
      {open && (
        <div className="hub-detail">
          <code className="hub-cmd">{server.command ? [server.command, ...server.args].join(' ') : server.url}</code>
          {server.envKeys.length > 0 && (
            <div>
              {t('hub.env')}: {server.envKeys.map((k) => <code key={k}>{k}</code>)}
            </div>
          )}
          {server.headerKeys.length > 0 && (
            <div>
              {t('hub.headers')}: {server.headerKeys.map((k) => <code key={k}>{k}</code>)}
            </div>
          )}
          <div className="hub-sources">
            {server.sources.map((s, i) => (
              <div key={i} title={s.file}>
                {label(s.agent)} · {t(`hub.scope.${s.scope}`)} · <span className="hub-file">{s.file.replace(/^\/Users\/[^/]+/, '~')}</span>
              </div>
            ))}
          </div>
          {missing > 0 && !plan && (
            <button className="btn-ghost small" onClick={() => void preparePlan()}>
              ⇄ {t('hub.useEverywhere', { n: missing })}
            </button>
          )}
          {plan && (
            <div className="hub-plan">
              <div className="field-label">{t('hub.planTitle')}</div>
              {plan[0]?.warnings.map((w) => (
                <div key={w} className="hub-warning">
                  ⚠ {t(`hub.warn.${w}`)}
                </div>
              ))}
              {plan.map((p) => (
                <div key={p.agent} className={`hub-step ${p.description ? '' : 'skip'}`}>
                  <b>{label(p.agent)}</b> {p.description ? <code>{p.description}</code> : <span>{p.reason}</span>}
                </div>
              ))}
              <p className="composer-note">{t('hub.planNote')}</p>
              <div className="arena-actions">
                <button className="btn-send" disabled={busy || !plan.some((p) => p.description)} onClick={() => void install()}>
                  {t('hub.confirm')}
                </button>
                <button className="btn-ghost small" onClick={() => setPlan(null)}>
                  {t('hub.cancel')}
                </button>
              </div>
            </div>
          )}
          {results?.map((r) => (
            <div key={r.agent} className={r.ok ? 'hub-ok' : 'live-error'}>
              {r.ok ? '✓' : '✕'} {label(r.agent)} {r.ok ? '' : `· ${r.message}`}
            </div>
          ))}
          {error && <div className="live-error">{error}</div>}
        </div>
      )}
    </div>
  );
}

/** One view of every agent's MCP servers, skills, hooks and project instructions. */
export function ExtensionsHub() {
  const t = useT();
  const project = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId));
  const cwd = project?.cwd ?? null;
  const [inv, setInv] = useState<HubInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allSkills, setAllSkills] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => {
    setError(null);
    window.alchemist
      .hubInventory(cwd)
      .then(setInv)
      .catch((e: unknown) => setError(errorText(e)));
  };
  useEffect(load, [cwd]);

  const unify = async () => {
    if (!cwd || !(await confirmAction({ title: t('hub.unify'), message: t('hub.unifyConfirm'), confirmLabel: t('hub.unify'), cancelLabel: t('dialog.cancel') }))) return;
    try {
      const r = await window.alchemist.hubUnify(cwd);
      setNotice(t('hub.unified', { files: [...r.created, ...r.changed].join(', ') || '—' }));
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!inv) return <div className="hub">{error ? <div className="live-error">{error}</div> : <span className="spin" />}</div>;
  const skills = allSkills ? inv.skills : inv.skills.slice(0, SKILLS_SHOWN);
  return (
    <div className="hub">
      <div className="hub-legend">
        {AGENTS.map(([id, letter, cls, label]) => (
          <span key={id} className={inv.installed[id] ? '' : 'dim'} title={inv.installed[id] ? label : `${label} · ${t('hub.notInstalled')}`}>
            <i className={`hb ${cls} own`}>{letter}</i> {label}
          </span>
        ))}
        <button className="icon-btn" onClick={load} title={t('files.refresh')}>
          ↻
        </button>
      </div>
      {inv.grokCompat.mcps && <p className="hub-note">{t('hub.grokCompat')}</p>}

      <div className="sec">
        {t('hub.mcp')} · {inv.mcp.length}
      </div>
      {inv.mcp.length === 0 && <p className="empty">{t('hub.noMcp')}</p>}
      {inv.mcp.map((s) => (
        <McpRow key={s.id} server={s} inv={inv} cwd={cwd} reload={load} />
      ))}

      <div className="sec">
        {t('hub.skills')} · {inv.skills.length}
      </div>
      {skills.map((s) => (
        <div key={s.name} className="hub-row flat" title={s.description}>
          <span className="hub-name">{s.name}</span>
          <Badges agents={s.agents} installed={inv.installed} />
        </div>
      ))}
      {inv.skills.length > SKILLS_SHOWN && (
        <button className="load-more" onClick={() => setAllSkills(!allSkills)}>
          {allSkills ? t('hub.fewer') : t('hub.all', { n: inv.skills.length })}
        </button>
      )}

      <div className="sec">
        {t('hub.hooks')} · {inv.hooks.length}
      </div>
      {inv.hooks.length === 0 && <p className="empty">{t('hub.noHooks')}</p>}
      {inv.hooks.map((h, i) => (
        <div key={i} className="hub-row flat" title={h.command}>
          <span className="hub-name">
            {h.event}
            {h.matcher ? ` · ${h.matcher}` : ''}
          </span>
          <Badges agents={h.agents} installed={inv.installed} />
        </div>
      ))}

      {inv.instructions && (
        <>
          <div className="sec">{t('hub.instructions')}</div>
          <div className="hub-instructions">
            {inv.instructions.files
              .filter((f) => f.exists || ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(f.name))
              .map((f) => (
                <div key={f.name} className={`hub-file-row ${f.exists ? '' : 'missing'}`}>
                  <span>{f.exists ? '●' : '○'}</span> {f.name}
                  {f.importsAgents && <span className="hub-kind">@AGENTS.md</span>}
                </div>
              ))}
            <div className="hub-readby">
              {AGENTS.map(([id, letter, cls, label]) => {
                const files = inv.instructions!.readBy[id];
                return (
                  <div key={id}>
                    <i className={`hb ${cls} ${files.length ? 'own' : 'off'}`}>{letter}</i> {label}: {files.length ? files.join(', ') : t('hub.none')}
                  </div>
                );
              })}
            </div>
            {inv.instructions.unified ? (
              <p className="hub-ok">✓ {t('hub.isUnified')}</p>
            ) : (
              <button className="btn-ghost small" onClick={() => void unify()}>
                ⇄ {t('hub.unify')}
              </button>
            )}
            {notice && <p className="hub-ok">{notice}</p>}
          </div>
        </>
      )}
      {error && <div className="live-error">{error}</div>}
    </div>
  );
}
