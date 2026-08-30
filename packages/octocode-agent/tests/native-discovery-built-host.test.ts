import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

it('discovers foreign MCP and Skill sources through the built CLI without mutating imports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-built-discovery-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const octocodeHome = path.join(root, 'octocode-home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });

  const jsonMcp = [
    [path.join(workspace, '.pi', 'mcp.json'), 'pi-project'],
    [path.join(home, '.pi', 'mcp.json'), 'pi-user'],
    [path.join(workspace, '.claude', 'mcp.json'), 'claude-project'],
    [path.join(home, '.claude', 'mcp.json'), 'claude-user'],
    [path.join(workspace, '.cursor', 'mcp.json'), 'cursor-project'],
    [path.join(home, '.cursor', 'mcp.json'), 'cursor-user'],
    [path.join(workspace, '.agent', 'mcp.json'), 'agent-project'],
    [path.join(home, '.agent', 'mcp.json'), 'agent-user'],
  ] as const;
  for (const [file, name] of jsonMcp) write(file, JSON.stringify({ mcpServers: { [name]: { command: process.execPath } } }));
  const codexProject = path.join(workspace, '.codex', 'config.toml');
  const codexUser = path.join(home, '.codex', 'config.toml');
  write(codexProject, '[mcp_servers.codex-project]\ncommand = "node"\n');
  write(codexUser, '[mcp_servers.codex-user]\ncommand = "node"\n');

  const skillSources = [
    [path.join(workspace, '.pi', 'skills'), 'pi-project-skill'],
    [path.join(home, '.pi', 'skills'), 'pi-user-skill'],
    [path.join(workspace, '.claude', 'skills'), 'claude-project-skill'],
    [path.join(home, '.claude', 'skills'), 'claude-user-skill'],
    [path.join(workspace, '.cursor', 'skills'), 'cursor-project-skill'],
    [path.join(home, '.cursor', 'skills'), 'cursor-user-skill'],
    [path.join(workspace, '.codex', 'skills'), 'codex-project-skill'],
    [path.join(home, '.codex', 'skills'), 'codex-user-skill'],
    [path.join(workspace, '.agent', 'skills'), 'agent-project-skill'],
    [path.join(home, '.agent', 'skills'), 'agent-user-skill'],
  ] as const;
  for (const [directory, name] of skillSources) write(path.join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nFixture.\n`);
  const fixtureFiles = [...jsonMcp.map(([file]) => file), codexProject, codexUser, ...skillSources.map(([directory, name]) => path.join(directory, name, 'SKILL.md'))];
  const before = new Map(fixtureFiles.map((file) => [file, fs.readFileSync(file)]));

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'out', 'octocode-agent.mjs'), 'discover', '--json'], {
    cwd: workspace,
    env: { ...process.env, HOME: home, OCTOCODE_HOME: octocodeHome },
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  const snapshot = JSON.parse(result.stdout) as {
    mcp: { servers: Array<{ name: string; vendor: string; scope: string; enabled: boolean }> };
    skills: { sources: Array<{ name: string; vendor: string; scope: string; enabled: boolean }> };
  };
  expect(snapshot.mcp.servers).toHaveLength(10);
  expect(new Set(snapshot.mcp.servers.map(({ vendor }) => vendor))).toEqual(new Set(['pi', 'claude', 'cursor', 'codex', 'agent']));
  expect(snapshot.mcp.servers.every(({ enabled }) => enabled === false)).toBe(true);
  expect(snapshot.mcp.servers.map(({ scope }) => scope)).toContain('global');
  expect(snapshot.mcp.servers.map(({ scope }) => scope)).toContain('workspace');
  expect(snapshot.skills.sources).toHaveLength(10);
  expect(new Set(snapshot.skills.sources.map(({ vendor }) => vendor))).toEqual(new Set(['pi', 'claude', 'cursor', 'codex', 'agent']));
  expect(snapshot.skills.sources.every(({ enabled }) => enabled === false)).toBe(true);
  for (const [file, bytes] of before) expect(fs.readFileSync(file)).toEqual(bytes);
});
