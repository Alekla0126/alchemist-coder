import type { MenuItemConstructorOptions } from 'electron';
import type { MenuItem } from '../shared/api';

const ID = /^[\w:.-]{1,80}$/;

/**
 * The native menu for what the renderer asked to show. Only well-formed items become entries (the
 * renderer's input is never trusted). A row with a submenu is always a submenu row: given an explicit
 * checkbox type, Electron keeps it and the row opens nothing, so «agent › model» menus could only
 * keep the agent already chosen. Such a row shows no check; the item it holds does.
 */
export function menuTemplate(items: unknown, choose: (id: string) => void, depth = 0): MenuItemConstructorOptions[] {
  if (!Array.isArray(items) || depth > 2) return [];
  return items.slice(0, 40).flatMap((raw): MenuItemConstructorOptions[] => {
    const item = raw as Partial<MenuItem & { type: string }>;
    if (item?.type === 'separator') return [{ type: 'separator' }];
    const { id, label } = item as { id?: unknown; label?: unknown };
    if (typeof id !== 'string' || !ID.test(id) || typeof label !== 'string' || !label || label.length > 200) return [];
    const it = item as Extract<MenuItem, { id: string }>;
    const submenu = it.submenu ? menuTemplate(it.submenu, choose, depth + 1) : [];
    if (submenu.length) return [{ label, enabled: it.enabled !== false, type: 'submenu', submenu }];
    return [
      {
        label,
        enabled: it.enabled !== false,
        ...(typeof it.checked === 'boolean' ? { type: 'checkbox' as const, checked: it.checked } : {}),
        ...(typeof it.accelerator === 'string' && it.accelerator.length < 40 ? { accelerator: it.accelerator, registerAccelerator: false } : {}),
        click: () => choose(id),
      },
    ];
  });
}
