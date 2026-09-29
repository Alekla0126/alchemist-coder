import { describe, expect, it } from 'vitest';
import { modelLabel } from '../src/renderer/src/format';

describe('modelLabel', () => {
  it('names Claude and GPT models the way people say them', () => {
    expect(modelLabel('claude-opus-4-1-20250805')).toBe('Opus 4.1');
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelLabel('claude-haiku-4-5')).toBe('Haiku 4.5');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel('claude-opus-4-6[1m]')).toBe('Opus 4.6 1M');
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(modelLabel('claude-3-opus-20240229')).toBe('Opus 3');
    expect(modelLabel('anthropic/claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('gpt-5.1-codex')).toBe('GPT-5.1 Codex');
    expect(modelLabel('gpt-5-codex-mini')).toBe('GPT-5 Codex Mini');
    expect(modelLabel('qwen2.5-coder:7b')).toBe('qwen2.5-coder:7b');
  });
});

describe('contextWindowFor', () => {
  it('prefers what the CLI recorded, then what the model is known for', async () => {
    const { contextWindowFor } = await import('../src/renderer/src/format');
    expect(contextWindowFor('gpt-5-codex', 400_000)).toBe(400_000);
    expect(contextWindowFor('claude-opus-4-6[1m]')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-5')).toBe(200_000);
    expect(contextWindowFor('qwen2.5-coder:7b')).toBeNull();
  });
});

describe('matchModel', () => {
  it('finds the provider model a conversation used', async () => {
    const { matchModel } = await import('../src/renderer/src/format');
    const personal = [{ id: 'default' }, { id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }];
    expect(matchModel(personal, 'claude-opus-4-8')).toBe('opus');
    expect(matchModel(personal, 'claude-3-5-haiku-20241022')).toBe('haiku');
    expect(matchModel([{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }], 'claude-opus-4-8')).toBe('claude-opus-4-1');
    expect(matchModel([{ id: 'claude-sonnet-4-5' }], 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(matchModel(personal, 'gpt-5-codex')).toBeUndefined();
    expect(matchModel(personal, undefined)).toBeUndefined();
  });
});

describe('text on accent buttons', () => {
  it('is dark on light accents and white on dark ones', async () => {
    const { onColor } = await import('../src/renderer/src/theme');
    expect(onColor('#d97a4a', '#f0b27a')).toBe('#1a0d05');
    expect(onColor('#0969da')).toBe('#ffffff');
    expect(onColor('not a color')).toBe('#1a0d05');
  });
});

describe('long-context sessions', () => {
  it('assumes the 1M window when a Claude conversation used more than 200K', async () => {
    const { contextWindowFor } = await import('../src/renderer/src/format');
    expect(contextWindowFor('claude-opus-4-8', null, 336_000)).toBe(1_000_000);
    expect(contextWindowFor('gpt-5-codex', null, 300_000)).toBeNull();
    expect(contextWindowFor('claude-opus-4-8', null, 120_000)).toBe(200_000);
  });
});

describe('model aliases', () => {
  it('reads CLI aliases like names', async () => {
    const { modelLabel } = await import('../src/renderer/src/format');
    expect(modelLabel('haiku')).toBe('Haiku');
    expect(modelLabel('opus')).toBe('Opus');
  });
});

describe('singular forms', () => {
  it('uses "<key>.one" when n is 1', async () => {
    const { translate } = await import('../src/renderer/src/i18n');
    expect(translate('es', 'bots.count', { n: 1 })).toBe('1 agente');
    expect(translate('es', 'bots.count', { n: 3 })).toBe('3 agentes');
    expect(translate('es', 'attention.needYou', { n: 1 })).toBe('1 te necesita');
    expect(translate('en', 'agent.editedN', { n: 1 })).toBe('1 file edited');
  });
});
