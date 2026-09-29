import { describe, expect, it } from 'vitest';
import { keys } from '../src/renderer/src/keys';

describe('shortcut labels', () => {
  it('stay as written on a Mac', () => {
    expect(keys('⌘⇧F', true)).toBe('⌘⇧F');
  });

  it('read Ctrl, Shift and Enter on Windows and Linux', () => {
    expect(keys('⌘K', false)).toBe('Ctrl+K');
    expect(keys('⌘⇧F', false)).toBe('Ctrl+Shift+F');
    expect(keys('⌘⇧↵', false)).toBe('Ctrl+Shift+Enter');
    expect(keys('⌘1 … ⌘6', false)).toBe('Ctrl+1 … Ctrl+6');
    expect(keys('⌘,', false)).toBe('Ctrl+,');
    expect(keys('⌘ + click', false)).toBe('Ctrl + click');
    expect(keys('Save (⌘S)', false)).toBe('Save (Ctrl+S)');
    expect(keys('⌘/Ctrl+Enter (Enter for a new line)', false)).toBe('Ctrl+Enter (Enter for a new line)');
    expect(keys('Send ↵', false)).toBe('Send ↵');
  });
});
