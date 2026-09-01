import { describe, expect, it } from 'vitest';
import {
  assertAutomationDefinition,
  assertAutomationOutcome,
  type AutomationClaim,
  type AutomationDefinition,
  type AutomationStorePort,
} from '../src/index.js';

const definition = {
  schemaVersion: 1,
  id: 'daily-research',
  revision: 3,
  state: 'active',
  schedule: { kind: 'interval', everyMs: 60_000, anchorAt: 1_700_000_000_000 },
  misfirePolicy: 'run-once',
  retryPolicy: { maxAttempts: 3, backoffMs: 5_000 },
  action: {
    name: 'research.refresh',
    version: 2,
    payload: { repository: 'octocode-agent', labels: ['scheduled'] },
  },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
} satisfies AutomationDefinition;

describe('automation contracts', () => {
  it('accepts a host-neutral versioned semantic action with JSON payload', () => {
    expect(assertAutomationDefinition(definition)).toBe(definition);
  });

  it.each([
    [{ ...definition, state: 'running' }, 'state'],
    [{ ...definition, misfirePolicy: 'replay-all' }, 'misfirePolicy'],
    [{ ...definition, action: { ...definition.action, payload: { invalid: undefined } } }, 'payload'],
    [{ ...definition, action: { ...definition.action, version: 0 } }, 'version'],
    [{ ...definition, retryPolicy: { maxAttempts: 0, backoffMs: 5_000 } }, 'maxAttempts'],
    [{ ...definition, retryPolicy: { maxAttempts: 3, backoffMs: 86_400_001 } }, 'backoffMs'],
  ])('fails closed on an invalid definition field', (candidate, field) => {
    expect(() => assertAutomationDefinition(candidate)).toThrow(field);
  });

  it('requires terminal outcomes and rejects impossible states', () => {
    const outcome = { state: 'succeeded', completedAt: 1_700_000_000_100, result: { refreshed: true } } as const;
    expect(assertAutomationOutcome(outcome)).toBe(outcome);
    const uncertain = {
      state: 'uncertain',
      completedAt: 1_700_000_000_101,
      reason: 'host crashed after dispatch; external effect receipt is unavailable',
    } as const;
    expect(assertAutomationOutcome(uncertain)).toBe(uncertain);
    expect(() => assertAutomationOutcome({ state: 'running', completedAt: 1 })).toThrow('state');
  });

  it('exposes fenced durable store operations without an execution API', () => {
    const claim = {
      schemaVersion: 1,
      runId: 'run-1',
      automationId: definition.id,
      scheduledFor: 1_700_000_060_000,
      attempt: 1,
      state: 'claimed',
      ownerId: 'host-1',
      leaseExpiresAt: 1_700_000_090_000,
      fencingToken: 7,
    } satisfies AutomationClaim;

    const store: AutomationStorePort = {
      async put(value) { return value; },
      async list() { return []; },
      async cancel() { return { ...definition, state: 'cancelled' }; },
      async claim() { return [claim]; },
      async heartbeat(value) { return value; },
      async complete(value, outcome) { return { ...value, state: 'succeeded', outcome }; },
      async fail(value, outcome) { return { ...value, state: 'failed', outcome }; },
      async uncertain(value, outcome) { return { ...value, state: 'uncertain', outcome }; },
    };
    void store.put(definition);
    void store.list({ states: ['active'] });
    void store.cancel(definition.id, definition.revision, 1_700_000_000_200);
    void store.claim({
      ownerId: claim.ownerId,
      now: 1_700_000_060_000,
      leaseMs: 30_000,
      limit: 1,
      candidates: [{ automationId: definition.id, scheduledAt: claim.scheduledFor }],
    });
    void store.heartbeat(claim, 1_700_000_070_000, 30_000);
    void store.complete(claim, { state: 'succeeded', completedAt: 1_700_000_070_000 });
    void store.fail(claim, {
      state: 'failed',
      completedAt: 1_700_000_070_000,
      error: { code: 'transient', message: 'retry later', retryable: true },
    });
    void store.uncertain(claim, {
      state: 'uncertain',
      completedAt: 1_700_000_070_000,
      reason: 'effect may have happened before the host crashed',
    });

    expect(claim.fencingToken).toBe(7);
  });
});
