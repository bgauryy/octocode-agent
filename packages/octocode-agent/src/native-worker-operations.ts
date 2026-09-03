import { randomUUID } from 'node:crypto';
import {
  packetId,
  type WorkerCommand,
  type WorkerController,
  type WorkerAuthorityV1,
  type WorkerPacket,
  type WorkerSnapshot,
  type WorkerState,
} from '@octocodeai/agent-core';
import {
  projectNativeWorkerInboxEntry,
  type NativeWorkerInboxSnapshot,
  type NativeWorkerPresentationMetadata,
} from './native-worker-operations-snapshot.js';

export type {
  NativeWorkerInboxAction,
  NativeWorkerInboxEntry,
  NativeWorkerInboxSnapshot,
  NativeWorkerPresentationMetadata,
} from './native-worker-operations-snapshot.js';

const MAX_ID_CHARS = 128;
const MAX_TEXT_CHARS = 8_192;
const MAX_REASON_CHARS = 512;
const MAX_WORKERS = 256;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const STATES: ReadonlySet<string> = new Set([
  'queued', 'starting', 'running', 'aborting', 'killing',
  'succeeded', 'failed', 'aborted', 'killed',
]);
const TERMINAL_STATES: ReadonlySet<WorkerState> = new Set(['succeeded', 'failed', 'aborted', 'killed']);

export type NativeWorkerOperationIntent =
  | { readonly type: 'refresh' }
  | { readonly type: 'inspect'; readonly expectedGeneration: number; readonly workerId: string }
  | { readonly type: 'send' | 'follow-up' | 'steer'; readonly expectedGeneration: number; readonly workerId: string; readonly text: string }
  | { readonly type: 'abort' | 'kill'; readonly expectedGeneration: number; readonly workerId: string; readonly reason?: string };

export interface NativeForceKillApprovalRequest {
  readonly workerId: string;
  readonly state: WorkerState;
  readonly consequence: 'Immediately terminate the worker; in-flight work may be left uncertain.';
}

export type NativeForceKillApproval = (request: NativeForceKillApprovalRequest) => Promise<boolean>;

export class NativeWorkerOperationsError extends Error {
  constructor(
    readonly category:
      | 'invalid-input'
      | 'not-open'
      | 'not-found'
      | 'stale-generation'
      | 'invalid-state'
      | 'approval-required'
      | 'approval-denied'
      | 'worker-operation',
    message: string,
  ) {
    super(message);
    this.name = 'NativeWorkerOperationsError';
  }
}

interface PrivateWorkerBinding {
  readonly snapshot: WorkerSnapshot;
  readonly authority: WorkerAuthorityV1;
  readonly presentation?: NativeWorkerPresentationMetadata;
}

export interface NativeWorkerOperationsOptions {
  readonly controller: WorkerController;
  readonly approveForceKill?: NativeForceKillApproval;
  readonly presentationFor?: (workerId: string) => NativeWorkerPresentationMetadata | undefined;
  /** Host-private authority lookup; authority is never reconstructed from the safe snapshot. */
  readonly authorityFor: (workerId: string) => WorkerAuthorityV1 | undefined;
  readonly idFactory?: () => string;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new NativeWorkerOperationsError('invalid-input', `${label} must be a bounded non-empty string`);
  }
  return value.trim();
}

function stableWorkerId(value: unknown): string {
  const id = boundedText(value, 'workerId', MAX_ID_CHARS);
  if (!WORKER_ID.test(id)) throw new NativeWorkerOperationsError('invalid-input', 'workerId must be a stable worker ID');
  return id;
}

function expectedGeneration(value: unknown, current: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new NativeWorkerOperationsError('invalid-input', 'expectedGeneration must be a non-negative safe integer');
  }
  if (value !== current) {
    throw new NativeWorkerOperationsError(
      'stale-generation',
      `Worker inbox generation ${String(value)} is stale; current generation is ${current}. Refresh before acting.`,
    );
  }
  return value as number;
}

function normalizeSnapshot(value: unknown): WorkerSnapshot {
  if (!isRecord(value)) throw new NativeWorkerOperationsError('worker-operation', 'Worker controller returned an invalid snapshot');
  stableWorkerId(value.workerId);
  if (typeof value.correlationId !== 'string' || typeof value.sessionId !== 'string') {
    throw new NativeWorkerOperationsError('worker-operation', 'Worker snapshot is missing its private routing identity');
  }
  if (!STATES.has(String(value.state))) throw new NativeWorkerOperationsError('worker-operation', 'Worker snapshot state is invalid');
  if (!Number.isSafeInteger(value.queueDepth) || (value.queueDepth as number) < 0) {
    throw new NativeWorkerOperationsError('worker-operation', 'Worker snapshot queue depth is invalid');
  }
  return value as unknown as WorkerSnapshot;
}

export class NativeWorkerOperationsController {
  readonly #controller: WorkerController;
  readonly #approveForceKill?: NativeForceKillApproval;
  readonly #presentationFor?: NativeWorkerOperationsOptions['presentationFor'];
  readonly #authorityFor: NativeWorkerOperationsOptions['authorityFor'];
  readonly #idFactory: () => string;
  readonly #now: () => number;
  readonly #bindings = new Map<string, PrivateWorkerBinding>();
  #generation = 0;
  #opened = false;
  #selectedWorkerId?: string;
  #snapshot: NativeWorkerInboxSnapshot = Object.freeze({
    authority: 'runtime',
    generation: 0,
    capturedAt: 0,
    workers: Object.freeze([]),
  });

  constructor(options: NativeWorkerOperationsOptions) {
    this.#controller = options.controller;
    this.#approveForceKill = options.approveForceKill;
    this.#presentationFor = options.presentationFor;
    this.#authorityFor = options.authorityFor;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? Date.now;
  }

  snapshot(): NativeWorkerInboxSnapshot {
    return this.#snapshot;
  }

  async open(): Promise<NativeWorkerInboxSnapshot> {
    this.#opened = true;
    return this.#refresh();
  }

  async dispatch(intent: NativeWorkerOperationIntent): Promise<NativeWorkerInboxSnapshot> {
    if (!this.#opened) throw new NativeWorkerOperationsError('not-open', 'Open the worker inbox before dispatching an operation');
    if (intent.type === 'refresh') return this.#refresh();
    expectedGeneration(intent.expectedGeneration, this.#generation);
    const id = stableWorkerId(intent.workerId);
    const binding = this.#bindings.get(id);
    if (binding === undefined) throw new NativeWorkerOperationsError('not-found', `Worker ${id} is not in the current inbox generation`);

    if (intent.type === 'inspect') {
      const value = await this.#execute({ type: 'status', workerId: binding.snapshot.workerId, authority: binding.authority });
      if (value === null) throw new NativeWorkerOperationsError('not-found', `Worker ${id} no longer exists`);
      const updated = this.#binding(normalizeSnapshot(value));
      this.#bindings.set(id, updated);
      this.#selectedWorkerId = id;
      return this.#publish();
    }

    if (TERMINAL_STATES.has(binding.snapshot.state)) {
      throw new NativeWorkerOperationsError('invalid-state', `Worker ${id} is already ${binding.snapshot.state}`);
    }

    if (intent.type === 'abort') {
      await this.#execute({
        type: 'abort',
        workerId: binding.snapshot.workerId,
        authority: binding.authority,
        ...(intent.reason === undefined ? {} : { reason: boundedText(intent.reason, 'reason', MAX_REASON_CHARS) }),
      });
      return this.#refresh();
    }

    if (intent.type === 'kill') {
      if (this.#approveForceKill === undefined) {
        throw new NativeWorkerOperationsError('approval-required', 'Force kill requires an explicit approval provider');
      }
      const approved = await this.#approveForceKill(Object.freeze({
        workerId: id,
        state: binding.snapshot.state,
        consequence: 'Immediately terminate the worker; in-flight work may be left uncertain.',
      }));
      if (!approved) throw new NativeWorkerOperationsError('approval-denied', `Force kill was not approved for worker ${id}`);
      await this.#execute({
        type: 'kill',
        workerId: binding.snapshot.workerId,
        authority: binding.authority,
        ...(intent.reason === undefined ? {} : { reason: boundedText(intent.reason, 'reason', MAX_REASON_CHARS) }),
      });
      return this.#refresh();
    }

    if (intent.type !== 'send' && intent.type !== 'follow-up' && intent.type !== 'steer') {
      throw new NativeWorkerOperationsError('invalid-input', `Unsupported worker operation ${String((intent as { type?: unknown }).type)}`);
    }
    const text = boundedText(intent.text, 'text', MAX_TEXT_CHARS);
    const packet: WorkerPacket = {
      schemaVersion: 1,
      packetId: packetId(this.#idFactory()),
      workerId: binding.snapshot.workerId,
      correlationId: binding.snapshot.correlationId,
      sessionId: binding.snapshot.sessionId,
      redaction: 'internal',
      authority: binding.authority,
      type: `worker.${intent.type}`,
      text,
    };
    await this.#execute({ type: intent.type, packet });
    return this.#refresh();
  }

  async #refresh(): Promise<NativeWorkerInboxSnapshot> {
    const raw = await this.#execute({ type: 'list' });
    if (!Array.isArray(raw) || raw.length > MAX_WORKERS) {
      throw new NativeWorkerOperationsError('worker-operation', 'Worker controller returned an invalid or oversized list');
    }
    const next = new Map<string, PrivateWorkerBinding>();
    for (const value of raw) {
      const snapshot = normalizeSnapshot(value);
      const id = String(snapshot.workerId);
      if (next.has(id)) throw new NativeWorkerOperationsError('worker-operation', `Worker controller returned duplicate ID ${id}`);
      next.set(id, this.#binding(snapshot));
    }
    this.#bindings.clear();
    for (const [id, binding] of next) this.#bindings.set(id, binding);
    if (this.#selectedWorkerId !== undefined && !this.#bindings.has(this.#selectedWorkerId)) this.#selectedWorkerId = undefined;
    return this.#publish();
  }

  #binding(snapshot: WorkerSnapshot): PrivateWorkerBinding {
    const authority = this.#authorityFor(String(snapshot.workerId));
    if (
      authority === undefined ||
      authority.workerId !== snapshot.workerId ||
      authority.correlationId !== snapshot.correlationId ||
      authority.parentSessionId !== snapshot.sessionId
    )
      throw new NativeWorkerOperationsError('worker-operation', 'Worker authority is unavailable or stale');
    const presentation = this.#presentationFor?.(String(snapshot.workerId));
    return Object.freeze({
      snapshot,
      authority,
      ...(presentation === undefined ? {} : { presentation: Object.freeze({ ...presentation }) }),
    });
  }

  #publish(): NativeWorkerInboxSnapshot {
    this.#generation += 1;
    const workers = [...this.#bindings.values()]
      .map((binding) => projectNativeWorkerInboxEntry(binding.snapshot, binding.presentation))
      .sort((left, right) => left.workerId.localeCompare(right.workerId));
    this.#snapshot = Object.freeze({
      authority: 'runtime',
      generation: this.#generation,
      capturedAt: this.#now(),
      ...(this.#selectedWorkerId === undefined ? {} : { selectedWorkerId: this.#selectedWorkerId }),
      workers: Object.freeze(workers),
    });
    return this.#snapshot;
  }

  async #execute(command: WorkerCommand): Promise<unknown> {
    try {
      return await this.#controller.execute(command);
    } catch (error) {
      if (error instanceof NativeWorkerOperationsError) throw error;
      throw new NativeWorkerOperationsError(
        'worker-operation',
        'Worker operation failed; refresh the inbox before retrying.',
      );
    }
  }
}
