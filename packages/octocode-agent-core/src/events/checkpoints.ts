import {
  assertCheckpointRecoveryV1,
  assertCheckpointTransitionV1,
  type CheckpointRecoveryV1,
  type CheckpointTransitionV1,
} from '../contracts/checkpoints.js';

export type CheckpointEventV1 =
  | { readonly schemaVersion: 1; readonly type: 'checkpoint.prepared'; readonly transition: CheckpointTransitionV1 }
  | { readonly schemaVersion: 1; readonly type: 'checkpoint.recovered'; readonly recovery: CheckpointRecoveryV1 }
  | { readonly schemaVersion: 1; readonly type: 'rewind.prepared'; readonly transition: CheckpointTransitionV1 }
  | { readonly schemaVersion: 1; readonly type: 'rewind.completed'; readonly recovery: CheckpointRecoveryV1 };

export interface CheckpointEventIngressPort {
  emit(event: CheckpointEventV1): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (field: string): never => {
  throw new TypeError(`Invalid checkpoint event ${field}`);
};

const isPublicCheckpointPath = (value: string): boolean => {
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    /^[a-zA-Z]:/u.test(value)
  ) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
};

export const assertCheckpointEventV1 = (value: unknown): CheckpointEventV1 => {
  const event = isRecord(value) ? value : invalid('event');
  if (event.schemaVersion !== 1) invalid('schemaVersion');
  if (event.type === 'checkpoint.prepared' || event.type === 'rewind.prepared') {
    if (Object.keys(event).length !== 3 || !('transition' in event)) invalid('fields');
    const transition = assertCheckpointTransitionV1(event.transition);
    if (!isPublicCheckpointPath(transition.path)) invalid('transition.path');
    if (event.type === 'checkpoint.prepared' && transition.attemptKind !== 'mutation') invalid('transition.attemptKind');
    if (event.type === 'rewind.prepared' && transition.attemptKind !== 'rewind') invalid('transition.attemptKind');
  } else if (event.type === 'checkpoint.recovered' || event.type === 'rewind.completed') {
    if (Object.keys(event).length !== 3 || !('recovery' in event)) invalid('fields');
    const recovery = assertCheckpointRecoveryV1(event.recovery);
    if (!isPublicCheckpointPath(recovery.path)) invalid('recovery.path');
    if (event.type === 'checkpoint.recovered' && recovery.attemptKind !== 'mutation') invalid('recovery.attemptKind');
    if (event.type === 'rewind.completed' && (recovery.attemptKind !== 'rewind' || recovery.state !== 'complete'))
      invalid('recovery.state');
  } else invalid('type');
  return event as unknown as CheckpointEventV1;
};

export const assertCheckpointEventPayloadV1 = <TType extends CheckpointEventV1['type']>(
  type: TType,
  value: unknown,
): Omit<Extract<CheckpointEventV1, { readonly type: TType }>, 'type'> => {
  const payload = isRecord(value) ? value : invalid('payload');
  if (Object.hasOwn(payload, 'type')) invalid('payload.fields');
  const event = assertCheckpointEventV1({ ...payload, type });
  const { type: _type, ...decoded } = event;
  return decoded as unknown as Omit<Extract<CheckpointEventV1, { readonly type: TType }>, 'type'>;
};
