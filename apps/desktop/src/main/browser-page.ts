/**
 * The page side of the built-in browser, kept free of Electron so it can be tested: what the address
 * bar makes of what you type, the script that reads a page for an agent, and how that reading is
 * written down for it.
 */

/** Where the address bar goes: a web address as is, a bare domain over https, anything else a search. */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^about:blank$/i.test(s)) return 'about:blank';
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).href;
    } catch {
      return null;
    }
  }
  // Other schemes (file:, javascript:, data:…) never load here.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^localhost:\d+/i.test(s)) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s);
  if (local || (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(s) && !/\s/.test(s))) {
    try {
      return new URL(`${local ? 'http' : 'https'}://${s}`).href;
    } catch {
      return null;
    }
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

export interface PageElement {
  ref: number;
  tag: string;
  role: string | null;
  name: string;
  href: string | null;
  type: string | null;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
}

/** Text an agent reads at most per page; the rest is cut (it can scroll and read again). */
export const MAX_TEXT = 12_000;
export const MAX_ELEMENTS = 250;

/**
 * Runs in the page (an isolated world): numbers what can be clicked or typed into that is on
 * screen or near it (`data-ac-ref`), and returns it with the page's visible text.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const MAX_TEXT = ${MAX_TEXT}, MAX_ELEMENTS = ${MAX_ELEMENTS};
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [contenteditable=""], [contenteditable=true], [onclick]';
  for (const el of document.querySelectorAll('[data-ac-ref]')) el.removeAttribute('data-ac-ref');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
    return r.bottom > -window.innerHeight && r.top < window.innerHeight * 2;
  };
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
  const out = [];
  let ref = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= MAX_ELEMENTS) break;
    if (el.disabled || !visible(el)) continue;
    ref += 1;
    el.setAttribute('data-ac-ref', String(ref));
    const tag = el.tagName.toLowerCase();
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('name') || '';
    out.push({ ref, tag, role: el.getAttribute('role'), name: clean(label), href: tag === 'a' ? el.href : null, type: el.getAttribute('type') });
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\\n…' : text, elements: out };
})()`;

/** Runs in the page: scrolls the numbered element into view and says where its middle is now. */
export function locateScript(ref: number): string {
  return `(() => {
    const el = document.querySelector('[data-ac-ref="${Math.trunc(ref)}"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), editable: el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName) };
  })()`;
}

/** Runs in the page: focuses the numbered field and empties it, ready for new text. */
export function focusScript(ref: number, clear: boolean): string {
  return `(() => {
    const el = document.querySelector('[data-ac-ref="${Math.trunc(ref)}"]');
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (${clear ? 'true' : 'false'}) {
      if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (el.isContentEditable) el.textContent = '';
    }
    return true;
  })()`;
}

/** Lines of the page's text that `find` keeps: the ones that mention it, with one line around each. */
export const MAX_FOUND_LINES = 60;

function elementLine(e: PageElement): string {
  const kind = e.role ?? (e.tag === 'a' ? 'link' : e.tag === 'input' ? `input${e.type ? `:${e.type}` : ''}` : e.tag);
  return `[${e.ref}] ${kind} "${e.name}"${e.href ? ` → ${e.href}` : ''}`;
}

/**
 * What the agent reads: where it is, what it can act on (by number), and the page's text. With `find`
 * (alternatives separated by |), only what mentions it: a long console page costs a few lines instead of
 * thousands of tokens. Numbers stay the same either way, so a click after a filtered read still works.
 */
export function formatSnapshot(s: PageSnapshot, find = ''): string {
  const lines = [`URL: ${s.url}`, `Title: ${s.title || '(none)'}`, ''];
  const wanted = find.split('|').map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (wanted.length) {
    const hit = (x: string | null) => !!x && wanted.some((w) => x.toLowerCase().includes(w));
    const elements = s.elements.filter((e) => hit(e.name) || hit(e.href));
    const text = (s.text || '').split('\n');
    const keep = new Set<number>();
    text.forEach((line, i) => {
      if (hit(line)) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < text.length) keep.add(j);
    });
    const kept = [...keep].sort((x, y) => x - y).slice(0, MAX_FOUND_LINES);
    if (!elements.length && !kept.length) {
      lines.push(`Nothing on this page mentions "${find}". Read it without find, or try other words.`);
      return lines.join('\n');
    }
    lines.push(`Only what mentions "${find}": ${elements.length} of ${s.elements.length} things to act on, ${kept.length} of ${text.length} lines of text. Read without find for the whole page.`, '');
    if (elements.length) lines.push('Things to click or type into (use their number):', ...elements.map(elementLine), '');
    if (kept.length) {
      lines.push('Page text:');
      kept.forEach((n, i) => {
        if (i && n !== kept[i - 1]! + 1) lines.push('…');
        lines.push(text[n]!);
      });
    }
    return lines.join('\n');
  }
  if (s.elements.length) {
    lines.push('Things to click or type into (use their number):', ...s.elements.map(elementLine));
  } else {
    lines.push('Nothing to click or type into on screen.');
  }
  lines.push('', 'Page text:', s.text || '(empty)');
  return lines.join('\n');
}

/** Keys an agent can press by name. */
export const KEYS = ['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'] as const;
export type Key = (typeof KEYS)[number];

/** Runs in the page: clicks the numbered element from inside it (when the window isn't on screen). */
export function clickScript(ref: number): string {
  return `(() => {
    const el = document.querySelector('[data-ac-ref="${Math.trunc(ref)}"]');
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    if (typeof el.focus === 'function') el.focus();
    el.click();
    return true;
  })()`;
}

/**
 * Runs in the page: a key on the focused element from inside it (when the window isn't on screen).
 * Enter in a form field submits its form, as it would for a person.
 */
export function keyScript(key: Key): string {
  const name = JSON.stringify(key === 'Space' ? ' ' : key);
  return `(() => {
    const el = document.activeElement || document.body;
    const init = { key: ${name}, bubbles: true, cancelable: true };
    const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (go && ${name} === 'Enter' && el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
    return true;
  })()`;
}
