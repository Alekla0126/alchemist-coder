import { LIMITS, resetPanel, setPanel, useLayout, type Panel } from '../layout';
import { useT } from '../store';

/**
 * A drag handle on a panel's edge. `edge` says where the panel is: 'left' grows with the pointer
 * (the sidebar), 'right' grows against it (the agent column in split mode). Double-click resets.
 */
export function Resizer({ panel, edge }: { panel: Panel; edge: 'left' | 'right' | 'bottom' }) {
  const vertical = edge !== 'bottom';
  const t = useT();
  const size = useLayout((l) => l[panel]);
  return (
    <div
      className={`resizer resizer-${panel}`}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-valuenow={size}
      aria-label={t('layout.resize')}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const d = vertical ? (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0) : e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        if (!d) return;
        e.preventDefault();
        setPanel(panel, size + (edge === 'right' ? -d : d));
      }}
      title={t('layout.resize')}
      onDoubleClick={() => resetPanel(panel)}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startY = e.clientY;
        const start = size;
        document.body.classList.add(vertical ? 'resizing' : 'resizing-y');
        const move = (ev: PointerEvent) => {
          const px = start + (edge === 'left' ? ev.clientX - startX : edge === 'right' ? startX - ev.clientX : startY - ev.clientY);
          // Dragged well past its minimum, the sidebar folds away (⌘B or the title bar brings it back).
          if (panel === 'side' && px < LIMITS.side[0] - 90) {
            useLayout.setState({ sideHidden: true });
            return up();
          }
          if (panel === 'splitSide' && px < LIMITS.splitSide[0] - 120) {
            useLayout.setState({ splitSideHidden: true });
            return up();
          }
          setPanel(panel, px);
        };
        function up() {
          document.body.classList.remove('resizing', 'resizing-y');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        }
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
    />
  );
}
