import { describe, expect, it } from 'vitest';
import { avatarSource, guessAvatar } from '../src/renderer/src/avatar';

describe('agent pictures', () => {
  it('gives each kind of subagent its picture, else the one its task suggests', () => {
    expect(guessAvatar('Explore', 'Find the CSV export')).toBe('emoji:🧭');
    expect(guessAvatar('Plan', 'Refunds')).toBe('emoji:📐');
    expect(guessAvatar('general-purpose', 'Write the migration')).toBe('emoji:🤖');
    expect(guessAvatar('code-reviewer', 'Look at the diff')).toBe('emoji:🔍');
    expect(guessAvatar('my-helper', 'Run the test suite')).toBe('emoji:🧪');
    expect(guessAvatar('my-helper', 'Rename things')).toBeUndefined();
  });

  it('keeps "general" only for the all-round subagent, not for names that contain it', () => {
    expect(avatarSource('General manager', null)).toEqual({ kind: 'emoji', emoji: '⚗️' });
    expect(avatarSource('Generalist', null)).toEqual({ kind: 'initials' });
  });
});
