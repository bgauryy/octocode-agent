import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';

import {
  RuntimeFailure,
  createEffectSet,
  jsonSchemaError,
  type JsonSchema,
  type ToolDefinition,
} from '@octocodeai/agent-core';

export type NativeCheckpointImage =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly sha256: string; readonly bytes: number; readonly mode: number };

export type NativeCheckpointTransition = {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly checkpointId: string;
  readonly attemptKind: 'mutation' | 'rewind';
  readonly operation: 'write' | 'edit' | 'delete' | 'rewind';
  readonly path: string;
  readonly before: NativeCheckpointImage;
  readonly after: NativeCheckpointImage;
  readonly journalSha256: string;
};

export type NativeCheckpointRecovery = {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly checkpointId: string;
  readonly attemptKind: 'mutation' | 'rewind';
  readonly path: string;
  readonly state: 'complete' | 'partial' | 'uncertain';
  readonly current: NativeCheckpointImage | { readonly kind: 'unknown' };
  readonly journalSha256: string;
  readonly reason?: string;
};

export interface NativeCheckpointReplaceInput {
  readonly checkpointId: string;
  readonly operation: 'write' | 'edit';
  readonly path: string;
  readonly content: string;
  readonly expectedSha256: string | null;
  readonly maxBytes: number;
}

export interface NativeCheckpointDeleteInput {
  readonly checkpointId: string;
  readonly path: string;
  readonly expectedSha256: string;
  readonly maxBytes: number;
}

export interface NativeRewindInput {
  readonly checkpointId: string;
  readonly rewindId: string;
  readonly path: string;
  readonly expectedPostimageSha256: string | null;
  readonly maxBytes: number;
}

/** Two-phase filesystem journal port. Preparation is durable before apply begins. */
export interface NativeCheckpointFileSystemPort {
  supportsCheckpoints(): boolean;
  prepareCheckpointReplace(input: NativeCheckpointReplaceInput, signal: AbortSignal): Promise<NativeCheckpointTransition>;
  prepareCheckpointDelete(input: NativeCheckpointDeleteInput, signal: AbortSignal): Promise<NativeCheckpointTransition>;
  prepareRewind(input: NativeRewindInput, signal: AbortSignal): Promise<NativeCheckpointTransition>;
  applyCheckpointAttempt(attemptId: string, maxBytes: number, signal: AbortSignal): Promise<NativeCheckpointRecovery>;
  recoverCheckpointAttempt(attemptId: string, maxBytes: number, signal: AbortSignal): Promise<NativeCheckpointRecovery>;
}

export type NativeCheckpointEvent =
  | { readonly schemaVersion: 1; readonly type: 'checkpoint.prepared'; readonly transition: NativeCheckpointTransition }
  | { readonly schemaVersion: 1; readonly type: 'checkpoint.recovered'; readonly recovery: NativeCheckpointRecovery }
  | { readonly schemaVersion: 1; readonly type: 'rewind.prepared'; readonly transition: NativeCheckpointTransition }
  | { readonly schemaVersion: 1; readonly type: 'rewind.completed'; readonly recovery: NativeCheckpointRecovery };

export type NativeCheckpointEventSink = (event: NativeCheckpointEvent) => void | Promise<void>;

const SHA256 = /^[a-f0-9]{64}$/u;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_BYTES = 10 * 1024 * 1024;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
};

const invalid = (field: string): never => {
  throw new RuntimeFailure('protocol', `Rust checkpoint ${field} is malformed`);
};

const digest = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);
const boundedString = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

function parseImage(value: unknown, observed = false): NativeCheckpointRecovery['current'] {
  const image = record(value) ? value : invalid('image');
  if (image.kind === 'unknown' && observed) {
    if (!exact(image, ['kind'])) invalid('image fields');
    return { kind: 'unknown' };
  }
  if (image.kind === 'absent') {
    if (!exact(image, ['kind'])) invalid('image fields');
    return { kind: 'absent' };
  }
  if (image.kind !== 'present' || !exact(image, ['kind', 'sha256', 'bytes', 'mode'])) invalid('image fields');
  if (!digest(image.sha256)) invalid('image sha256');
  if (!Number.isSafeInteger(image.bytes) || (image.bytes as number) < 0 || (image.bytes as number) > MAX_BYTES)
    invalid('image bytes');
  if (!Number.isSafeInteger(image.mode) || (image.mode as number) < 0 || (image.mode as number) > 0o7777)
    invalid('image mode');
  return image as unknown as NativeCheckpointImage;
}

export function parseNativeCheckpointTransition(value: unknown): NativeCheckpointTransition {
  const transition = record(value) ? value : invalid('transition');
  if (!exact(transition, [
    'schemaVersion',
    'attemptId',
    'checkpointId',
    'attemptKind',
    'operation',
    'path',
    'before',
    'after',
    'journalSha256',
  ])) invalid('transition fields');
  if (transition.schemaVersion !== 1) invalid('transition schemaVersion');
  if (!boundedString(transition.attemptId, 256)) invalid('transition attemptId');
  if (!boundedString(transition.checkpointId, 256)) invalid('transition checkpointId');
  if (!boundedString(transition.path, 4096)) invalid('transition path');
  if (!digest(transition.journalSha256)) invalid('transition journalSha256');
  if (transition.attemptKind !== 'mutation' && transition.attemptKind !== 'rewind') invalid('transition attemptKind');
  if (transition.operation !== 'write' && transition.operation !== 'edit' && transition.operation !== 'delete' && transition.operation !== 'rewind')
    invalid('transition operation');
  if (transition.attemptKind === 'mutation' && (transition.attemptId !== transition.checkpointId || transition.operation === 'rewind'))
    invalid('transition identity');
  if (transition.attemptKind === 'rewind' && transition.operation !== 'rewind') invalid('transition operation');
  parseImage(transition.before);
  const after = parseImage(transition.after);
  if (transition.operation === 'delete' && after.kind !== 'absent') invalid('transition after');
  return transition as unknown as NativeCheckpointTransition;
}

export function parseNativeCheckpointRecovery(value: unknown): NativeCheckpointRecovery {
  const recovery = record(value) ? value : invalid('recovery');
  if (!exact(
    recovery,
    ['schemaVersion', 'attemptId', 'checkpointId', 'attemptKind', 'path', 'state', 'current', 'journalSha256'],
    ['reason'],
  )) invalid('recovery fields');
  if (recovery.schemaVersion !== 1) invalid('recovery schemaVersion');
  if (!boundedString(recovery.attemptId, 256)) invalid('recovery attemptId');
  if (!boundedString(recovery.checkpointId, 256)) invalid('recovery checkpointId');
  if (recovery.attemptKind !== 'mutation' && recovery.attemptKind !== 'rewind') invalid('recovery attemptKind');
  if (!boundedString(recovery.path, 4096)) invalid('recovery path');
  if (recovery.state !== 'complete' && recovery.state !== 'partial' && recovery.state !== 'uncertain') invalid('recovery state');
  if (!digest(recovery.journalSha256)) invalid('recovery journalSha256');
  const current = parseImage(recovery.current, true);
  if (recovery.state === 'uncertain') {
    if (!boundedString(recovery.reason, 512)) invalid('recovery reason');
  } else {
    if ('reason' in recovery) invalid('recovery reason');
    if (current.kind === 'unknown') invalid('recovery current');
  }
  return recovery as unknown as NativeCheckpointRecovery;
}

export function isNativeCheckpointFileSystemPort(value: unknown): value is NativeCheckpointFileSystemPort {
  if (!record(value)) return false;
  const supports = value.supportsCheckpoints;
  return typeof supports === 'function' && [
    'prepareCheckpointReplace',
    'prepareCheckpointDelete',
    'prepareRewind',
    'applyCheckpointAttempt',
    'recoverCheckpointAttempt',
  ].every((method) => typeof value[method] === 'function') && supports.call(value) === true;
}

export function checkpointAttemptId(
  kind: 'checkpoint' | 'rewind',
  sessionId: string,
  callId: string,
  filePath: string,
): string {
  const sha256 = createHash('sha256')
    .update('octocode-checkpoint-v1\0')
    .update(kind)
    .update('\0')
    .update(sessionId)
    .update('\0')
    .update(callId)
    .update('\0')
    .update(filePath)
    .digest('hex');
  return `${kind}-${sha256}`;
}

async function emit(sink: NativeCheckpointEventSink | undefined, event: NativeCheckpointEvent): Promise<void> {
  await sink?.(event);
}

function sameImage(
  left: NativeCheckpointRecovery['current'],
  right: NativeCheckpointImage,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'absent' || (
    right.kind === 'present' &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes &&
    left.mode === right.mode
  );
}

function requireComplete(
  recovery: NativeCheckpointRecovery,
  kind: 'mutation' | 'rewind',
  transition: NativeCheckpointTransition,
): NativeCheckpointRecovery {
  if (recovery.state !== 'complete' || recovery.attemptKind !== kind)
    throw new RuntimeFailure('protocol', `Rust ${kind} apply did not return a complete recovery receipt`);
  if (
    recovery.attemptId !== transition.attemptId ||
    recovery.checkpointId !== transition.checkpointId ||
    recovery.path !== transition.path ||
    recovery.journalSha256 !== transition.journalSha256 ||
    !sameImage(recovery.current, transition.after)
  ) throw new RuntimeFailure('protocol', `Rust ${kind} recovery receipt does not match its prepared transition`);
  return recovery;
}

export async function executeCheckpointedReplace(
  fileSystem: NativeCheckpointFileSystemPort,
  input: NativeCheckpointReplaceInput,
  signal: AbortSignal,
  onEvent?: NativeCheckpointEventSink,
): Promise<{ readonly transition: NativeCheckpointTransition; readonly recovery: NativeCheckpointRecovery }> {
  const transition = await fileSystem.prepareCheckpointReplace(input, signal);
  await emit(onEvent, { schemaVersion: 1, type: 'checkpoint.prepared', transition });
  const recovery = requireComplete(
    await fileSystem.applyCheckpointAttempt(transition.attemptId, input.maxBytes, signal),
    'mutation',
    transition,
  );
  await emit(onEvent, { schemaVersion: 1, type: 'checkpoint.recovered', recovery });
  return { transition, recovery };
}

export async function executeCheckpointedDelete(
  fileSystem: NativeCheckpointFileSystemPort,
  input: NativeCheckpointDeleteInput,
  signal: AbortSignal,
  onEvent?: NativeCheckpointEventSink,
): Promise<{ readonly transition: NativeCheckpointTransition; readonly recovery: NativeCheckpointRecovery }> {
  const transition = await fileSystem.prepareCheckpointDelete(input, signal);
  await emit(onEvent, { schemaVersion: 1, type: 'checkpoint.prepared', transition });
  const recovery = requireComplete(
    await fileSystem.applyCheckpointAttempt(transition.attemptId, input.maxBytes, signal),
    'mutation',
    transition,
  );
  await emit(onEvent, { schemaVersion: 1, type: 'checkpoint.recovered', recovery });
  return { transition, recovery };
}

const SHA_SCHEMA: JsonSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const REWIND_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    checkpointId: { type: 'string', minLength: 1, maxLength: 256 },
    path: { type: 'string', minLength: 1, maxLength: 4096 },
    expectedPostimageSha256: { anyOf: [SHA_SCHEMA, { type: 'null' }] },
  },
  required: ['checkpointId', 'path', 'expectedPostimageSha256'],
  additionalProperties: false,
};

function bounded(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= MAX_BYTES ? value! : DEFAULT_MAX_BYTES;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export interface NativeRewindToolOptions {
  readonly workspace: string;
  readonly fileSystem: NativeCheckpointFileSystemPort;
  readonly maxWriteBytes?: number;
  readonly onEvent?: NativeCheckpointEventSink;
}

/** Registering this definition admits rewind as a new effect; it never rewrites the original effect. */
export function createNativeRewindTool(options: NativeRewindToolOptions): ToolDefinition {
  const workspace = fsSync.realpathSync(path.resolve(options.workspace));
  if (!fsSync.statSync(workspace).isDirectory()) throw new RuntimeFailure('validation', 'Rewind workspace must be a directory');
  const maximum = bounded(options.maxWriteBytes);
  return {
    name: 'rewind',
    label: 'Rewind',
    description: 'Restore one immutable Rust filesystem checkpoint as a distinct digest-fenced effect.',
    schemaVersion: 1,
    inputSchema: REWIND_INPUT_SCHEMA,
    outputSchema: { type: 'object' },
    outputVersion: 1,
    policy: {
      effects: createEffectSet('write', 'destructive'),
      trust: 'workspace',
      approval: 'always',
      plan: 'required',
      concurrency() {
        return { lane: 'native-file-mutate', maxActive: 1 };
      },
      lockTarget(input) {
        if (!record(input) || typeof input.path !== 'string') return [];
        const target = path.resolve(workspace, input.path);
        return contained(workspace, target) ? [target] : [];
      },
    },
    async execute(request) {
      const invalidInput = jsonSchemaError(request.input, REWIND_INPUT_SCHEMA);
      if (invalidInput) throw new RuntimeFailure('validation', invalidInput);
      const input = request.input as {
        readonly checkpointId: string;
        readonly path: string;
        readonly expectedPostimageSha256: string | null;
      };
      const rewindId = checkpointAttemptId(
        'rewind',
        String(request.context.sessionId),
        String(request.callId),
        input.path,
      );
      const transition = await options.fileSystem.prepareRewind(
        { ...input, rewindId, maxBytes: maximum },
        request.signal,
      );
      await emit(options.onEvent, { schemaVersion: 1, type: 'rewind.prepared', transition });
      const recovery = requireComplete(
        await options.fileSystem.applyCheckpointAttempt(transition.attemptId, maximum, request.signal),
        'rewind',
        transition,
      );
      await emit(options.onEvent, { schemaVersion: 1, type: 'rewind.completed', recovery });
      return {
        ok: true,
        content: {
          operation: 'rewind',
          checkpointId: transition.checkpointId,
          rewindId: transition.attemptId,
          path: transition.path,
          state: recovery.state,
          before: transition.before,
          after: transition.after,
          journalSha256: transition.journalSha256,
        },
        detailsVersion: 1,
      };
    },
  };
}
