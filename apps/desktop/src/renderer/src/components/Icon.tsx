import type { ReactNode } from 'react';

/**
 * The app's line icons, drawn on a 24 grid with the current text color. One look for every
 * "open", "close", panel and mode button, so the same action always has the same picture.
 */
const PATHS = {
  // Panels
  sidebarClose: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16M15.5 10l-2 2 2 2" />
    </>
  ),
  sidebarOpen: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16M13.5 10l2 2-2 2" />
    </>
  ),
  panelRightClose: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M15 4v16M8.5 10l2 2-2 2" />
    </>
  ),
  panelRightOpen: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M15 4v16M10.5 10l-2 2 2 2" />
    </>
  ),
  // Actions
  goto: <path d="M4.5 12h11M11.5 7.5l4.5 4.5-4.5 4.5M19.5 5v14" />,
  open: <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  done: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.2 12.3l2.6 2.6 5-5.4" />
    </>
  ),
  reopen: <path d="M4.5 5v5h5M5.2 15.5a7.5 7.5 0 1 0 1.3-8.1L4.5 10" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  chevronDown: <path d="M7 10l5 5 5-5" />,
  chevronRight: <path d="M10 7l5 5-5 5" />,
  chevronLeft: <path d="M14 7l-5 5 5 5" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7M10.5 10.5v6M13.5 10.5v6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M19.5 19.5l-4.2-4.2" />
    </>
  ),
  menu: <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />,
  // Composer
  bolt: <path d="M13 3.5L5.5 13.5h6l-1 7 8-10.5h-6z" />,
  gauge: <path d="M4.5 16.5a7.5 7.5 0 1 1 15 0M12 16.5l3.6-4.6M7.5 16.5h0M16.5 16.5h0" />,
  shield: <path d="M12 3.5l7 2.8v5c0 4.3-2.9 7.6-7 9.2-4.1-1.6-7-4.9-7-9.2v-5z" />,
  shieldCheck: (
    <>
      <path d="M12 3.5l7 2.8v5c0 4.3-2.9 7.6-7 9.2-4.1-1.6-7-4.9-7-9.2v-5z" />
      <path d="M9 12l2.2 2.2 4-4.4" />
    </>
  ),
  // Modes
  agents: <path d="M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8.5a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5v-3.5h-1A1.5 1.5 0 0 1 4 15V6.5A1.5 1.5 0 0 1 5.5 5z" />,
  arena: <path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5.5a2.5 2.5 0 0 0 2.8 3.9M16 6h2.5a2.5 2.5 0 0 1-2.8 3.9M12 13v3.5M9 20h6M10 16.5h4V20h-4z" />,
  code: <path d="M9 7.5L4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5" />,
  split: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14 4.5v15M3.5 13h10.5" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  bots: (
    <>
      <rect x="9" y="3.5" width="6" height="5" rx="1.2" />
      <rect x="3.5" y="15.5" width="6" height="5" rx="1.2" />
      <rect x="14.5" y="15.5" width="6" height="5" rx="1.2" />
      <path d="M12 8.5v3.5M6.5 15.5V12h11v3.5" />
    </>
  ),
  marketing: <path d="M4.5 10v4h3l6.5 4.5v-13L7.5 10zM17.5 9.5a3.5 3.5 0 0 1 0 5" />,
  board: (
    <>
      <rect x="3.5" y="4.5" width="4.5" height="12" rx="1.2" />
      <rect x="9.75" y="4.5" width="4.5" height="8" rx="1.2" />
      <rect x="16" y="4.5" width="4.5" height="15" rx="1.2" />
    </>
  ),
  folder: <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  blocks: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
      <path d="M16.5 3.5l4 4-4 4-4-4z" />
    </>
  ),
  list: <path d="M9 7h11M9 12h11M9 17h11M4.5 7h.5M4.5 12h.5M4.5 17h.5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`ic ${className ?? ''}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The fold arrow of lists and trees: pointing down when open, right when closed. */
export function Caret({ open }: { open: boolean }) {
  return <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="caret-ic" />;
}
