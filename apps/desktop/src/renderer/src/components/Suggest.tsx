import { useEffect, useRef } from 'react';

export interface SuggestItem {
  id: string;
  label: string;
  detail?: string;
  icon?: string;
  badge?: string;
}

/** The list that pops up over the composer for @ files and / commands. */
export function Suggest({ items, index, title, onPick, onHover }: { items: SuggestItem[]; index: number; title: string; onPick: (i: number) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('.suggest-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  return (
    <div className="suggest" role="listbox" aria-label={title} ref={list}>
      <div className="suggest-title">{title}</div>
      {items.map((item, i) => (
        <div
          key={item.id}
          role="option"
          aria-selected={i === index}
          className={`suggest-item ${i === index ? 'on' : ''}`}
          // mousedown, so the textarea keeps its focus
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(i);
          }}
          onMouseEnter={() => onHover(i)}
        >
          {item.icon && <span className="suggest-ic">{item.icon}</span>}
          <span className="suggest-label">{item.label}</span>
          {item.detail && <span className="suggest-detail">{item.detail}</span>}
          {item.badge && <span className="suggest-badge">{item.badge}</span>}
        </div>
      ))}
    </div>
  );
}
