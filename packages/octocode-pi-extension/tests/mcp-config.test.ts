import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  globalMcpConfigPaths,
  loadMcpConfig,
  projectMcpConfigPaths,
} from '../src/tools/mcp-config.js';
import type { PiContext } from '../src/types.js';

function writeServer(filePath: string, name: string, command: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers: { [name]: { command } } }), 'utf8');
}

function writeServers(filePath: string, servers: Record<string, { command: string }>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers: servers }), 'utf8');
}

test('MCP config has one canonical global and project location', () => {
  const cwd = '/workspace/project';
  const homeDir = '/users/demo';
  const octocodeHome = '/custom/octocode-home';

  assert.deepEqual(globalMcpConfigPaths({ homeDir, octocodeHome }), [
    path.join(octocodeHome, 'agent', 'mcp', 'servers.json'),
  ]);
  assert.deepEqual(projectMcpConfigPaths(cwd), [
    path.join(cwd, '.octocode', 'agent', 'mcp', 'servers.json'),
  ]);
});

test('loadMcpConfig merges canonical global and project config deterministically', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-config-cwd-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-config-home-'));
  const octocodeHome = path.join(homeDir, '.octocode-custom');
  const globalPaths = globalMcpConfigPaths({ homeDir, octocodeHome });
  const projectPaths = projectMcpConfigPaths(cwd);

  writeServers(globalPaths[0]!, { shared: { command: 'global-command' }, globalOnly: { command: 'global-only' } });
  writeServers(projectPaths[0]!, { shared: { command: 'project-command' }, projectOnly: { command: 'project-only' } });

  const ctx = { cwd, isProjectTrusted: async () => true } as unknown as PiContext;
  const loaded = await loadMcpConfig(ctx, { homeDir, octocodeHome });

  assert.equal(loaded.servers.get('shared')?.command, 'project-command');
  for (const name of ['globalOnly', 'projectOnly']) {
    assert.ok(loaded.servers.has(name), `${name} loaded`);
  }
  assert.deepEqual(loaded.sources.slice(1).map((source) => source.path), [...globalPaths, ...projectPaths]);
  assert.deepEqual(loaded.warnings, []);
});

test('HTTP MCP servers accept URL and headers without a command', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-http-cwd-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-http-home-'));
  const octocodeHome = path.join(homeDir, '.octocode-custom');
  const [configPath] = globalMcpConfigPaths({ homeDir, octocodeHome });
  fs.mkdirSync(path.dirname(configPath!), { recursive: true });
  fs.writeFileSync(configPath!, JSON.stringify({ mcpServers: { remote: {
    url: 'https://mcp.example.test/api',
    headers: { Authorization: 'Bearer test' },
  } } }));
  const loaded = await loadMcpConfig({ cwd, isProjectTrusted: async () => true } as unknown as PiContext, { homeDir, octocodeHome });
  assert.equal(loaded.servers.get('remote')?.transport, 'http');
  assert.equal(loaded.servers.get('remote')?.url, 'https://mcp.example.test/api');
});

test('untrusted projects skip every project alias but still load global aliases', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-config-untrusted-cwd-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-config-untrusted-home-'));
  const octocodeHome = path.join(homeDir, '.octocode-custom');
  const globalPaths = globalMcpConfigPaths({ homeDir, octocodeHome });
  const projectPaths = projectMcpConfigPaths(cwd);

  writeServer(globalPaths[0]!, 'globalOnly', 'global-command');
  for (const [index, filePath] of projectPaths.entries()) writeServer(filePath, `project${index}`, `project-command-${index}`);

  const ctx = { cwd, isProjectTrusted: async () => false } as unknown as PiContext;
  const loaded = await loadMcpConfig(ctx, { homeDir, octocodeHome });

  assert.equal(loaded.servers.get('globalOnly')?.command, 'global-command');
  for (const index of projectPaths.keys()) assert.equal(loaded.servers.has(`project${index}`), false);
  assert.deepEqual(
    loaded.sources.filter((source) => source.scope === 'project').map((source) => ({ path: source.path, trusted: source.trusted })),
    projectPaths.map((filePath) => ({ path: filePath, trusted: false })),
  );
  assert.equal(loaded.warnings.filter((warning) => warning.includes('project is not trusted')).length, projectPaths.length);
});
