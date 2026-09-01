import { createHash } from 'node:crypto';
import type { WorkerLedgerEntry, WorkerLedgerPort } from '@octocodeai/agent-core';
import type { WorkerSpawnPacket } from '@octocodeai/agent-core';
import type { NativeWorkerProcessIdentity } from './native-workers.js';
import {
  appendWorkerLifecycleEvent,
  closeOctocodeDb,
  agentDbPath,
  openOctocodeDb,
  type WorkerLifecycleJsonValue,
} from '@octocodeai/octocode-awareness/mcp-state';

const MAX_DURABLE_HANDBACK_BYTES = 4 * 1024 * 1024;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function boundedHandback(value: unknown): WorkerLifecycleJsonValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, WorkerLifecycleJsonValue> = {};
  let textBytes = 0;
  for (const key of ['summary', 'text'] as const) {
    const text = source[key];
    if (typeof text !== 'string') continue;
    textBytes += Buffer.byteLength(text);
    if (textBytes > MAX_DURABLE_HANDBACK_BYTES)
      throw new Error(`Worker handback exceeds ${MAX_DURABLE_HANDBACK_BYTES} durable bytes`);
    result[key] = text;
    result[`${key}Sha256`] = digest(text);
    result[`${key}Truncated`] = false;
  }
  for (const key of ['exitCode', 'signal', 'promptDigest', 'cacheKey'] as const) {
    const item = source[key];
    if (item === null || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) result[key] = item;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function durablePayload(entry: WorkerLedgerEntry): WorkerLifecycleJsonValue {
  switch (entry.type) {
    case 'worker.spawn':
      return {
        promptSha256: digest(entry.prompt),
        promptBytes: Buffer.byteLength(entry.prompt),
        promptSnapshotId: entry.promptSnapshotId,
        workspace: entry.workspace.mode === 'shared'
          ? { mode: 'shared' }
          : { mode: 'worktree', path: entry.workspace.path, baseRevision: entry.workspace.baseRevision },
        capabilities: {
          tools: [...entry.capabilities.tools],
          models: entry.capabilities.models.map((model) => ({ providerId: model.providerId, modelId: model.modelId })),
          maxTurns: entry.capabilities.maxTurns,
        },
      };
    case 'worker.send':
    case 'worker.steer':
    case 'worker.follow-up':
      return { textSha256: digest(entry.text), textBytes: Buffer.byteLength(entry.text) };
    case 'worker.state':
      return { state: entry.state };
    case 'worker.terminal': {
      const handback = boundedHandback(entry.handback);
      return {
        outcome: entry.outcome,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        ...(handback === undefined ? {} : { handback }),
      };
    }
  }
}

export interface NativeAwarenessWorkerLedgerOptions {
  readonly workspace: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

/** Persists the core worker ledger in Awareness without storing raw prompts or queued input. */
export class NativeAwarenessWorkerLedger implements WorkerLedgerPort {
  readonly #workspace: string;
  readonly #dbPath: string;
  readonly #now: () => number;

  constructor(options: NativeAwarenessWorkerLedgerOptions) {
    this.#workspace = options.workspace;
    this.#dbPath = agentDbPath(options.env);
    this.#now = options.now ?? Date.now;
  }

  async append(entry: WorkerLedgerEntry): Promise<void> {
    const db = openOctocodeDb(this.#dbPath);
    try {
      appendWorkerLifecycleEvent(db, {
        packetId: entry.packetId,
        workspace: this.#workspace,
        sessionId: entry.sessionId,
        workerId: entry.workerId,
        correlationId: entry.correlationId,
        type: entry.type,
        redaction: entry.redaction,
        createdAt: new Date(this.#now()).toISOString(),
        payload: durablePayload(entry),
      });
    } finally {
      closeOctocodeDb(this.#dbPath);
    }
  }

  async recordProcess(entry: WorkerSpawnPacket, identity: NativeWorkerProcessIdentity): Promise<void> {
    const db = openOctocodeDb(this.#dbPath);
    try {
      appendWorkerLifecycleEvent(db, {
        packetId: `process:${entry.packetId}`,
        workspace: this.#workspace,
        sessionId: entry.sessionId,
        workerId: entry.workerId,
        correlationId: entry.correlationId,
        type: 'worker.process',
        redaction: 'internal',
        createdAt: new Date(this.#now()).toISOString(),
        payload: {
          pid: identity.pid,
          startToken: identity.startToken,
          commandSha256: identity.commandSha256,
          ownershipTokenSha256: identity.ownershipTokenSha256,
          verification: identity.verification,
        },
      });
    } finally {
      closeOctocodeDb(this.#dbPath);
    }
  }
}
