/**
 * For captures (--drag, see AppInfo.capture.drag): plays a drag the way the mouse does it, through
 * the same DOM events (dragstart, dragover, drop, dragend), so a capture shows what really happens:
 * the drop marks mid-drag (":hold"), or the new order after the drop.
 */
export async function playDrag(spec: string): Promise<void> {
  const m = /^(rail|pin):(\d+)>(top|\d+)(\+)?(:hold)?$/.exec(spec.trim());
  if (!m) return;
  const [, where, from, to, after, hold] = m;
  const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(where === 'rail' ? '.rail .rail-item[draggable]' : '.tree [data-session-id]')];
  const data = new DataTransfer();
  const fire = (el: Element, type: string, y?: number) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: r.left + r.width / 2, clientY: y ?? r.top + r.height / 2 }));
  };
  // React re-renders between the steps (the dragged item fades, the pin zone appears).
  const frame = () => new Promise((r) => setTimeout(r, 150));
  const source = items()[Number(from)];
  if (!source) return;
  fire(source, 'dragstart');
  await frame();
  const target = to === 'top' ? document.querySelector<HTMLElement>('.pin-drop') : items()[Number(to)];
  if (!target) return;
  const r = target.getBoundingClientRect();
  const y = to === 'top' ? r.top + r.height / 2 : after ? r.bottom - 2 : r.top + 2;
  fire(target, 'dragenter', y);
  fire(target, 'dragover', y);
  await frame();
  if (hold) return;
  fire(target, 'drop', y);
  fire(source, 'dragend');
  await frame();
}
