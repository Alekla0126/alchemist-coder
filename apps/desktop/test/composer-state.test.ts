import { describe, expect, it } from 'vitest';
import { drafts, moveComposerState, queues } from '../src/renderer/src/composer-state';

describe('composer state', () => {
  it("moves a new conversation's draft and queue to its session", () => {
    drafts.set('p:1', 'half-written idea');
    queues.set('p:1', ['then this']);
    moveComposerState('p:1', 's:abc');
    expect(drafts.get('s:abc')).toBe('half-written idea');
    expect(queues.get('s:abc')).toEqual(['then this']);
    expect(drafts.has('p:1')).toBe(false);
  });
});
