import assert from 'node:assert/strict';
import { test } from 'vitest';
import { bindRuntimeRenderer, publishMcpRuntimeState, setManagedStatus } from '../src/tools/runtime-renderer.js';
import { createRuntimeStore } from '../src/tools/runtime-store.js';
import type { PiContext } from '../src/types.js';

test('one runtime renderer owns loading, MCP, managed statuses, notifications, and cleanup', () => {
  const statusCalls: Array<[string, string | undefined]> = [];
  const working: Array<boolean | undefined> = [];
  const messages: Array<string | undefined> = [];
  const notifications: string[] = [];
  const ctx: PiContext = {
    hasUI: true,
    ui: {
      setStatus: (name, text) => statusCalls.push([name, text]),
      setWorkingVisible: (visible) => working.push(visible),
      setWorkingMessage: (message) => messages.push(message),
      notify: (message) => notifications.push(message),
    },
  };
  const store = createRuntimeStore();
  const dispose = bindRuntimeRenderer(ctx, store);

  store.getState().begin('loading configuration');
  setManagedStatus(ctx, 'octocode-watch', 'watch: on');
  publishMcpRuntimeState(ctx, { status: 'running', message: 'discovering', servers: 2, tools: 0 });
  store.getState().ready('Octocode ready · 2 MCP servers');

  assert.ok(statusCalls.some(([name, text]) => name === 'octocode-init' && text === 'Octocode · loading configuration'));
  assert.ok(statusCalls.some(([name, text]) => name === 'octocode-watch' && text === 'watch: on'));
  assert.ok(statusCalls.some(([name, text]) => name === 'octocode-mcp-init' && text?.includes('2 servers')));
  assert.deepEqual(working, [false, true, false], 'unrelated status/MCP updates do not repaint working visibility');
  assert.equal(messages.at(-1), undefined);
  assert.deepEqual(notifications, ['Octocode ready · 2 MCP servers']);

  dispose();
  assert.ok(statusCalls.some(([name, text]) => name === 'octocode-watch' && text === undefined));
});

test('managed status creates a renderer-owned provisional runtime before session_start', () => {
  const calls: Array<[string, string | undefined]> = [];
  const ctx: PiContext = { hasUI: true, ui: { setStatus: (name, text) => calls.push([name, text]) } };
  setManagedStatus(ctx, 'standalone', 'ready');
  assert.deepEqual(calls, [['standalone', 'ready']]);
});
