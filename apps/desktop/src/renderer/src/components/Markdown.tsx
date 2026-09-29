import { createContext, Fragment, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ThemedToken } from 'shiki/core';
import { highlight, safeColor } from '../highlight';
import { useCurrentTheme } from '../theme-state';

const Mermaid = lazy(() => import('./Mermaid'));

/** Where the chat opens a file path it shows (set by the conversation panel). */
export const MarkdownActions = createContext<{ openPath?: (path: string, line?: number) => void }>({});

const WEB = /^https?:\/\/[^\s<>"']+$/;
/** A file path, maybe with :line[:col] ("src/app.ts:42"). Needs an extension, so words and commands don't match. */
const PATH = /^(?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10}(?::(\d+))?(?::\d+)?$/;

function Code({ text }: { text: string }) {
  const { openPath } = useContext(MarkdownActions);
  // A folder separator is required: "com.apple.macl" or "v1.2" aren't files.
  const path = openPath && !text.includes(' ') && text.includes('/') ? PATH.exec(text) : null;
  if (!path) return <code>{text}</code>;
  return (
    <code className="md-path" role="link" tabIndex={0} title={text} onClick={() => openPath!(text.replace(/(:\d+){1,2}$/, ''), path[1] ? Number(path[1]) : undefined)} onKeyDown={(e) => e.key === 'Enter' && openPath!(text.replace(/(:\d+){1,2}$/, ''), path[1] ? Number(path[1]) : undefined)}>
      {text}
    </code>
  );
}

/** http(s) links open in the browser (the main process decides); links to project files open them. */
function Link({ url, children }: { url: string; children: ReactNode }) {
  const { openPath } = useContext(MarkdownActions);
  if (!WEB.test(url)) {
    // "src/app.ts#L42", "./README.md", "/abs/path.ts:10": files the agent pointed at.
    const target = /^(?:file:\/\/)?([^#?\s]+?)(?:#L(\d+)|:(\d+))?$/.exec(url);
    const path = target?.[1] && !/^[a-z][\w+.-]*:/i.test(target[1]) ? decodeURIComponent(target[1]) : null;
    if (path && openPath)
      return (
        <a
          className="md-link md-file"
          href="#"
          title={url}
          onClick={(e) => {
            e.preventDefault();
            openPath(path, Number(target![2] ?? target![3]) || undefined);
          }}
        >
          {children}
        </a>
      );
    return (
      <span className="md-link" title={url}>
        {children}
      </span>
    );
  }
  return (
    <a className="md-link" href={url} target="_blank" rel="noreferrer noopener" title={url}>
      {children}
    </a>
  );
}

/**
 * A deliberately small Markdown renderer that only builds React elements —
 * transcripts are untrusted text, so nothing is ever injected as HTML.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*]))/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) out.push(<Code key={key} text={tok.slice(1, -1)} />);
    else if (tok.startsWith('**')) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    else if (tok.startsWith('http')) out.push(<Link key={key} url={tok}>{tok}</Link>);
    else if (tok.startsWith('[')) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      out.push(
        <Link key={key} url={url!}>
          {label}
        </Link>,
      );
    } else out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

function blocks(text: string, keyBase: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let para: string[] = [];
  let n = 0;
  const key = () => `${keyBase}-${n++}`;
  const flush = () => {
    if (!para.length) return;
    const k = key();
    out.push(
      <p key={k}>
        {para.map((line, i) => (
          <Fragment key={i}>
            {i > 0 && <br />}
            {inline(line, `${k}-${i}`)}
          </Fragment>
        ))}
      </p>,
    );
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line.trim());
    if (heading) {
      flush();
      const k = key();
      out.push(
        <p key={k} className={`h h${Math.min(heading[1]!.length, 4)}`}>
          {inline(heading[2]!, k)}
        </p>,
      );
      continue;
    }
    if (RULE.test(line) && !para.length) {
      out.push(<hr key={key()} />);
      continue;
    }
    if (line.trim().startsWith('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      i--;
      const k = key();
      out.push(
        <div key={k} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, `${k}-h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j}>{inline(r[j] ?? '', `${k}-${ri}-${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (ITEM.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items: Array<{ depth: number; text: string }> = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (m) items.push({ depth: Math.min(Math.floor(m[1]!.replace(/\t/g, '  ').length / 2), 3), text: m[3]! });
        else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) items[items.length - 1]!.text += ` ${lines[i]!.trim()}`;
        else break;
        i++;
      }
      i--;
      const k = key();
      const Tag = ordered ? 'ol' : 'ul';
      out.push(
        <Tag key={k}>
          {items.map((it, j) => {
            const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
            return (
              <li key={j} className={`d${it.depth}${task ? ' task' : ''}`}>
                {task ? (
                  <>
                    <span className="md-check">{task[1] === ' ' ? '☐' : '☑'}</span> {inline(task[2]!, `${k}-${j}`)}
                  </>
                ) : (
                  inline(it.text, `${k}-${j}`)
                )}
              </li>
            );
          })}
        </Tag>,
      );
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(QUOTE.exec(lines[i++]!)![1]!);
      i--;
      const k = key();
      out.push(<blockquote key={k}>{blocks(quoted.join('\n'), k)}</blockquote>);
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

/** A fenced code block with its language and a Copy button. */
function CodeBlock({ lang, body }: { lang: string; body: string }) {
  const [copied, setCopied] = useState(false);
  const theme = useCurrentTheme((s) => s.theme);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  useEffect(() => {
    if (!theme || !lang) return setTokens(null);
    let alive = true;
    // Plain first; colors arrive once the language is loaded.
    void highlight(body, lang, theme).then((t) => alive && setTokens(t));
    return () => {
      alive = false;
    };
  }, [body, lang, theme]);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || 'text'}</span>
        <button
          onClick={() => {
            void window.alchemist.copyText(body);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? '✓' : '⧉'}
        </button>
      </div>
      <pre>
        {tokens
          ? tokens.map((line, i) => (
              <span key={i} className="code-line">
                {line.map((tok, j) => (
                  <span key={j} style={{ color: safeColor(tok.color), fontStyle: tok.fontStyle === 1 ? 'italic' : undefined, fontWeight: tok.fontStyle === 2 ? 600 : undefined }}>
                    {tok.content}
                  </span>
                ))}
                {i < tokens.length - 1 ? '\n' : ''}
              </span>
            ))
          : body}
      </pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <div className="md">
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const nl = part.indexOf('\n');
          const lang = nl >= 0 ? part.slice(0, nl).trim() : '';
          const body = nl >= 0 && /^[\w+-]*$/.test(lang) ? part.slice(nl + 1).replace(/\n$/, '') : part;
          // An unclosed fence (still streaming) stays plain code.
          if (lang === 'mermaid' && i < parts.length - 1) {
            return (
              <Suspense key={i} fallback={<pre>{body}</pre>}>
                <Mermaid code={body} />
              </Suspense>
            );
          }
          return <CodeBlock key={i} lang={/^[\w+-]*$/.test(lang) ? lang : ''} body={body} />;
        }
        return <Fragment key={i}>{blocks(part, String(i))}</Fragment>;
      })}
    </div>
  );
}
