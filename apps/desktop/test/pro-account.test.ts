import { describe, expect, it, vi } from 'vitest';
import { ProAccountFlow } from '../src/main/pro-account';

const device = '12345678-1234-1234-1234-123456789abc';
function setup() {
  let now = 1000;
  const activate = vi.fn(async () => ({ ok: true }));
  const flow = new ProAccountFlow({ accountUrl: () => 'https://coder.alekla.com/account/', deviceId: () => device, activate }, '/unused', () => now);
  const start = new URL(flow.start()!);
  const callback = (state = start.searchParams.get('state')!) => `alchemistcoder://auth/pro?state=${state}#license=abc.def.ghi`;
  return { flow, activate, callback, start, advance: () => { now += 31 * 60_000; } };
}

describe('browser Pro activation', () => {
  it('sends only an opaque installation id and fresh state to the configured account page', () => {
    const { start, flow } = setup();
    expect(start.searchParams.get('device')).toBe(device);
    expect(start.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/);
    expect(new URL(flow.start()!).searchParams.get('state')).not.toBe(start.searchParams.get('state'));
    expect(new ProAccountFlow(null, '/unused').start()).toBeNull();
    expect(new ProAccountFlow({ accountUrl: () => 'javascript:alert(1)', deviceId: () => device, activate: vi.fn() }, '/unused').start()).toBeNull();
  });
  it('rejects unsolicited, wrong-state, duplicate-field and expired callbacks without invoking activation', async () => {
    const { flow, activate, callback, advance } = setup();
    expect(await flow.accept(callback('0'.repeat(64)))).toBeNull();
    expect(await flow.accept(callback().replace('alchemistcoder:', 'https:'))).toBeNull();
    expect(await flow.accept(callback().replace('#', '&state=bad#'))).toBeNull();
    advance();
    expect(await flow.accept(callback())).toBeNull();
    expect(activate).not.toHaveBeenCalled();
  });
  it('verifies before consuming the one-use login and never accepts a replay', async () => {
    const { flow, activate, callback } = setup();
    activate.mockResolvedValueOnce({ ok: false });
    expect(await flow.accept(callback())).toEqual({ ok: false });
    expect(await flow.accept(callback())).toEqual({ ok: true });
    expect(await flow.accept(callback())).toBeNull();
    expect(activate).toHaveBeenCalledTimes(2);
  });
});
