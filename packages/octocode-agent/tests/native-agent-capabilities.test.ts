import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@octocodeai/agent-core';
import { loadNativeMcpServers, registerNativeMcpTool, type NativeMcpClient } from '../src/native-mcp.js';
import { registerNativeSkillTool } from '../src/native-skills.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const execution = (input: unknown, cwd: string, trust: 'trusted' | 'untrusted' = 'trusted') => ({
  input,
  callId: 'call:1' as never,
  context: { sessionId: 's' as never, cwd, mode: 'headless' as const, trust: { workspace: trust, managedOnly: false }, signal: new AbortController().signal },
  signal: new AbortController().signal,
  update: async () => undefined,
});

describe('native Agent Skills and MCP capabilities', () => {
  it('loads managed MCP configuration only from the global agent home', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-hierarchy-'));
    roots.push(root);
    const nested = path.join(root, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    const octocodeHome = path.join(root, 'home');
    const globalConfig = path.join(octocodeHome, 'agent', 'mcp', 'servers.json');
    const projectConfig = path.join(nested, '.octocode', 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
    fs.writeFileSync(globalConfig, JSON.stringify({ mcpServers: { managed: { command: 'managed-command' } } }));
    fs.writeFileSync(projectConfig, JSON.stringify({ mcpServers: { forbidden: { command: 'project-command' } } }));

    expect(loadNativeMcpServers({ cwd: nested, env: { OCTOCODE_HOME: octocodeHome } })).toMatchObject({
      managed: { command: 'managed-command', provenance: { scope: 'global', file: globalConfig } },
    });
    expect(loadNativeMcpServers({ cwd: nested, env: { OCTOCODE_HOME: octocodeHome } })).not.toHaveProperty('forbidden');
  });

  it('does not follow symlinked MCP configuration files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-config-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-config-link-outside-'));
    roots.push(root, outside);
    const outsideConfig = path.join(outside, 'servers.json');
    fs.writeFileSync(outsideConfig, JSON.stringify({ mcpServers: { escaped: { command: 'nope' } } }));
    const octocodeHome = path.join(root, 'octocode-home');
    const config = path.join(octocodeHome, 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.symlinkSync(outsideConfig, config);
    expect(loadNativeMcpServers({ cwd: root, octocodeHome })).not.toHaveProperty('escaped');
  });

  it('does not let a disabled compatibility server overwrite a colliding managed server', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-collision-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const octocodeHome = path.join(root, 'octocode-home');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(octocodeHome, 'agent', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { docs: { url: 'https://foreign.example/mcp' } } }));
    fs.writeFileSync(path.join(octocodeHome, 'agent', 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { 'cursor.docs': { url: 'https://managed.example/mcp' } } }));

    expect(loadNativeMcpServers({ cwd: root, homeDir: home, octocodeHome })).toMatchObject({
      'cursor.docs': { url: 'https://managed.example/mcp', defaultEnabled: true },
    });
  });

  it('loads skill instructions progressively without granting allowed-tools', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-'));
    roots.push(root);
    const skillDir = path.join(root, '.agents', 'skills', 'release-check');
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: release-check\ndescription: Run release checks.\nallowed-tools: Bash(git:*) Read\n---\n# Release\n\nRun tests.');
    fs.writeFileSync(path.join(skillDir, 'references', 'DETAILS.md'), '# Details');
    const registry = new ToolRegistry();
    registerNativeSkillTool(registry, { cwd: root, roots: [path.join(root, '.agents', 'skills')] });
    const tool = registry.get('skill')!;
    const listed = await tool.execute(execution({ action: 'list' }, root));
    expect(listed.content).toMatchObject({ skills: [{ name: 'release-check', provenance: { scope: 'workspace', root: path.join(root, '.agents', 'skills') } }] });
    const loaded = await tool.execute(execution({ action: 'load', name: 'release-check' }, root));
    expect(loaded.content).toMatchObject({ name: 'release-check', allowedTools: 'Bash(git:*) Read' });
    expect(JSON.stringify(loaded.content)).toContain('Run tests.');
    expect(JSON.stringify(loaded.content)).toContain('references/DETAILS.md');
    expect(tool.policy.effects).toEqual(['read']);
    const supporting = await tool.execute(execution({ action: 'read', name: 'release-check', file: 'references/DETAILS.md' }, root));
    expect(supporting.content).toEqual({ name: 'release-check', file: path.join('references', 'DETAILS.md'), content: '# Details' });
    await expect(tool.execute(execution({ action: 'read', name: 'release-check', file: '../outside.md' }, root)))
      .rejects.toThrow(/skill (directory|file)/i);
  });

  it('lists workspace skills without injecting their instructions into an untrusted runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-trust-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.git'));
    const skillDir = path.join(root, '.agents', 'skills', 'unsafe-workspace');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: unsafe-workspace\ndescription: Workspace instructions.\n---\nDo a workspace thing.');
    const registry = new ToolRegistry();
    registerNativeSkillTool(registry, { cwd: root, roots: [path.join(root, '.agents', 'skills')] });
    const tool = registry.get('skill')!;

    await expect(tool.execute(execution({ action: 'list' }, root, 'untrusted'))).resolves.toMatchObject({ ok: true });
    await expect(tool.execute(execution({ action: 'load', name: 'unsafe-workspace' }, root, 'untrusted')))
      .rejects.toMatchObject({ category: 'trust' });
  });

  it('reports and ignores symlinked skill roots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-root-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-root-link-outside-'));
    roots.push(root, outside);
    const skill = path.join(outside, 'escaped');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: escaped\ndescription: Escaped skill.\n---\nEscape.');
    const linkedRoot = path.join(root, '.agents', 'skills');
    fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
    fs.symlinkSync(outside, linkedRoot);
    const registry = new ToolRegistry();
    registerNativeSkillTool(registry, { cwd: root, roots: [linkedRoot] });
    const listed = await registry.get('skill')!.execute(execution({ action: 'list' }, root));
    expect(listed.content).toMatchObject({ skills: [], errors: [{ path: linkedRoot }] });
  });

  it('routes MCP list/describe/call through canonical config and validates arguments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-'));
    roots.push(root);
    const octocodeHome = path.join(root, 'home');
    const config = path.join(octocodeHome, 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ['fixture.mjs'], env: { TOKEN: '${env:MCP_FIXTURE_TOKEN}' } } } }));
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const listTools = vi.fn(async () => ({ tools: [{ name: 'probe', description: 'Probe', inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } }, additionalProperties: false } }], ttlMs: 30_000, cacheScope: 'private' as const }));
    const client: NativeMcpClient = {
      listTools,
      callTool,
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
      listPrompts: async () => ({ prompts: [] }),
      getPrompt: async () => ({ messages: [] }),
      complete: async () => ({ completion: { values: [] } }),
      request: async () => ({}),
      close: async () => undefined,
    };
    type Connect = NonNullable<Parameters<typeof registerNativeMcpTool>[1]['connect']>;
    const connect = vi.fn<Connect>(async () => client);
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, homeDir: octocodeHome, octocodeHome, connect });
    const tool = registry.get('MCPTool')!;
    await expect(tool.execute(execution({ action: 'call', server: 'fixture', tool: 'probe', arguments: {} }, root))).rejects.toThrow(/message/);
    const called = await tool.execute(execution({ action: 'call', server: 'fixture', tool: 'probe', arguments: { message: 'hello' } }, root));
    expect(called.content).toMatchObject({ content: [{ text: 'ok' }] });
    expect(callTool).toHaveBeenCalledWith({ name: 'probe', arguments: { message: 'hello' } }, expect.anything());
    expect(connect.mock.calls[0]?.[1]).toMatchObject({ envRefs: { TOKEN: 'MCP_FIXTURE_TOKEN' } });
    expect(connect.mock.calls[0]?.[1]).not.toHaveProperty('env.TOKEN');
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(tool.policy.effects).toEqual(['network', 'process', 'write']);
  });

  it('normalizes MCP tool errors without hiding their corrective content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-error-'));
    roots.push(root);
    const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath } } }));
    const client: NativeMcpClient = {
      listTools: async () => ({ tools: [{ name: 'probe', inputSchema: { type: 'object' } }] }),
      callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'try a different argument' }] }),
      listResources: async () => ({}), readResource: async () => ({}), listPrompts: async () => ({}),
      getPrompt: async () => ({}), complete: async () => ({}), request: async () => ({}), close: async () => undefined,
    };
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => client });

    await expect(registry.get('MCPTool')!.execute(execution({ action: 'call', server: 'fixture', tool: 'probe', arguments: {} }, root)))
      .resolves.toMatchObject({
        ok: false,
        category: 'tool-execution',
        content: { isError: true, content: [{ text: 'try a different argument' }] },
      });
  });

  it('keeps MCP model-facing metadata stable across equivalent config ordering', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-order-'));
    roots.push(root);
    const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const descriptionFor = (servers: Record<string, unknown>): string => {
      fs.writeFileSync(config, JSON.stringify({ mcpServers: servers }));
      const registry = new ToolRegistry();
      registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: vi.fn() });
      return registry.get('MCPTool')!.description;
    };

    expect(descriptionFor({ zeta: { command: 'z' }, alpha: { command: 'a' } }))
      .toBe(descriptionFor({ alpha: { command: 'a' }, zeta: { command: 'z' } }));
  });

  it('collects paginated MCP tool catalogs deterministically', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-pages-'));
    roots.push(root);
    const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath } } }));
    const listTools = vi.fn(async (params?: { cursor?: string }) => params?.cursor === 'next'
      ? { tools: [{ name: 'beta', inputSchema: { type: 'object' } }] }
      : { tools: [{ name: 'zeta', inputSchema: { type: 'object' } }, { name: 'alpha', inputSchema: { type: 'object' } }], nextCursor: 'next' });
    const client: NativeMcpClient = {
      listTools, callTool: async () => ({}), listResources: async () => ({}), readResource: async () => ({}),
      listPrompts: async () => ({}), getPrompt: async () => ({}), complete: async () => ({}), request: async () => ({}), close: async () => undefined,
    };
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => client });

    await expect(registry.get('MCPTool')!.execute(execution({ action: 'describe', server: 'fixture', tool: 'beta' }, root)))
      .resolves.toMatchObject({ content: { name: 'beta' } });
    expect(listTools.mock.calls.map(([params]) => params)).toEqual([undefined, { cursor: 'next' }]);
  });

  it('treats absent or zero MCP TTL hints as immediately stale', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-ttl-'));
    roots.push(root);
    const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath } } }));
    const listTools = vi.fn(async () => ({
      tools: [{ name: 'probe', inputSchema: { type: 'object' } }],
      ttlMs: 0,
      cacheScope: 'private' as const,
    }));
    const client: NativeMcpClient = {
      listTools, callTool: async () => ({}), listResources: async () => ({}), readResource: async () => ({}),
      listPrompts: async () => ({}), getPrompt: async () => ({}), complete: async () => ({}), request: async () => ({}), close: async () => undefined,
    };
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => client, now: () => 100 });
    const tool = registry.get('MCPTool')!;

    await tool.execute(execution({ action: 'describe', server: 'fixture', tool: 'probe' }, root));
    await tool.execute(execution({ action: 'describe', server: 'fixture', tool: 'probe' }, root));
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('keeps status secret-free and does not connect', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-status-'));
    roots.push(root);
    const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { remote: { url: 'https://mcp.example.test', headers: { Authorization: 'secret-value' } } } }));
    const connect = vi.fn();
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, homeDir: path.join(root, 'user-home'), octocodeHome: path.join(root, 'home'), connect });
    const status = await registry.get('MCPTool')!.execute(execution({ action: 'status' }, root));
    expect(status.content).toMatchObject({ servers: [{ name: 'remote', transport: 'http', enabled: true, provenance: { scope: 'global', file: config } }] });
    expect(JSON.stringify(status.content)).not.toContain('secret-value');
    expect(connect).not.toHaveBeenCalled();
  });

  it('discovers foreign MCP servers but blocks connection until explicitly enabled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-foreign-'));
    roots.push(root);
    const homeDir = path.join(root, 'home');
    const config = path.join(homeDir, '.agents', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { foreign: { url: 'https://mcp.example.test' } } }));
    const connect = vi.fn();
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, homeDir, octocodeHome: path.join(root, 'octocode'), connect });
    const tool = registry.get('MCPTool')!;

    const status = await tool.execute(execution({ action: 'status' }, root));
    expect(status.content).toMatchObject({ servers: [expect.objectContaining({ name: 'agents.foreign', enabled: false })] });
    await expect(tool.execute(execution({ action: 'describe', server: 'agents.foreign', tool: 'probe' }, root))).rejects.toThrow(/disabled MCP server/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('keeps resources, prompts, and completion protocol families reachable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-protocols-'));
    roots.push(root);
    const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath } } }));
    const client: NativeMcpClient = {
      listTools: async () => ({ tools: [] }), callTool: async () => ({}),
      listResources: vi.fn(async (params?: { cursor?: string }) => params?.cursor === 'resources-next'
        ? { resources: [{ uri: 'file:///y' }] }
        : { resources: [{ uri: 'file:///x' }], nextCursor: 'resources-next' }),
      readResource: async ({ uri }) => ({ contents: [{ uri }] }),
      listPrompts: vi.fn(async (params?: { cursor?: string }) => params?.cursor === 'prompts-next'
        ? { prompts: [{ name: 'explain' }] }
        : { prompts: [{ name: 'review' }], nextCursor: 'prompts-next' }),
      getPrompt: async ({ name }) => ({ description: name, messages: [] }),
      complete: async ({ argument }) => ({ completion: { values: [argument.value] } }),
      request: async () => ({}),
      close: async () => undefined,
    };
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => client });
    const tool = registry.get('MCPTool')!;
    expect(await tool.execute(execution({ action: 'resources', server: 'fixture' }, root))).toMatchObject({ ok: true, content: { resources: [{ uri: 'file:///x' }, { uri: 'file:///y' }] } });
    expect(await tool.execute(execution({ action: 'read-resource', server: 'fixture', uri: 'file:///x' }, root))).toMatchObject({ content: { contents: [{ uri: 'file:///x' }] } });
    expect(await tool.execute(execution({ action: 'prompts', server: 'fixture' }, root))).toMatchObject({ content: { prompts: [{ name: 'review' }, { name: 'explain' }] } });
    expect(await tool.execute(execution({ action: 'get-prompt', server: 'fixture', prompt: 'review', arguments: { topic: 'mcp' } }, root))).toMatchObject({ content: { description: 'review' } });
    expect(await tool.execute(execution({ action: 'complete', server: 'fixture', ref: { type: 'ref/prompt', name: 'review' }, argument: { name: 'topic', value: 'mcp' } }, root))).toMatchObject({ content: { completion: { values: ['mcp'] } } });
  });
});
