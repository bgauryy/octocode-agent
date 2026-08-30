import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@octocodeai/agent-core';
import { registerNativeMcpTool, type NativeMcpClient } from '../src/native-mcp.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function execution(input: unknown, cwd: string, signal = new AbortController().signal) {
  return {
    input,
    callId: 'call:mcp' as never,
    context: { sessionId: 'session:mcp' as never, cwd, mode: 'headless' as const, trust: { workspace: 'trusted' as const, managedOnly: false }, signal },
    signal,
    update: async () => undefined,
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-state-'));
  roots.push(root);
  const config = path.join(root, 'home', 'agent', 'mcp', 'servers.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath } } }));
  return root;
}

function client(overrides: Partial<NativeMcpClient> = {}): NativeMcpClient {
  return {
    listTools: async () => ({ tools: [] }), callTool: async () => ({}), listResources: async () => ({}),
    readResource: async () => ({}), listPrompts: async () => ({}), getPrompt: async () => ({}),
    complete: async () => ({}), close: async () => undefined, ...overrides,
  };
}

async function waitForMessage(child: ChildProcess, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (message !== expected) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`MCP task writer exited before ${expected} (code ${String(code)})`));
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

describe('native MCP negotiated state surfaces', () => {
  it('advertises and handles typed elicitation only when an authorized broker is configured', async () => {
    const root = fixture();
    const handlers = new Map<string, (request: { params: Record<string, unknown> }) => Promise<unknown>>();
    const elicit = vi.fn(async () => ({ action: 'accept' as const, content: { token: 'secret', choice: 'yes' } }));
    const fake = client({
      setRequestHandler: (method, handler) => { handlers.set(method, handler); },
      getServerCapabilities: () => ({ elicitation: {} }),
    });
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => fake, elicit });
    await registry.get('MCPTool')!.execute(execution({ action: 'capabilities', server: 'fixture' }, root));

    expect(handlers.has('elicitation/create')).toBe(true);
    expect(await handlers.get('elicitation/create')!({ params: { message: 'Choose', requestedSchema: { type: 'object' } } }))
      .toEqual({ action: 'accept', content: { token: '[REDACTED]', choice: 'yes' } });
  });

  it('persists bounded task provenance and supports negotiated get/result/cancel with cancellation', async () => {
    const root = fixture();
    const getTask = vi.fn(async ({ taskId }: { taskId: string }) => ({ taskId, status: 'working' }));
    const getTaskResult = vi.fn(async ({ taskId }: { taskId: string }) => ({ taskId, result: { text: 'done', apiKey: 'secret' } }));
    const cancelTask = vi.fn(async ({ taskId }: { taskId: string }) => ({ taskId, status: 'cancelled' }));
    const fake = client({ getServerCapabilities: () => ({ tasks: {} }), getTask, getTaskResult, cancelTask });
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, {
      cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => fake,
      taskStoreFile: path.join(root, 'state', 'tasks.json'), maxStoredTasks: 2,
    });
    const tool = registry.get('MCPTool')!;

    await expect(tool.execute(execution({ action: 'task-get', server: 'fixture', taskId: 't1' }, root)))
      .resolves.toMatchObject({ content: { task: { taskId: 't1', status: 'working' }, provenance: { server: 'fixture', operation: 'get' } } });
    await expect(tool.execute(execution({ action: 'task-result', server: 'fixture', taskId: 't1' }, root)))
      .resolves.not.toHaveProperty('content.task.result.apiKey', 'secret');
    await expect(tool.execute(execution({ action: 'task-cancel', server: 'fixture', taskId: 't1' }, root)))
      .resolves.toMatchObject({ content: { task: { status: 'cancelled' }, provenance: { operation: 'cancel' } } });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'state', 'tasks.json'), 'utf8')).tasks).toHaveLength(2);

    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute(execution({ action: 'task-get', server: 'fixture', taskId: 't2' }, root, controller.signal)))
      .rejects.toThrow(/cancel/i);
  });

  it('fails closed when task or elicitation capabilities were not negotiated', async () => {
    const root = fixture();
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => client() });
    await expect(registry.get('MCPTool')!.execute(execution({ action: 'task-get', server: 'fixture', taskId: 't1' }, root)))
      .rejects.toThrow(/capability/i);
  });

  it('rejects task storage that escapes through a symlinked ancestor', async () => {
    const root = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-outside-'));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(root, 'linked-state'));
    const fake = client({ getServerCapabilities: () => ({ tasks: {} }), getTask: async ({ taskId }) => ({ taskId }) });
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => fake, taskStoreFile: path.join(root, 'linked-state', 'tasks.json') });
    await expect(registry.get('MCPTool')!.execute(execution({ action: 'task-get', server: 'fixture', taskId: 'escape' }, root)))
      .rejects.toThrow(/storage.*within/i);
    expect(fs.existsSync(path.join(outside, 'tasks.json'))).toBe(false);
  });

  it('serializes concurrent task ledger updates without losing bounded entries', async () => {
    const root = fixture();
    const fake = client({ getServerCapabilities: () => ({ tasks: {} }), getTask: async ({ taskId }) => ({ taskId, status: 'working' }) });
    const registry = new ToolRegistry();
    const store = path.join(root, 'state', 'tasks.json');
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => fake, taskStoreFile: store, maxStoredTasks: 8 });
    const tool = registry.get('MCPTool')!;
    await Promise.all(Array.from({ length: 8 }, (_, index) => tool.execute(execution({ action: 'task-get', server: 'fixture', taskId: `t${index}` }, root))));
    const tasks = JSON.parse(fs.readFileSync(store, 'utf8')).tasks as Array<{ task: { taskId: string } }>;
    expect(tasks.map(({ task }) => task.taskId).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `t${index}`).sort());
    expect(fs.readdirSync(path.dirname(store)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(store).mode & 0o777).toBe(0o600);
  });

  it('serializes task ledger updates across independent processes', async () => {
    const root = fixture();
    const store = path.join(root, 'state', 'tasks.json');
    const source = pathToFileURL(path.resolve(import.meta.dirname, '../src/native-mcp.ts')).href;
    const worker = path.join(root, 'task-writer.mts');
    fs.writeFileSync(worker, `
      import { registerNativeMcpTool } from ${JSON.stringify(source)};
      let tool;
      const registry = { register(value) { tool = value; } };
      const client = {
        listTools: async () => ({ tools: [] }), callTool: async () => ({}), listResources: async () => ({}),
        readResource: async () => ({}), listPrompts: async () => ({}), getPrompt: async () => ({}), complete: async () => ({}),
        getServerCapabilities: () => ({ tasks: {} }),
        getTask: async ({ taskId }) => {
          process.send('at-task');
          await new Promise((resolve) => process.once('message', resolve));
          return { taskId, status: 'working' };
        },
        close: async () => undefined,
      };
      registerNativeMcpTool(registry, {
        cwd: process.env.TEST_ROOT, octocodeHome: process.env.TEST_ROOT + '/home', connect: async () => client,
        taskStoreFile: process.env.TEST_STORE, maxStoredTasks: 32,
      });
      process.send('ready');
      process.once('message', async () => {
        const signal = new AbortController().signal;
        await tool.execute({
          input: { action: 'task-get', server: 'fixture', taskId: process.env.TEST_TASK_ID }, callId: 'call:mcp',
          context: { sessionId: 'session:mcp', cwd: process.env.TEST_ROOT, mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, signal },
          signal, update: async () => undefined,
        });
        process.send('done');
      });
    `);
    const children = Array.from({ length: 12 }, (_, index) => spawn(process.execPath, ['--import', 'tsx', worker], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, TEST_ROOT: root, TEST_STORE: store, TEST_TASK_ID: `p${index}` },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }));
    try {
      await Promise.all(children.map((child) => waitForMessage(child, 'ready')));
      for (const child of children) child.send('call');
      await Promise.all(children.map((child) => waitForMessage(child, 'at-task')));
      for (const child of children) child.send('persist');
      await Promise.all(children.map((child) => waitForMessage(child, 'done')));
      const tasks = JSON.parse(fs.readFileSync(store, 'utf8')).tasks as Array<{ task: { taskId: string } }>;
      expect(tasks.map(({ task }) => task.taskId).sort()).toEqual(Array.from({ length: 12 }, (_, index) => `p${index}`).sort());
    } finally {
      for (const child of children) child.kill();
    }
  }, 20_000);

  it('rejects corrupt task state without overwriting the original bytes', async () => {
    const root = fixture();
    const store = path.join(root, 'state', 'tasks.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    const corrupt = '{"version":1,"tasks":[{"task":';
    fs.writeFileSync(store, corrupt);
    const fake = client({ getServerCapabilities: () => ({ tasks: {} }), getTask: async ({ taskId }) => ({ taskId }) });
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => fake, taskStoreFile: store });

    await expect(registry.get('MCPTool')!.execute(execution({ action: 'task-get', server: 'fixture', taskId: 'new' }, root)))
      .rejects.toMatchObject({ name: 'McpTaskStoreCorruptionError' });
    expect(fs.readFileSync(store, 'utf8')).toBe(corrupt);
  });

  it('rejects unsupported task-state versions without overwriting them', async () => {
    const root = fixture();
    const store = path.join(root, 'state', 'tasks.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    const unsupported = '{"version":2,"tasks":[]}\n';
    fs.writeFileSync(store, unsupported);
    const fake = client({ getServerCapabilities: () => ({ tasks: {} }), getTask: async ({ taskId }) => ({ taskId }) });
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => fake, taskStoreFile: store });

    await expect(registry.get('MCPTool')!.execute(execution({ action: 'task-get', server: 'fixture', taskId: 'new' }, root)))
      .rejects.toMatchObject({ name: 'McpTaskStoreCorruptionError' });
    expect(fs.readFileSync(store, 'utf8')).toBe(unsupported);
  });

  it('fails with a bounded conflict when another writer owns the task-state lock', async () => {
    const root = fixture();
    const store = path.join(root, 'state', 'tasks.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(`${store}.lock`, 'active', { mode: 0o600 });
    const fake = client({ getServerCapabilities: () => ({ tasks: {} }), getTask: async ({ taskId }) => ({ taskId }) });
    const registry = new ToolRegistry();
    registerNativeMcpTool(registry, { cwd: root, octocodeHome: path.join(root, 'home'), connect: async () => fake, taskStoreFile: store });
    const startedAt = Date.now();

    await expect(registry.get('MCPTool')!.execute(execution({ action: 'task-get', server: 'fixture', taskId: 'new' }, root)))
      .rejects.toMatchObject({ name: 'McpTaskStoreConflictError' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(fs.existsSync(store)).toBe(false);
  });
});
