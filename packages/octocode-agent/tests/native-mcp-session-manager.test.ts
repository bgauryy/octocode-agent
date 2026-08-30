import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@octocodeai/agent-core';
import { NativeMcpSessionManager, registerNativeMcpTool, type NativeMcpClient } from '../src/native-mcp.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-session-'));
  roots.push(root);
  const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath } } }));
  return root;
}

const execution = (input: unknown, cwd: string) => ({
  input,
  callId: 'call:1' as never,
  context: { sessionId: 's' as never, cwd, mode: 'headless' as const, trust: { workspace: 'trusted' as const, managedOnly: false }, signal: new AbortController().signal },
  signal: new AbortController().signal,
  update: async () => undefined,
});

function fakeClient(overrides: Partial<NativeMcpClient> = {}): NativeMcpClient {
  return {
    listTools: async () => ({ tools: [{ name: 'probe', inputSchema: { type: 'object' } }], ttlMs: 60_000 }),
    callTool: async () => ({}),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    listPrompts: async () => ({ prompts: [] }),
    getPrompt: async () => ({ messages: [] }),
    complete: async () => ({ completion: { values: [] } }),
    close: async () => undefined,
    ...overrides,
  };
}

describe('native MCP session manager', () => {
  it('does not steal an old MCP task lock from a live owner', async () => {
    const root = fixtureRoot();
    const store = path.join(root, '.octocode', 'mcp-tasks.json');
    const lock = `${store}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid, createdAt: 1, nonce: 'live-owner' })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const manager = new NativeMcpSessionManager(async () => fakeClient());

    await expect(manager.persistTask(store, {
      task: { id: 'blocked' },
      provenance: { server: 'fixture', operation: 'get', observedAt: Date.now() },
    }, 10)).rejects.toThrow(/busy/i);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(lock, 'utf8')).toContain('live-owner');
  });

  it('recovers an old MCP task lock only after proving its owner is gone', async () => {
    const root = fixtureRoot();
    const store = path.join(root, '.octocode', 'mcp-tasks.json');
    const lock = `${store}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${JSON.stringify({ pid: 2_147_483_647, createdAt: 1, nonce: 'dead-owner' })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const manager = new NativeMcpSessionManager(async () => fakeClient());

    await expect(manager.persistTask(store, {
      task: { id: 'recovered' },
      provenance: { server: 'fixture', operation: 'get', observedAt: Date.now() },
    }, 10)).resolves.toBeUndefined();
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readFileSync(store, 'utf8')).toContain('recovered');
  });

  it('shares simultaneous acquisition and evicts a rejected connection for retry', async () => {
    const client = fakeClient();
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('connect failed'))
      .mockResolvedValue(client);
    const manager = new NativeMcpSessionManager(connect);
    const config = { transport: 'stdio' as const, command: process.execPath };
    const signal = new AbortController().signal;

    const first = manager.acquire('fixture', config, signal);
    const simultaneous = manager.acquire('fixture', config, signal);
    await expect(first).rejects.toThrow('connect failed');
    await expect(simultaneous).rejects.toThrow('connect failed');
    expect(connect).toHaveBeenCalledTimes(1);

    await expect(Promise.all([
      manager.acquire('fixture', config, signal),
      manager.acquire('fixture', config, signal),
    ])).resolves.toEqual([client, client]);
    expect(connect).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it('shares one in-flight close promise across concurrent shutdown callers', async () => {
    let releaseClose!: () => void;
    let reportCloseStarted!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closeStarted = new Promise<void>((resolve) => { reportCloseStarted = resolve; });
    const close = vi.fn(() => {
      reportCloseStarted();
      return closeGate;
    });
    const client = fakeClient({ close });
    const manager = new NativeMcpSessionManager(async () => client);
    await manager.acquire('fixture', { transport: 'stdio', command: process.execPath }, new AbortController().signal);

    let secondSettled = false;
    const first = manager.close();
    const second = manager.close().then(() => { secondSettled = true; });
    await closeStarted;
    expect(close).toHaveBeenCalledTimes(1);
    expect(secondSettled).toBe(false);

    releaseClose();
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reuses one connection, invalidates its catalog on negotiated tools changes, and closes once', async () => {
    const root = fixtureRoot();
    const listTools = vi.fn(fakeClient().listTools);
    const close = vi.fn(async () => undefined);
    let toolsChanged: (() => void | Promise<void>) | undefined;
    const client = fakeClient({
      listTools,
      close,
      getServerCapabilities: () => ({ tools: { listChanged: true } }),
      setNotificationHandler: (method, handler) => {
        expect(method).toBe('notifications/tools/list_changed');
        toolsChanged = handler;
      },
    });
    const connect = vi.fn(async () => client);
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect });
    const tool = registry.get('MCPTool')!;

    await tool.execute(execution({ action: 'describe', server: 'fixture', tool: 'probe' }, root));
    await tool.execute(execution({ action: 'describe', server: 'fixture', tool: 'probe' }, root));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(listTools).toHaveBeenCalledTimes(1);

    await toolsChanged?.();
    await tool.execute(execution({ action: 'describe', server: 'fixture', tool: 'probe' }, root));
    expect(listTools).toHaveBeenCalledTimes(2);

    await manager.close();
    await manager.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe when the server did not negotiate tool list changes', async () => {
    const root = fixtureRoot();
    const setNotificationHandler = vi.fn();
    const client = fakeClient({
      getServerCapabilities: () => ({ tools: {} }),
      setNotificationHandler,
    });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect: async () => client,
    });

    await registry.get('MCPTool')!.execute(execution({ action: 'describe', server: 'fixture', tool: 'probe' }, root));
    expect(setNotificationHandler).not.toHaveBeenCalled();
    await manager.close();
  });

  it('projects negotiated request progress through canonical tool updates in order', async () => {
    const root = fixtureRoot();
    const updates: unknown[] = [];
    const client = fakeClient({
      callTool: async (_params, options) => {
        const onprogress = (options as { onprogress?: (progress: unknown) => void } | undefined)?.onprogress;
        onprogress?.({ progress: 1, total: 2, message: 'halfway' });
        onprogress?.({ progress: 2, total: 2, message: 'done' });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect: async () => client,
    });
    const request = execution({ action: 'call', server: 'fixture', tool: 'probe' }, root);

    const result = await registry.get('MCPTool')!.execute({
      ...request,
      update: async (value) => { updates.push(value); },
    });

    expect(result.ok).toBe(true);
    expect(updates).toEqual([
      { version: 1, kind: 'progress', message: 'halfway', value: { progress: 1, total: 2, message: 'halfway' } },
      { version: 1, kind: 'progress', message: 'done', value: { progress: 2, total: 2, message: 'done' } },
    ]);
    await manager.close();
  });

  it.each([
    ['draft-07', 'http://json-schema.org/draft-07/schema#'],
    ['draft 2020-12', 'https://json-schema.org/draft/2020-12/schema'],
  ])('validates %s MCP tool schemas', async (_label, schemaVersion) => {
    const root = fixtureRoot();
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const client = fakeClient({
      listTools: async () => ({
        tools: [{
          name: 'probe',
          inputSchema: {
            $schema: schemaVersion,
            type: 'object',
            required: ['message'],
            properties: { message: { type: 'string' } },
            additionalProperties: false,
          },
        }],
      }),
      callTool,
    });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect: async () => client,
    });

    await expect(registry.get('MCPTool')!.execute(execution({
      action: 'call', server: 'fixture', tool: 'probe', arguments: { message: 'hello' },
    }, root))).resolves.toMatchObject({ ok: true });
    expect(callTool).toHaveBeenCalledOnce();
    await manager.close();
  });
});
