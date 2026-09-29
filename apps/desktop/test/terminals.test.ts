import { describe, expect, it } from 'vitest';
import { installedShells } from '../src/main/terminals';

describe('installedShells', () => {
  it('puts the login shell first and lists each installed shell once', () => {
    const shells = installedShells();
    expect(shells.length).toBeGreaterThan(0);
    if (process.platform !== 'win32' && process.env.SHELL) expect(shells[0]!.path).toBe(process.env.SHELL);
    const names = shells.map((s) => s.label);
    expect(new Set(names).size).toBe(names.length);
    for (const s of shells) if (['zsh', 'bash', 'fish', 'sh'].includes(s.label)) expect(s.args).toEqual(['-l']);
  });
});
