import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/renderer/src/components/Markdown';

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('never turns text into HTML', () => {
    const out = html('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });

  it('renders headings, lists, task lists, quotes, rules and inline styles', () => {
    const out = html('# Plan\n\n1. First **bold**\n2. Second `code`\n   continued\n\n- [x] done\n- [ ] todo\n  - nested *soft*\n\n> quoted\n\n---\n\nSee [docs](https://example.com).');
    expect(out).toContain('<p class="h h1">Plan</p>');
    expect(out).toContain('<ol><li class="d0">First <strong>bold</strong></li><li class="d0">Second <code>code</code> continued</li></ol>');
    expect(out).toContain('<span class="md-check">☑</span> done');
    expect(out).toContain('<span class="md-check">☐</span> todo');
    expect(out).toContain('<li class="d1">nested <em>soft</em></li>');
    expect(out).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(out).toContain('<hr/>');
    // http(s) links open in the browser (the main process only lets those out); other schemes stay text.
    expect(out).toContain('<a class="md-link" href="https://example.com" target="_blank" rel="noreferrer noopener" title="https://example.com">docs</a>');
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it('renders tables', () => {
    const out = html('| Agent | Tests |\n|---|:---:|\n| Claude | ✓ |\n| Codex |');
    expect(out).toContain('<thead><tr><th>Agent</th><th>Tests</th></tr></thead>');
    expect(out).toContain('<tr><td>Claude</td><td>✓</td></tr><tr><td>Codex</td><td></td></tr>');
  });

  it('shows Mermaid source until the diagram loads, and code blocks as code', () => {
    const out = html('```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst a = 1;\n```');
    expect(out).toContain('<pre>graph TD; A--&gt;B</pre>');
    expect(out).toContain('<pre>const a = 1;</pre>');
  });
});

describe('links and paths', () => {
  it('never makes a link out of other schemes, and finds bare URLs', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { Markdown } = await import('../src/renderer/src/components/Markdown');
    const out = renderToStaticMarkup(<Markdown text={'[x](javascript:alert(1)) and see https://example.com/a.'} />);
    expect(out).not.toContain('href="javascript');
    expect(out).toContain('href="https://example.com/a"');
  });
});

describe('round 6: inline code in bold, file links, paths', () => {
  it('renders code inside bold and never makes a link out of dotted words', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { Markdown, MarkdownActions } = await import('../src/renderer/src/components/Markdown');
    const out = renderToStaticMarkup(
      <MarkdownActions.Provider value={{ openPath: () => {} }}>
        <Markdown text={'**`mcore` started** and `com.apple.macl` and `src/app.ts:4` and [app](src/app.ts#L4)'} />
      </MarkdownActions.Provider>,
    );
    expect(out).toContain('<strong><code>mcore</code> started</strong>');
    expect(out).toContain('<code>com.apple.macl</code>');
    expect(out).toContain('class="md-path"');
    expect(out).toContain('class="md-link md-file"');
  });
});
