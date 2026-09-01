/** JSON-compatible data accepted at the durable automation boundary. */
export type AutomationJson = null | boolean | number | string | readonly AutomationJson[] | { readonly [key: string]: AutomationJson };

export type MisfirePolicy = 'skip' | 'run-once' | 'catch-up';
export type AutomationState = 'active' | 'paused' | 'cancelled';
export interface RetryPolicy { readonly maxAttempts: number; readonly backoffMs: number; }
export interface AutomationCandidate { readonly automationId: string; readonly scheduledAt: number; }

export type AutomationSchedule =
  | { readonly kind: 'once'; readonly at: number }
  | { readonly kind: 'interval'; readonly everyMs: number; readonly anchorAt: number }
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string };

/**
 * A durable declaration. The action is semantic rather than an executable
 * command so every host can apply its own policy before dispatching it.
 */
export interface AutomationDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly state: AutomationState;
  readonly schedule: AutomationSchedule;
  readonly misfirePolicy: MisfirePolicy;
  readonly retryPolicy: RetryPolicy;
  readonly action: {
    readonly name: string;
    readonly version: number;
    readonly payload: AutomationJson;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface AutomationRunEnvelope {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly automationId: string;
  readonly scheduledFor: number;
  readonly attempt: number;
}

export type AutomationOutcome =
  | { readonly state: 'succeeded'; readonly completedAt: number; readonly result?: AutomationJson }
  | {
      readonly state: 'failed';
      readonly completedAt: number;
      readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean; readonly details?: AutomationJson };
    }
  | { readonly state: 'uncertain'; readonly completedAt: number; readonly reason: string; readonly details?: AutomationJson };

export type AutomationRun = AutomationRunEnvelope &
  (
    | { readonly state: 'claimed'; readonly outcome?: never }
    | { readonly state: 'succeeded'; readonly outcome: Extract<AutomationOutcome, { readonly state: 'succeeded' }> }
    | { readonly state: 'failed'; readonly outcome: Extract<AutomationOutcome, { readonly state: 'failed' }> }
    | { readonly state: 'uncertain'; readonly outcome: Extract<AutomationOutcome, { readonly state: 'uncertain' }> }
  );

/** A lease-bearing run. The fencing token must accompany every mutation. */
export interface AutomationClaim extends AutomationRunEnvelope {
  readonly state: 'claimed';
  readonly ownerId: string;
  readonly leaseExpiresAt: number;
  readonly fencingToken: number;
}

export interface AutomationStorePort {
  /** Insert or replace by revision; implementations reject stale revisions. */
  put(definition: AutomationDefinition): Promise<AutomationDefinition>;
  list(filter?: { readonly states?: readonly AutomationState[] }): Promise<readonly AutomationDefinition[]>;
  /** Persist cancellation only when expectedRevision still owns the definition. */
  cancel(id: string, expectedRevision: number, cancelledAt: number): Promise<AutomationDefinition>;
  /**
   * Atomically materialize, deduplicate, and lease at most `limit` runs from
   * the supplied candidates. The host scheduler owns deterministic calendar
   * math; the durable store owns admission. Candidates must be non-empty and
   * bounded to `limit` (1..100).
   */
  claim(request: {
    readonly ownerId: string;
    readonly now: number;
    readonly leaseMs: number;
    readonly limit: number;
    readonly candidates: readonly AutomationCandidate[];
  }): Promise<readonly AutomationClaim[]>;
  /** Extend a live lease only when owner and fencing token still match. */
  heartbeat(claim: AutomationClaim, now: number, leaseMs: number): Promise<AutomationClaim>;
  complete(claim: AutomationClaim, outcome: Extract<AutomationOutcome, { readonly state: 'succeeded' }>): Promise<AutomationRun>;
  fail(claim: AutomationClaim, outcome: Extract<AutomationOutcome, { readonly state: 'failed' }>): Promise<AutomationRun>;
  /** Seal a run whose external effect may have happened but lacks a durable receipt. It must not be retried automatically. */
  uncertain(claim: AutomationClaim, outcome: Extract<AutomationOutcome, { readonly state: 'uncertain' }>): Promise<AutomationRun>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const isAutomationJson = (value: unknown, seen = new Set<object>()): value is AutomationJson => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isAutomationJson(entry, seen))
    : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((entry) => isAutomationJson(entry, seen));
  seen.delete(value);
  return valid;
};

const invalid = (field: string): never => {
  throw new TypeError(`Invalid automation ${field}`);
};

export const assertAutomationDefinition = (value: unknown): AutomationDefinition => {
  const definition = isRecord(value) ? value : invalid('definition');
  if (definition.schemaVersion !== 1) invalid('schemaVersion');
  if (!isNonEmptyString(definition.id)) invalid('id');
  if (!isNonNegativeInteger(definition.revision)) invalid('revision');
  if (definition.state !== 'active' && definition.state !== 'paused' && definition.state !== 'cancelled') invalid('state');
  if (definition.misfirePolicy !== 'skip' && definition.misfirePolicy !== 'run-once' && definition.misfirePolicy !== 'catch-up') invalid('misfirePolicy');
  const retryPolicy = isRecord(definition.retryPolicy) ? definition.retryPolicy : invalid('retryPolicy');
  if (!isPositiveInteger(retryPolicy.maxAttempts) || retryPolicy.maxAttempts > 100) invalid('retryPolicy.maxAttempts');
  if (!isNonNegativeInteger(retryPolicy.backoffMs) || retryPolicy.backoffMs > 86_400_000) invalid('retryPolicy.backoffMs');
  const schedule = isRecord(definition.schedule) ? definition.schedule : invalid('schedule');
  if (schedule.kind === 'once') {
    if (!isFiniteTimestamp(schedule.at)) invalid('schedule.at');
  } else if (schedule.kind === 'interval') {
    if (!isPositiveInteger(schedule.everyMs)) invalid('schedule.everyMs');
    if (!isFiniteTimestamp(schedule.anchorAt)) invalid('schedule.anchorAt');
  } else if (schedule.kind === 'cron') {
    if (!isNonEmptyString(schedule.expression)) invalid('schedule.expression');
    if (!isNonEmptyString(schedule.timeZone)) invalid('schedule.timeZone');
  } else invalid('schedule.kind');
  const action = isRecord(definition.action) ? definition.action : invalid('action');
  if (!isNonEmptyString(action.name)) invalid('action.name');
  if (!isPositiveInteger(action.version)) invalid('action.version');
  if (!isAutomationJson(action.payload)) invalid('action.payload');
  const createdAt = isFiniteTimestamp(definition.createdAt) ? definition.createdAt : invalid('createdAt');
  const updatedAt = isFiniteTimestamp(definition.updatedAt) ? definition.updatedAt : invalid('updatedAt');
  if (updatedAt < createdAt) invalid('updatedAt');
  return definition as unknown as AutomationDefinition;
};

export const assertAutomationOutcome = (value: unknown): AutomationOutcome => {
  const outcome = isRecord(value) ? value : invalid('outcome');
  if (!isFiniteTimestamp(outcome.completedAt)) invalid('outcome.completedAt');
  if (outcome.state === 'succeeded') {
    if ('result' in outcome && !isAutomationJson(outcome.result)) invalid('outcome.result');
  } else if (outcome.state === 'failed') {
    const error = isRecord(outcome.error) ? outcome.error : invalid('outcome.error');
    if (!isNonEmptyString(error.code)) invalid('outcome.error.code');
    if (!isNonEmptyString(error.message)) invalid('outcome.error.message');
    if (typeof error.retryable !== 'boolean') invalid('outcome.error.retryable');
    if ('details' in error && !isAutomationJson(error.details)) invalid('outcome.error.details');
  } else if (outcome.state === 'uncertain') {
    if (!isNonEmptyString(outcome.reason)) invalid('outcome.reason');
    if ('details' in outcome && !isAutomationJson(outcome.details)) invalid('outcome.details');
  } else invalid('outcome.state');
  return outcome as unknown as AutomationOutcome;
};
