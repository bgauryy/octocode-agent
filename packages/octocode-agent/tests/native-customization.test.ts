import { describe, expect, it, vi } from 'vitest';
import {
  LifecycleBus,
  ToolRegistry,
  eventId,
  sessionId,
  type RuntimeEvent,
  type ToolDefinition,
} from '@octocodeai/agent-core';
import {
  disposeNativeCustomization,
  installNativeCustomizationLifecycle,
  registerNativeCustomizationTools,
} from '../src/native-customization.js';
import type {
  AgentLifecycleEventV1,
  AgentToolV1,
  OctocodeAgentCustomizationV1,
} from '../src/api/v1.js';

function tool(name: string): AgentToolV1 {
  return {
    id: `tool.${name}`,
    name,
    label: name,
    description: `${name} description`,
    schemaVersion: 1,
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object' },
    outputVersion: 1,
    policy: { effects: ['read'], trust: 'none', approval: 'never', plan: 'allowed' },
    execute: async () => ({ ok: true, content: {}, detailsVersion: 1 }),
  };
}

function coreTool(name: string): ToolDefinition {
  return tool(name) as unknown as ToolDefinition;
}

function event(type: RuntimeEvent['type'], payload: RuntimeEvent['payload']): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventVersion: 1,
    id: eventId(`event:${type}`),
    type,
    phase: 'before',
    sessionId: sessionId('session:1'),
    timestamp: 1,
    cwd: '/workspace',
    mode: 'headless',
    model: { providerId: 'openai', modelId: 'gpt-5' },
    trust: { workspace: 'trusted', managedOnly: false },
    payload,
  } as unknown as RuntimeEvent;
}

describe('native API customization composition', () => {
  it('preflights additive tools and rolls back the whole owner on a collision', () => {
    const registry = new ToolRegistry();
    registry.register(coreTool('builtin'), 'native');
    const customization: OctocodeAgentCustomizationV1 = {
      schemaVersion: 1,
      id: 'com.acme.tools',
      tools: [tool('custom'), tool('builtin')],
    };

    expect(() => registerNativeCustomizationTools(registry, customization)).toThrow(/collides.*builtin/i);
    expect(registry.list().map(({ name }) => name)).toEqual(['builtin']);
  });

  it('registers additive tools under one disposable owner', () => {
    const registry = new ToolRegistry();
    registry.register(coreTool('builtin'), 'native');
    const dispose = registerNativeCustomizationTools(registry, {
      schemaVersion: 1,
      id: 'com.acme.tools',
      tools: [tool('custom')],
    });

    expect(registry.list().map(({ name }) => name).sort()).toEqual(['builtin', 'custom']);
    dispose();
    expect(registry.list().map(({ name }) => name)).toEqual(['builtin']);
  });

  it('keeps hook authority fixed and gives observers immutable redacted payloads', async () => {
    const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
    const observed = vi.fn();
    const handled = vi.fn(async (_event: AgentLifecycleEventV1) => ({
      kind: 'deny' as const,
      reason: 'host policy',
    }));
    const dispose = installNativeCustomizationLifecycle(lifecycle, {
      schemaVersion: 1,
      id: 'com.acme.lifecycle',
      hooks: [{
        id: 'deny-write',
        event: 'tool.requested',
        handle: handled,
      }],
      events: [{
        id: 'audit-tools',
        event: 'tool.requested',
        observe: (value) => observed(value),
      }],
    });
    const result = await lifecycle.get('tool.requested')!.dispatch(event('tool.requested', {
      callId: 'call:1',
      name: 'edit',
      input: { path: '/secret', content: 'private' },
    }) as never);

    expect(result.decision).toEqual({ kind: 'deny', reason: 'host policy' });
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      eventType: 'tool.requested',
      dataClassification: 'redacted',
      payload: { callId: 'call:1', name: 'edit' },
    }));
    expect(Object.isFrozen(observed.mock.calls[0]![0].payload)).toBe(true);
    const sensitive = handled.mock.calls[0]![0];
    expect(sensitive.dataClassification).toBe('sensitive');
    expect(Object.isFrozen(sensitive)).toBe(true);
    expect(Object.isFrozen(sensitive.model)).toBe(true);
    expect(Object.isFrozen(sensitive.trust)).toBe(true);
    expect(Object.isFrozen(sensitive.payload)).toBe(true);
    expect(Object.isFrozen((sensitive.payload as { input: unknown }).input)).toBe(true);
    dispose();
  });

  it('disposes a customization exactly once', async () => {
    const dispose = vi.fn();
    const customization = Object.freeze({
      schemaVersion: 1 as const,
      id: 'com.acme.dispose',
      dispose,
    });
    await disposeNativeCustomization(customization);
    await disposeNativeCustomization(customization);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('isolates observer failures from lifecycle decisions', async () => {
    const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
    installNativeCustomizationLifecycle(lifecycle, {
      schemaVersion: 1,
      id: 'com.acme.observer-failure',
      events: [{
        id: 'broken-audit',
        event: 'session.stopping',
        observe: () => {
          throw new Error('audit sink unavailable');
        },
      }],
    });

    const result = await lifecycle.get('session.stopping')!.dispatch(
      event('session.stopping', {}) as never,
    );
    expect(result.decision).toEqual({ kind: 'continue' });
    expect(result.receipts).toEqual([
      expect.objectContaining({ outcome: 'failed', diagnostic: 'audit sink unavailable' }),
    ]);
  });

  it('cancels and drains timed-out lifecycle callbacks before disposal', async () => {
    const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
    let settled = false;
    const control = installNativeCustomizationLifecycle(lifecycle, {
      schemaVersion: 1,
      id: 'com.acme.lifecycle-drain',
      events: [{
        id: 'slow-audit',
        event: 'session.stopping',
        timeoutMs: 1,
        observe: (_event, { signal }) => new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            settled = true;
            resolve();
          }, { once: true });
        }),
      }],
    });

    const result = await lifecycle.get('session.stopping')!.dispatch(
      event('session.stopping', {}) as never,
    );
    expect(result.receipts).toEqual([
      expect.objectContaining({ outcome: 'timeout' }),
    ]);
    expect(settled).toBe(false);
    control.cancel();
    await expect(control.drain({ timeoutMs: 50 })).resolves.toEqual({
      completed: true,
      pendingAtDeadline: 0,
    });
    expect(settled).toBe(true);
    control();
  });

  it('bounds teardown when a callback ignores cancellation and prevents new admission', async () => {
    const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
    let rejectDetached!: (error: Error) => void;
    const observe = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectDetached = reject;
    }));
    const control = installNativeCustomizationLifecycle(lifecycle, {
      schemaVersion: 1,
      id: 'com.acme.lifecycle-hard-bound',
      events: [{
        id: 'stubborn-audit',
        event: 'session.stopping',
        timeoutMs: 1,
        observe,
      }],
    });

    await lifecycle.get('session.stopping')!.dispatch(event('session.stopping', {}) as never);
    control.cancel();
    control();
    await expect(control.drain({ timeoutMs: 5 })).resolves.toEqual({
      completed: false,
      pendingAtDeadline: 1,
    });
    await lifecycle.get('session.stopping')!.dispatch(event('session.stopping', {}) as never);
    expect(observe).toHaveBeenCalledTimes(1);

    rejectDetached(new Error('late detached failure'));
    await new Promise((resolve) => setImmediate(resolve));
  });
});
