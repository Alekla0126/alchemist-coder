import { create } from 'zustand';

const KEY = 'alchemist.layout';

interface Layout {
  /** Sidebar (conversations, files) width in px. */
  side: number;
  /** Agent column in split mode. */
  splitSide: number;
  /** Terminal under the editor in split mode. */
  splitTerm: number;
  /** The conversation opened next to the board. */
  peek: number;
  sideHidden: boolean;
  /** The agent column of the split view, folded away. */
  splitSideHidden: boolean;
}

export const LIMITS = { side: [200, 560, 300], splitSide: [300, 760, 380], splitTerm: [120, 900, 280], peek: [360, 1200, 620] } as const;
export type Panel = keyof typeof LIMITS;

const clamp = (v: number, [min, max]: readonly [number, number, number]) => Math.round(Math.min(max, Math.max(min, v)));

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Layout>;
    return {
      side: clamp(Number(raw.side) || LIMITS.side[2], LIMITS.side),
      splitSide: clamp(Number(raw.splitSide) || LIMITS.splitSide[2], LIMITS.splitSide),
      splitTerm: clamp(Number(raw.splitTerm) || LIMITS.splitTerm[2], LIMITS.splitTerm),
      peek: clamp(Number(raw.peek) || LIMITS.peek[2], LIMITS.peek),
      sideHidden: raw.sideHidden === true,
      splitSideHidden: raw.splitSideHidden === true,
    };
  } catch {
    return { side: LIMITS.side[2], splitSide: LIMITS.splitSide[2], splitTerm: LIMITS.splitTerm[2], peek: LIMITS.peek[2], sideHidden: false, splitSideHidden: false };
  }
}

/** Panel sizes, kept across launches; applied as CSS variables. */
export const useLayout = create<Layout>(load);

/** The middle always keeps room: saved widths give way on a small window. */
const RAIL = 56;
const MIN_CENTER = 420;

function apply(l: Layout) {
  if (typeof document === 'undefined') return; // tests
  const width = window.innerWidth;
  const side = Math.max(LIMITS.side[0], Math.min(l.side, width - RAIL - MIN_CENTER));
  const splitSide = Math.max(LIMITS.splitSide[0], Math.min(l.splitSide, width - RAIL - (l.sideHidden ? 0 : side) - MIN_CENTER));
  const root = document.documentElement.style;
  root.setProperty('--side-w', `${side}px`);
  root.setProperty('--split-side-w', `${splitSide}px`);
  root.setProperty('--split-term-h', `${Math.min(l.splitTerm, window.innerHeight - 260)}px`);
  // The board keeps at least a column of room next to the conversation.
  root.setProperty('--peek-w', `${Math.max(LIMITS.peek[0], Math.min(l.peek, width - RAIL - 380))}px`);
}
apply(useLayout.getState());
if (typeof window !== 'undefined') window.addEventListener('resize', () => apply(useLayout.getState()));
useLayout.subscribe((l) => {
  apply(l);
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    // no storage (tests)
  }
});

export const setPanel = (panel: Panel, px: number) => useLayout.setState({ [panel]: clamp(px, LIMITS[panel]) } as Partial<Layout>);
export const resetPanel = (panel: Panel) => useLayout.setState({ [panel]: LIMITS[panel][2] } as Partial<Layout>);

/** Below this width (about half a laptop screen) the sidebar floats over the page instead of taking a column. */
export const NARROW = 1000;
const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < NARROW;

/** The window's size class, and whether the floating sidebar is open (it starts closed). */
export const useViewport = create<{ narrow: boolean; drawer: boolean }>(() => ({ narrow: isNarrow(), drawer: false }));
if (typeof window !== 'undefined')
  window.addEventListener('resize', () => {
    const narrow = isNarrow();
    if (narrow !== useViewport.getState().narrow) useViewport.setState({ narrow, drawer: false });
  });

/** ⌘B and the title bar button: hide or show the sidebar column, or open and close the floating one. */
export const toggleSidebar = () => {
  if (useViewport.getState().narrow) useViewport.setState((v) => ({ drawer: !v.drawer }));
  else useLayout.setState((l) => ({ sideHidden: !l.sideHidden }));
};
/** ⌘⌥B and the title bar button in split view: fold or unfold the agent column. */
export const toggleSplitSide = () => useLayout.setState((l) => ({ splitSideHidden: !l.splitSideHidden }));
export const closeDrawer = () => useViewport.getState().drawer && useViewport.setState({ drawer: false });
