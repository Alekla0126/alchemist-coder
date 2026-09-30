import { AgentsHome } from './AgentsHome';
import { keys } from '../keys';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionSummary, TranscriptEntry } from '@alchemist-coder/core';
import { compactNumber, duration, money, modelLabel } from '../format';
import { findAgent, useStore, useT } from '../store';
import { Composer } from './Composer';
import { StatusDot } from './StatusDot';
import { TranscriptEntries } from './Transcript';
import { LiveTurns } from './LiveTurns';
import { FindBar } from './FindBar';
import { StartScreen } from './StartScreen';
import { Icon } from './Icon';
import { useAgentNames } from '../agents-edit';
import { MarkdownActions } from './Markdown';
import { toast } from '../ui';
import { showSessionMenu } from '../actions/session';
import { openMenu } from '../ui';
import { relativePath } from '../paths';

const PAGE = 300;

export function AgentPanel() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const selection = useStore((s) => s.selection);
  const tree = useStore((s) => (s.selection ? s.trees[s.selection.sessionId] : undefined));
  const revision = useStore((s) => s.revision);
  const changed = useStore((s) => s.changedSessions);
  const select = useStore((s) => s.select);
  const markCaptureReady = useStore((s) => s.markCaptureReady);
  const composeProjectId = useStore((s) => s.composeProjectId);
  const scope = useStore((s) => s.agentsScope);
  const composeProject = useStore((s) => s.projects.find((p) => p.id === s.composeProjectId));
  // A live run knows more than the index (e.g. it is waiting for your permission right now).
  const liveStatus = useStore((s) => {
    const runId = s.selection ? s.runByTarget[`s:${s.selection.sessionId}`] : undefined;
    const run = runId ? s.runs[runId] : undefined;
    return run?.status === 'waiting' ? 'waiting' : run?.status === 'running' || run?.status === 'starting' ? 'running' : null;
  });
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  /** Index of the first loaded entry: conversations open at the end and load older pages upwards. */
  const [start, setStart] = useState(0);
  const [total, setTotal] = useState(0);
  /** New entries that arrived while you were reading further up. */
  const [unseen, setUnseen] = useState(0);
  /** More than a screen above the end: offer a way back down. */
  const [far, setFar] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** What to do with the scroll position after the next render. */
  const pendingScroll = useRef<{ kind: 'bottom' } | { kind: 'keep'; height: number; top: number } | null>(null);
  const loaded = useRef<{ key: string; start: number; total: number } | null>(null);
  const [finding, setFinding] = useState(false);
  // ⌘F finds in the conversation, unless the editor or a terminal has the focus (they have their own).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return;
      const el = document.activeElement;
      if (el?.closest('.monaco-editor, .xterm, .settings, .palette')) return;
      e.preventDefault();
      setFinding(true);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => setFinding(false), [selection?.sessionId, selection?.agentId]);
  const node = selection ? findAgent(tree, selection.agentId) : null;
  // A name you gave this agent in the tree.
  const alias = useAgentNames((n) => (selection && node ? n.names[selection.sessionId]?.[node.id] : undefined));
  // File paths in the chat open in the editor when they're in the project.
  const projectForLinks = useStore((s) => s.projects.find((p) => p.id === (s.composeProjectId ?? s.settings.activeProjectId)));
  const openFileAt = useStore((s) => s.openFileAt);
  const markdownActions = {
    openPath: (path: string, line?: number) => {
      const project = projectForLinks;
      if (!project) return;
      void window.alchemist.terminalLinks(project.cwd, [path]).then(([real]) => {
        if (real) openFileAt(project.id, real, line ?? 1);
        else toast(t('transcript.pathMissing', { path }));
      });
    },
  };
  const liveKey = selection && changed.includes(selection.sessionId) ? revision : 0;
  // A run of this conversation (or of the new one being composed) shows its turns in the chat.
  const liveRunId = useStore((s) => (s.selection && s.selection.agentId === 'main' ? s.runByTarget[`s:${s.selection.sessionId}`] : s.composeProjectId != null ? s.runByTarget[`p:${s.composeProjectId}`] : undefined));
  const liveTurns = useStore((s) => (liveRunId ? s.runs[liveRunId]?.turns : undefined));
  const clearTurns = useStore((s) => s.clearTurns);
  const liveSince = liveTurns?.length ? liveTurns[0]!.startedAt - 2000 : null;
  // Follow the reply as it streams, unless you scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current && liveTurns?.length) el.scrollTop = el.scrollHeight;
  }, [liveTurns]);

  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    const key = `${selection.sessionId}:${selection.agentId}`;
    const same = loaded.current?.key === key;
    void (async () => {
      // First open: the last page. A live update: everything from what's already loaded to the end.
      const from = same ? loaded.current!.start : -1;
      const limit = same ? Math.min(3000, Math.max(PAGE, loaded.current!.total - loaded.current!.start + 200)) : PAGE;
      const [s, page] = await Promise.all([window.alchemist.session(selection.sessionId), window.alchemist.transcript(selection.sessionId, selection.agentId, from, limit)]);
      if (cancelled) return;
      if (!same || atBottom.current) pendingScroll.current = { kind: 'bottom' };
      else if (page.total > loaded.current!.total) setUnseen((n) => n + page.total - loaded.current!.total);
      if (!same) setUnseen(0);
      loaded.current = { key, start: page.offset, total: page.total };
      // Once the run is over and the index has its last reply, the chat shows that instead.
      const run = liveRunId ? useStore.getState().runs[liveRunId] : undefined;
      const lastTurn = run?.turns.at(-1);
      if (run && lastTurn?.endedAt && !['running', 'starting', 'waiting'].includes(run.status) && page.entries.some((e) => e.role === 'assistant' && (e.ts ?? 0) >= lastTurn.startedAt - 2000)) {
        clearTurns(run.runId);
      }
      setSession(s);
      setEntries(page.entries);
      setStart(page.offset);
      setTotal(page.total);
      markCaptureReady();
    })();
    return () => {
      cancelled = true;
    };
  }, [selection?.sessionId, selection?.agentId, liveKey]);

  useLayoutEffect(() => {
    const el = scroller.current;
    const p = pendingScroll.current;
    if (!el || !p) return;
    pendingScroll.current = null;
    if (p.kind === 'bottom') {
      // Turns off screen aren't laid out (content-visibility), so their heights settle as they
      // render: stay pinned to the end for a couple of frames.
      el.scrollTop = el.scrollHeight;
      let frames = 3;
      const pin = () => {
        if (frames-- <= 0) return;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(pin);
      };
      requestAnimationFrame(pin);
    }
    // Older messages were added above: keep what you were reading where it was.
    else el.scrollTop = p.top + (el.scrollHeight - p.height);
  }, [entries]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = gap < 80;
    if (far !== gap > el.clientHeight) setFar(gap > el.clientHeight);
    if (atBottom.current && unseen) setUnseen(0);
  };
  const jumpToLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setUnseen(0);
  };

  if (composeProjectId != null && !selection) {
    return (
      <MarkdownActions.Provider value={markdownActions}>
      <section className="agent-panel">
        <div className="ah">
          <div className="live">⚗ {t('run.new').toUpperCase()}</div>
          <h1 className="aname">{t('run.newIn', { project: composeProject?.name ?? '' })}</h1>
          <p className="adesc">{composeProject?.cwd}</p>
        </div>
        <div className="tx">{liveRunId && <LiveTurns runId={liveRunId} />}</div>
        <Composer projectId={composeProjectId} />
      </section>
      </MarkdownActions.Provider>
    );
  }

  if (!selection || !node) {
    if (!selection) return scope === 'all' ? <AgentsHome /> : <StartScreen />;
    return <div className="panel-empty">{tree === undefined ? <span className="spin" /> : t('agent.select')}</div>;
  }

  const loadEarlier = async () => {
    if (start <= 0) return;
    const from = Math.max(0, start - PAGE);
    const page = await window.alchemist.transcript(selection.sessionId, selection.agentId, from, start - from);
    const el = scroller.current;
    if (el) pendingScroll.current = { kind: 'keep', height: el.scrollHeight, top: el.scrollTop };
    loaded.current = { key: `${selection.sessionId}:${selection.agentId}`, start: from, total: page.total };
    setEntries((prev) => [...page.entries, ...prev]);
    setStart(from);
  };

  const isMain = node.id === 'main';
  const status = isMain && liveStatus ? liveStatus : node.status;
  const parent = node.parentId ? findAgent(tree, node.parentId) : null;
  // While a run goes, the index lags behind it: its own counts are fresher.
  const liveRun = isMain && liveRunId ? useStore.getState().runs[liveRunId] : undefined;
  const running = !!liveRun && ['starting', 'running', 'waiting'].includes(liveRun.status);
  const elapsed = !running && node.startedTs != null && node.endedTs != null ? node.endedTs - node.startedTs : null;
  const tokens = Math.max(node.inputTokens + node.outputTokens, running ? (liveRun.usage?.usedTokens ?? 0) : 0);
  const toolCount = Math.max(node.toolCalls, running ? liveRun.tools.length : 0);
  const stats = [duration(elapsed), t('agent.toolsN', { n: toolCount }), `${compactNumber(tokens, locale)} tok`, money(isMain ? (session?.costUsd ?? node.costUsd) : node.costUsd, locale)]
    .filter((x) => x && x !== '—')
    .join(' · ');
  const pickEdited = async () => {
    if (!session || !projectForLinks) return;
    const files = session.editedFiles.slice(0, 40);
    const id = await openMenu(files.map((f, i) => ({ id: `f:${i}`, label: relativePath(f, projectForLinks.cwd) || f })));
    if (id) markdownActions.openPath(files[Number(id.slice(2))]!);
  };
  const pickChild = async () => {
    const id = await openMenu(node.children.slice(0, 40).map((c) => ({ id: `a:${c.id}`, label: `${c.type} · ${c.description}`.slice(0, 120) })));
    if (id) void select(selection.sessionId, id.slice(2));
  };
  return (
    <MarkdownActions.Provider value={markdownActions}>
      <section className="agent-panel">
      <div className="ah compact">
        <div className="ah-row">
          <span className={`live ${status}`} title={t(`status.${status}`)}>
            <StatusDot status={status} />
          </span>
          <h1 className="aname" title={isMain ? (session?.title ?? node.description) : node.type}>
            {isMain ? (session?.title ?? node.description) : (alias ?? node.type)}
          </h1>
          <span className="ah-stats" title={t('agent.costHint')}>
            {stats}
          </span>
          <button className="icon-btn ic-btn" title={`${t('find.title')} (${keys('⌘F')})`} aria-label={t('find.title')} onClick={() => setFinding(true)}>
            <Icon name="search" size={15} />
          </button>
          {isMain && session && (
            <button className="icon-btn ic-btn" title={t('menu.more')} aria-label={t('menu.more')} onClick={() => void showSessionMenu(session)}>
              <Icon name="more" size={16} />
            </button>
          )}
        </div>
        {!isMain && <p className="adesc">{node.description}</p>}
        <div className="achips">
          {status !== 'done' && status !== 'idle' && <span className={`ac status ${status}`}>{t(`status.${status}`)}</span>}
          {/* The main agent's CLI and model are in the chips under the message box. */}
          {node.model && !isMain && (
            <span className="ac model" title={node.model}>
              {modelLabel(node.model)}
            </span>
          )}
          {isMain ? (
            session && (
              <>
                {session.gitBranch && <span className="ac branch">⎇ {session.gitBranch}</span>}

                {session.preserved && (
                  <span className="ac kept" title={t('backup.keptHint')}>
                    🛟 {t('backup.kept')}
                  </span>
                )}
              </>
            )
          ) : (
            <span className="ac">{t('agent.depth', { n: node.depth })}</span>
          )}
          {node.worktreeBranch && <span className="ac branch">⎇ {node.worktreeBranch}</span>}
          {parent && (
            <button className="ac ac-btn" onClick={() => void select(selection.sessionId, parent.id)} title={t('agent.parent')}>
              ↑ {parent.id === 'main' ? t('agent.main') : parent.description}
            </button>
          )}
          {isMain && session && session.editedFiles.length > 0 && (
            <button className="ac ac-btn" onClick={() => void pickEdited()} aria-haspopup="menu" title={t('agent.editedHint')}>
              ✎ {t('agent.editedN', { n: session.editedFiles.length })} ▾
            </button>
          )}
          {node.children.length > 0 && (
            <button className="ac ac-btn" onClick={() => void pickChild()} aria-haspopup="menu">
              ⚗ {t('agent.subagentsN', { n: node.children.length })} ▾
            </button>
          )}
          {/* In a narrow panel the stats move here from the title row. */}
          <span className="ac ah-stats-chip">{stats}</span>
        </div>
      </div>
      {finding && (
        <FindBar root={scroller} version={`${entries.length}:${start}:${liveTurns?.length ?? 0}`} onClose={() => setFinding(false)} more={start} onLoadMore={() => void loadEarlier()} />
      )}
      <div className="tx" ref={scroller} onScroll={onScroll}>
        {start > 0 && (
          <button className="load-more load-earlier" onClick={() => void loadEarlier()}>
            ↑ {t('transcript.loadEarlier', { n: start })}
          </button>
        )}
        {entries.length === 0 && total === 0 ? (
          <p className="empty">{t('transcript.empty')}</p>
        ) : (
          <TranscriptEntries entries={liveSince != null ? entries.filter((e) => e.ts == null || e.ts < liveSince) : entries} sessionId={selection.sessionId} isSubagent={!isMain} />
        )}
        {isMain && liveRunId && <LiveTurns runId={liveRunId} />}
        {(unseen > 0 || far) && (
          <button className="jump-latest" onClick={jumpToLatest}>
            ↓ {unseen > 0 ? t('transcript.jumpLatest', { n: unseen }) : t('transcript.jumpLatestPlain')}
          </button>
        )}
      </div>
      {isMain && session && <Composer projectId={session.projectId} session={session} />}
    </section>
    </MarkdownActions.Provider>
  );
}
