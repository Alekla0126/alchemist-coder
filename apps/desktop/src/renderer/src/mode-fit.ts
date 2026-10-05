/** How the mode bar shows: icon and name on every tab, the name only on the open one, icons only, or one menu. */
export type ModeFit = 'full' | 'active' | 'icons' | 'menu';

/** Widths each way of showing the modes needs, in px (measured: they change with the language). */
export interface ModeWidths {
  full: number;
  active: number;
  icons: number;
}

/** The richest way of showing the modes that fits in `room`. */
export function fitModes(room: number, widths: ModeWidths): ModeFit {
  if (widths.full <= room) return 'full';
  if (widths.active <= room) return 'active';
  if (widths.icons <= room) return 'icons';
  return 'menu';
}

/**
 * The room the modes have: what the title bar leaves after its fixed left part, the right side's
 * buttons and the project name's minimum. They sit centered when there's more; when there isn't, the
 * project name shrinks first and they move a little left.
 */
export function modesRoom(o: { inner: number; gap: number; fixedLeft: number; right: number; crumbMin: number }): number {
  return o.inner - o.fixedLeft - 4 * o.gap - o.right - o.crumbMin;
}
