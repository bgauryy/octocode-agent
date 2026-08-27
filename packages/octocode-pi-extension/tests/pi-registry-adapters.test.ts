import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CommandRegistry,
  ToolRegistry,
  type CommandDefinition as CoreCommandDefinition,
  type ToolDefinition as CoreToolDefinition,
} from '@octocodeai/agent-core';
import { PiCommandRegistryAdapter, PiToolRegistryAdapter } from '../src/adapters/pi-registry-adapters.js';
import type { CommandDefinition, PiInstance, ToolDefinition } from '../src/types.js';

function hostHarness() {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const pi = {
    registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
    registerCommand: (name: string, definition: CommandDefinition) => commands.set(name, definition),
    sendUserMessage: () => undefined,
    on: () => undefined,
  } as unknown as PiInstance;
  return { pi, tools, commands };
}

test('registers canonical tools through a policy-owning execution callback', async () => {
  const { pi, tools } = hostHarness();
  const registry = new ToolRegistry();
  const executions: string[] = [];
  const adapter = new PiToolRegistryAdapter(pi, registry, async (name, input) => {
    executions.push(`${name}:${input.context.cwd}:${input.callId}`);
    return { ok: true, content: 'done', detailsVersion: 1 };
  });
  const definition: CoreToolDefinition = {
    name: 'example', label: 'Example', description: 'Example tool', schemaVersion: 1,
    inputSchema: { type: 'object' }, outputSchema: { type: 'string' }, outputVersion: 1,
    policy: { effect: 'write', trust: 'workspace', approval: 'on-request', plan: 'allowed' },
    execute: async () => { throw new Error('adapter must dispatch through policy callback'); },
  };
  adapter.register(definition, 'plugin:example');

  const result = await tools.get('example')?.execute('call-1', {}, undefined, undefined, {
    cwd: '/workspace', mode: 'tui', sessionManager: { getSessionId: () => 'session-1' },
  });
  assert.deepEqual(executions, ['example:/workspace:call-1']);
  assert.deepEqual(result?.content, [{ type: 'text', text: 'done' }]);
  assert.equal(registry.get('example')?.owner, 'plugin:example');
});

test('registers canonical commands with narrowed command capabilities', async () => {
  const { pi, commands } = hostHarness();
  const registry = new CommandRegistry();
  let observedCapabilities: readonly string[] = [];
  const adapter = new PiCommandRegistryAdapter(pi, registry, async (_name, _args, context) => {
    observedCapabilities = [...context.capabilities];
    return { status: 'ok', message: 'done' };
  });
  const definition: CoreCommandDefinition = {
    name: 'example', description: 'Example command', permission: 'trusted-workspace', headless: 'unsupported',
    execute: async () => ({ status: 'ok' }),
  };
  adapter.register(definition, 'builtin');
  await commands.get('example')?.handler('one two', { cwd: '/workspace', mode: 'tui' });

  assert.deepEqual(observedCapabilities, ['session.read', 'session.mutate', 'model.select', 'settings.read', 'ui.interact']);
  assert.equal(registry.get('example')?.owner, 'builtin');
});
