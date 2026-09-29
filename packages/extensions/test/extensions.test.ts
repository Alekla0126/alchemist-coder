import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyJsonStep, describeStep, installStep, inventory, maskArgs, maskCommand, maskUrl, readInstructions, scrub, unifyInstructions, UnsupportedError } from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ext-')));
  dirs.push(d);
  return d;
}
function put(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
const skill = (dir: string, name: string, description = `${name} skill`) => put(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\n---\n# ${name}\n`);

function fixture(grokCompat = true) {
  const home = tmp();
  const root = join(home, 'app');
  put(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        github: { type: 'stdio', command: 'npx', args: ['-y', '@mcp/github'], env: { GITHUB_TOKEN: 'ghp_secret' } },
        docs: { type: 'http', url: 'https://docs.example/mcp' },
      },
      projects: { [root]: { mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } } }, '/other': { mcpServers: { nope: { command: 'x' } } } },
    }),
  );
  put(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }));
  put(join(home, '.codex', 'config.toml'), '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@mcp/github"]\n[mcp_servers.github.env]\nGITHUB_TOKEN = "x"\n\n[mcp_servers.old]\ncommand = "old"\nenabled = false\n');
  put(join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: {} }, mcpServers: { unity: { httpUrl: 'http://localhost:8080/mcp' } } }));
  put(join(home, '.grok', 'config.toml'), `${grokCompat ? '' : '[compat.claude]\nmcps = false\nskills = false\nhooks = false\n\n'}[mcp_servers.sentry]\nurl = "https://mcp.sentry.dev/mcp"\n\n[[hooks.PreToolUse]]\nmatcher = "Bash"\nhooks = [{ type = "command", command = "./guard.sh" }]\n`);
  put(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  skill(join(home, '.claude', 'skills', 'synced', 'uuid-1'), 'pdf');
  skill(join(home, '.codex', 'skills'), 'playwright');
  skill(join(home, '.codex', 'skills', '.system'), 'hidden');
  skill(join(root, '.agents', 'skills'), 'release');
  return { home, root };
}

describe('inventory', () => {
  it('reads MCP servers from all four CLIs and shows who can use each', () => {
    const { home, root } = fixture();
    const inv = inventory({ home }, root);
    const by = Object.fromEntries(inv.mcp.map((s) => [s.name, s]));
    expect(Object.keys(by)).toEqual(['db', 'docs', 'github', 'playwright', 'sentry', 'unity']);
    // Claude + Codex have github in their own config; Grok imports Claude's.
    expect(by.github!.agents).toEqual({ 'claude-code': 'own', grok: 'compat', codex: 'own' });
    expect(by.github!.def).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', '@mcp/github'], env: { GITHUB_TOKEN: 'ghp_secret' } });
    expect(by.docs!.def).toMatchObject({ transport: 'http', url: 'https://docs.example/mcp' });
    expect(by.playwright!.sources[0]).toMatchObject({ agent: 'claude-code', scope: 'local' });
    expect(by.db!.sources[0]).toMatchObject({ scope: 'project', file: join(root, '.mcp.json') });
    expect(by.unity).toMatchObject({ agents: { gemini: 'own' }, def: { transport: 'http', url: 'http://localhost:8080/mcp' } });
    expect(by.sentry).toMatchObject({ agents: { grok: 'own' }, def: { transport: 'http' } });
    expect(by.nope).toBeUndefined();
    expect(by.old).toBeUndefined();
  });

  it('keeps same-named servers with different commands apart and flags the clash', () => {
    const { home, root } = fixture();
    put(join(home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { github: { command: 'evil-github', args: [] } } }));
    const github = inventory({ home }, root).mcp.filter((s) => s.name === 'github');
    expect(github).toHaveLength(2);
    expect(github.every((s) => s.conflict)).toBe(true);
    expect(new Set(github.map((s) => s.id)).size).toBe(2);
    expect(github.find((s) => s.def.command === 'evil-github')!.agents).toEqual({ gemini: 'own' });
    expect(inventory({ home }, root).mcp.find((s) => s.name === 'docs')!.conflict).toBe(false);
  });

  it('never reads project files through symlinks', () => {
    const { home, root } = fixture();
    const secret = join(home, 'secret.txt');
    put(secret, 'TOP SECRET');
    rmSync(join(root, '.mcp.json'));
    symlinkSync(secret, join(root, '.mcp.json'));
    symlinkSync(secret, join(root, 'CLAUDE.md'));
    const inv = inventory({ home }, root);
    expect(inv.mcp.find((s) => s.name === 'db')).toBeUndefined();
    expect(JSON.stringify(inv)).not.toContain('TOP SECRET');
  });

  it('respects Grok turning off its Claude compatibility', () => {
    const { home, root } = fixture(false);
    const inv = inventory({ home }, root);
    expect(inv.grokCompat).toEqual({ mcps: false, skills: false, hooks: false });
    expect(inv.mcp.find((s) => s.name === 'github')!.agents).toEqual({ 'claude-code': 'own', codex: 'own' });
    expect(inv.skills.find((s) => s.name === 'pdf')!.agents).toEqual({ 'claude-code': 'own' });
  });

  it('lists skills and hooks', () => {
    const { home, root } = fixture();
    const inv = inventory({ home }, root);
    expect(inv.skills.map((s) => [s.name, s.agents])).toEqual([
      ['pdf', { 'claude-code': 'own', grok: 'compat' }],
      ['playwright', { codex: 'own' }],
      ['release', { grok: 'own' }],
    ]);
    expect(inv.skills[0]!.description).toBe('pdf skill');
    expect(inv.hooks.map((h) => [h.event, h.matcher, h.command, h.agents])).toEqual([
      ['Stop', null, 'say done', { 'claude-code': 'own', grok: 'compat' }],
      ['PreToolUse', 'Bash', './guard.sh', { grok: 'own' }],
    ]);
  });
});

describe('install steps', () => {
  const github = { transport: 'stdio' as const, command: 'npx', args: ['-y', '@mcp/github'], env: { GITHUB_TOKEN: 'ghp_secret' } };
  const remote = { transport: 'http' as const, url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer abc' } };

  it('uses each CLI the way its docs say', () => {
    expect(installStep('codex', 'github', github, { home: '/h' })).toEqual({ agent: 'codex', kind: 'cli', command: 'codex', args: ['mcp', 'add', 'github', '--env', 'GITHUB_TOKEN=ghp_secret', '--', 'npx', '-y', '@mcp/github'] });
    expect(installStep('grok', 'github', github, { home: '/h', grokBin: '/h/.grok/bin/grok' })).toMatchObject({ command: '/h/.grok/bin/grok', args: ['mcp', 'add', '--scope', 'user', '-e', 'GITHUB_TOKEN=ghp_secret', 'github', '--', 'npx', '-y', '@mcp/github'] });
    expect(installStep('grok', 'remote', remote, { home: '/h' }).kind === 'cli' && (installStep('grok', 'remote', remote, { home: '/h' }) as { args: string[] }).args).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', '-H', 'Authorization: Bearer abc', 'remote', 'https://mcp.example/mcp']);
    const claude = installStep('claude-code', 'remote', remote, { home: '/h' });
    expect(claude).toMatchObject({ command: 'claude', args: ['mcp', 'add-json', '--scope', 'user', 'remote', JSON.stringify({ type: 'http', url: remote.url, headers: remote.headers })] });
    expect(installStep('gemini', 'github', github, { home: '/h' })).toEqual({ agent: 'gemini', kind: 'json', file: join('/h', '.gemini', 'settings.json'), key: ['mcpServers', 'github'], value: { command: 'npx', args: ['-y', '@mcp/github'], env: { GITHUB_TOKEN: 'ghp_secret' } } });
    expect(() => installStep('codex', 'remote', remote, { home: '/h' })).toThrow(UnsupportedError);
    expect(() => installStep('codex', 'bad name; rm -rf', github, { home: '/h' })).toThrow(/name/);
  });

  it('masks secrets when describing a step', () => {
    expect(describeStep(installStep('codex', 'github', github, { home: '/h' }))).toBe('codex mcp add github --env GITHUB_TOKEN=••• -- npx -y @mcp/github');
    expect(describeStep(installStep('grok', 'remote', remote, { home: '/h' }))).toContain('-H Authorization: •••');
    expect(describeStep(installStep('claude-code', 'github', github, { home: '/h' }))).toBe('claude mcp add-json --scope user github {…}');
    expect(describeStep(installStep('claude-code', 'github', github, { home: '/h' }))).not.toContain('ghp_secret');
  });

  it('rejects names that would poison a JSON object', () => {
    for (const name of ['__proto__', 'constructor', 'prototype', '-rf', 'a b', 'x'.repeat(65)]) expect(() => installStep('gemini', name, github, { home: '/h' })).toThrow(UnsupportedError);
  });

  it('shows the real command when describing a step, with secrets masked', () => {
    expect(describeStep(installStep('claude-code', 'github', github, { home: '/h' }), github)).toBe('claude mcp add-json --scope user github { npx -y @mcp/github; env GITHUB_TOKEN=••• }');
  });

  it('edits a symlinked settings file at its real location, keeping its permissions', () => {
    const home = tmp();
    const real = join(home, 'dotfiles', 'gemini.json');
    put(real, JSON.stringify({ mcpServers: {} }));
    chmodSync(real, 0o600);
    mkdirSync(join(home, '.gemini'));
    symlinkSync(real, join(home, '.gemini', 'settings.json'));
    const step = installStep('gemini', 'github', github, { home });
    if (step.kind !== 'json') throw new Error('expected json');
    applyJsonStep(step);
    expect(lstatSync(join(home, '.gemini', 'settings.json')).isSymbolicLink()).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(real, 'utf8')).mcpServers)).toEqual(['github']);
    // Windows has no POSIX permission bits.
    if (process.platform !== 'win32') expect(statSync(real).mode & 0o777).toBe(0o600);
  });

  it('leaves a settings file that is not a JSON object alone', () => {
    const home = tmp();
    put(join(home, '.gemini', 'settings.json'), '[1, 2]');
    const step = installStep('gemini', 'github', github, { home });
    if (step.kind !== 'json') throw new Error('expected json');
    expect(() => applyJsonStep(step)).toThrow();
    expect(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8')).toBe('[1, 2]');
  });

  it('edits Gemini settings without losing other keys', () => {
    const home = tmp();
    put(join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, mcpServers: { unity: { httpUrl: 'x' } } }));
    const step = installStep('gemini', 'github', github, { home });
    if (step.kind !== 'json') throw new Error('expected json');
    applyJsonStep(step);
    const data = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    expect(data.security.auth.selectedType).toBe('gemini-api-key');
    expect(Object.keys(data.mcpServers)).toEqual(['unity', 'github']);
  });
});

describe('instructions', () => {
  it('moves CLAUDE.md into a shared AGENTS.md that every agent reads', () => {
    const root = tmp();
    put(join(root, 'CLAUDE.md'), '# Rules\nUse pnpm.\n');
    const before = readInstructions({ home: root }, root);
    expect(before.unified).toBe(false);
    expect(before.readBy).toMatchObject({ 'claude-code': ['CLAUDE.md'], codex: [], gemini: [], grok: ['CLAUDE.md'] });
    expect(unifyInstructions(root)).toEqual({ created: ['AGENTS.md', 'GEMINI.md'], changed: ['CLAUDE.md'] });
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# Rules\nUse pnpm.\n');
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect(readFileSync(join(root, 'GEMINI.md'), 'utf8')).toBe('@AGENTS.md\n');
    const after = readInstructions({ home: root }, root);
    expect(after.unified).toBe(true);
    expect(after.readBy.codex).toEqual(['AGENTS.md']);
    // Running it again changes nothing.
    expect(unifyInstructions(root)).toEqual({ created: [], changed: [] });
  });

  it('keeps agent-specific notes and imports the shared file above them', () => {
    const root = tmp();
    put(join(root, 'AGENTS.md'), 'Shared rules\n');
    put(join(root, 'CLAUDE.md'), 'Claude-only tips\n');
    expect(unifyInstructions(root)).toEqual({ created: ['GEMINI.md'], changed: ['CLAUDE.md'] });
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n\nClaude-only tips\n');
  });

  it('refuses when there is nothing to share', () => {
    expect(() => unifyInstructions(tmp())).toThrow(/no instructions/);
  });

  it('never writes through a symlink planted in the repo', () => {
    const root = tmp();
    const outside = join(tmp(), 'zshrc');
    put(outside, 'export PATH=/usr/bin\n');
    put(join(root, 'AGENTS.md'), 'Shared rules\n');
    symlinkSync(outside, join(root, 'CLAUDE.md'));
    expect(() => unifyInstructions(root)).toThrow(/symlink/);
    expect(readFileSync(outside, 'utf8')).toBe('export PATH=/usr/bin\n');
  });

  it('counts CLAUDE.md -> AGENTS.md as already shared', () => {
    const root = tmp();
    put(join(root, 'AGENTS.md'), 'Shared rules\n');
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    expect(unifyInstructions(root)).toEqual({ created: ['GEMINI.md'], changed: [] });
    expect(lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });
});

describe('masking', () => {
  it('hides URL credentials and secret query parameters', () => {
    expect(maskUrl('https://user:hunter22@mcp.example/sse?api_key=abc123&region=eu')).toBe('https://•••@mcp.example/sse?api_key=•••&region=eu');
  });

  it('hides env, header and flag values in arguments', () => {
    expect(maskArgs(['-e', 'TOKEN=abc', '-H', 'Authorization: Bearer xyz', '--password', 'pw', 'SECRET_KEY=1', 'plain'])).toEqual(['-e', 'TOKEN=•••', '-H', 'Authorization: •••', '--password', '•••', 'SECRET_KEY=1', 'plain']);
    expect(maskCommand('curl -H "x" --token abc https://a:b@h/ && echo Bearer zzz')).not.toMatch(/abc|a:b@|zzz/);
  });

  it('scrubs literal secrets whatever the format', () => {
    expect(scrub('failed: {"env":{"T":"s3cr3t-value"}} Bearer qq', ['s3cr3t-value', 'no'])).toBe('failed: {"env":{"T":"•••"}} Bearer •••');
  });
});
