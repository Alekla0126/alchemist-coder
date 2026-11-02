import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The example office (screenshots, `demo-…`) is shown, never saved nor sent to: the guards sit in the
 * functions that write (saveConfig, deleteConfig, messageBot), whichever button reaches them. And the
 * office as the organization's home is a choice kept between visits, only from the view switch.
 */
const memory = new Map<string, string>();
const storage = { getItem: vi.fn((k: string) => memory.get(k) ?? null), setItem: vi.fn((k: string, v: string) => void memory.set(k, v)), removeItem: vi.fn((k: string) => void memory.delete(k)) };
// The preload bridge: every call recorded, none answered with anything.
const bridge = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, { get: (calls, name: string) => (calls[name] ??= vi.fn(async () => ({ id: 'saved' }))) });
const target = () => ({ addEventListener: () => {}, removeEventListener: () => {} });

async function fresh() {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { ...target(), alchemist: bridge, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), focus: () => {} });
  vi.stubGlobal('document', { ...target(), hidden: false, hasFocus: () => true, documentElement: { style: { setProperty: () => {} }, classList: { toggle: () => {}, add: () => {}, remove: () => {} }, dataset: {} }, querySelector: () => null, getElementById: () => null });
  const store = await import('../src/renderer/src/store');
  const org = await import('../src/renderer/src/actions/org');
  return { ...store, ...org };
}

beforeEach(() => {
  memory.clear();
  for (const k of Object.keys(bridge)) delete (bridge as Record<string, unknown>)[k];
  storage.setItem.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const member = (id: string) => ({ id, name: 'Coder', role: '', agent: { harnessId: 'claude-code', providerId: 'anthropic', model: 'sonnet' }, permissionMode: 'acceptEdits' as const, canSpawn: false, kind: 'member' as const });

describe('the example office is never saved', () => {
  it('refuses to save or delete a demo agent, saying why, and never calls the app', async () => {
    const { saveConfig, deleteConfig } = await fresh();
    await expect(saveConfig(member('demo-coder'))).rejects.toThrow('example');
    await expect(deleteConfig('demo-coder')).rejects.toThrow('example');
    expect(bridge.saveBotConfig).not.toHaveBeenCalled();
    expect(bridge.deleteBotConfig).not.toHaveBeenCalled();
  });

  it('saves and deletes real agents as before', async () => {
    const { saveConfig, deleteConfig } = await fresh();
    await saveConfig(member('3f2a'));
    await deleteConfig('3f2a');
    expect(bridge.saveBotConfig).toHaveBeenCalledWith(expect.objectContaining({ id: '3f2a' }));
    expect(bridge.deleteBotConfig).toHaveBeenCalledWith('3f2a');
  });

  it('lets a new agent (no id yet) through, as undoing a dismissal does', async () => {
    const { saveConfig } = await fresh();
    await saveConfig({ ...member('x'), id: undefined } as never);
    expect(bridge.saveBotConfig).toHaveBeenCalled();
  });

  it('goes through the guard from the actions that save or remove an agent, showing why', async () => {
    // Renaming and deleting ask first (a dialog); these three don't.
    const { setLead, keepMember, dismissMember, useStore } = await fresh();
    const { useUi } = await import('../src/renderer/src/ui');
    useStore.setState({ loadBots: async () => {} } as never);
    const demo = member('demo-coder');
    await setLead(demo, null);
    await keepMember(demo);
    await dismissMember(demo);
    expect(bridge.saveBotConfig).not.toHaveBeenCalled();
    expect(bridge.deleteBotConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(useUi.getState())).toContain('This is the example office: nothing is saved.');
  });

  it('sends nothing to an example assignment, and says why', async () => {
    const { useStore } = await fresh();
    await expect(useStore.getState().messageBot('demo-a', 'demo-a-1', 'hello')).rejects.toThrow('This is the example office: nothing is sent.');
    expect(bridge.messageBot).not.toHaveBeenCalled();
    await useStore.getState().messageBot('3f2a', 'b1', 'hello');
    expect(bridge.messageBot).toHaveBeenCalledWith('3f2a', 'b1', 'hello');
  });

  it('has the words for it in Spanish', async () => {
    const { translate } = await import('../src/renderer/src/i18n');
    expect(translate('es', 'org.office.demoNoSave')).not.toBe('org.office.demoNoSave');
    expect(translate('es', 'org.office.demoNoSend')).not.toBe('org.office.demoNoSend');
  });
});

describe('the office as home', () => {
  it('opens on the office unless you chose a detailed view last time', async () => {
    expect((await fresh()).useStore.getState().orgOffice).toBe(true);
    memory.set('alchemist.orgOffice', '0');
    expect((await fresh()).useStore.getState().orgOffice).toBe(false);
    memory.set('alchemist.orgOffice', '1');
    expect((await fresh()).useStore.getState().orgOffice).toBe(true);
  });

  it('keeps the choice only from the view switch: going to the inbox or the automations writes nothing', () => {
    const src = (file: string) => readFileSync(new URL(`../src/renderer/src/components/${file}`, import.meta.url), 'utf8');
    // The office's (OrgHome's) one: the last of that name in the file.
    const body = (code: string, name: string) => {
      const start = code.lastIndexOf(`const ${name} = `);
      expect(start).toBeGreaterThan(-1);
      return code.slice(start, code.indexOf('\n  };', start));
    };
    const org = src('Org.tsx');
    expect(body(org, 'showInbox')).toContain('orgOffice: false');
    expect(body(org, 'showInbox')).not.toContain('localStorage');
    expect(body(src('OrgOffice.tsx'), 'showAutomations')).not.toContain('localStorage');
    // The view switch is the one place the office's choice is written.
    expect(body(org, 'view')).toContain('localStorage.setItem(ORG_OFFICE_KEY');
    expect(org.match(/ORG_OFFICE_KEY/g)?.length).toBe(2);
    expect(org.match(/localStorage\.setItem/g)?.length).toBe(3);
  });
});
