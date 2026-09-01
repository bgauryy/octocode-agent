import { describe, expect, it } from 'vitest';
import {
  eventId,
  sessionId,
  type RuntimeEvent,
} from '@octocodeai/agent-core';
import {
  PUBLIC_REDACTED_PAYLOAD_KEYS_V1,
  projectControlEventV1,
  projectObservedLifecycleEventV1,
  projectSensitiveLifecycleEventV1,
} from '../src/native-public-events.js';

function event(type: RuntimeEvent['type'], payload: unknown): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventVersion: 1,
    id: eventId(`event:${type}`),
    type,
    phase: 'notification',
    sessionId: sessionId('session:public-events'),
    timestamp: 1,
    cwd: '/private/workspace',
    mode: 'headless',
    trust: { workspace: 'trusted', managedOnly: false },
    payload,
  } as RuntimeEvent;
}

describe('native public event v1 projection', () => {
  it('uses event-specific redaction instead of widening every event through one allowlist', () => {
    expect(projectControlEventV1(event('session.starting', {
      reason: 'private reason',
      callId: 'must-not-cross',
      name: 'must-not-cross',
    })).payload).toEqual({});

    expect(projectControlEventV1(event('tool.started', {
      callId: 'call:1',
      name: 'file',
      outcome: 'must-not-cross',
      nested: { path: '/private/path' },
    })).payload).toEqual({ callId: 'call:1', name: 'file' });

    expect(projectControlEventV1(event('model.selected', {
      source: 'settings',
      status: 'ready',
      nested: { token: 'private' },
    })).payload).toEqual({ source: 'settings', status: 'ready' });
  });

  it('keeps the redaction table exhaustive and immutable', () => {
    expect(Object.keys(PUBLIC_REDACTED_PAYLOAD_KEYS_V1).length).toBeGreaterThan(50);
    expect(Object.isFrozen(PUBLIC_REDACTED_PAYLOAD_KEYS_V1)).toBe(true);
    for (const keys of Object.values(PUBLIC_REDACTED_PAYLOAD_KEYS_V1))
      expect(Object.isFrozen(keys)).toBe(true);
  });

  it('exposes only bounded context projection receipt metadata', () => {
    expect(projectControlEventV1(event('context.artifacts-projected', {
      phase: 'compaction',
      sourceCount: 4,
      projectedCount: 3,
      droppedCount: 1,
      stablePrefixDigest: 'a'.repeat(64),
      summary: 'must-not-cross',
      plan: { secret: true },
    })).payload).toEqual({
      phase: 'compaction',
      sourceCount: 4,
      projectedCount: 3,
      droppedCount: 1,
      stablePrefixDigest: 'a'.repeat(64),
    });
  });

  it('fixes lifecycle classification in the projector and rejects type mismatches', () => {
    const requested = event('tool.requested', {
      callId: 'call:1',
      name: 'file',
      input: { path: '/private/path' },
    });
    expect(projectSensitiveLifecycleEventV1(requested, 'tool.requested')).toMatchObject({
      dataClassification: 'sensitive',
      payload: { input: { path: '/private/path' } },
    });
    expect(projectObservedLifecycleEventV1(requested, 'tool.requested')).toMatchObject({
      dataClassification: 'redacted',
      payload: { callId: 'call:1', name: 'file' },
    });
    expect(() => projectObservedLifecycleEventV1(requested, 'tool.ended')).toThrow(/event type/i);
  });
});
