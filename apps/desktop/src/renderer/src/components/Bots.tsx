import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TranscriptEntry } from '@alchemist-coder/core';
import type { BotMember, BotStatus, BotTeam, PlannedBot, TeamEvent } from '@shared/api';
import { clockTime, money, modelLabel as rawModelLabel } from '../format';
import { sourceOf } from '../sources';
import { useStore, useT } from '../store';
import { confirmAction, contextMenu, openMenu, promptText, toast } from '../ui';
import { LiveTurns } from './LiveTurns';
import { Markdown } from './Markdown';
import { TranscriptEntries } from './Transcript';
import { CommitDialog } from './CommitDialog';
import { Icon } from './Icon';
import { AgentAvatar } from './AgentAvatar';
import { parsePatch } from '../diff';
import { relativePath, tailOf } from '../paths';
import { ACTIVE, botState, needsYou, teamActive, teamCost, teamState, type TeamState } from '../org-model';
import { showOnChart } from '../actions/org';

export { ACTIVE, botState, needsYou, teamActive, teamCost, teamState, type TeamState };

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const STATUS_ICON: Record<BotStatus, string> = { starting: '○', working: '◐', waiting: '!', idle: '✓', done: '✓', error: '✕', stopped: '■' };
type T = ReturnType<typeof useT>;

/** What a bot is doing now, in words: the app's own tools come as "@tool:target". */
export function doingText(doing: string, t: T): { text: string; words: boolean } {
  const m = /^@(\w+):(.*)$/.exec(doing);
  if (!m) return { text: doing, words: false };
  const key = `bots.doing.${m[1]}`;
  const text = t(key as never, { name: m[2] || '…' });
  return { text: text === key ? m[1]! : text, words: true };
}

/** Asks before deleting a team, saying which bots' work in their own copy was never applied. */
export async function confirmDeleteTeam(team: BotTeam, t: T): Promise<boolean> {
  const copies = team.bots.filter((b) => b.worktree);
  const unapplied: string[] = [];
  for (const b of copies) {
    const n = await window.alchemist.botChanges(team.id, b.id).then((c) => c.length).catch(() => 0);
    if (n > 0) unapplied.push(t('bots.unappliedLine', { name: b.name, n }));
  }
  const message = [team.title || team.goal.slice(0, 200), unapplied.length ? t('bots.deleteUnapplied', { list: unapplied.join(', ') }) : '', copies.length ? t('bots.deleteKeepsBranches') : ''].filter(Boolean).join('\n\n');
  return confirmAction({ title: t('bots.deleteTeamTitle'), message, confirmLabel: unapplied.length ? t('bots.deleteAnyway') : t('bots.deleteTeam'), cancelLabel: t('dialog.cancel'), danger: true });
}

/** "default" is the CLI's own setting: say so in the app's language. */
const modelNamer = (t: ReturnType<typeof useT>) => (model: string) => (model === 'default' ? t('run.defaultModel') : rawModelLabel(model));

/** A goal to start the next new assignment with ("New assignment with this goal"). */
export function setDraftGoal(goal: string) {
  useStore.setState({ orgGoal: goal });
}

function BotRow({ bot, selected, onSelect, team }: { bot: BotMember; selected: boolean; onSelect: () => void; team: BotTeam }) {
  const t = useT();
  const config = useStore((s) => s.botConfigs.find((c) => c.id === bot.configId));
  const running = ACTIVE.includes(bot.status);
  // Who created it is what the indent shows; the badge names its configuration, if any.
  const badge = bot.depth === 0 ? (/^(coordinator|coordinador)$/i.test(bot.name) ? null : t('bots.leadBadge')) : config && config.name.toLowerCase() !== bot.name.trim().toLowerCase() ? config.name : null;
  const state = botState(team, bot);
  const doing = bot.doing ? doingText(bot.doing, t) : null;
  return (
    <div
      className={`row bot-row ${selected ? 'sel' : ''} st-${state}`}
      style={{ paddingLeft: 10 + bot.depth * 16 }}
      onClick={onSelect}
      onContextMenu={contextMenu(
        () => [{ id: 'stop', label: t('bots.stopBot'), enabled: running }],
        (id) => id === 'stop' && void window.alchemist.stopBot(team.id, bot.id),
      )}
      title={bot.role || bot.task}
    >
      <AgentAvatar name={config?.name ?? bot.name} avatar={config?.avatar} size={20} state={state === 'working' || state === 'starting' ? 'working' : state === 'waiting' ? 'waiting' : state === 'error' ? 'error' : null} label={t(`bots.status.${state}`)} />
      <span className="tt">
        {bot.name}
        {running && doing && <small className={`bot-doing ${doing.words ? 'words' : ''}`}>{doing.text}</small>}
      </span>
      {bot.worktree && (
        <span className="bot-copy" title={t('bots.ownCopy')}>
          ⎇
        </span>
      )}
      <span className="r">{badge && <span className="bot-badge">{badge}</span>}</span>
      {running && (
        <button
          className="row-more bot-stop"
          title={t('bots.stopBot')}
          onClick={(e) => {
            e.stopPropagation();
            void window.alchemist.stopBot(team.id, bot.id);
          }}
        >
          ■
        </button>
      )}
    </div>
  );
}

/** A finished bot's whole conversation, from the CLI's transcript (after a restart too). */
function SavedConversation({ sessionId, fallback, onGone }: { sessionId: string; fallback: string; onGone: (sessionId: string) => void }) {
  const t = useT();
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const revision = useStore((s) => s.revision);
  useEffect(() => {
    let alive = true;
    void window.alchemist
      .transcript(sessionId, 'main', -1, 300)
      .then((page) => alive && setEntries(page.entries))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [sessionId, revision]);
  useEffect(() => {
    if (entries && !entries.length) onGone(sessionId);
  }, [entries, sessionId]);
  if (!entries) return <span className="spin" />;
  // The CLI deleted the transcript (old sessions are cleaned up): its last answer is all that's left.
  if (!entries.length)
    return (
      <div className="entry assistant">
        <div className="entry-body">
          <p className="bot-gone">{t(fallback ? 'bots.convGone' : 'bots.convGoneEmpty')}</p>
          {fallback && <Markdown text={fallback} />}
        </div>
      </div>
    );
  return <TranscriptEntries entries={entries} sessionId={sessionId} isSubagent={false} />;
}

/** One line of the team's activity, in words. */
function EventLine({ e, team }: { e: TeamEvent; team: BotTeam }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const nameOf = (id: string) => (id === 'you' ? t('bots.you') : (team.bots.find((b) => b.id === id)?.name ?? id));
  const [other, rest] = e.detail.includes('|') ? [e.detail.slice(0, e.detail.indexOf('|')), e.detail.slice(e.detail.indexOf('|') + 1)] : ['', e.detail];
  const who = nameOf(e.botId);
  const text =
    e.kind === 'created' ? t('bots.ev.created', { who, other: nameOf(other) })
    : e.kind === 'waiting' ? t('bots.ev.waiting', { who })
    : e.kind === 'finished' ? t('bots.ev.finished', { who })
    : e.kind === 'done' ? t('bots.ev.done', { who })
    : e.kind === 'failed' ? t('bots.ev.failed', { who })
    : e.kind === 'stopped' ? t('bots.ev.stopped', { who })
    : e.kind === 'plan' ? t('bots.ev.plan', { who, n: rest })
    : e.kind === 'approved' ? t('bots.ev.approved', { n: rest })
    : e.kind === 'changes' ? t('bots.ev.changes')
    : e.kind === 'applied' ? t('bots.ev.applied', { who, other: nameOf(other), n: rest })
    : t('bots.ev.message', { who, other: nameOf(other) });
  const target = ['created', 'applied', 'message'].includes(e.kind) && other ? other : e.botId;
  const detail = ['created', 'message'].includes(e.kind) ? rest : e.kind === 'waiting' || e.kind === 'changes' ? rest : '';
  return (
    <li className={`ev ev-${e.kind}`} onClick={() => target !== 'you' && useStore.setState({ activeBotId: target })} title={detail || undefined}>
      <span className="ev-time">{clockTime(e.at, locale)}</span>
      <span className="ev-text">
        {text}
        {detail && <small>{detail}</small>}
      </span>
    </li>
  );
}

/** What the team did, newest first. */
function Activity({ team }: { team: BotTeam }) {
  const t = useT();
  const events = [...(team.activity ?? [])].reverse().slice(0, 80);
  if (!events.length) return null;
  return (
    <section className="team-activity" aria-label={t('bots.activity')}>
      <h4>{t('bots.activity')}</h4>
      <ul>
        {events.map((e, i) => (
          <EventLine key={`${e.at}-${i}`} e={e} team={team} />
        ))}
      </ul>
    </section>
  );
}

/** A reply shown in a few lines, with "More" for the rest. */
function Clamp({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Measured with the clamp on: "More" only when something is actually hidden.
  const [fits, setFits] = useState<boolean | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    setFits(null);
  }, [text]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && fits === null) setFits(el.scrollHeight <= el.clientHeight + 2);
  }, [fits]);
  const long = fits === false;
  return (
    <div className={`res-reply ${open || fits ? 'open' : ''}`}>
      <div className="res-clamp" ref={box}>
        <Markdown text={text} />
      </div>
      {long && (
        <button className="link small" onClick={() => setOpen(!open)}>
          {open ? t('bots.less') : t('bots.more')}
        </button>
      )}
    </div>
  );
}

/** Where a bot's own copy stands: work to apply (how many files), applied, nothing changed, or gone. */
type CopyState = { n: number } | { error: string };

function useCopies(team: BotTeam, bots: BotMember[]) {
  const [copies, setCopies] = useState<Record<string, CopyState>>({});
  const load = () => {
    for (const b of bots.filter((x) => x.worktree)) {
      void window.alchemist
        .botChanges(team.id, b.id)
        .then((c) => setCopies((p) => ({ ...p, [b.id]: { n: c.length } })))
        .catch((e: unknown) => setCopies((p) => ({ ...p, [b.id]: { error: errorText(e) } })));
    }
  };
  useEffect(load, [team.id, team.updatedAt]);
  return { copies, reload: load };
}

const MAX_REVIEW_LINES = 4000;

/** "@@ -3,2 +3,5 @@" in words: the lines of the new file it shows (or the old ones it removes). */
function hunkLabel(text: string, t: T): string {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
  if (!m) return text;
  const [from, count] = Number(m[4] ?? '1') > 0 ? [Number(m[3]), Number(m[4] ?? '1')] : [Number(m[1]), Number(m[2] ?? '1')];
  return count > 1 ? t('bots.hunkLines', { from, to: from + count - 1 }) : t('bots.hunkLine', { n: from });
}

/** What applying a bot's copy would bring into the folder, file by file, with Apply at the end. */
function CopyDiffDialog({ team, bot, onClose, onApply }: { team: BotTeam; bot: BotMember; onClose: () => void; onApply: () => Promise<boolean> }) {
  const t = useT();
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.alchemist.botDiff(team.id, bot.id).then(setPatch).catch((e: unknown) => setError(errorText(e)));
  }, [team.id, bot.id]);
  const files = patch ? parsePatch(patch) : [];
  const count = (file: (typeof files)[number], kind: 'add' | 'del') => file.lines.filter((l) => l.kind === kind).length;
  const added = files.reduce((a, f) => a + count(f, 'add'), 0);
  const removed = files.reduce((a, f) => a + count(f, 'del'), 0);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => closeBtn.current?.focus(), []);
  let budget = MAX_REVIEW_LINES;
  const apply = async () => {
    setBusy(true);
    const ok = await onApply();
    setBusy(false);
    // A failed apply keeps the dialog open: the toast says why.
    if (ok) onClose();
  };
  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="commit-dialog copy-diff-dialog" role="dialog" aria-modal="true" aria-label={t('bots.reviewTitle', { name: bot.name })} onKeyDown={(e) => e.key === 'Escape' && onClose()} tabIndex={-1}>
        <div className="copy-diff-head">
          <h3>{t('bots.reviewTitle', { name: bot.name })}</h3>
          <button className="icon-btn" aria-label={t('dialog.close')} title={t('dialog.close')} onClick={onClose}>
            ×
          </button>
        </div>
        <p className="composer-note">
          {files.length > 0 && (
            <b className="copy-diff-count">
              {t('bots.filesN', { n: files.length })} · <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
            </b>
          )}{' '}
          {t('bots.reviewHint')}
        </p>
        {files.length > 1 && (
          <ul className="copy-diff-index">
            {files.map((file, i) => (
              <li key={file.path}>
                <button className="link small" onClick={() => document.getElementById(`copy-file-${bot.id}-${i}`)?.scrollIntoView({ block: 'start' })}>
                  {file.path}
                </button>
                <span className={`diff-status ${file.status}`}>{t(`bots.fileStatus.${file.status}`)}</span>
                {!file.binary && (
                  <small>
                    <span className="plus">+{count(file, 'add')}</span> <span className="minus">−{count(file, 'del')}</span>
                  </small>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="copy-diff-files">
          {error && <p className="copy-gone">{error}</p>}
          {!error && patch === null && <span className="spin" />}
          {patch !== null && !files.length && <p className="empty">{t('bots.noChanges')}</p>}
          {files.map((file, fi) => {
            const shown = file.lines.slice(0, Math.max(0, budget));
            budget -= shown.length;
            return (
              <details key={file.path} className="diff" id={`copy-file-${bot.id}-${fi}`} open>
                <summary className="diff-path" title={file.path}>
                  {file.path}
                  <span className={`diff-status ${file.status}`}>{t(`bots.fileStatus.${file.status}`)}</span>
                </summary>
                {file.binary ? (
                  <div className="dl more">{t('bots.binaryFile')}</div>
                ) : (
                  <pre>
                    {shown.map((l, i) =>
                      l.kind === 'hunk' ? (
                        <div key={i} className="dl hunk">
                          {hunkLabel(l.text, t)}
                        </div>
                      ) : (
                        <div key={i} className={`dl ${l.kind}`}>
                          <span>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                          {l.text || ' '}
                        </div>
                      ),
                    )}
                    {shown.length < file.lines.length && <div className="dl more">{t('perm.moreLines', { n: file.lines.length - shown.length })}</div>}
                  </pre>
                )}
              </details>
            );
          })}
        </div>
        <div className="commit-foot">
          <span className="composer-sp" />
          <button ref={closeBtn} className="btn-ghost" onClick={onClose}>
            {t('dialog.close')}
          </button>
          <button className="btn-send" disabled={busy || !files.length || ACTIVE.includes(bot.status)} onClick={() => void apply()}>
            ⇣ {t('bots.applyFiles', { n: files.length })}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A bot's own copy: review and apply its work, or say where it stands. */
function CopyStatus({ team, bot, state, onApplied }: { team: BotTeam; bot: BotMember; state: CopyState | undefined; onApplied: () => void }) {
  const t = useT();
  const [reviewing, setReviewing] = useState(false);
  if (!bot.worktree || !state) return null;
  if ('error' in state)
    return (
      <>
        <span className="ac copy-gone">⚠ {t('bots.copyGone')}</span>
        <small className="copy-gone-why">{state.error}</small>
      </>
    );
  if (state.n === 0) {
    const applied = (team.activity ?? []).some((e) => e.kind === 'applied' && e.detail.startsWith(`${bot.id}|`));
    return <span className="ac">{applied ? `✓ ${t('bots.applied')}` : t('bots.noChanges')}</span>;
  }
  const apply = async (): Promise<boolean> => {
    try {
      toast(await window.alchemist.applyBotWork(team.id, bot.id));
      onApplied();
      return true;
    } catch (e) {
      toast(errorText(e), undefined, 10_000);
      return false;
    }
  };
  return (
    <>
      <span className="ac copy-pending">{t('bots.notApplied', { n: state.n })}</span>
      <button className="btn-ghost small" onClick={() => setReviewing(true)}>
        {t('bots.review')}
      </button>
      <button className="btn-ghost small" disabled={ACTIVE.includes(bot.status)} onClick={() => void apply()} title={ACTIVE.includes(bot.status) ? t('bots.applyWhenDone') : undefined}>
        ⇣ {t('bots.applyNow')}
      </button>
      {reviewing && <CopyDiffDialog team={team} bot={bot} onClose={() => setReviewing(false)} onApply={apply} />}
    </>
  );
}

/** A bot whose last turn failed: why, and a way to try again in the same conversation. */
function FailedLine({ team, bot }: { team: BotTeam; bot: BotMember }) {
  const t = useT();
  const messageBot = useStore((s) => s.messageBot);
  if (bot.status !== 'error') return null;
  const retry = () => void messageBot(team.id, bot.id, t('bots.retryMsg')).catch((e: unknown) => toast(errorText(e)));
  return (
    <div className="res-error">
      <span>✕ {bot.error || t('bots.failedNoReason')}</span>
      {(bot.sessionId || bot.runId) && (
        <button className="btn-ghost small" onClick={retry}>
          ↻ {t('bots.retry')}
        </button>
      )}
    </div>
  );
}

const SEEN_KEY = 'alchemist.resultsSeen';
const seenResults = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** When the team has ended its work (or was stopped): the coordinator's summary, each bot's result, and what's left to apply or commit. */
function ResultsCard({ team, state }: { team: BotTeam; state: TeamState }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const lead = team.bots[0]!;
  const workers = team.bots.filter((b) => b.depth > 0);
  const [files, setFiles] = useState<Record<string, string[]>>({});
  const [commit, setCommit] = useState<Map<string, string> | null>(null);
  const { copies, reload } = useCopies(team, workers);
  // Open on its own once, when the team finishes; after that it stays a one-line summary until you open it.
  const seenKey = `${team.id}:${team.finished?.at ?? 0}`;
  const [open, setOpen] = useState(() => state === 'finished' && !seenResults().includes(seenKey));
  useEffect(() => {
    if (state !== 'finished' || seenResults().includes(seenKey)) return;
    localStorage.setItem(SEEN_KEY, JSON.stringify([seenKey, ...seenResults()].slice(0, 200)));
  }, [seenKey, state]);
  // Uncommitted changes in the folder: without any, there is nothing to commit.
  const [dirty, setDirty] = useState<number | null>(null);
  const reloadAll = () => {
    reload();
    void window.alchemist.gitStatus(team.cwd).then((l) => setDirty(l.length)).catch(() => setDirty(0));
  };
  useEffect(() => {
    for (const b of workers) if (b.sessionId) void window.alchemist.session(b.sessionId).then((s) => s && setFiles((f) => ({ ...f, [b.id]: s.editedFiles }))).catch(() => {});
    void window.alchemist.gitStatus(team.cwd).then((l) => setDirty(l.length)).catch(() => setDirty(0));
  }, [team.id, team.updatedAt]);
  const summary = team.finished?.summary || lead.lastReply;
  if (!workers.length && !summary) return null;
  // Paths inside a bot's own copy read like paths in the project.
  const rel = (p: string) => (relativePath(p, team.cwd) ?? p.replace(/\\/g, '/')).replace(/^(.*\/)?\.alchemist\/worktrees\/[^/]+\/[^/]+\//, '');
  const unapplied = workers.filter((b) => { const c = copies[b.id]; return !!c && 'n' in c && c.n > 0; });
  const openCommit = async () => {
    const list = await window.alchemist.gitStatus(team.cwd).catch(() => []);
    // Work still in bots' own copies isn't in the folder yet, so it wouldn't be in the commit.
    if (unapplied.length) toast(t('bots.commitUnapplied', { names: unapplied.map((b) => b.name).join(', ') }), undefined, 8000);
    if (!list.length) return toast(t('bots.nothingToCommit'));
    setCommit(new Map(list.map((c) => [c.path, c.status])));
  };
  const partial = state !== 'finished';
  return (
    <details className={`results-card ${partial ? 'partial' : ''}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {partial ? '◐' : '✓'} {t(partial ? 'bots.resultsPartial' : 'bots.results')} · {money(teamCost(team), locale)}
        {unapplied.length > 0 && <span className="copy-pending"> · {t('bots.unappliedCount', { n: unapplied.length })}</span>}
      </summary>
      {summary && (
        <div className="res-summary">
          <b onClick={() => useStore.setState({ activeBotId: lead.id })}>{lead.name}</b>
          <Clamp text={summary} />
        </div>
      )}
      {workers.length > 0 && (
        <ul>
          {workers.map((b) => (
            <li key={b.id}>
              <div className="res-head">
                <span className={`bot-st st-${b.status}`}>{STATUS_ICON[b.status]}</span>
                <b onClick={() => useStore.setState({ activeBotId: b.id })}>{b.name}</b>
                {b.costUsd != null && <span className="ac">{money(b.costUsd, locale)}</span>}
                <CopyStatus team={team} bot={b} state={copies[b.id]} onApplied={reloadAll} />
              </div>
              <FailedLine team={team} bot={b} />
              {!!files[b.id]?.length && <div className="res-files">{files[b.id]!.slice(0, 8).map(rel).join(' · ')}{files[b.id]!.length > 8 ? ' …' : ''}</div>}
              {b.lastReply && <Clamp text={b.lastReply} />}
            </li>
          ))}
        </ul>
      )}
      {!!dirty && (
        <div className="res-actions">
          <button className="btn-ghost small" onClick={() => void openCommit()}>
            ⇡ {t('bots.commitWork')}
          </button>
        </div>
      )}
      {commit && <CommitDialog cwd={team.cwd} changes={commit} onClose={() => setCommit(null)} onDone={reloadAll} />}
    </details>
  );
}

/** The coordinator's plan: you edit the bots and their tasks, then approve it or ask for changes. */
function PlanCard({ team }: { team: BotTeam }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const plan = team.plan!;
  const [bots, setBots] = useState<PlannedBot[]>(plan.bots);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<PlannedBot>) => setBots(bots.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const answer = async (approve: boolean) => {
    setBusy(true);
    try {
      await window.alchemist.answerPlan(team.id, approve ? { approve, bots, feedback } : { approve, feedback });
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const over = plan.estimateUsd != null && team.budgetUsd != null && plan.estimateUsd > team.budgetUsd;
  const configs = useStore((s) => s.botConfigs);
  const lead = team.bots[0]!;
  const modelLabel = modelNamer(t);
  /** Who a planned bot will be: its configuration's agent, or the coordinator's (never more permissions). */
  const agentLine = (b: PlannedBot) => {
    const c = b.config ? configs.find((x) => x.id === b.config || x.name.toLowerCase() === b.config.toLowerCase()) : undefined;
    const model = c ? c.agent.model : lead.agent.model;
    const mode = c ? c.permissionMode : lead.permissionMode;
    return [modelLabel(model), t(`perm.${mode}`), c?.canSpawn ? `⚗ ${t('bots.canSpawn')}` : null].filter(Boolean).join(' · ');
  };
  return (
    <section className="plan-card" aria-label={t('bots.planTitle')}>
      <div className="plan-head">
        <span className="team-state ts-waiting">{t('bots.team.waiting')}</span>
        <b>{t('bots.planTitle')}</b>
        {plan.revision > 1 && <span className="ac">{t('bots.planRevision', { n: plan.revision })}</span>}
        {plan.estimateUsd != null && (
          <span className={`ac ${over ? 'plan-over' : ''}`} title={over ? t('bots.planOverBudget') : undefined}>
            ≈ {money(plan.estimateUsd, locale)}
            {team.budgetUsd ? ` / ${money(team.budgetUsd, locale)}` : ''}
          </span>
        )}
      </div>
      {plan.summary && <p className="plan-summary">{plan.summary}</p>}
      <ol className="plan-bots">
        {bots.map((bot, i) => (
          <li key={i}>
            <div className="plan-bot-head">
              <input value={bot.name} onChange={(e) => set(i, { name: e.target.value })} aria-label={t('bots.name')} />
              {/* The configuration's name says nothing new when the agent is called the same. */}
              {bot.config.toLowerCase() !== bot.name.trim().toLowerCase() && <span className="bot-badge">{bot.config || t('bots.definedHere')}</span>}
              <label className="plan-copy" title={t('bots.ownWorktreeHint')}>
                <input type="checkbox" checked={bot.ownWorktree} onChange={(e) => set(i, { ownWorktree: e.target.checked })} /> {t('bots.ownCopy')}
              </label>
              <button className="icon-btn" title={t('bots.planRemove')} aria-label={t('bots.planRemove')} onClick={() => setBots(bots.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
            <textarea value={bot.task} rows={2} onChange={(e) => set(i, { task: e.target.value })} aria-label={t('bots.task')} />
            <small className="plan-agent">{agentLine(bot)}</small>
            {bot.role && !bot.config && <small className="plan-role">{bot.role}</small>}
          </li>
        ))}
      </ol>
      <textarea className="plan-feedback" rows={2} value={feedback} placeholder={t('bots.planFeedback')} onChange={(e) => setFeedback(e.target.value)} />
      <div className="plan-actions">
        <span className="composer-note">{t('bots.planHint')}</span>
        <span className="composer-sp" />
        <button className="btn-ghost" disabled={busy || !feedback.trim()} onClick={() => void answer(false)} title={feedback.trim() ? undefined : t('bots.planNeedFeedback')}>
          {t('bots.planChanges')}
        </button>
        <button className="btn-send" disabled={busy || !bots.length} onClick={() => void answer(true)}>
          ✓ {t('bots.planApprove', { n: bots.length })}
        </button>
      </div>
    </section>
  );
}

/** On a bot's card: its own copy's pending work, to apply without waiting for the results. */
function BotCopy({ team, bot }: { team: BotTeam; bot: BotMember }) {
  const { copies, reload } = useCopies(team, [bot]);
  return <CopyStatus team={team} bot={bot} state={copies[bot.id]} onApplied={reload} />;
}

/** One team: its bots as a tree, and the selected bot's conversation. */
export function TeamView({ team }: { team: BotTeam }) {
  const t = useT();
  const modelLabel = modelNamer(t);
  const locale = useStore((s) => s.locale);
  const activeBotId = useStore((s) => s.activeBotId);
  const messageBot = useStore((s) => s.messageBot);
  const bot = team.bots.find((b) => b.id === activeBotId) ?? team.bots[0]!;
  const hasTurns = useStore((s) => !!(bot.runId && s.runs[bot.runId]?.turns.length));
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  // Conversations the CLI no longer has on disk: those bots can't be continued.
  const [gone, setGone] = useState<Record<string, true>>({});
  const onGone = (id: string) => setGone((g) => (g[id] ? g : { ...g, [id]: true }));
  const state = teamState(team);
  const anyActive = teamActive(team);
  const lead = team.bots[0]!;
  const planPending = team.plan?.status === 'pending';
  const running = (b: BotMember) => !!b.runId && (ACTIVE.includes(b.status) || b.status === 'idle');
  const live = running(bot);
  /** Who a bot can still hear from: a live run, or a saved conversation to continue. */
  const reachable = (b: BotMember) => running(b) || (!!b.sessionId && !gone[b.sessionId]);
  const canTalk = reachable(bot) && !(planPending && bot.depth === 0);
  const locked = planPending ? bot.depth === 0 : !canTalk && !team.bots.some(reachable);
  const send = async () => {
    const v = text.trim();
    if (!v) return;
    // "@Tester …" goes to that bot, "@all …" (or the word in the app's language) to every bot that can still hear it.
    const m = /^@(\S+)\s+([\s\S]+)$/.exec(v);
    const key = m?.[1]!.toLowerCase();
    const all = !!key && ['todos', 'todas', 'all', 'everyone', t('bots.mentionAll').toLowerCase()].includes(key);
    const named = key && !all ? team.bots.find((b) => b.name.toLowerCase().replace(/\s+/g, '') === key) : undefined;
    if (key && !all && !named) return toast(t('bots.noSuchBot', { name: m![1]! }));
    const targets = all ? team.bots.filter(reachable) : [named ?? bot];
    const body = all || named ? m![2]! : v;
    // Finished bots start again to read it: each one is a new agent run (and costs).
    const restarts = all ? targets.filter((b) => !running(b)).length : 0;
    if (restarts && !(await confirmAction({ title: t('bots.allRestartTitle', { n: restarts }), message: t('bots.allRestartBody'), confirmLabel: t('bots.sendToAll', { n: targets.length }), cancelLabel: t('dialog.cancel') }))) return;
    try {
      for (const target of targets) await messageBot(team.id, target.id, body);
      if (named) useStore.setState({ activeBotId: named.id });
      setText('');
      if (all) toast(t('bots.sentToAll', { n: targets.length }), undefined, 2500);
    } catch (e) {
      toast(errorText(e));
    }
  };
  // Typing "@": the team's names to pick from.
  const mentioning = /^@(\S*)$/.exec(text);
  const mentionOptions = mentioning ? [...team.bots.map((b) => b.name.replace(/\s+/g, '')), t('bots.mentionAll')].filter((n) => n.toLowerCase().startsWith(mentioning[1]!.toLowerCase())) : [];
  const teamMenu = () =>
    void openMenu([
      { id: 'stop', label: t('bots.stopTeam'), enabled: anyActive },
      { id: 'rename', label: t('bots.renameTeam') },
      { id: 'folder', label: t('bots.openFolder') },
      { type: 'separator' },
      { id: 'delete', label: t('bots.deleteTeam') },
    ]).then(async (id) => {
      if (id === 'stop') await window.alchemist.stopBot(team.id);
      if (id === 'folder') await window.alchemist.revealPath(team.cwd);
      if (id === 'rename') {
        const title = await promptText({ title: t('bots.renameTeam'), value: team.title ?? '', confirmLabel: t('menu.renameOk'), cancelLabel: t('dialog.cancel') });
        if (title !== null) await window.alchemist.renameTeam(team.id, title);
      }
      if (id === 'delete' && (await confirmDeleteTeam(team, t))) {
        await window.alchemist.deleteTeam(team.id);
        useStore.setState({ activeTeamId: null });
        await useStore.getState().loadBots();
      }
    });
  // Order: each bot followed by the bots it created.
  const ordered: BotMember[] = [];
  const add = (parent: string | null) => {
    for (const b of team.bots.filter((x) => x.parentId === parent)) {
      ordered.push(b);
      add(b.id);
    }
  };
  add(null);
  const folder = team.cwd.replace(/^\/Users\/[^/]+/, '~');
  return (
    <section className="team-view">
      <header className="team-head">
        {/* Back to the chart, with this assignment showing on it: who does what. */}
        <button className="icon-btn ic-btn" onClick={() => showOnChart(team.id)} title={t('org.seeOnChart')} aria-label={t('org.seeOnChart')}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <div className="team-title">
          <span className={`team-state ts-${state}`}>{t(`bots.team.${state}`)}</span>
          <h1 title={team.goal}>{team.title || team.goal}</h1>
        </div>
        <button className="ac team-folder" title={`${team.cwd}\n${t('bots.openFolder')}`} onClick={() => void window.alchemist.revealPath(team.cwd)}>
          📁 {tailOf(folder, 2)}
        </button>
        <span className="ah-stats">
          {t('bots.count', { n: team.bots.length })}
          {(teamCost(team) > 0 || team.budgetUsd) && ` · ${money(teamCost(team), locale)}`}
          {team.budgetUsd ? ` / ${money(team.budgetUsd, locale)}` : ''}
        </span>
        {anyActive && (
          <button className="btn-stop" onClick={() => void window.alchemist.stopBot(team.id)}>
            ■ {t('bots.stopTeam')}
          </button>
        )}
        <button className="icon-btn" title={t('menu.more')} aria-label={t('menu.more')} onClick={teamMenu}>
          ⋯
        </button>
      </header>
      {team.plan?.status === 'pending' && <PlanCard key={`${team.id}:${team.plan.revision}`} team={team} />}
      {team.plan?.status === 'approved' && (
        <details className="plan-done">
          <summary>✓ {t('bots.planApproved', { n: team.plan.bots.length })}</summary>
          <ol>
            {team.plan.bots.map((b, i) => (
              <li key={i}>
                <b>{b.name}</b> — {b.task}
              </li>
            ))}
          </ol>
        </details>
      )}
      {['finished', 'yourTurn', 'stopped', 'failed'].includes(state) && !planPending && (team.bots.length > 1 || !!team.finished) && <ResultsCard team={team} state={state} />}
      {team.stoppedReason?.startsWith('budget') && <div className="team-banner">■ {t('bots.budgetStopped', { cap: money(team.budgetUsd ?? 0, locale) })}</div>}
      {team.stoppedReason === 'appClosed' && !planPending && (
        <div className="team-banner">
          ■ {t('bots.appClosedStopped')}
          {lead.sessionId && !gone[lead.sessionId] && (
            <button className="btn-ghost small" onClick={() => void messageBot(team.id, lead.id, t('bots.continueAfterClose')).catch((e: unknown) => toast(errorText(e)))}>
              {t('bots.continueTeam')}
            </button>
          )}
        </div>
      )}
      <div className="team-body">
        <nav className="team-tree" aria-label={t('bots.teamBots')}>
          {ordered.map((b) => (
            <BotRow key={b.id} bot={b} team={team} selected={b.id === bot.id} onSelect={() => useStore.setState({ activeBotId: b.id })} />
          ))}
          <Activity team={team} />
        </nav>
        <div className="team-bot">
          <div className="bot-card">
            <div className="bot-card-head">
              <b>{bot.name}</b>
              <span className={`ac bot-status st-${botState(team, bot)}`}>{t(`bots.status.${botState(team, bot)}`)}</span>
              <span className="ac model" title={bot.agent.model}>
                {sourceOf(bot.agent.harnessId).glyph} {modelLabel(bot.agent.model)}
              </span>
              <span className="ac">{t(`perm.${bot.permissionMode}`)}</span>
              {bot.canSpawn && <span className="ac">⚗ {t('bots.canSpawn')}</span>}
              {bot.worktree && (
                <span className="ac branch" title={bot.worktree.path}>
                  ⎇ {t('bots.ownCopy')}
                </span>
              )}
              {bot.costUsd != null && <span className="ac">{money(bot.costUsd, locale)}</span>}
              {bot.worktree && <BotCopy team={team} bot={bot} />}
              {bot.sessionId && !gone[bot.sessionId] && (
                <button
                  className="link small bot-open"
                  onClick={() => {
                    const s = useStore.getState();
                    s.setMode('agents');
                    void s.select(bot.sessionId!, 'main');
                  }}
                >
                  {t('bots.openConversation')} →
                </button>
              )}
            </div>
            {bot.role && <p className="bot-role">{bot.role}</p>}
            <FailedLine team={team} bot={bot} />
            <details className="bot-task" open={!hasTurns && (!bot.sessionId || !!gone[bot.sessionId])}>
              <summary>{bot.depth === 0 ? t('bots.goal') : t('bots.task')}</summary>
              <Markdown text={bot.task} />
            </details>
          </div>
          <div className="tx team-tx">
            {hasTurns && bot.runId ? (
              <LiveTurns runId={bot.runId} />
            ) : bot.sessionId ? (
              <SavedConversation sessionId={bot.sessionId} fallback={bot.lastReply} onGone={onGone} />
            ) : bot.lastReply ? (
              <div className="entry assistant">
                <div className="entry-body">
                  <Markdown text={bot.lastReply} />
                </div>
              </div>
            ) : (
              ACTIVE.includes(bot.status) && <p className="empty">{t('bots.startingUp')}</p>
            )}
          </div>
          <div className="composer team-composer">
            {mentionOptions.length > 0 && (
              <div className="mention-row">
                {mentionOptions.map((n) => (
                  <button key={n} className="f" onMouseDown={(e) => (e.preventDefault(), setText(`@${n} `), box.current?.focus())}>
                    @{n}
                  </button>
                ))}
              </div>
            )}
            <div className="composer-box">
              <textarea
                ref={box}
                rows={2}
                value={text}
                disabled={locked}
                placeholder={
                  planPending && bot.depth === 0 ? t('bots.answerPlanFirst')
                  : !canTalk ? t(bot.sessionId && gone[bot.sessionId] ? 'bots.convGoneShort' : 'bots.ended')
                  : live ? t('bots.messagePlaceholder', { name: bot.name })
                  : t('bots.continuePlaceholder', { name: bot.name })
                }
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {locked ? (
                <div className="composer-bar">
                  <span className="composer-sp" />
                  {!planPending && (
                    <button
                      className="btn-ghost small"
                      onClick={() => {
                        setDraftGoal(team.goal);
                        showOnChart(null);
                      }}
                    >
                      ⚗ {t('bots.newTeamSameGoal')}
                    </button>
                  )}
                </div>
              ) : (
              <div className="composer-bar">
                <span className="composer-note">{t('bots.mentionHint')}</span>
                <span className="composer-sp" />
                {ACTIVE.includes(bot.status) && bot.runId && (
                  <button className="btn-ghost small" onClick={() => void window.alchemist.stopBot(team.id, bot.id)}>
                    ■ {t('bots.stopBot')}
                  </button>
                )}
                <button className="btn-send" disabled={(!canTalk && !text.startsWith('@')) || !text.trim()} onClick={() => void send()}>
                  {live ? t('run.send') : t('bots.continue')} ↵
                </button>
              </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
