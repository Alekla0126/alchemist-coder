import { describe, expect, it } from 'vitest';
import type { HarnessAdapter, RunHandle } from '@alchemist-coder/core';
import { npxOrHeadless } from '../src/agents.ts';

const fake = (name: string): HarnessAdapter => ({
  id: 'claude-code',
  label: 'Claude Code',
  detect: async () => ({ installed: true, version: name, path: name }),
  run: () => ({ id: name }) as unknown as RunHandle,
});

describe('Claude Code and Codex through ACP or headless', () => {
  it('switches to ACP once Node.js shows up, without a restart', async () => {
    let npx = false;
    const h = npxOrHeadless(fake('acp'), fake('headless'), false, async () => ({ installed: npx, version: null, path: null }));
    expect((await h.detect()).version).toBe('headless');
    expect(h.run({} as never).id).toBe('headless');
    npx = true;
    expect((await h.detect()).version).toBe('acp');
    expect(h.run({} as never).id).toBe('acp');
  });
});
