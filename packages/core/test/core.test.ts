import { describe, expect, it } from 'vitest';
import { AUTOPILOT_ANSWER, autopilotAnswer, autopilotChoice, estimateCost, irreversible, isLocalEndpoint, priceFor, ExtensionRegistry, type QuestionField } from '../src/index.ts';

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

describe('Autopilot', () => {
  it('lets through everyday commands and refuses what can\'t be undone', () => {
    for (const ok of ['npm test', 'git push origin main', 'git push -u origin feature/x', 'rm -rf node_modules dist', 'rm -rf ./build', 'pnpm install', 'Edit a.txt', 'git commit -m "fix: rm -rf /tmp/x"', 'npm run publish-docs', 'fastlane test', 'appconsole play upload com.x app.aab', 'mcp__alchemist_play__play_upload', 'mcp__alchemist_play__play_tracks\nconfirm=true'])
      expect([ok, irreversible(ok)]).toEqual([ok, false]);
    for (const bad of [
      'sudo rm x',
      'cd / && sudo make install',
      'rm -rf /',
      'rm -fr ~',
      'rm -r -f $HOME/',
      'cd x; rm -rf ~/*',
      'git push --force origin main',
      'git push -f',
      'git push origin +main',
      'git push origin --delete old',
      'npm publish',
      'pnpm publish --access public',
      'gh release create v1.0.0',
      'fastlane android deploy',
      'fastlane supply',
      'eas submit -p ios',
      'docker push me/app',
      'appconsole play upload com.x app.aab --track production --confirm',
      'appconsole appstore submit MyApp --confirm',
      'mcp__alchemist_play__play_promote\nconfirm=true',
      'mcp__alchemist_appstore__appstore_submit\nconfirm=true',
      'mcp__plugin_google-play_google-play__play_reply\nconfirm=true',
      'diskutil eraseDisk APFS X disk2',
      'dd if=x of=/dev/disk2',
      'sudo shutdown -h now',
    ])
      expect([bad, irreversible(bad)]).toEqual([bad, true]);
  });

  it('allows once (never always), and refuses once', () => {
    const choices = [
      { id: 'always', label: 'Always', kind: 'allow_always' as const },
      { id: 'once', label: 'Once', kind: 'allow_once' as const },
      { id: 'no', label: 'No', kind: 'reject_once' as const },
    ];
    expect(autopilotChoice(choices, false)?.id).toBe('once');
    expect(autopilotChoice(choices.slice(0, 1), false)?.id).toBe('always');
    expect(autopilotChoice(choices, true)?.id).toBe('no');
    expect(autopilotChoice(choices.slice(0, 2), true)).toBeNull();
  });

  it('leaves a question with an "Other" box to the agent, and picks the first option otherwise', () => {
    const f = (key: string, kind: QuestionField['kind'], extra: Partial<QuestionField> = {}): QuestionField => ({ key, title: key, description: '', kind, options: [{ value: 'a', title: 'A', description: '' }, { value: 'b', title: 'B', description: '' }], ...extra });
    expect(autopilotAnswer([f('q', 'single'), f('q_custom', 'text', { options: [], forKey: 'q' }), f('m', 'multi'), f('m_custom', 'text', { options: [], forKey: 'm' })])).toEqual({
      action: 'accept',
      content: { q_custom: AUTOPILOT_ANSWER, m_custom: AUTOPILOT_ANSWER },
    });
    expect(autopilotAnswer([f('size', 'single'), f('tags', 'multi'), f('ok', 'boolean'), f('note', 'text', { options: [] }), f('why', 'text', { options: [], required: true }), f('n', 'number')])).toEqual({
      action: 'accept',
      content: { size: 'a', tags: ['a'], ok: true, why: AUTOPILOT_ANSWER },
    });
    expect(autopilotAnswer([f('n', 'number', { required: true })])).toEqual({ action: 'decline' });
  });
});
