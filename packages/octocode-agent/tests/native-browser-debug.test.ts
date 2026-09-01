import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@octocodeai/agent-core';

import {
  createNativeBrowserDebugTool,
  registerNativeBrowserDebugTool,
  type NativeBrowserDebugPort,
} from '../src/native-browser-debug.js';
import { createDefaultOctocodeToolRegistry } from '../src/native-tools.js';

function request(input: unknown) {
  return { input, signal: new AbortController().signal } as never;
}

describe('native browser diagnostics', () => {
  it('exposes bounded target metadata without debugger websocket credentials', async () => {
    const port: NativeBrowserDebugPort = {
      listTargets: vi.fn(async () => [{
        id: 'page-1', type: 'page', title: 'Docs', url: 'https://example.com/docs',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1?token=secret',
      }]),
      command: vi.fn(),
      observe: vi.fn(),
    };
    const result = await createNativeBrowserDebugTool({ port }).execute(request({ action: 'targets' }));
    expect(result.content).toEqual({ action: 'targets', targets: [{ id: 'page-1', type: 'page', title: 'Docs', url: 'https://example.com/docs' }] });
    expect(JSON.stringify(result)).not.toContain('token=secret');
  });

  it('runs only fixed read-only CDP methods with bounded output', async () => {
    const command = vi.fn(async (_endpoint, _target, method) => method === 'Page.captureScreenshot'
      ? { data: 'a'.repeat(32) }
      : { documents: [{ nodes: { nodeName: [0] } }], strings: ['HTML'] });
    const port: NativeBrowserDebugPort = {
      listTargets: vi.fn(async () => []), command, observe: vi.fn(async () => []),
    };
    const tool = createNativeBrowserDebugTool({ port, maxResultBytes: 1024 });
    expect((await tool.execute(request({ action: 'snapshot', targetId: 'page-1' }))).content).toMatchObject({ action: 'snapshot' });
    expect((await tool.execute(request({ action: 'screenshot', targetId: 'page-1' }))).content).toMatchObject({ action: 'screenshot', mediaType: 'image/png' });
    expect(command.mock.calls.map((call) => call[2])).toEqual(['DOMSnapshot.captureSnapshot', 'Page.captureScreenshot']);
    await expect(tool.execute(request({ action: 'evaluate', targetId: 'page-1', expression: 'document.cookie' })))
      .rejects.toThrow(/schema|valid|oneOf/i);
  });

  it('observes console and network events for a short bounded window', async () => {
    const observe = vi.fn(async (_endpoint: string, _target: string, methods: readonly string[]) => methods.map((method) => ({ method, params: { ok: true } })));
    const port: NativeBrowserDebugPort = { listTargets: vi.fn(async () => []), command: vi.fn(), observe };
    const tool = createNativeBrowserDebugTool({ port });
    const consoleResult = await tool.execute(request({ action: 'console', targetId: 'page-1', observeMs: 25 }));
    const networkResult = await tool.execute(request({ action: 'network', targetId: 'page-1', observeMs: 25 }));
    expect(consoleResult.content).toMatchObject({ action: 'console' });
    expect(networkResult.content).toMatchObject({ action: 'network' });
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it('registers as an approval-gated workspace tool', () => {
    const registry = new ToolRegistry();
    const tool = registerNativeBrowserDebugTool(registry, {
      port: { listTargets: vi.fn(async () => []), command: vi.fn(), observe: vi.fn(async () => []) },
    });
    expect(registry.get('browserDebug')).toBe(tool);
    expect(tool.policy.approval).toBe('on-request');
    expect(tool.policy.trust).toBe('workspace');
  });

  it('is reachable through production native tool composition', async () => {
    const registry = await createDefaultOctocodeToolRegistry({
      run: async () => JSON.stringify({ kind: 'octocode.toolCatalog.full', version: 1, toolCount: 0, tools: [] }),
      allowedTools: new Set(['browserDebug']),
      browserDebug: { port: { listTargets: vi.fn(async () => []), command: vi.fn(), observe: vi.fn(async () => []) } },
    });
    expect(registry.list().map(({ name }) => name)).toEqual(['browserDebug']);
  });
});
