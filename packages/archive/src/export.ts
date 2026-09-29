import type { AgentNode, SessionSummary, TranscriptBlock, TranscriptEntry } from '@alchemist-coder/core';

export interface ExportAgent {
  node: Omit<AgentNode, 'children'>;
  entries: TranscriptEntry[];
}

export interface ExportInput {
  session: SessionSummary;
  project: { name: string; cwd: string } | null;
  /** Main agent first, then subagents in tree order. */
  agents: ExportAgent[];
  exportedAt: number;
}

export interface ExportOptions {
  thinking?: boolean;
  tools?: boolean;
}

const SOURCE: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', grok: 'Grok Build' };
const iso = (ts: number | null) => (ts == null ? '' : new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
const money = (n: number | null) => (n == null ? '—' : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const onlyResults = (e: TranscriptEntry) => e.blocks.length > 0 && e.blocks.every((b) => b.kind === 'tool_result');
const roleLabel = (e: TranscriptEntry) => (onlyResults(e) ? 'Tool result' : e.role === 'user' ? 'User' : e.role === 'assistant' ? `Assistant${e.model ? ` (${e.model})` : ''}` : e.role === 'notice' ? 'Notice' : 'Meta');
const agentTitle = (n: ExportAgent['node']) => (n.id === 'main' ? 'Main agent' : `${n.type} — ${n.description}`);

function facts(input: ExportInput): Array<[string, string]> {
  const s = input.session;
  return [
    ['Source', SOURCE[s.source] ?? s.source],
    ...(input.project ? ([['Project', `${input.project.name} (${input.project.cwd})`]] as Array<[string, string]>) : []),
    ...(s.gitBranch ? ([['Branch', s.gitBranch]] as Array<[string, string]>) : []),
    ['Models', s.models.join(', ') || '—'],
    ['Messages', String(s.messageCount)],
    ['Agents', String(input.agents.length)],
    ['Estimated cost', money(s.costUsd)],
    ['Started', iso(s.firstTs)],
    ['Last activity', iso(s.lastTs)],
    ['Session id', s.id],
  ];
}

// ---------- Markdown ----------

function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text.replace(/\n$/, '')}\n${f}`;
}

function mdBlock(b: TranscriptBlock, o: Required<ExportOptions>): string | null {
  switch (b.kind) {
    case 'text':
      return b.text.trim();
    case 'thinking':
      return o.thinking && b.text.trim() ? `<details><summary>Thinking</summary>\n\n${b.text.trim()}\n\n</details>` : null;
    case 'tool_use':
      if (!o.tools) return null;
      return `<details><summary>🔧 ${b.name}${b.summary ? ` — ${b.summary.replace(/[<>]/g, '')}` : ''}${b.spawnsAgentId ? ` → subagent ${b.spawnsAgentId}` : ''}</summary>\n\n${fence(b.input, 'json')}\n\n</details>`;
    case 'tool_result':
      return o.tools && b.preview.trim() ? `<details><summary>${b.isError ? '⚠️ Error' : 'Result'}</summary>\n\n${fence(b.preview)}\n\n</details>` : null;
    case 'image':
      return `*[image: ${b.mediaType}, ${Math.round(b.bytes / 1024)} KB]*`;
    case 'notice':
      return `> ${b.text.trim().split('\n').join('\n> ')}`;
  }
}

export function toMarkdown(input: ExportInput, options: ExportOptions = {}): string {
  const o = { thinking: options.thinking ?? false, tools: options.tools ?? true };
  const out = [`# ${input.session.title}`, '', ...facts(input).map(([k, v]) => `- **${k}:** ${v}`), ''];
  for (const a of input.agents) {
    out.push(`## ${agentTitle(a.node)}`, '');
    if (a.node.id !== 'main') out.push(`*depth ${a.node.depth}${a.node.model ? ` · ${a.node.model}` : ''} · ${a.node.status}*`, '');
    for (const e of a.entries) {
      const body = e.blocks.map((b) => mdBlock(b, o)).filter((x): x is string => !!x);
      if (!body.length) continue;
      out.push(`### ${roleLabel(e)}${e.ts ? ` · ${iso(e.ts)}` : ''}`, '', body.join('\n\n'), '');
    }
  }
  out.push('---', `*Exported with Alchemist Coder on ${iso(input.exportedAt)}.*`, '');
  return out.join('\n');
}

// ---------- HTML ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Small, escape-first Markdown: fences, inline code, bold, headings, paragraphs. */
function mdToHtml(text: string): string {
  return text
    .split(/```/)
    .map((part, i) => {
      if (i % 2 === 1) return `<pre>${esc(part.replace(/^[\w+-]*\n/, '').replace(/\n$/, ''))}</pre>`;
      return part
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p) => {
          const h = /^(#{1,4})\s+(.*)$/.exec(p.trim());
          const inline = (s: string) =>
            esc(s)
              .replace(/`([^`\n]+)`/g, '<code>$1</code>')
              .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
              .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
          if (h && !p.trim().includes('\n')) return `<h4>${inline(h[2]!)}</h4>`;
          return `<p>${p.split('\n').map(inline).join('<br>')}</p>`;
        })
        .join('');
    })
    .join('');
}

function htmlBlock(b: TranscriptBlock, o: Required<ExportOptions>): string {
  switch (b.kind) {
    case 'text':
      return `<div class="text">${mdToHtml(b.text)}</div>`;
    case 'thinking':
      return o.thinking && b.text.trim() ? `<details class="thinking"><summary>Thinking</summary>${mdToHtml(b.text)}</details>` : '';
    case 'tool_use':
      if (!o.tools) return '';
      return `<details class="tool"><summary><b>${esc(b.name)}</b> ${esc(b.summary)}${b.spawnsAgentId ? ` <a href="#agent-${esc(b.spawnsAgentId)}">→ subagent</a>` : ''}</summary><pre>${esc(b.input)}</pre></details>`;
    case 'tool_result':
      return o.tools && b.preview.trim() ? `<details class="result${b.isError ? ' error' : ''}"><summary>${b.isError ? 'Error' : 'Result'}</summary><pre>${esc(b.preview)}</pre></details>` : '';
    case 'image':
      return `<p class="muted">[image: ${esc(b.mediaType)}, ${Math.round(b.bytes / 1024)} KB]</p>`;
    case 'notice':
      return `<p class="notice">${esc(b.text)}</p>`;
  }
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1f24;--muted:#6b7486;--line:#e3e6eb;--card:#f6f7f9;--accent:#d97a4a;--user:#eef3ff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e9ef;--muted:#8b93a3;--line:#232a36;--card:#151922;--user:#141c2c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 22px 80px}h1{font-size:26px;margin:0 0 12px}h2{margin:44px 0 14px;padding-top:14px;border-top:1px solid var(--line);font-size:19px}
h4{margin:12px 0 6px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:13px;color:var(--muted);margin:0 0 20px}dt{font-weight:600}dd{margin:0;word-break:break-all}
.entry{border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:10px 0;background:var(--card)}.entry.user{background:var(--user)}
.who{font-size:12px;color:var(--muted);margin-bottom:6px;display:flex;justify-content:space-between;gap:10px}.who b{color:var(--fg)}
pre{background:rgba(127,127,127,.12);border-radius:8px;padding:10px 12px;overflow-x:auto;font:12.5px/1.5 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-wrap;word-break:break-word}
code{font:13px ui-monospace,"SF Mono",Menlo,monospace;background:rgba(127,127,127,.14);padding:1px 5px;border-radius:4px}
details{margin:6px 0}summary{cursor:pointer;font-size:13px;color:var(--muted)}summary b{color:var(--accent)}.error summary{color:#e5534b}
.text{overflow-wrap:anywhere}.entry.tool{background:transparent;padding:6px 16px}.notice,.muted{color:var(--muted);font-size:13px}.sub{font-size:13px;color:var(--muted);margin:-8px 0 12px}a{color:var(--accent)}footer{margin-top:50px;color:var(--muted);font-size:12px}`;

export function toHtml(input: ExportInput, options: ExportOptions = {}): string {
  const o = { thinking: options.thinking ?? false, tools: options.tools ?? true };
  const sections = input.agents
    .map((a) => {
      const entries = a.entries
        .map((e) => {
          const body = e.blocks.map((b) => htmlBlock(b, o)).join('');
          return body ? `<div class="entry ${onlyResults(e) ? 'tool' : e.role}"><div class="who"><b>${esc(roleLabel(e))}</b><span>${esc(iso(e.ts))}</span></div>${body}</div>` : '';
        })
        .join('');
      const sub = a.node.id === 'main' ? '' : `<p class="sub">depth ${a.node.depth}${a.node.model ? ` · ${esc(a.node.model)}` : ''} · ${esc(a.node.status)}</p>`;
      return `<section id="agent-${esc(a.node.id)}"><h2>${esc(agentTitle(a.node))}</h2>${sub}${entries}</section>`;
    })
    .join('');
  const dl = facts(input)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(input.session.title)}</title><style>${CSS}</style></head>
<body><main><h1>${esc(input.session.title)}</h1><dl>${dl}</dl>${sections}
<footer>Exported with Alchemist Coder on ${esc(iso(input.exportedAt))}.</footer></main></body></html>
`;
}

// ---------- JSON ----------

export function toJson(input: ExportInput): string {
  return `${JSON.stringify({ format: 'alchemist-coder/conversation', version: 1, exportedAt: new Date(input.exportedAt).toISOString(), session: input.session, project: input.project, agents: input.agents }, null, 2)}\n`;
}

/** Depth-first list of an agent tree, main agent first. */
export function flattenAgents(root: AgentNode): Array<Omit<AgentNode, 'children'>> {
  const out: Array<Omit<AgentNode, 'children'>> = [];
  const walk = (n: AgentNode) => {
    const { children, ...rest } = n;
    out.push(rest);
    children.forEach(walk);
  };
  walk(root);
  return out;
}
