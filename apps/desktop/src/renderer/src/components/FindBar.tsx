import { useEffect, useRef, useState, type RefObject } from 'react';
import { useT } from '../store';
import { foldWithMap } from '../fold';

const MAX_MATCHES = 2000;

/** Every match of `query` (case and accents ignored) in the visible text under `root`. */
function findRanges(root: HTMLElement, query: string): Range[] {
  const q = foldWithMap(query).folded;
  const ranges: Range[] = [];
  if (!q) return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // Not inside the find bar, buttons, or anything hidden (a closed "Thinking", for one).
    acceptNode: (n) => {
      const el = n.parentElement;
      if (!el || el.closest('.find-bar, button, .sr-only')) return NodeFilter.FILTER_REJECT;
      return el.checkVisibility?.() === false ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node && ranges.length < MAX_MATCHES; node = walker.nextNode()) {
    const { folded, map } = foldWithMap(node.textContent ?? '');
    for (let i = folded.indexOf(q); i >= 0 && ranges.length < MAX_MATCHES; i = folded.indexOf(q, i + q.length)) {
      const r = document.createRange();
      r.setStart(node, map[i]!);
      r.setEnd(node, map[i + q.length - 1]! + 1);
      ranges.push(r);
    }
  }
  return ranges;
}

const highlights = () => (globalThis.CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
const clear = () => {
  highlights()?.delete('find');
  highlights()?.delete('find-current');
};

/**
 * ⌘F in a conversation: highlights matches in what's loaded (CSS highlights, so the DOM is left
 * alone) and steps through them.
 */
export function FindBar({ root, version, onClose, more, onLoadMore }: { root: RefObject<HTMLElement | null>; version: unknown; onClose: () => void; more?: number; onLoadMore?: () => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => clear, []);
  useEffect(() => {
    const el = root.current;
    if (!el || !query.trim()) {
      ranges.current = [];
      setCount(0);
      clear();
      return;
    }
    ranges.current = findRanges(el, query.trim());
    setCount(ranges.current.length);
    const Highlight = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (Highlight) highlights()?.set('find', new Highlight(...ranges.current));
  }, [query, version]);
  useEffect(() => {
    const list = ranges.current;
    if (!list.length) return highlights()?.delete('find-current') as unknown as void;
    const current = list[((index % list.length) + list.length) % list.length]!;
    const Highlight = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (Highlight) highlights()?.set('find-current', new Highlight(current));
    current.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  }, [index, count]);
  const step = (d: number) => setIndex((i) => i + d);
  const shown = count ? (((index % count) + count) % count) + 1 : 0;
  return (
    <div className="find-bar" role="search">
      <input
        ref={input}
        value={query}
        placeholder={t('find.placeholder')}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="find-count">{query.trim() ? (count ? `${shown}/${count}${count >= MAX_MATCHES ? '+' : ''}` : t('find.none')) : ''}</span>
      <button className="icon-btn" disabled={!count} onClick={() => step(-1)} title="⇧↵">
        ↑
      </button>
      <button className="icon-btn" disabled={!count} onClick={() => step(1)} title="↵">
        ↓
      </button>
      {!!more && onLoadMore && (
        <button className="link small find-more" onClick={onLoadMore} title={t('find.olderHint', { n: more })}>
          {t('find.older')}
        </button>
      )}
      <button className="icon-btn" onClick={onClose} title="Esc">
        ×
      </button>
    </div>
  );
}
