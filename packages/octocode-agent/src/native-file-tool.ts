import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RuntimeFailure, createEffectSet, jsonSchemaError, type JsonSchema, type ToolDefinition, type ToolRegistry } from '@octocodeai/agent-core';
import {
  checkpointAttemptId,
  executeCheckpointedDelete,
  executeCheckpointedReplace,
  isNativeCheckpointFileSystemPort,
  type NativeCheckpointEventSink,
  type NativeCheckpointFileSystemPort,
} from './native-checkpoints.js';

export interface NativeFileToolOptions {
  readonly workspace: string;
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
  readonly fileSystem: NativeFileSystemPort;
  /** Opt-in journal path. Production callers must supply the Rust checkpoint port. */
  readonly checkpoints?: { readonly onEvent?: NativeCheckpointEventSink };
  /** Testable commit boundary; production callers should leave this unset. */
  readonly beforeCommit?: (operation: 'write' | 'edit' | 'delete', file: string, signal: AbortSignal) => Promise<void>;
}

export interface NativeFileSnapshot {
  readonly path: string;
  readonly content: string;
  readonly validUtf8: boolean;
  readonly bytes: number;
  readonly sha256: string;
}

export interface NativeFileBinarySnapshot {
  readonly path: string;
  readonly contentBase64: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface NativeFileReplaceInput {
  readonly path: string;
  readonly content: string;
  readonly expectedSha256: string | null;
  readonly maxBytes: number;
}

export interface NativeFileReplaceResult {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly previousSha256: string | null;
}

export interface NativeFileDeleteResult {
  readonly path: string;
  readonly previousSha256: string;
}

export interface NativeExternalPathAuthorization {
  readonly path: string;
  readonly hostPath: string;
  readonly kind: 'input' | 'output';
}

/** Renderer-neutral filesystem execution boundary. Tool policy and edit semantics stay in TypeScript. */
export interface NativeFileSystemPort {
  authorizeExternalPath(path: string, kind: 'input' | 'output', signal: AbortSignal): Promise<NativeExternalPathAuthorization>;
  readBinary(path: string, maxBytes: number, signal: AbortSignal): Promise<NativeFileBinarySnapshot | null>;
  snapshot(path: string, maxBytes: number, signal: AbortSignal): Promise<NativeFileSnapshot | null>;
  replace(input: NativeFileReplaceInput, signal: AbortSignal): Promise<NativeFileReplaceResult>;
  delete(path: string, expectedSha256: string, maxBytes: number, signal: AbortSignal): Promise<NativeFileDeleteResult>;
}

type ReadOperation = { readonly operation: 'read'; readonly path: string };
type WriteOperation = {
  readonly operation: 'write';
  readonly path: string;
  readonly content: string;
  readonly expectedSha256: string | null;
};
type EditOperation = {
  readonly operation: 'edit';
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly expectedSha256: string;
  readonly replaceAll?: boolean;
};
type DeleteOperation = {
  readonly operation: 'delete';
  readonly path: string;
  readonly expectedSha256: string;
};
type FileOperation = ReadOperation | WriteOperation | EditOperation | DeleteOperation;

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_CONFIGURED_BYTES = 10 * 1024 * 1024;
const SHA256_SCHEMA: JsonSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const PATH_SCHEMA: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 4096,
};
const CONTENT_SCHEMA: JsonSchema = {
  type: 'string',
  maxLength: MAX_CONFIGURED_BYTES,
};

const readSchema: JsonSchema = {
  type: 'object',
  properties: { operation: { const: 'read' }, path: PATH_SCHEMA },
  required: ['operation', 'path'],
  additionalProperties: false,
};
const writeSchema: JsonSchema = {
  type: 'object',
  properties: {
    operation: { const: 'write' },
    path: PATH_SCHEMA,
    content: CONTENT_SCHEMA,
    expectedSha256: { anyOf: [SHA256_SCHEMA, { type: 'null' }] },
  },
  required: ['operation', 'path', 'content', 'expectedSha256'],
  additionalProperties: false,
};
const editSchema: JsonSchema = {
  type: 'object',
  properties: {
    operation: { const: 'edit' },
    path: PATH_SCHEMA,
    oldText: { ...CONTENT_SCHEMA, minLength: 1 },
    newText: CONTENT_SCHEMA,
    expectedSha256: SHA256_SCHEMA,
    replaceAll: { type: 'boolean' },
  },
  required: ['operation', 'path', 'oldText', 'newText', 'expectedSha256'],
  additionalProperties: false,
};
const deleteSchema: JsonSchema = {
  type: 'object',
  properties: {
    operation: { const: 'delete' },
    path: PATH_SCHEMA,
    expectedSha256: SHA256_SCHEMA,
  },
  required: ['operation', 'path', 'expectedSha256'],
  additionalProperties: false,
};

export const NATIVE_FILE_INPUT_SCHEMA: JsonSchema = {
  oneOf: [readSchema, writeSchema, editSchema, deleteSchema],
};

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new RuntimeFailure('cancelled', 'File operation cancelled');
}

function bounded(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= MAX_CONFIGURED_BYTES ? value! : DEFAULT_MAX_BYTES;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveContained(root: string, requested: string): Promise<string> {
  const lexical = path.resolve(root, requested);
  if (!contained(root, lexical) || lexical === root) throw new RuntimeFailure('validation', 'File path must stay within the workspace');
  const parts = path.relative(root, lexical).split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (index !== parts.length - 1) throw new RuntimeFailure('validation', 'File parent directory does not exist');
        return current;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new RuntimeFailure('validation', 'File path cannot traverse a symbolic link');
    if (index !== parts.length - 1 && !stat.isDirectory()) throw new RuntimeFailure('validation', 'File parent path must be a directory');
  }
  const physical = await fs.realpath(current);
  if (!contained(root, physical)) throw new RuntimeFailure('validation', 'File path must stay within the workspace');
  return physical;
}

interface Snapshot {
  readonly bytes: Buffer;
  readonly sha256: string;
}

async function snapshot(file: string, maximum: number, signal: AbortSignal): Promise<Snapshot | null> {
  cancelled(signal);
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new RuntimeFailure('validation', 'File path must identify a regular file');
    if (stat.size > maximum) throw new RuntimeFailure('validation', `File exceeds maximum ${maximum} bytes`);
    const bytes = await handle.readFile();
    cancelled(signal);
    if (bytes.byteLength > maximum) throw new RuntimeFailure('validation', `File exceeds maximum ${maximum} bytes`);
    return { bytes, sha256: digest(bytes) };
  } finally {
    await handle.close();
  }
}

function assertPrecondition(current: { readonly sha256: string } | null, expected: string | null): void {
  if (expected === null) {
    if (current !== null) throw new RuntimeFailure('validation', 'File create precondition failed: target already exists');
    return;
  }
  if (current === null) throw new RuntimeFailure('validation', 'File precondition failed: target does not exist');
  if (current.sha256 !== expected) throw new RuntimeFailure('validation', 'File precondition is stale');
}

async function assertUnchanged(file: string, prior: Snapshot | null, maximum: number, signal: AbortSignal): Promise<void> {
  const current = await snapshot(file, maximum, signal);
  if (current?.sha256 !== prior?.sha256) throw new RuntimeFailure('validation', 'File changed before commit; retry with a fresh snapshot');
}

async function atomicWrite(file: string, bytes: Buffer, prior: Snapshot | null, maximum: number, signal: AbortSignal): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.octocode-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    cancelled(signal);
    await assertUnchanged(file, prior, maximum, signal);
    await fs.rename(temporary, file);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function displayPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export function createNodeNativeFileSystemPort(workspaceInput: string): NativeFileSystemPort {
  const workspace = fsSync.realpathSync(path.resolve(workspaceInput));
  if (!fsSync.statSync(workspace).isDirectory()) throw new RuntimeFailure('validation', 'File workspace must be a directory');
  return {
    async authorizeExternalPath(requested, kind, signal) {
      cancelled(signal);
      const file = await resolveContained(workspace, requested);
      let stat;
      try {
        stat = await fs.lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (kind === 'input' && stat === undefined) throw new RuntimeFailure('validation', 'Input file does not exist');
      if (stat?.isSymbolicLink()) throw new RuntimeFailure('validation', 'File path cannot traverse a symbolic link');
      if (stat !== undefined && !stat.isFile()) throw new RuntimeFailure('validation', 'File path must identify a regular file');
      cancelled(signal);
      return { path: displayPath(workspace, file), hostPath: file, kind };
    },
    async readBinary(requested, maximum, signal) {
      const file = await resolveContained(workspace, requested);
      const current = await snapshot(file, maximum, signal);
      if (current === null) return null;
      return {
        path: displayPath(workspace, file),
        contentBase64: current.bytes.toString('base64'),
        bytes: current.bytes.byteLength,
        sha256: current.sha256,
      };
    },
    async snapshot(requested, maximum, signal) {
      const file = await resolveContained(workspace, requested);
      const current = await snapshot(file, maximum, signal);
      if (current === null) return null;
      const content = current.bytes.toString('utf8');
      return {
        path: displayPath(workspace, file),
        content,
        validUtf8: Buffer.from(content, 'utf8').equals(current.bytes),
        bytes: current.bytes.byteLength,
        sha256: current.sha256,
      };
    },
    async replace(input, signal) {
      const file = await resolveContained(workspace, input.path);
      const current = await snapshot(file, input.maxBytes, signal);
      assertPrecondition(current, input.expectedSha256);
      const next = Buffer.from(input.content, 'utf8');
      if (next.byteLength > input.maxBytes) throw new RuntimeFailure('validation', `File exceeds maximum ${input.maxBytes} bytes`);
      await atomicWrite(file, next, current, input.maxBytes, signal);
      return {
        path: displayPath(workspace, file),
        bytes: next.byteLength,
        sha256: digest(next),
        previousSha256: current?.sha256 ?? null,
      };
    },
    async delete(requested, expectedSha256, maximum, signal) {
      const file = await resolveContained(workspace, requested);
      const current = await snapshot(file, maximum, signal);
      assertPrecondition(current, expectedSha256);
      cancelled(signal);
      await assertUnchanged(file, current, maximum, signal);
      await fs.unlink(file);
      return {
        path: displayPath(workspace, file),
        previousSha256: current!.sha256,
      };
    },
  };
}

export function createNativeFileTool(options: NativeFileToolOptions): ToolDefinition {
  const workspace = fsSync.realpathSync(path.resolve(options.workspace));
  if (!fsSync.statSync(workspace).isDirectory()) throw new RuntimeFailure('validation', 'File workspace must be a directory');
  const maxReadBytes = bounded(options.maxReadBytes);
  const maxWriteBytes = bounded(options.maxWriteBytes);
  const fileSystem = options.fileSystem;
  const checkpointFileSystem: NativeCheckpointFileSystemPort | undefined = options.checkpoints
    ? isNativeCheckpointFileSystemPort(fileSystem)
      ? fileSystem
      : (() => {
          throw new RuntimeFailure('validation', 'Checkpointed file mutations require the Rust checkpoint filesystem port');
        })()
    : undefined;
  return {
    name: 'file',
    label: 'File',
    description: 'Read or atomically mutate workspace files with explicit SHA-256 preconditions and symlink-safe containment.',
    schemaVersion: 1,
    inputSchema: NATIVE_FILE_INPUT_SCHEMA,
    outputSchema: { type: 'object' },
    outputVersion: 1,
    policy: {
      effects: createEffectSet('write', 'destructive'),
      trust: 'workspace',
      approval: 'always',
      plan: 'allowed',
      resolve(input) {
        const operation = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as { operation?: unknown }).operation : undefined;
        if (operation === 'read')
          return {
            effects: createEffectSet('read'),
            trust: 'none',
            approval: 'never',
          };
        if (operation === 'write' || operation === 'edit')
          return {
            effects: createEffectSet('write'),
            trust: 'workspace',
            approval: 'on-request',
          };
        if (operation === 'delete')
          return {
            effects: createEffectSet('write', 'destructive'),
            trust: 'workspace',
            approval: 'on-request',
          };
        return {
          effects: createEffectSet('write', 'destructive'),
          trust: 'workspace',
          approval: 'always',
        };
      },
      concurrency(input) {
        const operation = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as { operation?: unknown }).operation : undefined;
        return operation === 'read' ? { lane: 'native-file-read', maxActive: 4 } : { lane: 'native-file-mutate', maxActive: 1 };
      },
      lockTarget(input) {
        if (typeof input !== 'object' || input === null || Array.isArray(input)) return [];
        const candidate = input as { operation?: unknown; path?: unknown };
        if (candidate.operation === 'read' || typeof candidate.path !== 'string') return [];
        const target = path.resolve(workspace, candidate.path);
        return target !== workspace && contained(workspace, target) ? [target] : [];
      },
    },
    async execute(request) {
      const invalid = jsonSchemaError(request.input, NATIVE_FILE_INPUT_SCHEMA);
      if (invalid) throw new RuntimeFailure('validation', invalid);
      cancelled(request.signal);
      const operation = request.input as FileOperation;
      if (operation.operation === 'read') {
        const current = await fileSystem.snapshot(operation.path, maxReadBytes, request.signal);
        if (current === null) throw new RuntimeFailure('validation', 'File does not exist');
        return {
          ok: true,
          content: {
            operation: 'read',
            path: current.path,
            content: current.content,
            bytes: current.bytes,
            sha256: current.sha256,
          },
          detailsVersion: 1,
        };
      }

      const current = await fileSystem.snapshot(operation.path, maxWriteBytes, request.signal);
      assertPrecondition(current, operation.expectedSha256);
      if (operation.operation === 'delete') {
        await options.beforeCommit?.('delete', path.resolve(workspace, operation.path), request.signal);
        cancelled(request.signal);
        if (checkpointFileSystem) {
          const checkpointId = checkpointAttemptId(
            'checkpoint',
            String(request.context.sessionId),
            String(request.callId),
            operation.path,
          );
          const { transition } = await executeCheckpointedDelete(
            checkpointFileSystem,
            {
              checkpointId,
              path: operation.path,
              expectedSha256: operation.expectedSha256,
              maxBytes: maxWriteBytes,
            },
            request.signal,
            options.checkpoints?.onEvent,
          );
          return {
            ok: true,
            content: {
              operation: 'delete',
              path: transition.path,
              previousSha256: operation.expectedSha256,
              checkpointId,
              journalSha256: transition.journalSha256,
            },
            detailsVersion: 1,
          };
        }
        const removed = await fileSystem.delete(
          operation.path,
          operation.expectedSha256,
          maxWriteBytes,
          request.signal,
        );
        return {
          ok: true,
          content: {
            operation: 'delete',
            path: removed.path,
            previousSha256: removed.previousSha256,
          },
          detailsVersion: 1,
        };
      }

      let next: string;
      if (operation.operation === 'write') {
        next = operation.content;
      } else {
        if (!current!.validUtf8) throw new RuntimeFailure('validation', 'File edit requires valid UTF-8 text');
        const original = current!.content;
        const first = original.indexOf(operation.oldText);
        if (first < 0) throw new RuntimeFailure('validation', 'File edit oldText was not found');
        if (!operation.replaceAll && original.indexOf(operation.oldText, first + operation.oldText.length) >= 0) throw new RuntimeFailure('validation', 'File edit oldText is ambiguous; use replaceAll');
        next = operation.replaceAll ? original.split(operation.oldText).join(operation.newText) : `${original.slice(0, first)}${operation.newText}${original.slice(first + operation.oldText.length)}`;
      }
      if (Buffer.byteLength(next) > maxWriteBytes) throw new RuntimeFailure('validation', `File exceeds maximum ${maxWriteBytes} bytes`);
      await options.beforeCommit?.(operation.operation, path.resolve(workspace, operation.path), request.signal);
      cancelled(request.signal);
      if (checkpointFileSystem) {
        const checkpointId = checkpointAttemptId(
          'checkpoint',
          String(request.context.sessionId),
          String(request.callId),
          operation.path,
        );
        const { transition } = await executeCheckpointedReplace(
          checkpointFileSystem,
          {
            checkpointId,
            operation: operation.operation,
            path: operation.path,
            content: next,
            expectedSha256: operation.expectedSha256,
            maxBytes: maxWriteBytes,
          },
          request.signal,
          options.checkpoints?.onEvent,
        );
        const after = transition.after;
        if (after.kind !== 'present') throw new RuntimeFailure('protocol', 'Checkpoint replace returned an absent postimage');
        return {
          ok: true,
          content: {
            operation: operation.operation,
            path: transition.path,
            sha256: after.sha256,
            bytes: after.bytes,
            previousSha256: transition.before.kind === 'present' ? transition.before.sha256 : null,
            checkpointId,
            journalSha256: transition.journalSha256,
          },
          detailsVersion: 1,
        };
      }
      const committed = await fileSystem.replace(
        {
          path: operation.path,
          content: next,
          expectedSha256: operation.expectedSha256,
          maxBytes: maxWriteBytes,
        },
        request.signal,
      );
      return {
        ok: true,
          content: {
            operation: operation.operation,
            path: committed.path,
            sha256: committed.sha256,
            bytes: committed.bytes,
            previousSha256: committed.previousSha256,
        },
        detailsVersion: 1,
      };
    },
  };
}

export function registerNativeFileTool(registry: ToolRegistry, options: NativeFileToolOptions): ToolDefinition {
  const tool = createNativeFileTool(options);
  registry.register(tool, 'native-file');
  return tool;
}
