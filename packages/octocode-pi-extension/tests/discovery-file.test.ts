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

test('discoverMcpConfigs inventories claude/cursor/codex/octocode/pi configs with hosts, scopes, and servers', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-disc-cwd-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-disc-home-'));
  write(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'] } } }));
  write(path.join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { figma: { command: 'figma-mcp' } } }));
  write(path.join(cwd, '.codex', 'config.toml'), '[other]\nx = 1\n[mcp_servers.github]\ncommand = "gh-mcp"\n[mcp_servers.github.env]\nTOKEN = "x"\n[mcp_servers.jira]\n');
  write(path.join(cwd, '.octocode', 'mcp.json'), JSON.stringify({ servers: { extra: { command: 'extra-mcp' } } }));
  write(path.join(cwd, '.pi', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { active1: { command: 'a' } } }));
  write(path.join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: { memory: { command: 'mem-mcp' } } }));

  const configs = discoverMcpConfigs(cwd, home);
  const byPath = (suffix: string) => configs.find((c) => c.path.endsWith(suffix))!;
  assert.deepEqual(byPath('.mcp.json').servers, [{ name: 'linear', command: 'npx' }]);
  assert.equal(byPath('.mcp.json').host, 'claude');
  assert.deepEqual(byPath('.cursor/mcp.json').servers, [{ name: 'figma', command: 'figma-mcp' }]);
  assert.deepEqual(byPath('config.toml').servers, [{ name: 'github', command: 'gh-mcp' }, { name: 'jira' }], 'toml server names + commands extracted');
  assert.equal(byPath('config.toml').format, 'toml');
  assert.deepEqual(byPath('.octocode/mcp.json').servers, [{ name: 'extra', command: 'extra-mcp' }], 'bare servers container supported');
  assert.equal(byPath('.claude/mcp.json').scope, 'user');
  // Only the harness's own .pi/agent/mcp.json is ACTIVE — foreign configs are inventory only.
  assert.equal(byPath('.pi/agent/mcp.json').active, true);
  for (const config of configs.filter((c) => !c.path.includes('.pi/agent/'))) {
    assert.equal(config.active, false, `${config.path} must not be auto-loaded`);
  }
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
