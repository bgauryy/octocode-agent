import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeKernel, ToolRegistry, jsonSchemaError, sessionId, type ModelPort } from '@octocodeai/agent-core';
import { NativeMcpSessionManager, registerNativeMcpTool, type NativeMcpClient } from '../src/native-mcp.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(server: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-session-'));
  roots.push(root);
  const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, ...server } } }));
  return root;
}

const execution = (input: unknown, cwd: string, signal = new AbortController().signal) => ({
  input,
  callId: 'call:1' as never,
  context: { sessionId: 's' as never, cwd, mode: 'headless' as const, trust: { workspace: 'trusted' as const, managedOnly: false }, signal },
  signal,
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
    request: async () => ({}),
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

  it('evicts an established closed connection without replaying operations', async () => {
    const first = fakeClient();
    const second = fakeClient();
    const connect = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const manager = new NativeMcpSessionManager(connect);
    const config = { transport: 'stdio' as const, command: process.execPath };
    const signal = new AbortController().signal;

    await expect(manager.acquire('fixture', config, signal)).resolves.toBe(first);
    first.onclose?.();
    await expect(manager.acquire('fixture', config, signal)).resolves.toBe(second);

    expect(connect).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it('evicts a connection after a catalog transport failure without replaying the failed request', async () => {
    const root = fixtureRoot();
    const firstListTools = vi.fn()
      .mockResolvedValueOnce({ tools: [{ name: 'probe', inputSchema: { type: 'object' } }], ttlMs: 60_000 })
      .mockRejectedValue(new Error('stdio connection closed'));
    const secondListTools = vi.fn(async () => ({
      tools: [{ name: 'probe', inputSchema: { type: 'object' } }],
      ttlMs: 60_000,
    }));
    const firstClose = vi.fn(async () => undefined);
    const first = fakeClient({ listTools: firstListTools, close: firstClose });
    const second = fakeClient({ listTools: secondListTools });
    const connect = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect,
    });
    const tool = registry.get('MCPTool')!;

    await expect(tool.execute(execution({ action: 'discover', server: 'fixture' }, root))).resolves.toMatchObject({
      content: { phase: 'discovered' },
    });
    await expect(tool.execute(execution({ action: 'refresh', server: 'fixture' }, root)))
      .rejects.toThrow('stdio connection closed');
    await expect(tool.execute(execution({ action: 'refresh', server: 'fixture' }, root))).resolves.toMatchObject({
      ok: true,
    });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(firstListTools).toHaveBeenCalledTimes(2);
    expect(secondListTools).toHaveBeenCalledTimes(1);
    await manager.close();
    expect(firstClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a healthy shared connection owned when catalog refresh is cancelled', async () => {
    const root = fixtureRoot();
    let reportRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      reportRefreshStarted = resolve;
    });
    const neverCompletes = new Promise<never>(() => undefined);
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [{ name: 'probe', inputSchema: { type: 'object' } }], ttlMs: 60_000 })
      .mockImplementationOnce(() => {
        reportRefreshStarted();
        return neverCompletes;
      })
      .mockResolvedValue({ tools: [{ name: 'probe', inputSchema: { type: 'object' } }], ttlMs: 60_000 });
    const close = vi.fn(async () => undefined);
    const client = fakeClient({ listTools, close });
    const connect = vi.fn(async () => client);
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect,
    });
    const tool = registry.get('MCPTool')!;

    await tool.execute(execution({ action: 'discover', server: 'fixture' }, root));
    const cancellation = new AbortController();
    const refresh = tool.execute(execution({ action: 'refresh', server: 'fixture' }, root, cancellation.signal));
    await refreshStarted;
    cancellation.abort('cancel refresh');
    await expect(refresh).rejects.toMatchObject({ category: 'cancelled' });

    await expect(tool.execute(execution({ action: 'refresh', server: 'fixture' }, root))).resolves.toMatchObject({
      ok: true,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    await manager.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('overlaps same-server MCP calls only when the server declares a bounded concurrency above one', async () => {
    const root = fixtureRoot({ maxConcurrentCalls: 2 });
    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    let reportSecondStarted!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { reportSecondStarted = resolve; });
    let calls = 0;
    const client = fakeClient({
      callTool: async () => {
        calls += 1;
        if (calls === 1) {
          reportFirstStarted();
          await firstReleased;
        } else reportSecondStarted();
        return { content: [{ type: 'text', text: `call-${calls}` }] };
      },
    });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect: async () => client,
    });
    let iteration = 0;
    const model: ModelPort = {
      run: async (_request, context) => {
        iteration += 1;
        if (iteration === 1) {
          const input = { action: 'call', server: 'fixture', tool: 'probe' };
          await context.emit?.({ type: 'tool-call', id: 'mcp-a', name: 'MCPTool', input });
          await context.emit?.({ type: 'tool-call', id: 'mcp-b', name: 'MCPTool', input });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const submission = new RuntimeKernel({
      sessionId: sessionId('mcp-parallel'),
      model,
      tools: registry,
      trust: { workspace: 'trusted', managedOnly: false },
      approve: async () => true,
    }).submit('go');

    await firstStarted;
    const overlapped = await Promise.race([
      secondStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseFirst();
    await submission;
    expect(overlapped).toBe(true);
    expect(calls).toBe(2);
    await manager.close();
  });

  it('keeps same-server MCP calls serial by default', async () => {
    const root = fixtureRoot();
    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    let reportSecondStarted!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { reportSecondStarted = resolve; });
    let calls = 0;
    const client = fakeClient({
      callTool: async () => {
        calls += 1;
        if (calls === 1) {
          reportFirstStarted();
          await firstReleased;
        } else reportSecondStarted();
        return { content: [] };
      },
    });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => client });
    let iteration = 0;
    const model: ModelPort = { run: async (_request, context) => {
      iteration += 1;
      if (iteration === 1) {
        const input = { action: 'call', server: 'fixture', tool: 'probe' };
        await context.emit?.({ type: 'tool-call', id: 'serial-mcp-a', name: 'MCPTool', input });
        await context.emit?.({ type: 'tool-call', id: 'serial-mcp-b', name: 'MCPTool', input });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const submission = new RuntimeKernel({
      sessionId: sessionId('mcp-serial'), model, tools: registry,
      trust: { workspace: 'trusted', managedOnly: false }, approve: async () => true,
    }).submit('go');
    await firstStarted;
    const overlapped = await Promise.race([
      secondStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseFirst();
    await submission;
    expect(overlapped).toBe(false);
    expect(calls).toBe(2);
    await manager.close();
  });

  it('overlaps calls to different MCP servers while retaining one connection per server', async () => {
    const root = fixtureRoot();
    const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
    fs.writeFileSync(config, JSON.stringify({ mcpServers: {
      alpha: { command: process.execPath },
      beta: { command: process.execPath },
    } }));
    let releaseAlpha!: () => void;
    let reportAlphaStarted!: () => void;
    let reportBetaStarted!: () => void;
    const alphaReleased = new Promise<void>((resolve) => { releaseAlpha = resolve; });
    const alphaStarted = new Promise<void>((resolve) => { reportAlphaStarted = resolve; });
    const betaStarted = new Promise<void>((resolve) => { reportBetaStarted = resolve; });
    const connect = vi.fn(async (name: string) => fakeClient({
      callTool: async () => {
        if (name === 'alpha') {
          reportAlphaStarted();
          await alphaReleased;
        } else reportBetaStarted();
        return { content: [] };
      },
    }));
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect });
    let iteration = 0;
    const model: ModelPort = { run: async (_request, context) => {
      iteration += 1;
      if (iteration === 1) {
        await context.emit?.({ type: 'tool-call', id: 'server-alpha', name: 'MCPTool', input: { action: 'call', server: 'alpha', tool: 'probe' } });
        await context.emit?.({ type: 'tool-call', id: 'server-beta', name: 'MCPTool', input: { action: 'call', server: 'beta', tool: 'probe' } });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const submission = new RuntimeKernel({
      sessionId: sessionId('mcp-cross-server'), model, tools: registry,
      trust: { workspace: 'trusted', managedOnly: false }, approve: async () => true,
    }).submit('go');
    await alphaStarted;
    const overlapped = await Promise.race([
      betaStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseAlpha();
    await submission;
    expect(overlapped).toBe(true);
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
    const onCatalogInvalidated = vi.fn(async () => undefined);
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect,
      onCatalogInvalidated,
    });
    const tool = registry.get('MCPTool')!;

    await tool.execute(execution({ action: 'describe', server: 'fixture', tool: 'probe' }, root));
    await tool.execute(execution({ action: 'describe', server: 'fixture', tool: 'probe' }, root));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(listTools).toHaveBeenCalledTimes(1);

    await toolsChanged?.();
    expect(onCatalogInvalidated).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: 'mcp.catalog-invalidated',
      severity: 'info',
      server: 'fixture',
      message: 'MCP tool catalog changed · fixture · refresh required',
    });
    const status = await tool.execute(execution({ action: 'status' }, root));
    expect((status.content as { servers: Array<{ name: string; catalogState: string }> }).servers)
      .toContainEqual(expect.objectContaining({ name: 'fixture', catalogState: 'stale' }));
    await expect(tool.execute(execution({ action: 'discover', server: 'fixture' }, root))).resolves.toMatchObject({
      content: { server: 'fixture', phase: 'updated', source: 'server' },
    });
    expect(listTools).toHaveBeenCalledTimes(2);

    await manager.close();
    await manager.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exposes bounded live connection and catalog snapshots including empty and stale states', async () => {
    let release: ((client: NativeMcpClient) => void) | undefined;
    const manager = new NativeMcpSessionManager(
      () => new Promise<NativeMcpClient>((resolve) => { release = resolve; }),
      { now: () => 100 },
    );
    const config = { transport: 'stdio' as const, command: process.execPath };
    const acquiring = manager.acquire('fixture', config, new AbortController().signal);

    expect(manager.liveSnapshot('fixture', 100)).toEqual({
      connectionState: 'connecting',
      catalogState: 'not-loaded',
      knownCatalogNames: [],
      knownCatalogCount: 0,
      knownCatalogNamesTruncated: false,
    });

    release!(fakeClient());
    await acquiring;
    manager.setCatalog('fixture', { expiresAt: 200, tools: [] });
    expect(manager.liveSnapshot('fixture', 100)).toMatchObject({
      connectionState: 'connected',
      catalogState: 'empty',
      lastRefreshAt: 100,
      knownCatalogNames: [],
    });

    manager.setCatalog('fixture', {
      expiresAt: 200,
      tools: Array.from({ length: 150 }, (_, index) => ({ name: `tool-${String(index).padStart(3, '0')}` })),
    });
    expect(manager.liveSnapshot('fixture', 100)).toMatchObject({
      catalogState: 'ready',
      lastRefreshAt: 100,
      knownCatalogCount: 150,
      knownCatalogNamesTruncated: true,
      knownCatalogNames: expect.any(Array),
    });
    expect(manager.liveSnapshot('fixture', 100).knownCatalogNames).toHaveLength(100);
    expect(manager.liveSnapshot('fixture', 201).catalogState).toBe('stale');
    await manager.close();
  });

  it('does not automatically replay a failed mutating MCP call', async () => {
    const root = fixtureRoot();
    const callTool = vi.fn(async () => { throw new Error('remote failure after dispatch'); });
    const connect = vi.fn(async () => fakeClient({ callTool }));
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect,
    });

    await expect(registry.get('MCPTool')!.execute(execution({
      action: 'call', server: 'fixture', tool: 'probe', arguments: {},
    }, root))).rejects.toThrow();
    expect(connect).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledOnce();
    await manager.close();
  });

  it('exposes explicit cache-aware discovery and forced refresh phases', async () => {
    const root = fixtureRoot();
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [{ name: 'alpha', inputSchema: { type: 'object' } }], ttlMs: 60_000 })
      .mockResolvedValueOnce({ tools: [{ name: 'beta', inputSchema: { type: 'object' } }], ttlMs: 60_000 });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect: async () => fakeClient({ listTools }),
    });
    const tool = registry.get('MCPTool')!;
    const updates: unknown[] = [];
    const execute = (input: unknown) => tool.execute({
      ...execution(input, root),
      update: async (value) => { updates.push(value); },
    });

    await expect(execute({ action: 'discover', server: 'fixture' })).resolves.toMatchObject({
      ok: true,
      content: { server: 'fixture', source: 'server', toolCount: 1, tools: [{ name: 'alpha' }] },
    });
    await expect(execute({ action: 'discover', server: 'fixture' })).resolves.toMatchObject({
      content: { server: 'fixture', source: 'cache', toolCount: 1, tools: [{ name: 'alpha' }] },
    });
    await expect(execute({ action: 'refresh', server: 'fixture' })).resolves.toMatchObject({
      content: { server: 'fixture', source: 'server', toolCount: 1, tools: [{ name: 'beta' }] },
    });

    expect(listTools).toHaveBeenCalledTimes(2);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'progress', message: expect.stringContaining('Discovering') }),
      expect.objectContaining({ kind: 'progress', message: expect.stringContaining('Refreshing') }),
      expect.objectContaining({ kind: 'progress', message: expect.stringContaining('ready') }),
    ]));
    await manager.close();
  });

  it('ignores unsupported cache-scope hints instead of pretending they isolate catalog entries', async () => {
    const root = fixtureRoot();
    const listTools = vi.fn(async (params?: { cursor?: string }) => params?.cursor === 'next'
      ? { tools: [{ name: 'beta', inputSchema: { type: 'object' } }], cacheScope: 'public' as const }
      : { tools: [{ name: 'alpha', inputSchema: { type: 'object' } }], nextCursor: 'next', ttlMs: 60_000, cacheScope: 'private' as const });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect: async () => fakeClient({ listTools }),
    });

    await expect(registry.get('MCPTool')!.execute(execution({ action: 'describe', server: 'fixture', tool: 'beta' }, root)))
      .resolves.toMatchObject({ content: { name: 'beta' } });
    expect(listTools).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it('rejects an MCP catalog item that exceeds the per-item byte limit', async () => {
    const root = fixtureRoot();
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect: async () => fakeClient({
        listTools: async () => ({ tools: [{ name: 'oversized', description: 'x'.repeat(300_000), inputSchema: { type: 'object' } }] }),
      }),
    });

    await expect(registry.get('MCPTool')!.execute(execution({ action: 'describe', server: 'fixture', tool: 'oversized' }, root)))
      .rejects.toThrow(/item.*(?:byte|size|large)|(?:byte|size|large).*item/i);
    await manager.close();
  });

  it('rejects MCP catalogs that exceed item-count and aggregate-byte limits', async () => {
    const root = fixtureRoot();
    for (const tools of [
      Array.from({ length: 1_001 }, (_, index) => ({ name: `tool-${index}`, inputSchema: { type: 'object' } })),
      Array.from({ length: 5 }, (_, index) => ({ name: `large-${index}`, description: 'x'.repeat(240_000), inputSchema: { type: 'object' } })),
    ]) {
      const registry = new ToolRegistry();
      const manager = registerNativeMcpTool(registry, {
        cwd: root,
        octocodeHome: path.join(root, 'home'),
        connect: async () => fakeClient({ listTools: async () => ({ tools }) }),
      });
      await expect(registry.get('MCPTool')!.execute(execution({ action: 'describe', server: 'fixture', tool: tools[0]!.name }, root)))
        .rejects.toThrow(/catalog.*(?:count|byte|size|large|limit)|(?:count|byte|size|large|limit).*catalog/i);
      await manager.close();
    }
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

  it('bounds progress update count, fields, and message bytes', async () => {
    const root = fixtureRoot();
    const updates: Array<{ message?: string; value: Record<string, unknown> }> = [];
    const client = fakeClient({
      callTool: async (_params, options) => {
        for (let index = 0; index < 300; index += 1) {
          options?.onprogress?.({
            progress: index,
            total: 300,
            message: '🚀'.repeat(5_000),
            ignored: 'x'.repeat(100_000),
          } as never);
        }
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

    await registry.get('MCPTool')!.execute({
      ...request,
      update: async (value) => { updates.push(value as never); },
    });

    expect(updates.length).toBeLessThanOrEqual(256);
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(Buffer.byteLength(update.message ?? '', 'utf8')).toBeLessThanOrEqual(4_096);
      expect(update.value).not.toHaveProperty('ignored');
      expect(Buffer.byteLength(JSON.stringify(update), 'utf8')).toBeLessThanOrEqual(16_384);
    }
    await manager.close();
  });

  it('rejects oversized MCP transport results before exposing them to the model', async () => {
    const root = fixtureRoot();
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect: async () => fakeClient({
        callTool: async () => ({ content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] }),
      }),
    });

    await expect(registry.get('MCPTool')!.execute(execution({ action: 'call', server: 'fixture', tool: 'probe' }, root)))
      .rejects.toThrow(/transport.*(?:byte|size|large|limit)|(?:byte|size|large|limit).*transport/i);
    await manager.close();
  });

  it('settles cancellation even when an MCP client ignores the abort signal', async () => {
    const root = fixtureRoot();
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect: async () => fakeClient({ callTool: async () => new Promise(() => undefined) }),
    });
    const controller = new AbortController();
    const pending = registry.get('MCPTool')!.execute({
      ...execution({ action: 'call', server: 'fixture', tool: 'probe' }, root),
      signal: controller.signal,
    });
    controller.abort();

    const outcome = await Promise.race([
      pending.then(() => 'resolved', (error: unknown) => error instanceof Error && /cancel/i.test(error.message) ? 'cancelled' : 'failed'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    expect(outcome).toBe('cancelled');
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

  it('publishes action-exclusive schemas and resolves read versus mutating policy fail-closed', () => {
    const root = fixtureRoot();
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => fakeClient() });
    const tool = registry.get('MCPTool')!;

    expect(tool.inputSchema).toMatchObject({ oneOf: expect.any(Array) });
    expect(jsonSchemaError({ action: 'status' }, tool.inputSchema)).toBeUndefined();
    expect(jsonSchemaError({ action: 'status', server: 'fixture' }, tool.inputSchema)).toBeDefined();
    expect(jsonSchemaError({ action: 'call', server: 'fixture', tool: 'probe' }, tool.inputSchema)).toBeUndefined();
    expect(jsonSchemaError({ action: 'call', server: 'fixture', tool: 'probe', uri: 'extra' }, tool.inputSchema)).toBeDefined();
    expect(jsonSchemaError({ action: 'parallel-call', calls: [] }, tool.inputSchema)).toBeDefined();
    expect(jsonSchemaError({ action: 'parallel-call', calls: Array.from({ length: 9 }, () => ({ server: 'fixture', tool: 'probe' })) }, tool.inputSchema)).toBeDefined();

    expect(tool.policy.resolve?.({ action: 'status' })).toEqual({ effects: ['read'], trust: 'none', approval: 'never' });
    for (const action of ['capabilities', 'describe', 'resources', 'read-resource', 'prompts', 'get-prompt', 'complete', 'task-get', 'task-list', 'task-result']) {
      expect(tool.policy.resolve?.({ action, server: 'fixture' })).toMatchObject({ approval: 'never', trust: 'workspace' });
      expect(tool.policy.resolve?.({ action, server: 'fixture' }).effects).not.toContain('write');
    }
    for (const action of ['call', 'parallel-call', 'task-cancel', 'unknown']) {
      expect(tool.policy.resolve?.({ action, server: 'fixture' })).toMatchObject({ approval: expect.stringMatching(/on-request|always/), trust: 'workspace' });
      expect(tool.policy.resolve?.({ action, server: 'fixture' }).effects).toContain('write');
    }
  });

  it('uses official MCP task requests and preserves opaque list cursors', async () => {
    const root = fixtureRoot();
    const request = vi.fn(async (envelope: { method: string; params?: Record<string, unknown> }) => {
      if (envelope.method === 'tasks/list') {
        return {
          tasks: [{ taskId: 'task-1', status: 'working' }],
          nextCursor: 'opaque:next',
        };
      }
      return { taskId: 'task-1', status: envelope.method === 'tasks/cancel' ? 'cancelled' : 'working' };
    });
    const client = fakeClient({
      request,
      getServerCapabilities: () => ({
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      }),
    });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, {
      cwd: root,
      octocodeHome: path.join(root, 'home'),
      connect: async () => client,
    });
    const tool = registry.get('MCPTool')!;

    await tool.execute(execution({ action: 'task-get', server: 'fixture', taskId: 'task-1' }, root));
    const listed = await tool.execute(execution({
      action: 'task-list', server: 'fixture', cursor: 'opaque:current',
    }, root));
    await tool.execute(execution({ action: 'task-result', server: 'fixture', taskId: 'task-1' }, root));
    await tool.execute(execution({ action: 'task-cancel', server: 'fixture', taskId: 'task-1' }, root));

    expect(request.mock.calls.map(([envelope]) => envelope)).toEqual([
      { method: 'tasks/get', params: { taskId: 'task-1' } },
      { method: 'tasks/list', params: { cursor: 'opaque:current' } },
      { method: 'tasks/result', params: { taskId: 'task-1' } },
      { method: 'tasks/cancel', params: { taskId: 'task-1' } },
    ]);
    expect(listed).toMatchObject({
      ok: true,
      content: { task: { nextCursor: 'opaque:next' } },
    });
    await manager.close();
  });

  it('runs ordered parallel calls with global and per-server caps, redaction, and cancellation', async () => {
    const root = fixtureRoot({ maxConcurrentCalls: 2 });
    let active = 0;
    let maximum = 0;
    const callTool = vi.fn(async ({ arguments: args }: { name: string; arguments?: Record<string, unknown> }, options) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10);
        options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('secret-token-cancelled')); }, { once: true });
      });
      active -= 1;
      return { content: [{ type: 'text', text: String(args?.message) }], apiKey: 'must-redact' };
    });
    const client = fakeClient({
      listTools: async () => ({ tools: [{
        name: 'probe',
        inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } }, additionalProperties: false },
      }] }),
      callTool: callTool as NativeMcpClient['callTool'],
    });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => client });
    const tool = registry.get('MCPTool')!;
    const result = await tool.execute(execution({
      action: 'parallel-call',
      calls: [
        { server: 'fixture', tool: 'probe', arguments: { message: 'zero' } },
        ...Array.from({ length: 7 }, (_, index) => ({ server: 'fixture', tool: 'probe', arguments: { message: String(index + 1) } })),
      ],
    }, root));

    expect(maximum).toBe(2);
    expect(callTool).toHaveBeenCalledTimes(8);
    const results = (result.content as { results: unknown[] }).results;
    expect(results).toHaveLength(8);
    expect(results[0]).toMatchObject({ ok: true, server: 'fixture', tool: 'probe', content: { apiKey: '[REDACTED]' } });
    expect(results.map((entry) => (entry as { content: { content: Array<{ text: string }> } }).content.content[0]?.text))
      .toEqual(['zero', '1', '2', '3', '4', '5', '6', '7']);

    const controller = new AbortController();
    const pending = tool.execute({ ...execution({ action: 'parallel-call', calls: [{ server: 'fixture', tool: 'probe', arguments: { message: 'cancel' } }] }, root), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel/i);
    await manager.close();
  });

  it('preflights every parallel call before invoking any MCP tool', async () => {
    const root = fixtureRoot({ maxConcurrentCalls: 2 });
    const callTool = vi.fn(async () => ({ content: [] }));
    const client = fakeClient({
      listTools: async () => ({ tools: [{
        name: 'probe',
        inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } }, additionalProperties: false },
      }] }),
      callTool,
    });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => client });

    await expect(registry.get('MCPTool')!.execute(execution({
      action: 'parallel-call',
      calls: [
        { server: 'fixture', tool: 'probe', arguments: { message: 'valid' } },
        { server: 'fixture', tool: 'probe', arguments: {} },
      ],
    }, root))).rejects.toThrow(/invalid mcp arguments/i);
    expect(callTool).not.toHaveBeenCalled();
    await manager.close();
  });

  it('caps parallel MCP work at four even when the server allows more', async () => {
    const root = fixtureRoot({ maxConcurrentCalls: 4 });
    let active = 0;
    let maximum = 0;
    const client = fakeClient({
      callTool: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { content: [] };
      },
    });
    const registry = new ToolRegistry();
    const manager = registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => client });
    await registry.get('MCPTool')!.execute(execution({
      action: 'parallel-call',
      calls: Array.from({ length: 8 }, () => ({ server: 'fixture', tool: 'probe' })),
    }, root));
    expect(maximum).toBe(4);
    await manager.close();
  });
});
