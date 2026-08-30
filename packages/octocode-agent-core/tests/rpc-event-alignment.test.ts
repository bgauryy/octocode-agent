import { describe, expect, it } from 'vitest';

import {
  AGENT_EVENT_TYPES,
  RUNTIME_MODES,
  parseRpcRequest,
  parseRpcEvent,
  type AgentEventType,
  type RuntimeMode,
} from '../src/index.js';

function event(type: AgentEventType, mode: RuntimeMode) {
  const payload = type === 'provider.request-started'
    ? { requestId: 'request-1', iteration: 1, attempt: 1, maxAttempts: 1 }
    : type === 'provider.response-received'
      ? { requestId: 'request-1', iteration: 1, attempt: 1, maxAttempts: 1, durationMs: 1, stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }
      : type === 'provider.failed'
        ? { iteration: 1, message: 'provider failed' }
        : type === 'context.usage-changed'
          ? { inputTokens: 0, outputTokens: 0 }
          : {};
  return {
    schemaVersion: 1 as const,
    eventVersion: 1 as const,
    id: `event:${type}:${mode}`,
    type,
    phase: 'notification' as const,
    sessionId: 'session-1',
    timestamp: 1,
    cwd: '/workspace',
    mode,
    trust: { workspace: 'trusted' as const, managedOnly: false },
    payload,
  };
}

describe('RPC event contract alignment', () => {
  it('accepts the safe monitoring snapshot command without extra fields', () => {
    expect(parseRpcRequest({
      protocolVersion: 1,
      requestId: 'monitor-1',
      command: { type: 'monitoring.snapshot' },
    }).command).toEqual({ type: 'monitoring.snapshot' });
    expect(() => parseRpcRequest({
      protocolVersion: 1,
      requestId: 'monitor-2',
      command: { type: 'monitoring.snapshot', prompt: 'must not pass' },
    })).toThrow(/command/i);
  });

  it('accepts every canonical agent event type in every canonical runtime mode', () => {
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length);
    expect(new Set(RUNTIME_MODES).size).toBe(RUNTIME_MODES.length);

    for (const type of AGENT_EVENT_TYPES) {
      for (const mode of RUNTIME_MODES) {
        expect(parseRpcEvent({
          protocolVersion: 1,
          sequence: 1,
          event: event(type, mode),
        }).event).toMatchObject({ type, mode });
      }
    }
  });

  it('keeps near-miss wire values outside the canonical contract', () => {
    const valid = event(AGENT_EVENT_TYPES[0], RUNTIME_MODES[0]);
    expect(() => parseRpcEvent({
      protocolVersion: 1,
      sequence: 1,
      event: { ...valid, type: 'runtime.future' },
    })).toThrow(/event envelope/i);
    expect(() => parseRpcEvent({
      protocolVersion: 1,
      sequence: 1,
      event: { ...valid, mode: 'batch' },
    })).toThrow(/event envelope/i);
  });
});
