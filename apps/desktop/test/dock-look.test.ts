import { describe, expect, it } from 'vitest';
import { dockLook } from '../src/main/dock-look';

const at = (waiting: number, working: number, notify = true) => ({ waiting, working, label: '', notify });

describe('the Dock or taskbar icon', () => {
  it('counts what waits for you, with an amber dot before the green one of agents working', () => {
    expect(dockLook(null, at(0, 0), false)).toEqual({ badge: 0, dot: null, alert: false });
    expect(dockLook(null, at(0, 2), false)).toMatchObject({ badge: 0, dot: 'working' });
    expect(dockLook(null, at(3, 2), false)).toMatchObject({ badge: 3, dot: 'waiting' });
  });

  it('calls you only when something new waits for you, you are elsewhere and notifications are on', () => {
    expect(dockLook(at(1, 0), at(2, 0), false).alert).toBe(true);
    expect(dockLook(null, at(1, 0), false).alert).toBe(true);
    expect(dockLook(at(1, 0), at(2, 0), true).alert).toBe(false);
    expect(dockLook(at(2, 0), at(2, 1), false).alert).toBe(false);
    expect(dockLook(at(2, 0), at(1, 0), false).alert).toBe(false);
    expect(dockLook(at(1, 0), at(2, 0, false), false).alert).toBe(false);
  });
});
