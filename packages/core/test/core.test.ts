import { describe, expect, it } from 'vitest';
import { estimateCost, isLocalEndpoint, priceFor, ExtensionRegistry } from '../src/index.ts';

describe('pricing', () => {
  it('resolves model families by longest prefix', () => {
    expect(priceFor('claude-opus-5')).toEqual({ input: 5, output: 25 });
    expect(priceFor('claude-opus-4-1-20250805')).toEqual({ input: 15, output: 75 });
    expect(priceFor('claude-opus-4-8')).toEqual({ input: 5, output: 25 });
    expect(priceFor('gpt-5.6-sol')).toBeNull();
  });

  it('bills cache reads at 0.1x and 1h writes at 2x', () => {
    const cost = estimateCost('claude-opus-5', { input: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 1_000_000 });
    expect(cost).toBeCloseTo(5 + 0.5 + 10);
  });
});

describe('isLocalEndpoint', () => {
  it.each([
    ['http://localhost:11434', true],
    ['http://127.0.0.1:1234/v1', true],
    ['http://192.168.1.20:8080', true],
    ['http://10.0.0.5', true],
    ['http://172.20.0.2', true],
    ['http://[::1]:11434', true],
    ['https://api.moonshot.ai/anthropic', false],
    ['https://api.anthropic.com', false],
    ['http://172.40.0.2', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isLocalEndpoint(url)).toBe(expected);
  });
});

describe('ExtensionRegistry', () => {
  it('ignores Pro providers in the Community edition', () => {
    const reg = new ExtensionRegistry('community');
    const provider = { id: 'claude', label: 'Claude', edition: 'pro' as const, harnesses: [], capabilities: { toolSearch: true, webFetch: true, webSearch: true, subagents: true }, models: async () => [], env: async () => ({}) };
    reg.registerProvider(provider);
    expect(reg.providers.size).toBe(0);
    reg.registerFeatureGate({ id: 'cloud-providers', edition: 'pro' });
    expect(reg.isEnabled('cloud-providers')).toBe(false);
    expect(new ExtensionRegistry('pro').isEnabled('anything')).toBe(true);
  });
});
