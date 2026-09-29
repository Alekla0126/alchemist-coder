import { create } from 'zustand';

const KEY = 'alchemist.layout';

interface Layout {
  /** Sidebar (conversations, files) width in px. */
  side: number;
  /** Agent column in split mode. */
  splitSide: number;
  /** Terminal under the editor in split mode. */
  splitTerm: number;
  sideHidden: boolean;
}

export const LIMITS = { side: [200, 560, 300], splitSide: [300, 760, 380], splitTerm: [120, 900, 280] } as const;
export type Panel = keyof typeof LIMITS;

const clamp = (v: number, [min, max]: readonly [number, number, number]) => Math.round(Math.min(max, Math.max(min, v)));

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Layout>;
    return {
      side: clamp(Number(raw.side) || LIMITS.side[2], LIMITS.side),
      splitSide: clamp(Number(raw.splitSide) || LIMITS.splitSide[2], LIMITS.splitSide),
      splitTerm: clamp(Number(raw.splitTerm) || LIMITS.splitTerm[2], LIMITS.splitTerm),
      sideHidden: raw.sideHidden === true,
    };
  } catch {
    return { side: LIMITS.side[2], splitSide: LIMITS.splitSide[2], splitTerm: LIMITS.splitTerm[2], sideHidden: false };
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
export const toggleSidebar = () => useLayout.setState((l) => ({ sideHidden: !l.sideHidden }));
