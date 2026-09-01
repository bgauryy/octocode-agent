import { describe, expect, it, vi } from 'vitest';
import {
  eventId,
  sessionId,
  type AgentRuntime,
  type RuntimeEvent,
} from '@octocodeai/agent-core';
import { createAgentControlV1 } from '../src/native-api-control.js';

describe('native API control v1', () => {
  it('projects narrow commands, snapshots, and redacted events', async () => {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const runtime = {
      start: vi.fn(),
      submit: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      execute: vi.fn(),
      snapshot: vi.fn(() => ({
        schemaVersion: 1 as const,
        state: 'ready' as const,
        sessionId: sessionId('session:control'),
        activeTurn: false,
        model: { providerId: 'openai', modelId: 'gpt-5' },
        thinkingLevel: null,
        usage: { inputTokens: 2, outputTokens: 1 },
        revision: 3,
      })),
      subscribe: vi.fn((listener: (event: RuntimeEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      stop: vi.fn(async () => undefined),
    } satisfies AgentRuntime;
    const owned = new Set<() => void>();
    const control = createAgentControlV1(runtime, owned);
    const observed = vi.fn();
    const unsubscribe = control.subscribe(observed);

    await control.submit('hello');
    await control.cancel('later');
    expect(control.snapshot()).toEqual(expect.objectContaining({
      schemaVersion: 1,
      sessionId: 'session:control',
      state: 'ready',
      revision: 3,
    }));
    for (const listener of listeners) listener({
      schemaVersion: 1,
      eventVersion: 1,
      id: eventId('event:control'),
      type: 'input.received',
      phase: 'before',
      sessionId: sessionId('session:control'),
      timestamp: 1,
      cwd: '/workspace',
      mode: 'headless',
      model: { providerId: 'openai', modelId: 'gpt-5' },
      trust: { workspace: 'trusted', managedOnly: false },
      payload: { text: 'private prompt', source: 'api' },
    } as RuntimeEvent);

    expect(runtime.submit).toHaveBeenCalledWith('hello');
    expect(runtime.cancel).toHaveBeenCalledWith('later');
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      type: 'input.received',
      dataClassification: 'redacted',
      payload: { source: 'api' },
    }));
    const projected = observed.mock.calls[0]![0];
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.model)).toBe(true);
    expect(Object.isFrozen(projected.trust)).toBe(true);
    expect(() => {
      projected.model.modelId = 'mutated';
    }).toThrow();
    expect(owned.size).toBe(1);
    unsubscribe();
    expect(owned.size).toBe(0);
    await control.stop();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it('isolates control event listener failures', () => {
    let emit: ((event: RuntimeEvent) => void) | undefined;
    const runtime = {
      start: vi.fn(),
      submit: vi.fn(),
      cancel: vi.fn(),
      execute: vi.fn(),
      snapshot: vi.fn(() => ({
        schemaVersion: 1 as const,
        state: 'ready' as const,
        sessionId: sessionId('session:control-failure'),
        activeTurn: false,
        model: null,
        thinkingLevel: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        revision: 0,
      })),
      subscribe: vi.fn((listener: (event: RuntimeEvent) => void) => {
        emit = listener;
        return vi.fn();
      }),
      stop: vi.fn(),
    } satisfies AgentRuntime;
    createAgentControlV1(runtime).subscribe(() => {
      throw new Error('telemetry sink failed');
    });

    expect(() => emit!({
      schemaVersion: 1,
      eventVersion: 1,
      id: eventId('event:control-failure'),
      type: 'session.stopping',
      phase: 'before',
      sessionId: sessionId('session:control-failure'),
      timestamp: 1,
      cwd: '/workspace',
      mode: 'headless',
      model: null,
      trust: { workspace: 'unknown', managedOnly: false },
      payload: {},
    } as unknown as RuntimeEvent)).not.toThrow();
  });

  it('omits messages, reasons, errors, and unknown nested payload data', () => {
    let emit: ((event: RuntimeEvent) => void) | undefined;
    const runtime = {
      start: vi.fn(), submit: vi.fn(), cancel: vi.fn(), execute: vi.fn(), stop: vi.fn(),
      snapshot: vi.fn(() => ({
        schemaVersion: 1 as const,
        state: 'ready' as const,
        sessionId: sessionId('session:redaction'),
        activeTurn: false,
        model: null,
        thinkingLevel: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        revision: 0,
      })),
      subscribe: vi.fn((listener: (event: RuntimeEvent) => void) => {
        emit = listener;
        return vi.fn();
      }),
    } satisfies AgentRuntime;
    const observed = vi.fn();
    createAgentControlV1(runtime).subscribe(observed);

    emit!({
      schemaVersion: 1,
      eventVersion: 1,
      id: eventId('event:redaction'),
      type: 'runtime.failed',
      phase: 'after',
      sessionId: sessionId('session:redaction'),
      timestamp: 1,
      cwd: '/workspace',
      mode: 'headless',
      trust: { workspace: 'unknown', managedOnly: false },
      payload: {
        message: 'private failure',
        reason: 'private reason',
        error: { message: 'nested private failure', path: '/private/path' },
      },
    } as unknown as RuntimeEvent);

    expect(observed.mock.calls[0]![0].payload).toEqual({});
  });
});
