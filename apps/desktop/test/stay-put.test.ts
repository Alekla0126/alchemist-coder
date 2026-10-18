import { describe, expect, it } from 'vitest';
import { bornConversation, heldConversation, provisionalProjects, type ComposeFollowState } from '../src/renderer/src/stay-put';

const state = (over: Partial<ComposeFollowState> = {}): ComposeFollowState => ({
  runs: { r1: { runId: 'r1', target: 'p:1', sessionId: 'sess-1' } },
  runByTarget: { 'p:1': 'r1' },
  composeProjectId: 1,
  selection: null,
  activeProjectId: 1,
  ...over,
});

describe('a new conversation never moves you', () => {
  it('turns its «New conversation» screen into it while you are still there', () => {
    expect(bornConversation(state(), ['sess-1'])).toEqual({ runId: 'r1', target: 'p:1', sessionId: 'sess-1', follow: true });
  });

  it('stays put when you went to another project, another conversation or another «New conversation»', () => {
    expect(bornConversation(state({ activeProjectId: 2 }), ['sess-1'])?.follow).toBe(false);
    expect(bornConversation(state({ selection: { sessionId: 'other' } }), ['sess-1'])?.follow).toBe(false);
    expect(bornConversation(state({ composeProjectId: 2, activeProjectId: 2 }), ['sess-1'])?.follow).toBe(false);
    expect(bornConversation(state({ composeProjectId: null }), ['sess-1'])?.follow).toBe(false);
  });

  it('an older new conversation writing again pulls nobody anywhere', () => {
    const s = state({ runs: { r0: { runId: 'r0', target: 'p:1', sessionId: 'sess-0' }, r1: { runId: 'r1', target: 'p:1', sessionId: null } } });
    expect(bornConversation(s, ['sess-0'])).toBeNull();
    // Once its screen is free (runByTarget dropped it), the same run never counts again.
    expect(bornConversation(state({ runByTarget: {} }), ['sess-1'])).toBeNull();
  });

  it('only for the sessions the index just reported, and only new conversations', () => {
    expect(bornConversation(state(), ['sess-9'])).toBeNull();
    const s = state({ runs: { r1: { runId: 'r1', target: 's:sess-1', sessionId: 'sess-1' } }, runByTarget: { 's:sess-1': 'r1' } });
    expect(bornConversation(s, ['sess-1'])).toBeNull();
  });
});

describe('«New conversation» asked for again', () => {
  it('opens empty, with every agent to pick, once the conversation it held exists', () => {
    expect(heldConversation(state(), 1)).toBe('p:1');
  });

  it('keeps a message just sent (no session yet), and has nothing to drop elsewhere', () => {
    expect(heldConversation(state({ runs: { r1: { runId: 'r1', target: 'p:1', sessionId: null } } }), 1)).toBeNull();
    expect(heldConversation(state({ runByTarget: {} }), 1)).toBeNull();
    expect(heldConversation(state(), 2)).toBeNull();
  });
});

describe('the first index never switches your project', () => {
  it('shows the most active projects', () => {
    expect(provisionalProjects([5, 4, 3, 2, 1], null)).toEqual([5, 4, 3, 2]);
    expect(provisionalProjects([5, 4, 3, 2, 1], 4)).toEqual([5, 4, 3, 2]);
  });

  it('keeps the one you are on among them, first, when it falls out of the top', () => {
    expect(provisionalProjects([5, 4, 3, 2, 1], 1)).toEqual([1, 5, 4, 3]);
  });

  it('forgets a project the index no longer has', () => {
    expect(provisionalProjects([5, 4, 3, 2, 1], 99)).toEqual([5, 4, 3, 2]);
  });
});
