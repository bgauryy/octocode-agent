import {
  APPROVAL_CLASSES,
  PERMISSION_MODES,
  type ApprovalClass,
  type PermissionDecision,
  type PermissionDecisionOutcome,
  type PermissionDecisionRequest,
  type PermissionDecisionSource,
  type PermissionGuardName,
  type PermissionMode,
  type PermissionReviewerAvailability,
  type ResolvedToolRisk,
} from '../contracts/permissions.js';

const GUARD_ORDER = Object.freeze([
  'trust',
  'managed',
  'capability',
  'sandbox',
  'plan',
  'lock',
] as const satisfies readonly PermissionGuardName[]);
const TOOL_EFFECT_ORDER = Object.freeze(['read', 'network', 'process', 'write', 'destructive'] as const);
const TOOL_EFFECTS: ReadonlySet<string> = new Set(TOOL_EFFECT_ORDER);
const TRUST_REQUIREMENTS = new Set(['none', 'workspace', 'managed']);
const RISK_SCOPES = new Set(['closed', 'workspace', 'host', 'external']);
const DATA_CLASSES = new Set(['public', 'workspace', 'private', 'secret']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const validMode = (value: unknown): value is PermissionMode =>
  typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);

const validApproval = (value: unknown): value is ApprovalClass =>
  typeof value === 'string' && (APPROVAL_CLASSES as readonly string[]).includes(value);

const validReviewer = (value: unknown): value is PermissionReviewerAvailability =>
  value === 'available' || value === 'unavailable';

function validRisk(value: unknown): value is ResolvedToolRisk {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (!hasOnlyKeys(value, [
    'schemaVersion', 'effects', 'trust', 'approval', 'scope', 'data',
    'openWorld', 'externalCommunication', 'destructive', 'reversible', 'idempotent',
  ])) return false;
  if (!Array.isArray(value.effects) || value.effects.length === 0) return false;
  const effects = value.effects;
  if (!effects.every((effect) => typeof effect === 'string' && TOOL_EFFECTS.has(effect))) return false;
  if (new Set(effects).size !== effects.length) return false;
  const canonical = TOOL_EFFECT_ORDER.filter((effect) => effects.includes(effect));
  if (canonical.some((effect, index) => effects[index] !== effect)) return false;
  return TRUST_REQUIREMENTS.has(String(value.trust))
    && validApproval(value.approval)
    && RISK_SCOPES.has(String(value.scope))
    && DATA_CLASSES.has(String(value.data))
    && typeof value.openWorld === 'boolean'
    && typeof value.externalCommunication === 'boolean'
    && typeof value.destructive === 'boolean'
    && typeof value.reversible === 'boolean'
    && typeof value.idempotent === 'boolean';
}

function failedGuards(value: unknown): readonly PermissionGuardName[] | undefined {
  if (!isRecord(value)) return undefined;
  if (!hasOnlyKeys(value, GUARD_ORDER)) return undefined;
  const failed: PermissionGuardName[] = [];
  for (const guard of GUARD_ORDER) {
    const state = value[guard];
    if (state !== 'satisfied' && state !== 'failed') return undefined;
    if (state === 'failed') failed.push(guard);
  }
  return Object.freeze(failed);
}

function elevatedForStrictMode(risk: ResolvedToolRisk): boolean {
  return risk.effects.some((effect) => effect !== 'read')
    || (risk.scope !== 'closed' && risk.scope !== 'workspace')
    || (risk.data !== 'public' && risk.data !== 'workspace')
    || risk.openWorld
    || risk.externalCommunication
    || risk.destructive;
}

function receipt(input: {
  readonly mode: PermissionMode | 'invalid';
  readonly approval: ApprovalClass | 'invalid';
  readonly outcome: PermissionDecisionOutcome;
  readonly source: PermissionDecisionSource;
  readonly reason: string;
  readonly availability: PermissionReviewerAvailability | 'invalid';
  readonly reviewerRequired: boolean;
  readonly failedGuards?: readonly PermissionGuardName[];
}): PermissionDecision {
  return Object.freeze({
    schemaVersion: 1,
    mode: input.mode,
    approval: input.approval,
    outcome: input.outcome,
    source: input.source,
    reason: input.reason,
    reviewer: Object.freeze({
      availability: input.availability,
      required: input.reviewerRequired,
    }),
    failedGuards: Object.freeze([...(input.failedGuards ?? [])]),
  });
}

function invalidDecision(): PermissionDecision {
  return receipt({
    mode: 'invalid',
    approval: 'invalid',
    outcome: 'deny',
    source: 'validation',
    reason: 'Permission request is invalid',
    availability: 'invalid',
    reviewerRequired: false,
  });
}

/** Resolve one already-validated tool risk without consulting ambient host state. */
export function resolvePermissionDecision(value: unknown): PermissionDecision {
  if (!isRecord(value) || value.schemaVersion !== 1) return invalidDecision();
  if (!hasOnlyKeys(value, ['schemaVersion', 'mode', 'risk', 'reviewer', 'guards'])) return invalidDecision();
  if (!validMode(value.mode) || !validRisk(value.risk)) return invalidDecision();
  if (!isRecord(value.reviewer)
    || !hasOnlyKeys(value.reviewer, ['availability'])
    || !validReviewer(value.reviewer.availability)) return invalidDecision();
  const guards = failedGuards(value.guards);
  if (guards === undefined) return invalidDecision();

  const request = value as unknown as PermissionDecisionRequest;
  if (guards.length > 0) {
    return receipt({
      mode: request.mode,
      approval: request.risk.approval,
      outcome: 'deny',
      source: 'guard',
      reason: `Permission guards failed: ${guards.join(', ')}`,
      availability: request.reviewer.availability,
      reviewerRequired: false,
      failedGuards: guards,
    });
  }

  if (request.risk.approval === 'deny') {
    return receipt({
      mode: request.mode,
      approval: request.risk.approval,
      outcome: 'deny',
      source: 'risk',
      reason: 'Resolved tool risk denies this operation',
      availability: request.reviewer.availability,
      reviewerRequired: false,
    });
  }

  const requiresPrompt = request.risk.approval === 'mandatory'
    || (request.risk.approval === 'prompt' && request.mode !== 'allow-all')
    || (request.risk.approval === 'auto'
      && request.mode === 'strict'
      && elevatedForStrictMode(request.risk));

  if (!requiresPrompt) {
    return receipt({
      mode: request.mode,
      approval: request.risk.approval,
      outcome: 'allow',
      source: 'mode',
      reason: request.mode === 'allow-all' && request.risk.approval === 'prompt'
        ? 'Allow-all bypassed promptable approval'
        : 'Permission mode allows this operation',
      availability: request.reviewer.availability,
      reviewerRequired: false,
    });
  }

  if (request.reviewer.availability === 'unavailable') {
    return receipt({
      mode: request.mode,
      approval: request.risk.approval,
      outcome: 'deny',
      source: 'reviewer-unavailable',
      reason: 'Permission approval requires an available reviewer',
      availability: request.reviewer.availability,
      reviewerRequired: true,
    });
  }

  return receipt({
    mode: request.mode,
    approval: request.risk.approval,
    outcome: 'prompt',
    source: 'mode',
    reason: request.risk.approval === 'mandatory'
      ? 'This operation requires mandatory approval'
      : 'Permission mode requires approval',
    availability: request.reviewer.availability,
    reviewerRequired: true,
  });
}
