import { describe, expect, it } from 'vitest';
import { menuTemplate } from '../src/main/menu-template';

describe('native menus', () => {
  it('an «agent › model» row always opens its models, even the agent not chosen', () => {
    const picked: string[] = [];
    const items = [
      { id: 'h:0', label: 'Claude Code', checked: true, enabled: true, submenu: [{ id: 'hm:0:2:0', label: 'Opus', checked: true }] },
      { id: 'h:1', label: 'Codex', checked: false, enabled: true, submenu: [{ id: 'hm:1:2:0', label: 'Codex default model', checked: false }] },
    ];
    const [claude, codex] = menuTemplate(items, (id) => picked.push(id));
    // An explicit checkbox type made Electron drop the submenu: these rows did nothing when clicked.
    expect(codex).toMatchObject({ label: 'Codex', type: 'submenu' });
    expect(codex).not.toHaveProperty('checked');
    expect(claude).toMatchObject({ type: 'submenu' });
    const model = (codex!.submenu as Array<{ type?: string; checked?: boolean; click?: () => void }>)[0]!;
    expect(model).toMatchObject({ type: 'checkbox', checked: false });
    model.click!();
    expect(picked).toEqual(['hm:1:2:0']);
  });

  it('keeps plain rows as before: checks, shortcuts, disabled rows and separators', () => {
    const [a, sep, b] = menuTemplate([{ id: 'a', label: 'Bring them', checked: true, accelerator: 'CmdOrCtrl+B' }, { type: 'separator' }, { id: 'b', label: 'Offline', enabled: false }], () => {});
    expect(a).toMatchObject({ type: 'checkbox', checked: true, accelerator: 'CmdOrCtrl+B', registerAccelerator: false });
    expect(sep).toEqual({ type: 'separator' });
    expect(b).toMatchObject({ enabled: false });
    expect(b).not.toHaveProperty('type');
  });

  it('never trusts the renderer: bad ids, empty labels and deep nesting are left out', () => {
    expect(menuTemplate([{ id: 'bad id!', label: 'x' }, { id: 'ok', label: '' }, { id: 'ok2' }], () => {})).toEqual([]);
    expect(menuTemplate('nope', () => {})).toEqual([]);
    const deep = [{ id: 'a', label: 'a', submenu: [{ id: 'b', label: 'b', submenu: [{ id: 'c', label: 'c', submenu: [{ id: 'd', label: 'd' }] }] }] }];
    const c = ((menuTemplate(deep, () => {})[0]!.submenu as Array<{ submenu?: unknown[] }>)[0]!.submenu as Array<{ submenu?: unknown; label: string }>)[0]!;
    expect(c.label).toBe('c');
    expect(c).not.toHaveProperty('submenu');
  });
});
