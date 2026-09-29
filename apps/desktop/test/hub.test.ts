import { describe, expect, it } from 'vitest';
import { scrub } from '@alchemist-coder/extensions';
import { maskArgs, secretsOf } from '../src/main/hub';

describe('maskArgs', () => {
  it('hides secret-looking values but keeps commands readable', () => {
    expect(maskArgs(['-y', '@modelcontextprotocol/server-github', '--api-key', 'sk-live-123', '--token=abc', '--port', '8080'])).toEqual([
      '-y',
      '@modelcontextprotocol/server-github',
      '--api-key',
      '•••',
      '--token=•••',
      '--port',
      '8080',
    ]);
    // A made-up token, built at runtime so secret scanners don't mistake it for a real one.
    const token = `ghp_${'a1'.repeat(18)}`;
    expect(maskArgs([token, '/Users/me/servers/run.py', 'mcp-server-sqlite'])).toEqual(['•••', '/Users/me/servers/run.py', 'mcp-server-sqlite']);
  });
});

describe('secretsOf', () => {
  it('collects every value the renderer must never see', () => {
    const def = {
      transport: 'stdio' as const,
      command: 'npx',
      args: ['server', '--api-key', 'sk-live-123456', '--token=tok-abcdef', 'https://me:p%40ss123@host/mcp?access_token=qwerty12'],
      env: { GITHUB_TOKEN: 'ghp_secret' },
    };
    const secrets = secretsOf(def);
    const leaked = `codex: {"args":${JSON.stringify(def.args)},"env":${JSON.stringify(def.env)}} p@ss123`;
    const out = scrub(leaked, secrets);
    for (const s of ['sk-live-123456', 'tok-abcdef', 'p%40ss123', 'p@ss123', 'qwerty12', 'ghp_secret']) expect(out).not.toContain(s);
    expect(out).toContain('server');
  });

  it('covers header values of remote servers', () => {
    expect(scrub('401 for Bearer: xyz-12345', secretsOf({ transport: 'http', url: 'https://h/mcp', headers: { 'X-Key': 'xyz-12345' } }))).toBe('401 for Bearer: •••');
  });
});
