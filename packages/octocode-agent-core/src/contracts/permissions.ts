import type { EffectSet } from './tools.js';

export const PERMISSION_MODES = Object.freeze([
  'strict',
  'default',
  'allow-all',
] as const);
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const APPROVAL_CLASSES = Object.freeze([
  'auto',
  'prompt',
  'mandatory',
  'deny',
] as const);
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

export type PermissionReviewerAvailability = 'available' | 'unavailable';
export type PermissionGuardState = 'satisfied' | 'failed';
export type PermissionGuardName =
  | 'trust'
  | 'managed'
  | 'capability'
  | 'sandbox'
  | 'plan'
  | 'lock';

export interface PermissionGuardSnapshot {
  readonly trust: PermissionGuardState;
  readonly managed: PermissionGuardState;
  readonly capability: PermissionGuardState;
  readonly sandbox: PermissionGuardState;
  readonly plan: PermissionGuardState;
  readonly lock: PermissionGuardState;
}

export interface ResolvedToolRisk {
  readonly schemaVersion: 1;
  readonly effects: EffectSet;
  readonly trust: 'none' | 'workspace' | 'managed';
  readonly approval: ApprovalClass;
  readonly scope: 'closed' | 'workspace' | 'host' | 'external';
  readonly data: 'public' | 'workspace' | 'private' | 'secret';
  readonly openWorld: boolean;
  readonly externalCommunication: boolean;
  readonly destructive: boolean;
  readonly reversible: boolean;
  readonly idempotent: boolean;
}

export interface PermissionDecisionRequest {
  readonly schemaVersion: 1;
  readonly mode: PermissionMode;
  readonly risk: ResolvedToolRisk;
  readonly reviewer: {
    readonly availability: PermissionReviewerAvailability;
  };
  readonly guards: PermissionGuardSnapshot;
}

export type PermissionDecisionOutcome = 'allow' | 'prompt' | 'deny';
export type PermissionDecisionSource =
  | 'validation'
  | 'guard'
  | 'risk'
  | 'mode'
  | 'reviewer-unavailable';

/** Deterministic, data-only receipt suitable for later JSON serialization. */
export interface PermissionDecision {
  readonly schemaVersion: 1;
  readonly mode: PermissionMode | 'invalid';
  readonly approval: ApprovalClass | 'invalid';
  readonly outcome: PermissionDecisionOutcome;
  readonly source: PermissionDecisionSource;
  readonly reason: string;
  readonly reviewer: {
    readonly availability: PermissionReviewerAvailability | 'invalid';
    readonly required: boolean;
  };
  readonly failedGuards: readonly PermissionGuardName[];
}
