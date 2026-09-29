import { useState } from 'react';
import type { LiveBlock, LiveTurn } from '../live-turns';
import { useStore, useT, type RunState } from '../store';
import { DiffPreview, PermissionCard } from './LiveRun';
import { mainFields, QuestionForm, questionHeading } from './QuestionForm';
import { Markdown } from './Markdown';
import { QuietRow, ToolInput } from './Transcript';
import { displaySummary } from '../transcript-model';

const STATE_ICON: Record<string, string> = { pending: '…', running: '◐', done: '✓', failed: '✕' };

/** The bot tools, named for people ("Created a bot"), and other MCP tools without their server prefix. */
function toolLabel(name: string, t: ReturnType<typeof useT>): { label: string; icon: string | null } {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (!m) return { label: name, icon: null };
  if (m[1] === 'alchemist_bots') {
    const key = `bots.tool.${m[2]}`;
    const label = t(key as never);
    return { label: label === key ? m[2]! : label, icon: '⚗' };
  }
  return { label: m[2]!, icon: '◇' };
}

const QUIET = new Set(['ToolSearch', 'Skill']);

/** What a bot tool call was about: the bot's name (and task), from its input or the team. */
function botCallSummary(tool: { name: string; input?: string; output?: string }): { text: string; botId: string | null } | null {
  const m = /^mcp__alchemist_bots__(.+)$/.exec(tool.name);
  if (!m) return null;
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(tool.input ?? '{}') as Record<string, unknown>;
  } catch {
    input = {};
  }
  const s = useStore.getState();
  const team = s.botTeams.find((x) => x.id === s.activeTeamId);
  if (m[1] === 'create_bot') {
    const id = /\bid (b\d+)/.exec(tool.output ?? '')?.[1] ?? null;
    const task = String(input.task ?? '').replace(/\s+/g, ' ');
    return { text: `${String(input.name ?? '')}${task ? ` — ${task.slice(0, 120)}` : ''}`, botId: id };
  }
  const id = typeof input.bot_id === 'string' ? input.bot_id : null;
  const name = team?.bots.find((b) => b.id === id)?.name ?? id ?? '';
  return { text: name, botId: id };
}

function LiveToolRow({ tool }: { tool: Extract<LiveBlock, { kind: 'tool' }>['tool'] }) {
  const t = useT();
  const [open, setOpen] = useState(tool.state === 'failed');
  const diffs = tool.diffs ?? [];
  const { label, icon } = toolLabel(tool.name, t);
  const bot = botCallSummary(tool);
  const summary = bot?.text ?? (tool.summary === tool.name ? '' : displaySummary(tool.name, tool.input, tool.summary));
  const canOpen = diffs.length > 0 || !!tool.input || !!tool.output;
  if (QUIET.has(tool.name)) {
    return <QuietRow use={{ kind: 'tool_use', id: tool.id ?? '', name: tool.name, summary: tool.summary, input: tool.input ?? '{}', spawnsAgentId: null }} result={undefined} />;
  }
  return (
    <div className={`tool ${tool.state === 'failed' ? 'failed' : ''}`}>
      <div className={`tool-head ${open ? 'open' : ''}`} onClick={() => canOpen && setOpen(!open)}>
        <span className="ic">{icon ?? (tool.kind === 'execute' ? '$' : tool.kind === 'edit' ? '✎' : tool.kind === 'read' ? '▤' : '•')}</span>
        <span className="nm">{label}</span>
        <span className="sum">{summary}</span>
        {bot?.botId && (
          <button
            className="link open-agent"
            title={t('bots.openBot')}
            onClick={(e) => {
              e.stopPropagation();
              useStore.setState({ activeBotId: bot.botId });
            }}
          >
            →
          </button>
        )}
        <span className="tool-status">
          <span className={tool.state === 'failed' ? 'bad' : tool.state === 'done' ? 'ok' : 'pending'}>{STATE_ICON[tool.state ?? 'pending']}</span>
          {diffs.length > 0 && <small>±{diffs.length}</small>}
        </span>
      </div>
      {open && (
        <div className="tool-open">
          {diffs.map((d, i) => (
            <DiffPreview key={i} diff={d} />
          ))}
          {!diffs.length && tool.input && <ToolInput use={{ kind: 'tool_use', id: tool.id ?? '', name: tool.name, summary: tool.summary, input: tool.input, spawnsAgentId: null }} />}
          {tool.output && <pre className={`tool-body tool-out ${tool.state === 'failed' ? 'error' : ''}`}>{tool.output}</pre>}
        </div>
      )}
    </div>
  );
}

function Block({ b, run, last }: { b: LiveBlock; run: RunState; last: boolean }) {
  const t = useT();
  switch (b.kind) {
    case 'text':
      return <Markdown text={b.text} />;
    case 'thinking':
      // The latest thought stays open while the agent is still thinking.
      return (
        <details className="thinking" open={last && run.status === 'running'}>
          <summary>
            {t('transcript.thinking')} <span className="thinking-first">{b.text.trim().split('\n')[0]}</span>
          </summary>
          <Markdown text={b.text} />
        </details>
      );
    case 'tool':
      return <LiveToolRow tool={b.tool} />;
    case 'permission':
      if (!b.resolved) return <PermissionCard runId={run.runId} request={b.request} />;
      return (
        <div className={`perm-done ${b.choiceId && !/reject|deny/i.test(b.choiceId) ? 'ok' : 'no'}`}>
          {b.choiceId && !/reject|deny/i.test(b.choiceId) ? '✓' : '✕'} {b.request.title}
        </div>
      );
    case 'question':
      if (!b.resolved) return <QuestionForm runId={run.runId} request={b.request} />;
      return (
        <div className={`perm-done q-done ${b.answered ? 'ok' : 'no'}`}>
          <span className="q-done-q">{questionHeading(b.request) || t('ask.nQuestions', { n: mainFields(b.request).length })}</span>
          <span className="q-done-a">{b.answered ? b.summary || t('ask.answered') : `— ${t('ask.skipped')}`}</span>
        </div>
      );
  }
}

function Turn({ turn, run, isLast }: { turn: LiveTurn; run: RunState; isLast: boolean }) {
  const t = useT();
  const working = isLast && turn.endedAt === null;
  return (
    <>
      {turn.prompt && (
        <div className="entry user live-entry">
          <div className="entry-body">
            <Markdown text={turn.prompt} />
            {!!turn.images?.length && (
              <div className="turn-images">
                {turn.images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={t('transcript.image')}
                    tabIndex={0}
                    onClick={(e) => e.currentTarget.classList.toggle('big')}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {(turn.blocks.length > 0 || working) && (
        <div className="entry assistant live-entry">
          <div className="entry-body">
            {turn.blocks.map((b, i) =>
              // The question card stands for the agent's AskUserQuestion call: no second row for it.
              b.kind === 'tool' && b.tool.name === 'AskUserQuestion' && turn.blocks.some((x) => x.kind === 'question') ? null : (
                <Block key={i} b={b} run={run} last={i === turn.blocks.length - 1} />
              ),
            )}
            {working && (
              <span className={`live-working ${run.status === 'waiting' ? 'waiting' : ''}`} role="status">
                <span className="live-dot" aria-hidden /> {t(run.status === 'waiting' ? 'run.waiting' : 'run.running')}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The turns of a run as they happen, drawn like the rest of the conversation. */
export function LiveTurns({ runId }: { runId: string }) {
  const run = useStore((s) => s.runs[runId]);
  if (!run?.turns.length) return null;
  return (
    <div className="entries live-turns">
      {run.turns.map((turn, i) => (
        <Turn key={turn.startedAt} turn={turn} run={run} isLast={i === run.turns.length - 1} />
      ))}
    </div>
  );
}
