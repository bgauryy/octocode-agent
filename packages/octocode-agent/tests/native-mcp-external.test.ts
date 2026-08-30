import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ToolRegistry } from '@octocodeai/agent-core';
import { registerNativeMcpTool } from '../src/native-mcp.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const execution = (input: unknown, cwd: string) => ({
  input,
  callId: 'call:external' as never,
  context: { sessionId: 's' as never, cwd, mode: 'headless' as const, trust: { workspace: 'trusted' as const, managedOnly: false }, signal: new AbortController().signal },
  signal: new AbortController().signal,
  update: async () => undefined,
});

it('calls a real external stdio MCP server through the native facade', async () => {
  const root = fs.mkdtempSync(path.join(packageRoot, '.tmp-native-mcp-'));
  roots.push(root);
  const serverPath = path.join(root, 'server.mjs');
  fs.writeFileSync(serverPath, `
    import { Server } from '@modelcontextprotocol/server';
    import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
    const server = new Server({ name: 'native-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'probe', description: 'Native probe', inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } }, additionalProperties: false } }] }));
    server.setRequestHandler('tools/call', async (request) => ({ content: [{ type: 'text', text: 'native:' + request.params.arguments?.message }] }));
    await server.connect(new StdioServerTransport());
  `);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [serverPath], timeoutMs: 5_000 } } }));
  const registry = new ToolRegistry();
  registerNativeMcpTool(registry, { cwd: workspace, octocodeHome: path.join(root, 'home') });
  const tool = registry.get('MCPTool')!;
  const described = await tool.execute(execution({ action: 'describe', server: 'fixture', tool: 'probe' }, workspace));
  expect(described.content).toMatchObject({ name: 'probe', description: 'Native probe' });
  const called = await tool.execute(execution({ action: 'call', server: 'fixture', tool: 'probe', arguments: { message: 'ok' } }, workspace));
  expect(JSON.stringify(called.content)).toContain('native:ok');
}, 30_000);

it('rejects stdio cwd escapes before spawning a process', async () => {
  const root = fs.mkdtempSync(path.join(packageRoot, '.tmp-native-mcp-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { escape: { command: process.execPath, args: ['nope.mjs'], cwd: '..' } } }));
  const registry = new ToolRegistry();
  registerNativeMcpTool(registry, { cwd: workspace, octocodeHome: path.join(root, 'home') });
  await expect(registry.get('MCPTool')!.execute(execution({ action: 'describe', server: 'escape', tool: 'probe' }, workspace))).rejects.toThrow(/within the workspace/);
});

it('rejects stdio cwd symlinks that escape the workspace', async () => {
  const root = fs.mkdtempSync(path.join(packageRoot, '.tmp-native-mcp-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(workspace, 'linked-outside'));
  const configPath = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { escape: { command: process.execPath, args: ['nope.mjs'], cwd: 'linked-outside' } } }));
  const registry = new ToolRegistry();
  registerNativeMcpTool(registry, { cwd: workspace, octocodeHome: path.join(root, 'home') });

  await expect(registry.get('MCPTool')!.execute(execution({ action: 'describe', server: 'escape', tool: 'probe' }, workspace))).rejects.toThrow(/within the workspace/);
});
