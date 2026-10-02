import { Fragment, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';
import { useNow, WorkingOrb } from './WorkingOrb';
import { useAgentNames } from '../agents-edit';
import { findByToolUse, typeLabel } from '../chat-model';
import type { FileDiff, TranscriptBlock, TranscriptEntry } from '@alchemist-coder/core';
import { clockTime, duration, modelLabel, money } from '../format';
import { findAgent, useStore, useT } from '../store';
import { contextMenu, toast } from '../ui';
import { Markdown } from './Markdown';
import { DiffPreview, relativeTo, useProjectRoot } from './LiveRun';
import { lineDiff } from '../diff';
import { INTERRUPTED_NOTICE, buildTurns, displaySummary, shortToolName, toolSummary, type RenderBlock, type TaskItem, type ToolResult, type ToolUse, type Turn } from '../transcript-model';

const TOOL_ICONS: Record<string, string> = { Bash: '$', Read: '▤', Edit: '✎', Write: '✎', MultiEdit: '✎', Grep: '⌕', Glob: '⌕', Agent: '⚗', Task: '⚗', WebFetch: '↗', WebSearch: '⌕', shell: '$', exec: '$' };
const MAX_TEXT = 6000;

function LongText({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  if (text.length <= MAX_TEXT || full) return <Markdown text={text} />;
  return (
    <>
      <Markdown text={`${text.slice(0, MAX_TEXT)}…`} />
      <button className="link" onClick={() => setFull(true)}>+{Math.round((text.length - MAX_TEXT) / 1000)}k</button>
    </>
  );
}

/** The file a Read / Edit / Write call worked on, when its input says. */
function fileOf(block: ToolUse): string | null {
  try {
    const input = JSON.parse(block.input) as Record<string, unknown>;
    const p = input.file_path ?? input.path ?? input.notebook_path;
    // Absolute on macOS/Linux (/…) or Windows (C:\… or \\server\…).
    return typeof p === 'string' && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p) ? p : null;
  } catch {
    return null;
  }
}

const parseInput = (use: ToolUse): Record<string, any> => {
  try {
    const v = JSON.parse(use.input);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

/** A tool's input as people read it: the command for a shell, the path and pattern for a search; JSON otherwise. */
export function ToolInput({ use }: { use: ToolUse }) {
  const t = useT();
  const [raw, setRaw] = useState(false);
  const input = parseInput(use);
  const command = Array.isArray(input.command) ? String(input.command.at(-1) ?? '') : typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : null;
  const fields: Array<[string, unknown]> =
    use.name === 'Read' ? [['path', input.file_path], ['from line', input.offset], ['lines', input.limit]]
    : use.name === 'Grep' ? [['pattern', input.pattern], ['in', input.path ?? input.glob], ['type', input.type]]
    : use.name === 'Glob' ? [['pattern', input.pattern], ['in', input.path]]
    : use.name === 'WebFetch' || use.name === 'WebSearch' ? [['url', input.url], ['query', input.query], ['prompt', input.prompt]]
    : [];
  const shown = fields.filter(([, v]) => v != null && v !== '');
  if (raw || (!command && !shown.length)) return use.input ? <pre className="tool-body">{use.input}</pre> : null;
  return (
    <div className="tool-input">
      {command != null ? (
        <>
          {typeof input.description === 'string' && <div className="tool-cap">{input.description}</div>}
          <pre className="tool-body shell">
            <span className="prompt-sign">$ </span>
            {command}
          </pre>
        </>
      ) : (
        <dl className="tool-fields">
          {shown.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <button className="link small" onClick={() => setRaw(true)}>
        {t('transcript.showJson')}
      </button>
    </div>
  );
}

/** AskUserQuestion: the questions, their options, and what you picked. */
function QuestionCard({ block, result }: { block: ToolUse; result: ToolResult | undefined }) {
  const t = useT();
  const answers: Record<string, string> = { ...(result?.answers ?? {}) };
  if (!result?.answers && result?.preview) for (const m of result.preview.matchAll(/"([^"]+)"="([^"]*)"/g)) answers[m[1]!] = m[2]!;
  return (
    <div className="ask-card">
      {block.ask!.map((q, i) => {
        const answer = answers[q.question];
        const picked = (label: string) => !!answer && (answer === label || answer.split(', ').includes(label));
        const custom = answer && !q.options.some((o) => picked(o.label));
        return (
          <div key={i} className="ask-q">
            <div className="ask-top">
              {q.header && <span className="ask-h">{q.header}</span>}
              <b>{q.question}</b>
            </div>
            <ul className="ask-opts" aria-label={q.question}>
              {q.options.map((o) => (
                <li key={o.label} className={`ask-opt ${picked(o.label) ? 'on' : ''}`}>
                  <span className="ask-radio" aria-hidden>
                    {picked(o.label) ? (q.multiSelect ? '☑' : '◉') : q.multiSelect ? '☐' : '○'}
                  </span>
                  <span>
                    <b>{o.label}</b>
                    {o.description && <small>{o.description}</small>}
                  </span>
                </li>
              ))}
            </ul>
            {custom && <div className="ask-answer">↳ {answer}</div>}
          </div>
        );
      })}
      {!result && <div className="ask-wait">{t('transcript.askNoAnswer')}</div>}
      {result && !Object.keys(answers).length && <div className="ask-wait">{result.isError ? t('transcript.askSkipped') : result.preview.slice(0, 200)}</div>}
    </div>
  );
}

/** The task list after a run of task calls: done, in progress, waiting. */
function TaskList({ items, ops }: { items: TaskItem[]; ops: number }) {
  const t = useT();
  const done = items.filter((x) => x.status === 'completed').length;
  const [open, setOpen] = useState(items.length <= 8);
  const current = items.find((x) => x.status === 'in_progress');
  return (
    <div className="task-list">
      <div className="task-head" onClick={() => setOpen(!open)}>
        <span className="ic">☑</span>
        <span className="nm">{t('transcript.tasks', { done, n: items.length })}</span>
        {!open && current && <span className="sum">◐ {current.subject}</span>}
        <span className="task-ops">{t('transcript.taskOps', { n: ops })}</span>
      </div>
      {open && (
        <ul>
          {items.map((x) => (
            <li key={x.id} className={x.status}>
              <span className="task-ic">{x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '◐' : '○'}</span>
              {x.subject}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Loading tools or a skill: bookkeeping, one dim line. */
export function QuietRow({ use, result }: { use: ToolUse; result: ToolResult | undefined }) {
  const t = useT();
  const input = parseInput(use);
  const text =
    use.name === 'Skill'
      ? t('transcript.usedSkill', { name: String(input.skill ?? input.command ?? '') })
      : t('transcript.loadedTools', { names: String(input.query ?? '').replace(/^select:/, '').split(',').map((x) => shortToolName(x.trim())).filter(Boolean).slice(0, 6).join(', ') });
  return (
    <div className={`quiet-row ${result?.isError ? 'failed' : ''}`} title={use.input}>
      <span className="ic">{use.name === 'Skill' ? '✦' : '⌕'}</span> {text}
    </div>
  );
}

/** Who says each turn of a chat: you (or the agent that gave a subagent its task) and the agent answering. */
export interface Speakers {
  asker: string;
  agent: string;
  /** The asker is you, not another agent. */
  you: boolean;
}

/** The line over a turn that says whose it is. */
export function Who({ name, you }: { name: string; you?: boolean }) {
  return (
    <div className={`speaker ${you ? 'you' : 'agent'}`}>
      <span className="speaker-av" aria-hidden>
        {you ? <Icon name="user" size={12} /> : '⚗'}
      </span>
      {name}
    </div>
  );
}

/**
 * A subagent in the chat, where its parent launched it: who it is, how it's doing, and a way into
 * its own chat. What it was asked and what it answered open in place.
 */
export function SubagentCard({ sessionId, agentId, toolUseId, type, description, prompt, answer, pending, failed, live }: { sessionId: string; agentId?: string | null; toolUseId?: string; type: string; description: string; prompt: string; answer: string; pending: boolean; failed: boolean; /** Part of a run going on right now. */ live?: boolean }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const select = useStore((s) => s.select);
  const node = useStore((s) => (agentId ? findAgent(s.trees[sessionId], agentId) : findByToolUse(s.trees[sessionId], toolUseId)));
  const alias = useAgentNames((n) => (node ? n.names[sessionId]?.[node.id] : undefined));
  // A failed call is failed. Otherwise the subagent's own state says: one launched in the background
  // keeps working after its call returned. Without it, the call's outcome is all there is.
  const status = failed ? 'error' : node ? node.status : !pending ? 'done' : live ? 'running' : 'idle';
  const working = status === 'running';
  const now = useNow(working && node?.startedTs != null);
  const elapsed = node?.startedTs != null ? (working ? now : (node.endedTs ?? node.startedTs)) - node.startedTs : null;
  const stats = [elapsed != null && elapsed > 0 ? duration(elapsed) : '', node?.toolCalls ? t('agent.toolsN', { n: node.toolCalls }) : '', node?.costUsd ? money(node.costUsd, locale) : ''].filter(Boolean).join(' · ');
  const label = working ? t('run.running') : status === 'done' ? t('chat.subDone') : t(`status.${status}`);
  return (
    <div className={`sub-card st-${status}`}>
      <div className="sub-head">
        {working ? <WorkingOrb size={16} label={label} /> : <StatusDot status={status} />}
        <span className="sub-title">
          <small>
            {t('chat.subagent')} · {typeLabel(node?.type ?? type)}
          </small>
          <b>{alias ?? (description || node?.description || typeLabel(type))}</b>
        </span>
        <span className="sub-side">
          <span className={`sub-state st-${status}`}>{label}</span>
          {stats && <small>{stats}</small>}
        </span>
        {node && (
          <button className="btn-ghost small sub-open" onClick={() => void select(sessionId, node.id)}>
            {t('chat.openChat')} →
          </button>
        )}
      </div>
      {prompt && (
        <details className="sub-more">
          <summary>{t('chat.subAsked')}</summary>
          <LongText text={prompt} />
        </details>
      )}
      {answer && (
        <details className="sub-more">
          <summary>{t('chat.subAnswered')}</summary>
          <LongText text={answer} />
        </details>
      )}
    </div>
  );
}

/** The card of the subagent a tool call launched. */
function SpawnCard({ block, result, sessionId }: { block: ToolUse; result: ToolResult | undefined; sessionId: string }) {
  const input = parseInput(block);
  return (
    <SubagentCard
      sessionId={sessionId}
      agentId={block.spawnsAgentId}
      type={String(input.subagent_type ?? block.name)}
      description={String(input.description ?? block.summary ?? '')}
      prompt={typeof input.prompt === 'string' ? input.prompt : ''}
      answer={result && !result.isError ? result.preview : ''}
      pending={!result}
      failed={!!result?.isError}
    />
  );
}

/** Lines added and removed by an edit call. */
export function editStats(edits: FileDiff[] | undefined): { added: number; removed: number } | null {
  if (!edits?.length) return null;
  let added = 0;
  let removed = 0;
  for (const d of edits) for (const l of lineDiff(d.oldText, d.newText, 0)) l.kind === 'add' ? added++ : l.kind === 'del' && removed++;
  return { added, removed };
}

/** One tool call with its result folded in: a single row that opens to show input and output. */
function ToolRow({ block, result, sessionId }: { block: ToolUse; result: ToolResult | undefined; sessionId: string }) {
  const t = useT();
  const select = useStore((s) => s.select);
  const projectId = useStore((s) => s.settings.activeProjectId);
  const openFileAt = useStore((s) => s.openFileAt);
  // Failures open by themselves: they're what you want to read.
  const [open, setOpen] = useState(!!result?.isError);
  const [raw, setRaw] = useState(false);
  const root = useProjectRoot();
  const file = fileOf(block);
  const lines = result?.preview ? result.preview.split('\n').length : 0;
  const name = block.name.startsWith('mcp__') ? block.name.split('__').slice(1).join(' · ') : block.name;
  const stats = editStats(block.edits);
  // Write replaces a whole file: it's only "new" when Claude Code says it created it.
  const created = block.name === 'Write' && result ? /created/i.test(result.preview) : undefined;
  const shown = displaySummary(block.name, block.input, block.summary);
  // Paths inside the project read relative; the stored summary may have been cut short (160 characters).
  const rel = file ? relativeTo(file, root) : null;
  const summary = file && rel && rel !== file ? (shown.includes(file) ? shown.replace(file, rel) : file.startsWith(shown.replace(/…$/, '')) ? rel : shown) : shown;
  if (block.ask?.length) return <QuestionCard block={block} result={result} />;
  return (
    <div
      className={`tool ${block.spawnsAgentId ? 'spawn' : ''} ${result?.isError ? 'failed' : ''}`}
      onContextMenu={contextMenu(
        () => [
          { id: 'copy-input', label: t('transcript.copyInput') },
          { id: 'copy-output', label: t('transcript.copyOutput'), enabled: !!result?.preview },
          ...(file && projectId != null ? [{ id: 'open-file', label: t('transcript.openFile') }] : []),
        ],
        (id) => {
          if (id === 'copy-input') void window.alchemist.copyText(block.input);
          if (id === 'copy-output' && result) void window.alchemist.copyText(result.preview);
          if (id === 'open-file' && file && projectId != null) openFileAt(projectId, file);
        },
      )}
    >
      <div className={`tool-head ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
        <span className="ic">{TOOL_ICONS[block.name] ?? (block.name.startsWith('mcp__') ? '◇' : '•')}</span>
        <span className="nm">{name}</span>
        <span className="sum" title={block.summary}>{summary}</span>
        <span className="tool-status">
          {stats && created === false ? (
            <small className="tool-stats">{t('transcript.rewrote', { n: stats.added })}</small>
          ) : (
            stats && (
              <small className="tool-stats">
                <span className="plus">+{stats.added}</span> <span className="minus">−{stats.removed}</span>
              </small>
            )
          )}
          {result ? (result.isError ? <span className="bad">✕</span> : <span className="ok">✓</span>) : <span className="pending">…</span>}
          {!stats && lines > 1 && <small>{t('transcript.lines', { n: lines })}</small>}
        </span>
        {file && projectId != null && (
          <button
            className="link open-agent"
            title={t('transcript.openFile')}
            onClick={(e) => {
              e.stopPropagation();
              openFileAt(projectId, file);
            }}
          >
            <Icon name="goto" size={12} />
          </button>
        )}
        {block.spawnsAgentId && (
          <button
            className="link open-agent"
            onClick={(e) => {
              e.stopPropagation();
              void select(sessionId, block.spawnsAgentId!);
            }}
          >
            {t('transcript.openAgent')} →
          </button>
        )}
      </div>
      {open && (
        <div className="tool-open">
          {block.edits && !raw ? (
            <>
              {block.edits.map((d, i) => (
                <DiffPreview key={i} diff={d} newFile={created ?? d.oldText == null} />
              ))}
              {result?.isError && <pre className="tool-body tool-out error">{result.preview || '∅'}</pre>}
              <button className="link small" onClick={() => setRaw(true)}>
                {t('transcript.showInput')}
              </button>
            </>
          ) : (
            <>
              {raw ? block.input && <pre className="tool-body">{block.input}</pre> : <ToolInput use={block} />}
              {result && <pre className={`tool-body tool-out ${result.isError ? 'error' : ''}`}>{result.preview || '∅'}</pre>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "Ran 7 tools · Bash ×3, Read ×2 · 1 failed", opening to the rows; opens by itself on a failure or a call still running. */
function ToolGroup({ tools, sessionId }: { tools: Array<{ use: ToolUse; result: ToolResult | undefined }>; sessionId: string }) {
  const t = useT();
  const failed = tools.filter((x) => x.result?.isError).length;
  const pending = tools.some((x) => !x.result);
  const [open, setOpen] = useState(failed > 0 || pending);
  const stats = editStats(tools.flatMap((x) => x.use.edits ?? []));
  return (
    <div className={`tool-group ${failed ? 'failed' : ''}`}>
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <span className="ic">⋮</span>
        <span className="nm group-nm">{t('transcript.ranTools', { n: tools.length })}</span>
        <span className="sum">{toolSummary(tools)}</span>
        <span className="tool-status">
          {stats && (
            <small className="tool-stats">
              <span className="plus">+{stats.added}</span> <span className="minus">−{stats.removed}</span>
            </small>
          )}
          {failed > 0 ? <span className="bad">✕ {t('transcript.failed', { n: failed })}</span> : pending ? <span className="pending">…</span> : <span className="ok">✓</span>}
        </span>
      </div>
      {open && (
        <div className="tool-group-body">
          {tools.map((x) => (
            <ToolRow key={x.use.id} block={x.use} result={x.result} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A picture from the conversation, loaded from its file when shown; a chip when it can't be. */
function TranscriptImage({ block, sessionId }: { block: Extract<TranscriptBlock, { kind: 'image' }>; sessionId: string }) {
  const t = useT();
  const [src, setSrc] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const ref = block.ref;
  useEffect(() => {
    if (!ref) return;
    let alive = true;
    void window.alchemist.transcriptImage(sessionId, ref.agentId, ref.offset, ref.n).then((url) => alive && setSrc(url));
    return () => {
      alive = false;
    };
  }, [sessionId, ref?.agentId, ref?.offset, ref?.n]);
  if (!src)
    return (
      <span className="image-chip">
        ▣ {t('transcript.image')} · {block.mediaType.replace('image/', '')} · {Math.max(1, Math.round(block.bytes / 1024))} KB
      </span>
    );
  return <img className={`turn-image ${big ? 'big' : ''}`} src={src} alt={t('transcript.image')} onClick={() => setBig(!big)} />;
}

function Block({ block, sessionId }: { block: TranscriptBlock; sessionId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  switch (block.kind) {
    case 'text':
      // Claude Code writes connection failures into the reply itself: show them as the notice they are.
      if (/^API Error:/.test(block.text.trim()))
        return (
          <div className="api-error" role="note">
            <b>⚠ {t('transcript.apiError')}</b>
            <small>{block.text.trim()}</small>
          </div>
        );
      return <LongText text={block.text} />;
    case 'thinking':
      return (
        <details className="thinking">
          <summary>
            {t('transcript.thinking')} <span className="thinking-first">{block.text.trim().split('\n')[0]?.slice(0, 90)}</span>
          </summary>
          <Markdown text={block.text} />
        </details>
      );
    case 'tool_use':
      return block.spawnsAgentId ? <SpawnCard block={block} result={undefined} sessionId={sessionId} /> : <ToolRow block={block} result={undefined} sessionId={sessionId} />;
    case 'tool_result':
      // Results whose call isn't on this page (the call is on an earlier one) still show on their own.
      return (
        <div className={`result ${block.isError ? 'error' : ''}`} onClick={() => setOpen(!open)}>
          <span className="label">{block.isError ? t('transcript.error') : t('transcript.result')}</span>
          <pre className={open ? 'open' : ''}>{block.preview || '∅'}</pre>
        </div>
      );
    case 'image':
      return <TranscriptImage block={block} sessionId={sessionId} />;
    case 'notice':
      return block.text === INTERRUPTED_NOTICE ? <span className="interrupted-note">⏹ {t('transcript.interrupted')}</span> : <span>{block.text}</span>;
  }
}

/** The text of a turn, for copying. */
const textOf = (turn: Turn) =>
  turn.entries
    .flatMap((e) => e.blocks)
    .filter((b): b is Extract<TranscriptBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();

/** Shown on hover: when it was said (and by which model), then copy, reuse, retry and fork. */
function TurnActions({ turn, last, meta }: { turn: Turn; last: boolean; meta: string }) {
  const t = useT();
  const fillComposer = useStore((s) => s.fillComposer);
  const text = textOf(turn);
  if (!text && !meta) return null;
  return (
    <span className="entry-actions">
      {meta && <span className="entry-when">{meta}</span>}
      {text && (
        <>
      <button
        title={t('transcript.copy')}
        onClick={() => {
          void window.alchemist.copyText(text);
          toast(t('transcript.copied'), undefined, 1800);
        }}
      >
        ⧉
      </button>
      {turn.role === 'user' && (
        <button title={t('transcript.reuse')} onClick={() => fillComposer(text)}>
          ✎
        </button>
      )}
      {turn.role === 'user' && last && (
        <button title={t('transcript.retry')} onClick={() => fillComposer(text, true)}>
          ⟳
        </button>
      )}
      {turn.role === 'user' && (
        <button title={t('transcript.editFork')} onClick={() => fillComposer(text, false, true)}>
          ⑂
        </button>
      )}
        </>
      )}
    </span>
  );
}

function RenderBlockView({ b, sessionId }: { b: RenderBlock; sessionId: string }) {
  if (b.kind === 'tool') return b.use.spawnsAgentId ? <SpawnCard block={b.use} result={b.result} sessionId={sessionId} /> : <ToolRow block={b.use} result={b.result} sessionId={sessionId} />;
  if (b.kind === 'tasks') return <TaskList items={b.items} ops={b.ops} />;
  if (b.kind === 'quiet') return <QuietRow use={b.use} result={b.result} />;
  if (b.kind === 'group') return <ToolGroup tools={b.tools} sessionId={sessionId} />;
  return <Block block={b.block} sessionId={sessionId} />;
}

export function TranscriptEntries({ entries, sessionId, isSubagent, who }: { entries: TranscriptEntry[]; sessionId: string; isSubagent: boolean; who?: Speakers }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const fillComposer = useStore((s) => s.fillComposer);
  const turns = buildTurns(entries);
  const firstUser = turns.findIndex((x) => x.role === 'user');
  const lastUser = turns.findLastIndex((x) => x.role === 'user');
  // The conversation header names the model; a switch halfway through gets a quiet divider.
  let lastModel: string | null = null;
  return (
    <div className="entries">
      {turns.map((turn, i) => {
        if (turn.role === 'system') {
          const text = textOf(turn);
          const first = text.split('\n').find((l) => l.trim() && !/^<\/?[\w-]+>$/.test(l.trim())) ?? text;
          return (
            <details key={turn.key} className="system-line">
              <summary>
                <span className="system-ic">⚙</span> {first.replace(/^\[|\]$/g, '').replace(/<[^>]+>/g, '').trim().slice(0, 140)}
                <span className="time">{clockTime(turn.ts, locale)}</span>
              </summary>
              <pre>{text}</pre>
            </details>
          );
        }
        if (turn.role === 'notice') {
          return (
            <div key={turn.key} className={`notice-line ${turn.entries[0]!.role}`}>
              {turn.blocks.map((b, j) => (
                <RenderBlockView key={j} b={b} sessionId={sessionId} />
              ))}
            </div>
          );
        }
        const brief = isSubagent && i === firstUser;
        const text = textOf(turn);
        const start = clockTime(turn.ts, locale);
        const end = clockTime(turn.endTs, locale);
        const when = start && end && start !== end ? `${start}–${end}` : start;
        const switched = turn.role === 'assistant' && turn.model && lastModel && turn.model !== lastModel ? turn.model : null;
        if (turn.role === 'assistant' && turn.model) lastModel = turn.model;
        return (
          <Fragment key={turn.key}>
          {switched && (
            <div className="model-switch" role="separator">
              <span>{modelLabel(switched)}</span>
            </div>
          )}
          <div
            className={`entry ${turn.role} ${brief ? 'brief' : ''}`}
            onContextMenu={
              text
                ? contextMenu(
                    () => [
                      { id: 'copy', label: t('transcript.copy') },
                      ...(turn.role === 'user' ? [{ id: 'reuse', label: t('transcript.reuse') }] : []),
                      ...(turn.role === 'user' && i === lastUser && !isSubagent ? [{ id: 'retry', label: t('transcript.retry') }] : []),
                      ...(turn.role === 'user' && !isSubagent ? [{ id: 'fork', label: t('transcript.editFork') }] : []),
                    ],
                    (id) => {
                      if (id === 'copy') void window.alchemist.copyText(text);
                      if (id === 'reuse') fillComposer(text);
                      if (id === 'retry') fillComposer(text, true);
                      if (id === 'fork') fillComposer(text, false, true);
                    },
                  )
                : undefined
            }
          >
            <TurnActions turn={turn} last={i === lastUser && !isSubagent} meta={[when, turn.role === 'assistant' && turn.model ? modelLabel(turn.model) : ''].filter(Boolean).join(' · ')} />
            {who && (turn.role === 'user' ? <Who name={who.you ? who.asker : t('chat.asked', { name: who.asker })} you={who.you} /> : <Who name={who.agent} />)}
            <div className="entry-body">
              {brief && !who && <span className="brief-label">{t('agent.brief')}</span>}
              {turn.blocks.map((b, j) => (
                <RenderBlockView key={j} b={b} sessionId={sessionId} />
              ))}
            </div>
          </div>
          </Fragment>
        );
      })}
    </div>
  );
}
