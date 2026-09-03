import { createHash } from 'node:crypto';
import type { WorkerAuthorityV1, WorkerLedgerEntry, WorkerLedgerPort } from '@octocodeai/agent-core';
import type { WorkerSpawnPacket } from '@octocodeai/agent-core';
import type { NativeWorkerProcessIdentity } from './native-workers.js';
import {
  appendWorkerLifecycleEvent,
  connectDb,
  resolveDbPath,
  type WorkerLifecycleJsonValue,
} from '@octocodeai/octocode-awareness';

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
  const authority = durableAuthority(entry.authority);
  switch (entry.type) {
    case 'worker.spawn':
      return { authority,
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
      return { authority, textSha256: digest(entry.text), textBytes: Buffer.byteLength(entry.text) };
    case 'worker.state':
      return { authority, state: entry.state };
    case 'worker.terminal': {
      const handback = boundedHandback(entry.handback);
      return { authority,
        outcome: entry.outcome,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        ...(handback === undefined ? {} : { handback }),
      };
    }
  }
}

function durableAuthority(authority: WorkerAuthorityV1): WorkerLifecycleJsonValue {
  return {
    schemaVersion: 1,
    workerId: authority.workerId,
    correlationId: authority.correlationId,
    rootAgentId: authority.rootAgentId,
    parentSessionId: authority.parentSessionId,
    workspaceId: authority.workspaceId,
    workspaceGeneration: authority.workspaceGeneration,
    trustRevision: authority.trustRevision,
    permissionMode: authority.permissionMode,
    capabilityDigest: authority.capabilityDigest,
    ...(authority.planId === undefined ? {} : { planId: authority.planId }),
    ...(authority.planRevision === undefined ? {} : { planRevision: authority.planRevision }),
    ...(authority.planStepId === undefined ? {} : { planStepId: authority.planStepId }),
    effectAdmissionId: authority.effectAdmissionId,
    ownershipGeneration: authority.ownershipGeneration,
    digest: digest(JSON.stringify(authority)),
  };
}

export interface NativeAwarenessWorkerLedgerOptions {
  readonly workspace: string;
  readonly now?: () => number;
}

/** Publishes a redacted Awareness projection; Rust remains the authoritative worker store. */
export class NativeAwarenessWorkerLedger implements WorkerLedgerPort {
  readonly #workspace: string;
  readonly #dbPath: string;
  readonly #now: () => number;

  constructor(options: NativeAwarenessWorkerLedgerOptions) {
    this.#workspace = options.workspace;
    this.#dbPath = resolveDbPath(undefined, { scope: 'repo', workspace: options.workspace });
    this.#now = options.now ?? Date.now;
  }

  async append(entry: WorkerLedgerEntry): Promise<void> {
    const db = connectDb(this.#dbPath);
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
      db.close();
    }
  }

  async recordProcess(entry: WorkerSpawnPacket, identity: NativeWorkerProcessIdentity): Promise<void> {
    const db = connectDb(this.#dbPath);
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
          schemaVersion: identity.schemaVersion,
          kind: identity.kind,
          pid: identity.pid,
          processGroupId: identity.processGroupId,
          generation: identity.generation,
          startToken: identity.startToken,
          commandSha256: identity.commandSha256,
          ownershipTokenSha256: identity.ownershipTokenSha256,
          verification: identity.verification,
        },
      });
    } finally {
      db.close();
    }
  }
}
