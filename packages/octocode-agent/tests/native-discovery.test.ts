import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentDbPath, workspaceAgentRoot } from '@octocodeai/octocode-shared/paths';

import { buildNativeDiscoverySnapshot } from '../src/native-discovery.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function writeSkill(root: string, name: string, description: string): void {
  const file = path.join(root, name, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions.\n`);
}

describe('native discovery snapshot', () => {
  it('lists model, MCP, and Skill sources with safe default enablement and provenance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-discovery-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const octocodeHome = path.join(root, 'octocode');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    writeJson(path.join(octocodeHome, 'agent', 'models.json'), {
      providers: {
        local: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          api: 'openai-completions',
          apiKey: 'LOCAL_MODEL_KEY',
          models: [{ id: 'qwen-local' }],
        },
      },
    });
    writeJson(path.join(octocodeHome, 'agent', 'mcp', 'servers.json'), {
      mcpServers: { native: { url: 'https://native.example.test/mcp' } },
    });
    writeJson(path.join(home, '.agents', 'mcp.json'), {
      mcpServers: { foreign: { url: 'https://foreign.example.test/mcp', headers: { Authorization: 'secret-value' } } },
    });
    writeSkill(path.join(octocodeHome, 'agent', 'skills'), 'native-skill', 'Native Skill');
    writeSkill(path.join(home, '.agents', 'skills'), 'foreign-skill', 'Foreign Skill');

    const snapshot = buildNativeDiscoverySnapshot({
      cwd: workspace,
      env: { HOME: home, OCTOCODE_HOME: octocodeHome },
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    });

    expect(snapshot.generatedAt).toBe('2026-08-29T00:00:00.000Z');
    expect(snapshot.models.entries).toContainEqual(expect.objectContaining({ providerId: 'local', id: 'qwen-local', enabled: true }));
    expect(snapshot.models.sources).toContainEqual(expect.objectContaining({ path: path.join(octocodeHome, 'agent', 'models.json'), parseState: 'valid' }));
    expect(snapshot.mcp.servers).toContainEqual(expect.objectContaining({ name: 'native', vendor: 'octocode', enabled: true }));
    expect(snapshot.mcp.servers).toContainEqual(expect.objectContaining({ name: 'agents.foreign', vendor: 'agents', enabled: false }));
    expect(snapshot.skills.sources).toContainEqual(expect.objectContaining({ name: 'native-skill', vendor: 'octocode', enabled: true }));
    expect(snapshot.skills.sources).toContainEqual(expect.objectContaining({ name: 'foreign-skill', vendor: 'agents', enabled: false }));
    expect(JSON.stringify(snapshot)).not.toContain('secret-value');
    expect(fs.existsSync(agentDbPath({ HOME: home, OCTOCODE_HOME: octocodeHome }))).toBe(false);
  });

  it('discovers managed global and repository sources from a nested working directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-scopes-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const octocodeHome = path.join(root, 'octocode');
    const repository = path.join(root, 'repository');
    const workspace = path.join(repository, 'packages', 'app');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    writeJson(path.join(octocodeHome, 'agent', 'models.json'), {
      providers: { global: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', apiKey: 'global', models: [{ id: 'global-model' }] } },
    });
    const workspaceAgent = workspaceAgentRoot(repository, octocodeHome);
    writeJson(path.join(workspaceAgent, 'models.json'), {
      providers: { repository: { baseUrl: 'http://127.0.0.1:11435/v1', api: 'openai-completions', apiKey: 'repository', models: [{ id: 'repository-model' }] } },
    });
    writeJson(path.join(octocodeHome, 'agent', 'mcp', 'servers.json'), { mcpServers: { global: { url: 'https://global.example.test/mcp' } } });
    writeJson(path.join(workspaceAgent, 'mcp', 'servers.json'), { mcpServers: { repository: { url: 'https://repository.example.test/mcp' } } });
    writeSkill(path.join(octocodeHome, 'agent', 'skills'), 'global-skill', 'Global Skill');

    const snapshot = buildNativeDiscoverySnapshot({
      cwd: workspace,
      env: { HOME: home, OCTOCODE_HOME: octocodeHome },
      workspaceTrusted: true,
    });

    expect(snapshot.models.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'native.global', scope: 'global', path: path.join(octocodeHome, 'agent', 'models.json') }),
      expect.objectContaining({ id: 'native.workspace', scope: 'workspace', path: path.join(workspaceAgent, 'models.json') }),
    ]));
    expect(snapshot.mcp.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'global', scope: 'global', enabled: true }),
      expect.objectContaining({ name: 'repository', scope: 'workspace', enabled: true }),
    ]));
    expect(snapshot.skills.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'global-skill', scope: 'user', enabled: true }),
    ]));
  });
});
