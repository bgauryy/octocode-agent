import { describe, expect, it } from 'vitest';
import type {
  ApprovalClass,
  PermissionDecisionRequest,
  PermissionGuardSnapshot,
  PermissionMode,
  ResolvedToolRisk,
} from '../src/contracts/permissions.js';
import { resolvePermissionDecision } from '../src/runtime/permissions.js';

const satisfiedGuards: PermissionGuardSnapshot = {
  trust: 'satisfied',
  managed: 'satisfied',
  capability: 'satisfied',
  sandbox: 'satisfied',
  plan: 'satisfied',
  lock: 'satisfied',
};

const risk = (
  approval: ApprovalClass,
  elevated = false,
): ResolvedToolRisk => ({
  schemaVersion: 1,
  effects: elevated ? ['network'] : ['read'],
  trust: 'none',
  approval,
  scope: elevated ? 'external' : 'workspace',
  data: elevated ? 'private' : 'workspace',
  openWorld: elevated,
  externalCommunication: elevated,
  destructive: false,
  reversible: true,
  idempotent: true,
});

const request = (
  mode: PermissionMode,
  approval: ApprovalClass,
  options: {
    elevated?: boolean;
    reviewer?: 'available' | 'unavailable';
    guards?: PermissionGuardSnapshot;
  } = {},
): PermissionDecisionRequest => ({
  schemaVersion: 1,
  mode,
  risk: risk(approval, options.elevated),
  reviewer: { availability: options.reviewer ?? 'available' },
  guards: options.guards ?? satisfiedGuards,
});

describe('permission decision foundation', () => {
  it.each([
    ['strict', 'auto', false, 'allow'],
    ['default', 'auto', false, 'allow'],
    ['allow-all', 'auto', false, 'allow'],
    ['strict', 'auto', true, 'prompt'],
    ['default', 'auto', true, 'allow'],
    ['allow-all', 'auto', true, 'allow'],
    ['strict', 'prompt', false, 'prompt'],
    ['default', 'prompt', false, 'prompt'],
    ['allow-all', 'prompt', false, 'allow'],
    ['strict', 'mandatory', false, 'prompt'],
    ['default', 'mandatory', false, 'prompt'],
    ['allow-all', 'mandatory', false, 'prompt'],
    ['strict', 'deny', false, 'deny'],
    ['default', 'deny', false, 'deny'],
    ['allow-all', 'deny', false, 'deny'],
  ] as const)(
    'maps %s + %s (elevated=%s) to %s',
    (mode, approval, elevated, outcome) => {
      expect(resolvePermissionDecision(request(mode, approval, { elevated }))).toMatchObject({
        schemaVersion: 1,
        mode,
        approval,
        outcome,
      });
    },
  );

  it('turns every prompt into a denial when no reviewer is available', () => {
    for (const candidate of [
      request('strict', 'auto', { elevated: true, reviewer: 'unavailable' }),
      request('default', 'prompt', { reviewer: 'unavailable' }),
      request('allow-all', 'mandatory', { reviewer: 'unavailable' }),
    ]) {
      expect(resolvePermissionDecision(candidate)).toMatchObject({
        outcome: 'deny',
        source: 'reviewer-unavailable',
        reviewer: { availability: 'unavailable', required: true },
      });
    }
  });

  it.each(['trust', 'managed', 'capability', 'sandbox', 'plan', 'lock'] as const)(
    'never lets allow-all bypass a failed %s guard',
    (guard) => {
      expect(resolvePermissionDecision(request('allow-all', 'prompt', {
        guards: { ...satisfiedGuards, [guard]: 'failed' },
      }))).toMatchObject({
        outcome: 'deny',
        source: 'guard',
        failedGuards: [guard],
      });
    },
  );

  it('fails closed for unknown modes, approval classes, risk values, and guards', () => {
    const invalid = [
      { ...request('default', 'auto'), mode: 'turbo' },
      { ...request('default', 'auto'), risk: { ...risk('auto'), approval: 'sometimes' } },
      { ...request('default', 'auto'), risk: { ...risk('auto'), effects: ['teleport'] } },
      { ...request('default', 'auto'), guards: { ...satisfiedGuards, sandbox: 'unknown' } },
    ];
    for (const candidate of invalid) {
      expect(resolvePermissionDecision(candidate)).toMatchObject({
        outcome: 'deny',
        source: 'validation',
        mode: 'invalid',
        approval: 'invalid',
      });
    }
  });

  it('keeps RuntimeMode outside the strict contract and returns deterministic JSON-safe receipts', () => {
    const base = request('default', 'prompt');
    const interactive = resolvePermissionDecision({ ...base, runtimeMode: 'interactive' });
    const headless = resolvePermissionDecision({ ...base, runtimeMode: 'headless' });
    expect(interactive).toEqual(headless);
    expect(interactive).toMatchObject({ outcome: 'deny', source: 'validation' });
    expect(JSON.parse(JSON.stringify(interactive))).toEqual(interactive);
    expect(resolvePermissionDecision(base)).toMatchObject({ outcome: 'prompt' });
  });
});
