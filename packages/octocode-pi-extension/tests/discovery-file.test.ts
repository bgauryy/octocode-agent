import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { buildDiscoverySnapshot, discoverMcpConfigs, getDiscoveryFilePath, writeDiscoveryFile } from '../src/tools/discovery-file.js';
import { __test__ as mcpTestHooks } from '../src/tools/mcp-tool.js';
import type { DiscoveredSkill } from '../src/tools/skill-tool.js';
import type { PiContext } from '../src/types.js';

afterEach(() => {
  mcpTestHooks.clearCachedMcpCatalog();
});

function tmpCtx(): PiContext {
  return { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'octo-discovery-')) } as unknown as PiContext;
}

const SKILLS: DiscoveredSkill[] = [
  { name: 'demo-flow', description: 'Demo workflow.', path: '/x/demo-flow/SKILL.md', dir: '/x/demo-flow', source: 'project' },
];

test('discovery snapshot inventories skills, native tools (sorted), and full MCP configuration', async () => {
  const ctx = tmpCtx();
  mcpTestHooks.setCachedMcpCatalog(ctx, [{
    name: 'octocode',
    instructions: 'Research via tools.',
    text: 'octocode: 1 tool(s)',
    tools: [{ name: 'localSearchCode', description: 'Search local code.', inputSchema: { type: 'object' } }],
  }]);
  const snapshot = await buildDiscoverySnapshot(ctx, { skills: SKILLS, nativeTools: ['write', 'bash', 'skill'] });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.workspace, (ctx as unknown as { cwd: string }).cwd);
  assert.deepEqual(snapshot.nativeTools, ['bash', 'skill', 'write'], 'sorted for stable diffs');
  assert.deepEqual(snapshot.skills, [{ name: 'demo-flow', description: 'Demo workflow.', source: 'project', path: '/x/demo-flow/SKILL.md' }]);
  // MCP: the built-in octocode server is always configured; discovered tools come from the cache.
  const octo = snapshot.mcp.servers.find((s) => s.name === 'octocode');
  assert.ok(octo, 'built-in octocode server inventoried');
  assert.equal(octo!.toolCount, 1);
  assert.deepEqual(octo!.tools, [{ name: 'localSearchCode', description: 'Search local code.' }]);
  assert.ok(snapshot.mcp.sources.some((s) => s.scope === 'built-in'));
});

test('writeDiscoveryFile writes .octocode/discovery.json atomically and returns the path', async () => {
  const ctx = tmpCtx();
  const filePath = await writeDiscoveryFile(ctx, { skills: SKILLS, nativeTools: ['skill'] });
  assert.equal(filePath, getDiscoveryFilePath((ctx as unknown as { cwd: string }).cwd));
  const parsed = JSON.parse(fs.readFileSync(filePath!, 'utf8'));
  assert.equal(parsed.harness, '@octocodeai/pi-extension');
  assert.equal(parsed.skills[0].name, 'demo-flow');
  assert.ok(Array.isArray(parsed.mcp.servers));
  assert.ok(!fs.readdirSync(path.dirname(filePath!)).some((f) => f.endsWith('.tmp')), 'no temp files left behind');
});

// ─── MCP config discoverability across common ecosystem locations ─────────────

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('discoverMcpConfigs inventories official and compatibility MCP locations without activating foreign hosts', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-disc-cwd-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-disc-home-'));
  const octocodeHome = path.join(homeDir, '.octocode-custom');

  const projectClaude = path.join(cwd, '.mcp.json');
  const projectClaudeCompat = path.join(cwd, '.claude', 'mcp.json');
  const projectCursor = path.join(cwd, '.cursor', 'mcp.json');
  const projectCodex = path.join(cwd, '.codex', 'config.toml');
  const projectAgents = path.join(cwd, '.agents', 'mcp.json');
  const projectOctocodeCompat = path.join(cwd, '.octocode', 'mcp.json');
  const projectOctocode = path.join(cwd, '.octocode', 'agent', 'mcp', 'servers.json');
  const userClaude = path.join(homeDir, '.claude.json');
  const userClaudeCompat = path.join(homeDir, '.claude', 'mcp.json');
  const userCursor = path.join(homeDir, '.cursor', 'mcp.json');
  const userCodex = path.join(homeDir, '.codex', 'config.toml');
  const userAgents = path.join(homeDir, '.agents', 'mcp.json');
  const userOctocode = path.join(octocodeHome, 'agent', 'mcp', 'servers.json');

  write(projectClaude, JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'] } } }));
  write(projectClaudeCompat, JSON.stringify({ mcpServers: { claudeCompat: { command: 'claude-compat' } } }));
  write(projectCursor, JSON.stringify({ mcpServers: { figma: { url: 'https://example.invalid/mcp', headers: { Authorization: 'secret' } } } }));
  write(projectCodex, '[other]\nx = 1\n[mcp_servers.github]\ncommand = "gh-mcp"\n[mcp_servers.github.env]\nTOKEN = "x"\n[mcp_servers.jira]\n');
  write(projectAgents, JSON.stringify({ mcpServers: { sharedAgent: { command: 'agent-mcp' } } }));
  write(projectOctocodeCompat, JSON.stringify({ servers: { oldOctocode: { command: 'old-octocode-mcp' } } }));
  write(projectOctocode, JSON.stringify({ mcpServers: { octocodeAgent: { command: 'octocode-agent' } } }));
  write(userClaude, JSON.stringify({ mcpServers: { memory: { command: 'mem-mcp', env: { TOKEN: 'never-report-me' } } } }));
  write(userClaudeCompat, JSON.stringify({ mcpServers: { userCompat: { command: 'user-compat' } } }));
  write(userCursor, JSON.stringify({ mcpServers: { browser: { command: 'browser-mcp' } } }));
  write(userCodex, '[mcp_servers.docs]\nurl = "https://example.invalid/mcp"\n');
  write(userAgents, JSON.stringify({ mcpServers: { globalAgent: { command: 'global-agent-mcp' } } }));
  write(userOctocode, JSON.stringify({ mcpServers: { globalOctocode: { command: 'global-octocode' } } }));

  const configs = discoverMcpConfigs(cwd, { homeDir, octocodeHome });
  const byPath = (filePath: string) => configs.find((config) => config.path === filePath)!;

  assert.deepEqual(byPath(projectClaude).servers, [{ name: 'linear', command: 'npx' }]);
  assert.equal(byPath(projectClaude).host, 'claude');
  assert.deepEqual(byPath(projectCursor).servers, [{ name: 'figma' }], 'remote URL and headers are not exposed');
  assert.deepEqual(byPath(projectCodex).servers, [{ name: 'github', command: 'gh-mcp' }, { name: 'jira' }], 'TOML server names + commands extracted');
  assert.equal(byPath(projectCodex).format, 'toml');
  assert.equal(byPath(projectAgents).host, 'agents');
  assert.equal(byPath(userClaude).scope, 'user');
  assert.deepEqual(byPath(userClaude).servers, [{ name: 'memory', command: 'mem-mcp' }]);
  assert.equal(JSON.stringify(configs).includes('never-report-me'), false, 'env secrets never enter discovery output');

  const expectedActive = new Set([
    projectOctocode,
    userOctocode,
  ]);
  for (const config of configs) {
    assert.equal(config.active, expectedActive.has(config.path), `${config.path} active classification`);
  }
  assert.equal(byPath(projectOctocodeCompat).active, false, 'legacy .octocode/mcp.json remains inventory-only');
  assert.equal(byPath(projectClaudeCompat).active, false);
  assert.equal(byPath(userClaudeCompat).active, false);
});

test('discoverMcpConfigs reports malformed configs as errors instead of throwing, and skips absent files', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-disc-bad-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-disc-empty-'));
  write(path.join(cwd, '.cursor', 'mcp.json'), '{not json');
  const configs = discoverMcpConfigs(cwd, home);
  assert.equal(configs.length, 1, 'only existing files are inventoried');
  assert.ok(configs[0]!.error, 'parse failure captured as error');
  assert.deepEqual(configs[0]!.servers, []);
});

test('discovery snapshot embeds discoveredConfigs under mcp', async () => {
  const ctx = tmpCtx();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-disc-snap-'));
  write(path.join((ctx as unknown as { cwd: string }).cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { figma: { command: 'figma-mcp' } } }));
  const snapshot = await buildDiscoverySnapshot(ctx, { skills: [], nativeTools: [], home });
  assert.equal(snapshot.mcp.discoveredConfigs.length, 1);
  assert.equal(snapshot.mcp.discoveredConfigs[0]!.host, 'cursor');
});

test('writeDiscoveryFile never throws — an unwritable workspace returns null', async () => {
  const ctx = { cwd: '/nonexistent-root-path/definitely/not/writable' } as unknown as PiContext;
  const filePath = await writeDiscoveryFile(ctx, { skills: [], nativeTools: [] });
  assert.equal(filePath, null);
});
