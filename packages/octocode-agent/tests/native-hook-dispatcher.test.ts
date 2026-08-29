import { describe, expect, it, vi } from 'vitest';
import {
  LifecycleBus,
  eventId,
  revision,
  sessionId,
  type CodexHookConfiguration,
  type HookSourceDescriptor,
  type RuntimeEvent,
} from '@octocodeai/agent-core';
import { NativeExtensionsController, type NativeDiscoveredHook } from '../src/native-extensions.js';
import { installNativeHookDispatcher, type NativeHookDispatchReceipt } from '../src/native-hook-dispatcher.js';

function source(id: string, configuration: CodexHookConfiguration): NativeDiscoveredHook {
  const descriptor: HookSourceDescriptor = {
    id, scope: 'workspace', provenance: `test:${id}`, managed: false, rawHash: `${id}:raw`,
    normalizedHash: `${id}:normalized`, trust: 'trusted', revision: revision('1'), discoveryOrder: 0,
  };
  return { source: descriptor, configuration, reviewedHash: descriptor.normalizedHash };
}

async function controller(configuration: CodexHookConfiguration): Promise<NativeExtensionsController> {
  const value = new NativeExtensionsController({
    discoverHooks: async () => [source('hook', configuration)], discoverPlugins: async () => [], activatePlugin: async () => undefined,
  });
  await value.discover();
  return value;
}

function event(type: RuntimeEvent['type'], payload: unknown): RuntimeEvent {
  return {
    schemaVersion: 1, eventVersion: 1, id: eventId(`event:${type}`), type, phase: 'before',
    sessionId: sessionId('session:1'), timestamp: 1, cwd: '/workspace', mode: 'headless',
    model: { providerId: 'openai', modelId: 'gpt-5' }, trust: { workspace: 'trusted', managedOnly: false }, payload,
  };
}

describe('native hook dispatcher', () => {
  it('installs deterministic matched PreToolUse denial with Codex stdin and lifecycle authority', async () => {
    const extensions = await controller({ schemaVersion: 1, unsupported: [], hooks: {
      PreToolUse: [
        { matcher: '^read$', handlers: [{ type: 'command', command: 'miss', timeoutSeconds: 1, async: false }], declarationOrder: 0 },
        { matcher: '^edit$', handlers: [{ type: 'command', command: 'hit', timeoutSeconds: 1, async: false }], declarationOrder: 1 },
      ],
    } });
    const execute = vi.fn(async () => ({ decision: { kind: 'deny' as const, reason: 'blocked' }, output: {}, stderr: '' }));
    const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
    installNativeHookDispatcher({ extensions, lifecycle, executor: { execute }, workspaceTrusted: true });

    const result = await lifecycle.get('tool.requested')!.dispatch(event('tool.requested', { callId: 'call:1', name: 'edit', input: { path: 'a' } }));
    expect(result.decision).toEqual({ kind: 'deny', reason: 'blocked' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ session_id: 'session:1', hook_event_name: 'PreToolUse', tool_name: 'edit', tool_input: { path: 'a' } });
  });

  it('composes valid tool and prompt rewrites and rejects malformed rewrites before runtime effect', async () => {
    const hookConfig: CodexHookConfiguration = { schemaVersion: 1, unsupported: [], hooks: {
      PreToolUse: [{ matcher: '^edit$', handlers: [{ type: 'command', command: 'tool', timeoutSeconds: 1, async: false }], declarationOrder: 0 }],
      UserPromptSubmit: [{ handlers: [{ type: 'command', command: 'prompt', timeoutSeconds: 1, async: false }], declarationOrder: 0 }],
    } };
    const actual = await controller(hookConfig);
    let malformed = false;
    const execute = vi.fn(async (handler: { command: string }) => ({
      decision: { kind: 'continue' as const }, stderr: '',
      output: handler.command === 'tool'
        ? { hookSpecificOutput: { updatedInput: malformed ? 'bad' : { path: 'b' } } }
        : { hookSpecificOutput: { updatedPrompt: 'rewritten' } },
    }));
    const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
    installNativeHookDispatcher({ extensions: actual, lifecycle, executor: { execute }, workspaceTrusted: true });
    await expect(lifecycle.get('tool.requested')!.dispatch(event('tool.requested', { callId: 'call:1', name: 'edit', input: { path: 'a' } }))).resolves.toMatchObject({ payload: { callId: 'call:1', name: 'edit', input: { path: 'b' } } });
    await expect(lifecycle.get('input.received')!.dispatch(event('input.received', { text: 'original', source: 'user' }))).resolves.toMatchObject({ payload: { text: 'rewritten', source: 'user' } });
    malformed = true;
    await expect(lifecycle.get('tool.requested')!.dispatch(event('tool.requested', { callId: 'call:2', name: 'edit', input: {} }))).rejects.toThrow(/updatedInput/i);
  });

  it('executes synchronous MCP hooks and owns bounded async work without changing the triggering effect', async () => {
    const extensions = await controller({ schemaVersion: 1, unsupported: [], hooks: {
      PostToolUse: [{ handlers: [
        { type: 'mcp_tool', server: 's', tool: 't', timeoutSeconds: 1, async: false },
        { type: 'unsupported', originalType: 'prompt', reason: 'unsupported', definition: {} },
        { type: 'command', command: 'async', timeoutSeconds: 1, async: true },
        { type: 'command', command: 'context', timeoutSeconds: 1, async: false },
      ], declarationOrder: 0 }],
    } });
    const receipts: NativeHookDispatchReceipt[] = [];
    let releaseAsync!: () => void;
    const asyncDone = new Promise<void>((resolve) => { releaseAsync = resolve; });
    const execute = vi.fn(async (handler: { command: string }) => {
      if (handler.command === 'async') await asyncDone;
      return { decision: { kind: 'context' as const, text: 'extra' }, output: 'extra', stderr: '' };
    });
    const executeMcp = vi.fn(async () => ({ decision: { kind: 'context' as const, text: 'mcp-extra' }, output: {}, stderr: '' }));
    const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
    const installed = installNativeHookDispatcher({ extensions, lifecycle, executor: { execute }, mcpExecutor: { execute: executeMcp }, workspaceTrusted: true, onReceipt: (receipt) => receipts.push(receipt) });
    const result = await lifecycle.get('tool.ended')!.dispatch(event('tool.ended', { callId: 'call:1', name: 'edit', result: { ok: true } }));
    expect(result.context).toEqual(['mcp-extra', 'extra']);
    expect(executeMcp).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(receipts.map(({ outcome, reason }) => [outcome, reason])).toContainEqual(['skipped', 'unsupported-handler']);
    expect(receipts).not.toContainEqual(expect.objectContaining({ reason: 'async-handler-deferred' }));
    let drained = false;
    const draining = installed.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseAsync();
    await draining;
    expect(drained).toBe(true);
    installed();
  });

  it('times out MCP hooks and cancels owned asynchronous hooks on disposal', async () => {
    const extensions = await controller({ schemaVersion: 1, unsupported: [], hooks: {
      SessionStart: [{ handlers: [
        { type: 'mcp_tool', server: 's', tool: 'slow', timeoutSeconds: 0.001, async: false },
        { type: 'mcp_tool', server: 's', tool: 'background', timeoutSeconds: 10, async: true },
      ], declarationOrder: 0 }],
    } });
    const seen: AbortSignal[] = [];
    const mcpExecutor = { execute: vi.fn(async (_handler: unknown, _input: unknown, signal: AbortSignal) => {
      seen.push(signal);
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      throw new Error('unreachable');
    }) };
    const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
    const receipts: NativeHookDispatchReceipt[] = [];
    const installed = installNativeHookDispatcher({ extensions, lifecycle, executor: { execute: vi.fn() }, mcpExecutor, workspaceTrusted: true, onReceipt: (receipt) => receipts.push(receipt) });
    await lifecycle.get('session.starting')!.dispatch(event('session.starting', { reason: 'new' }));
    expect(receipts).toContainEqual(expect.objectContaining({ outcome: 'failed', reason: 'Hook handler timed out' }));
    installed.cancel();
    await installed.drain();
    expect(seen.every((signal) => signal.aborted)).toBe(true);
  });

  it('passes cancellation to command execution and rejects recursive dispatch', async () => {
    const extensions = await controller({ schemaVersion: 1, unsupported: [], hooks: {
      SessionStart: [{ handlers: [{ type: 'command', command: 'start', timeoutSeconds: 1, async: false }], declarationOrder: 0 }],
    } });
    const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
    const signal = new AbortController().signal;
    const execute = vi.fn(async () => {
      await lifecycle.get('session.starting')!.dispatch(event('session.starting', { reason: 'new' }));
      return { decision: { kind: 'continue' as const }, output: {}, stderr: '' };
    });
    installNativeHookDispatcher({ extensions, lifecycle, executor: { execute }, workspaceTrusted: true, signal });
    await expect(lifecycle.get('session.starting')!.dispatch(event('session.starting', { reason: 'new' }))).rejects.toThrow(/recursive/i);
    expect(execute.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });
});
