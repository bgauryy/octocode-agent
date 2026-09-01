export const CHECKPOINT_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const CHECKPOINT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type CheckpointImageV1 =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'present';
      readonly sha256: string;
      readonly bytes: number;
      readonly mode: number;
    };

export type CheckpointAttemptKind = 'mutation' | 'rewind';
export type CheckpointMutationOperation = 'write' | 'edit' | 'delete';
export type CheckpointOperation = CheckpointMutationOperation | 'rewind';
export type CheckpointRecoveryState = 'complete' | 'partial' | 'uncertain';

/** Immutable host-neutral description of one prepared filesystem transition. */
export interface CheckpointTransitionV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly checkpointId: string;
  readonly attemptKind: CheckpointAttemptKind;
  readonly operation: CheckpointOperation;
  readonly path: string;
  readonly before: CheckpointImageV1;
  readonly after: CheckpointImageV1;
  readonly journalSha256: string;
}

export type CheckpointObservedImageV1 = CheckpointImageV1 | { readonly kind: 'unknown' };

/**
 * Recovery is observational. It never replays an admitted effect: complete
 * means the target equals the journaled after-image, partial means it still
 * equals the before-image, and uncertain means neither can be proven.
 */
export interface CheckpointRecoveryV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly checkpointId: string;
  readonly attemptKind: CheckpointAttemptKind;
  readonly path: string;
  readonly state: CheckpointRecoveryState;
  readonly current: CheckpointObservedImageV1;
  readonly journalSha256: string;
  readonly reason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (field: string): never => {
  throw new TypeError(`Invalid checkpoint ${field}`);
};

const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
};

const boundedString = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const digest = (value: unknown): value is string =>
  typeof value === 'string' && CHECKPOINT_SHA256_PATTERN.test(value);

export const assertCheckpointImageV1 = (value: unknown): CheckpointImageV1 => {
  const image = isRecord(value) ? value : invalid('image');
  if (image.kind === 'absent') {
    if (!exactKeys(image, ['kind'])) invalid('image.absent');
    return image as unknown as CheckpointImageV1;
  }
  if (image.kind !== 'present' || !exactKeys(image, ['kind', 'sha256', 'bytes', 'mode']))
    invalid('image.present');
  if (!digest(image.sha256)) invalid('image.sha256');
  if (!Number.isSafeInteger(image.bytes) || (image.bytes as number) < 0 || (image.bytes as number) > CHECKPOINT_MAX_IMAGE_BYTES)
    invalid('image.bytes');
  if (!Number.isSafeInteger(image.mode) || (image.mode as number) < 0 || (image.mode as number) > 0o7777)
    invalid('image.mode');
  return image as unknown as CheckpointImageV1;
};

export const assertCheckpointTransitionV1 = (value: unknown): CheckpointTransitionV1 => {
  const transition = isRecord(value) ? value : invalid('transition');
  if (!exactKeys(transition, [
    'schemaVersion',
    'attemptId',
    'checkpointId',
    'attemptKind',
    'operation',
    'path',
    'before',
    'after',
    'journalSha256',
  ])) invalid('transition.fields');
  if (transition.schemaVersion !== 1) invalid('transition.schemaVersion');
  if (!boundedString(transition.attemptId, 256)) invalid('transition.attemptId');
  if (!boundedString(transition.checkpointId, 256)) invalid('transition.checkpointId');
  if (!boundedString(transition.path, 4096)) invalid('transition.path');
  if (!digest(transition.journalSha256)) invalid('transition.journalSha256');
  const mutation = transition.attemptKind === 'mutation';
  const rewind = transition.attemptKind === 'rewind';
  if (!mutation && !rewind) invalid('transition.attemptKind');
  if (mutation) {
    if (transition.attemptId !== transition.checkpointId) invalid('transition.attemptId');
    if (transition.operation !== 'write' && transition.operation !== 'edit' && transition.operation !== 'delete')
      invalid('transition.operation');
    if (transition.operation === 'delete' && (transition.after as { kind?: unknown }).kind !== 'absent')
      invalid('transition.after');
  } else if (transition.operation !== 'rewind') invalid('transition.operation');
  assertCheckpointImageV1(transition.before);
  assertCheckpointImageV1(transition.after);
  return transition as unknown as CheckpointTransitionV1;
};

export const assertCheckpointRecoveryV1 = (value: unknown): CheckpointRecoveryV1 => {
  const recovery = isRecord(value) ? value : invalid('recovery');
  if (!exactKeys(
    recovery,
    ['schemaVersion', 'attemptId', 'checkpointId', 'attemptKind', 'path', 'state', 'current', 'journalSha256'],
    ['reason'],
  )) invalid('recovery.fields');
  if (recovery.schemaVersion !== 1) invalid('recovery.schemaVersion');
  if (!boundedString(recovery.attemptId, 256)) invalid('recovery.attemptId');
  if (!boundedString(recovery.checkpointId, 256)) invalid('recovery.checkpointId');
  if (recovery.attemptKind !== 'mutation' && recovery.attemptKind !== 'rewind') invalid('recovery.attemptKind');
  if (!boundedString(recovery.path, 4096)) invalid('recovery.path');
  if (!digest(recovery.journalSha256)) invalid('recovery.journalSha256');
  if (recovery.state !== 'complete' && recovery.state !== 'partial' && recovery.state !== 'uncertain')
    invalid('recovery.state');
  const current = isRecord(recovery.current) ? recovery.current : invalid('recovery.current');
  if (current.kind === 'unknown') {
    if (!exactKeys(current, ['kind']) || recovery.state !== 'uncertain') invalid('recovery.current');
  } else {
    assertCheckpointImageV1(current);
  }
  if (recovery.state === 'uncertain') {
    if (!boundedString(recovery.reason, 512)) invalid('recovery.reason');
  } else if ('reason' in recovery) invalid('recovery.reason');
  return recovery as unknown as CheckpointRecoveryV1;
};
