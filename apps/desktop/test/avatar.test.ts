import { describe, expect, it } from 'vitest';
import { avatarSource, guessAvatar } from '../src/renderer/src/avatar';
import { monsterParts, monsterSvg, monsterUri } from '../src/renderer/src/monster';
import { avatarOf } from '../src/main/bots';

describe('agent pictures', () => {
  it('gives each kind of subagent its picture, else the one its task suggests', () => {
    expect(guessAvatar('Explore', 'Find the CSV export')).toBe('emoji:🧭');
    expect(guessAvatar('Plan', 'Refunds')).toBe('emoji:📐');
    expect(guessAvatar('general-purpose', 'Write the migration')).toBe('emoji:🤖');
    expect(guessAvatar('code-reviewer', 'Look at the diff')).toBe('emoji:🔍');
    expect(guessAvatar('my-helper', 'Run the test suite')).toBe('emoji:🧪');
    expect(guessAvatar('my-helper', 'Rename things')).toBeUndefined();
  });

  it('shows the picture you chose, else the agent’s own monster', () => {
    expect(avatarSource('Programador', 'emoji:🦊')).toEqual({ kind: 'emoji', emoji: '🦊' });
    expect(avatarSource('Programador', 'data:image/png;base64,AAAA')).toEqual({ kind: 'image', src: 'data:image/png;base64,AAAA' });
    expect(avatarSource('Programador', null)).toEqual({ kind: 'image', src: monsterUri('Programador') });
    // A chosen monster stays when the agent is renamed.
    expect(avatarSource('Renamed', 'monster:k3x9a')).toEqual({ kind: 'image', src: monsterUri('k3x9a') });
    expect(avatarSource('  ', null)).toEqual({ kind: 'initials' });
  });
});

describe('monsters', () => {
  it('draws the same monster for the same seed, and different ones for different seeds', () => {
    expect(monsterSvg('Tester')).toBe(monsterSvg('Tester'));
    const looks = new Set(['Coordinador', 'Programador', 'Tester', 'Revisor', 'Investigador', 'Diseñador', 'Arquitecto', 'Redactor'].map((n) => JSON.stringify(monsterParts(n))));
    expect(looks.size).toBe(8);
  });

  it('is a self-contained SVG with plain colours (every renderer reads #rrggbb)', () => {
    const svg = monsterSvg('Ana');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">')).toBe(true);
    expect(svg).not.toMatch(/hsl\(|<script|href=/);
    expect(svg.match(/fill="(#[0-9a-f]{6}|#fff|none|url\(#b\))"/g)!.length).toBeGreaterThan(5);
    expect(monsterUri('Ana').startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
  });

  it('is kept by the app as a seed, and nothing else gets through', () => {
    expect(avatarOf('monster:k3x9a')).toBe('monster:k3x9a');
    expect(avatarOf('monster:Diseñador UI')).toBe('monster:Diseñador UI');
    expect(avatarOf('monster:<script>')).toBeNull();
    expect(avatarOf('monster:')).toBeNull();
  });
});
