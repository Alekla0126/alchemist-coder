import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONSOLE_SOURCE, configuredServices, findUvx, storeMcpServers } from '../src/main/store-tools';

let home: string;
let project: string;
const config = (values: Record<string, string>) => {
  mkdirSync(join(home, '.config', 'appconsole'), { recursive: true });
  writeFileSync(join(home, '.config', 'appconsole', 'config.json'), JSON.stringify(values));
};
const file = (path: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{}');
  return path;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'store-tools-'));
  project = join(home, 'project');
  mkdirSync(project);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('store tools', () => {
  it('adds nothing until a service is set up', () => {
    expect(configuredServices({}, home)).toEqual([]);
    expect(storeMcpServers('claude-code', project, { env: {}, home, uvx: '/bin/uvx' })).toEqual([]);
  });

  it('finds each service the way app-console does: environment first, then its config file', () => {
    const key = file(join(home, 'keys', 'play.json'));
    config({ GOOGLE_PLAY_SERVICE_ACCOUNT: key, ASC_KEY_ID: 'K', ASC_ISSUER_ID: 'I' });
    expect(configuredServices({}, home)).toEqual(['play', 'appstore']);
    // A key file that isn't there doesn't count; neither does a plugin placeholder.
    expect(configuredServices({ GOOGLE_PLAY_SERVICE_ACCOUNT: join(home, 'missing.json') }, home)).toEqual(['appstore']);
    expect(configuredServices({ ADMOB_PUBLISHER_ID: '${user_config.publisher_id}' }, home)).toEqual(['play', 'appstore']);
    file(join(home, '.config', 'appconsole', 'admob-token.json'));
    expect(configuredServices({}, home)).toEqual(['play', 'appstore', 'admob']);
  });

  it('runs the pinned release with uv, passing on what it needs', () => {
    config({ ADMOB_PUBLISHER_ID: 'pub-1' });
    const servers = storeMcpServers('claude-code', project, { env: { PATH: '/usr/bin', HOME: home, SECRET_ELSEWHERE: 'x' }, home, uvx: '/opt/uv/uvx' });
    expect(servers).toEqual([
      { name: 'alchemist_admob', command: '/opt/uv/uvx', args: ['--quiet', '--from', APP_CONSOLE_SOURCE, 'appconsole', 'mcp', 'admob'], env: { PATH: '/usr/bin', HOME: home } },
    ]);
    expect(APP_CONSOLE_SOURCE).toMatch(/^app-console-mcp @ https:\/\/github\.com\/Alekla0126\/app-console-mcp\/archive\/refs\/tags\/v\d+\.\d+\.\d+\.zip$/);
    expect(storeMcpServers('claude-code', project, { env: {}, home, uvx: null })).toEqual([]);
  });

  it("doesn't add them twice when the agent has app-console already", () => {
    config({ ADMOB_PUBLISHER_ID: 'pub-1' });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { admob: { command: 'uvx', args: ['--from', 'git+https://github.com/Alekla0126/app-console-mcp', 'appconsole', 'mcp', 'admob'] } } }));
    expect(storeMcpServers('claude-code', project, { env: {}, home, uvx: '/bin/uvx' })).toEqual([]);
    rmSync(join(home, '.claude.json'));
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'admob@app-console': true } }));
    expect(storeMcpServers('claude-code', project, { env: {}, home, uvx: '/bin/uvx' })).toEqual([]);
    expect(storeMcpServers('codex', project, { env: {}, home, uvx: '/bin/uvx' })).toHaveLength(1);
  });

  it('finds uvx on PATH', () => {
    const bin = join(home, 'bin');
    expect(findUvx({ PATH: bin }, 'darwin')).toBeNull();
    file(join(bin, 'uvx'));
    chmodSync(join(bin, 'uvx'), 0o755);
    expect(findUvx({ PATH: [join(home, 'nowhere'), bin].join(delimiter) }, 'darwin')).toBe(join(bin, 'uvx'));
  });
});
