import path from 'node:path';

import {
  RuntimeFailure,
  assertCheckpointEventV1,
  type CheckpointEventV1,
  type CheckpointRecoveryV1,
  type CheckpointTransitionV1,
} from '@octocodeai/agent-core';

import {
  parseNativeCheckpointRecovery,
  parseNativeCheckpointTransition,
  type NativeCheckpointEvent,
} from './native-checkpoints.js';

export type NativeCheckpointRuntimeEventProjection =
  | {
      readonly type: 'checkpoint.prepared';
      readonly payload: { readonly schemaVersion: 1; readonly transition: CheckpointTransitionV1 };
    }
  | {
      readonly type: 'checkpoint.recovered';
      readonly payload: { readonly schemaVersion: 1; readonly recovery: CheckpointRecoveryV1 };
    }
  | {
      readonly type: 'rewind.prepared';
      readonly payload: { readonly schemaVersion: 1; readonly transition: CheckpointTransitionV1 };
    }
  | {
      readonly type: 'rewind.completed';
      readonly payload: { readonly schemaVersion: 1; readonly recovery: CheckpointRecoveryV1 };
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertEventShape(value: unknown): asserts value is NativeCheckpointEvent {
  if (!isRecord(value))
    throw new RuntimeFailure('protocol', 'Native checkpoint event must be an object');
  const bodyKey = value.type === 'checkpoint.prepared' || value.type === 'rewind.prepared'
    ? 'transition'
    : value.type === 'checkpoint.recovered' || value.type === 'rewind.completed'
      ? 'recovery'
      : undefined;
  if (
    bodyKey === undefined ||
    value.schemaVersion !== 1 ||
    !Object.hasOwn(value, bodyKey) ||
    Object.keys(value).some((key) => key !== 'schemaVersion' && key !== 'type' && key !== bodyKey)
  ) throw new RuntimeFailure('protocol', 'Native checkpoint event is malformed');
}

function publicPath(workspace: string, candidate: string): string {
  const root = path.resolve(workspace);
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) throw new RuntimeFailure('protocol', 'Native checkpoint event path is outside the workspace');
  return relative.split(path.sep).join('/');
}

function safeTransition(workspace: string, value: unknown): CheckpointTransitionV1 {
  const transition = parseNativeCheckpointTransition(value);
  return { ...transition, path: publicPath(workspace, transition.path) };
}

function safeRecovery(workspace: string, value: unknown): CheckpointRecoveryV1 {
  const recovery = parseNativeCheckpointRecovery(value);
  return {
    ...recovery,
    path: publicPath(workspace, recovery.path),
    ...(recovery.state === 'uncertain'
      ? { reason: 'filesystem state could not be proven' }
      : {}),
  };
}

/**
 * Decode a native checkpoint receipt once, remove host paths and diagnostic
 * detail, then revalidate it against the public core event vocabulary.
 */
export function sanitizeNativeCheckpointEvent(
  value: NativeCheckpointEvent,
  workspace: string,
): CheckpointEventV1 {
  assertEventShape(value);
  switch (value.type) {
    case 'checkpoint.prepared':
    case 'rewind.prepared':
      return assertCheckpointEventV1({
        schemaVersion: 1,
        type: value.type,
        transition: safeTransition(workspace, value.transition),
      });
    case 'checkpoint.recovered':
    case 'rewind.completed':
      return assertCheckpointEventV1({
        schemaVersion: 1,
        type: value.type,
        recovery: safeRecovery(workspace, value.recovery),
      });
  }
}

export function projectNativeCheckpointRuntimeEvent(
  value: NativeCheckpointEvent,
  workspace: string,
): NativeCheckpointRuntimeEventProjection {
  const safe = sanitizeNativeCheckpointEvent(value, workspace);
  switch (safe.type) {
    case 'checkpoint.prepared':
      return { type: safe.type, payload: { schemaVersion: safe.schemaVersion, transition: safe.transition } };
    case 'checkpoint.recovered':
      return { type: safe.type, payload: { schemaVersion: safe.schemaVersion, recovery: safe.recovery } };
    case 'rewind.prepared':
      return { type: safe.type, payload: { schemaVersion: safe.schemaVersion, transition: safe.transition } };
    case 'rewind.completed':
      return { type: safe.type, payload: { schemaVersion: safe.schemaVersion, recovery: safe.recovery } };
  }
}
