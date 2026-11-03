import { describe, expect, it, vi } from 'vitest';
import { codexComposerSelection, drafts, moveComposerState, queues, sendQueuedMessage } from '../src/renderer/src/composer-state';
import type { RunnerCatalog } from '../src/shared/api';

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

it('keeps queued text on unavailable selection or rejection and removes it only after acceptance', async () => {
  const target = 's:recover-400'; queues.set(target, ['first pending', 'second pending']);
  expect(await sendQueuedMessage(target, async () => false)).toBeNull();
  expect(queues.get(target)).toEqual(['first pending', 'second pending']);
  await expect(sendQueuedMessage(target, async () => { throw new Error('model_not_found'); })).rejects.toThrow('model_not_found');
  expect(queues.get(target)).toEqual(['first pending', 'second pending']);
  let finish!: (ok: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const pending = sendQueuedMessage(target, send);
  expect(await sendQueuedMessage(target, send)).toBeNull();
  finish(true);
  expect(await pending).toEqual(['second pending']);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('first pending');
  expect(queues.get(target)).toEqual(['second pending']);
});

it('keeps a legacy Codex selection instead of silently choosing a paid provider or another model', () => {
  const account = { id: 'openai', harnesses: ['codex'], available: false, models: [] };
  const paid = { id: 'paid-api', harnesses: ['codex'], available: true, models: [{ id: 'alternative', label: 'Alternative' }] };
  const providers = [account, paid] as RunnerCatalog['providers'];
  expect(codexComposerSelection(providers, 'openai', 'old-model')).toEqual({ provider: account, model: 'old-model', valid: false });
  expect(codexComposerSelection(providers, undefined, 'old-model').provider?.id).toBe('openai');
  expect(codexComposerSelection(providers, 'missing-provider', 'old-model').provider).toBeUndefined();
  expect(codexComposerSelection(providers, 'paid-api', 'alternative')).toMatchObject({ provider: paid, model: 'alternative', valid: true });
  drafts.set('s:invalid-model', 'unfinished draft'); queues.set('s:invalid-model', ['later']);
  codexComposerSelection([], 'openai', 'old-model');
  expect(drafts.get('s:invalid-model')).toBe('unfinished draft');
  expect(queues.get('s:invalid-model')).toEqual(['later']);
});
