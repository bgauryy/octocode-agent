import { createHash } from "node:crypto";
import {
  RuntimeFailure,
  type WorkerAuthorityV1,
} from "@octocodeai/agent-core";
import type {
  NativeRustCoreObject,
  NativeRustWorkerHandoffAckInput,
  NativeRustWorkerHandoffGenerationInput,
  NativeRustWorkerHandoffKey,
  NativeRustWorkerHandoffMutationResult,
  NativeRustWorkerHandoffOpenInput,
  NativeRustWorkerHandoffSettleInput,
  NativeRustWorkerHandoffTransitionInput,
  NativeRustWorkerWorktreeGetResult,
  NativeRustWorkerWorktreeKey,
  NativeRustWorkerWorktreeMutationResult,
  NativeRustWorkerWorktreeReserveInput,
  NativeRustWorkerWorktreeTransitionInput,
} from "./native-rust-core.js";
import {
  nativeWorkerAuthorityDigest,
  type NativeWorkerWorktreeRecordV1,
  type NativeWorkerWorktreeState,
  type NativeWorkerWorktreeStore,
} from "./native-worker-worktrees.js";
import type {
  NativeWorkerHandoffReceiptV1,
  NativeWorkerHandoffRecordV1,
  NativeWorkerHandoffState,
  NativeWorkerHandoffStore,
} from "./native-worker-handoff.js";

export interface NativeRustWorkerLifecycleClient {
  workerWorktreeReserve(input: NativeRustWorkerWorktreeReserveInput, signal?: AbortSignal): Promise<NativeRustWorkerWorktreeMutationResult>;
  workerWorktreeGet(input: NativeRustWorkerWorktreeKey, signal?: AbortSignal): Promise<NativeRustWorkerWorktreeGetResult>;
  workerWorktreeTransition(input: NativeRustWorkerWorktreeTransitionInput, signal?: AbortSignal): Promise<NativeRustWorkerWorktreeMutationResult>;
  workerHandoffOpen(input: NativeRustWorkerHandoffOpenInput, signal?: AbortSignal): Promise<NativeRustWorkerHandoffMutationResult>;
  workerHandoffSeal(input: NativeRustWorkerHandoffGenerationInput, signal?: AbortSignal): Promise<NativeRustWorkerHandoffMutationResult>;
  workerHandoffTransition(input: NativeRustWorkerHandoffTransitionInput, signal?: AbortSignal): Promise<NativeRustWorkerHandoffMutationResult>;
  workerHandoffSettle(input: NativeRustWorkerHandoffSettleInput, signal?: AbortSignal): Promise<NativeRustWorkerHandoffMutationResult>;
  workerHandoffAck(input: NativeRustWorkerHandoffAckInput, signal?: AbortSignal): Promise<NativeRustWorkerHandoffMutationResult>;
}

const WORKTREE_STATES = new Set<NativeWorkerWorktreeState>([
  "requested", "preparing", "active", "ready-to-integrate", "integrating",
  "integrated", "conflict-retained", "retained", "discarding", "discarded",
  "recovery-needed",
]);
const HANDOFF_STATES = new Set<NativeWorkerHandoffState>([
  "open", "sealing", "draining", "terminalizing", "handed-off", "uncertain",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function lifecycleTimestamp(authorityDigest: string, identity: string, phase: string): number {
  return Number.parseInt(sha256(`${authorityDigest}\0${identity}\0${phase}`).slice(0, 13), 16);
}

function rustAuthority(authority: WorkerAuthorityV1): NativeRustCoreObject {
  return {
    schemaVersion: 1,
    workerId: String(authority.workerId),
    correlationId: String(authority.correlationId),
    rootAgentId: authority.rootAgentId,
    parentSessionId: String(authority.parentSessionId),
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
  };
}

function assertOwnership(
  authority: WorkerAuthorityV1,
  authorityDigest: string,
  generation: number,
): void {
  if (
    authorityDigest !== nativeWorkerAuthorityDigest(authority) ||
    generation !== authority.ownershipGeneration
  ) {
    throw new RuntimeFailure("conflict", "Worker lifecycle authority or generation is stale");
  }
}

function stringField(value: NativeRustCoreObject, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0)
    throw new RuntimeFailure("persistence", `Rust worker lifecycle ${key} is malformed`);
  return result;
}

function integerField(value: NativeRustCoreObject, key: string): number {
  const result = value[key];
  if (!Number.isSafeInteger(result) || Number(result) < 0)
    throw new RuntimeFailure("persistence", `Rust worker lifecycle ${key} is malformed`);
  return Number(result);
}

function worktreeKey(authority: WorkerAuthorityV1, authorityDigest: string): NativeRustWorkerWorktreeKey {
  return {
    authority: rustAuthority(authority),
    authorityDigest,
    worktreeGeneration: authority.ownershipGeneration,
  };
}

function decodeWorktree(
  value: NativeRustWorkerWorktreeGetResult,
  authority: WorkerAuthorityV1,
  authorityDigest: string,
): NativeWorkerWorktreeRecordV1 | undefined {
  if (value === null) return undefined;
  const state = stringField(value, "state") as NativeWorkerWorktreeState;
  if (!WORKTREE_STATES.has(state))
    throw new RuntimeFailure("persistence", "Rust worker worktree state is malformed");
  const generation = integerField(value, "worktreeGeneration");
  assertOwnership(authority, authorityDigest, generation);
  const clean = value["lastCleanStatusDigest"];
  if (clean !== null && typeof clean !== "string")
    throw new RuntimeFailure("persistence", "Rust worker clean-status digest is malformed");
  return Object.freeze({
    schemaVersion: 1,
    authorityDigest,
    workspaceId: authority.workspaceId,
    sessionId: String(authority.parentSessionId),
    workerId: String(authority.workerId),
    repositoryRoot: stringField(value, "repositoryId"),
    commonDir: stringField(value, "commonDirId"),
    path: stringField(value, "generatedPath"),
    baseOid: stringField(value, "baseOid"),
    headOid: stringField(value, "currentHeadOid"),
    privateRef: stringField(value, "privateRef"),
    gitWorktreeId: stringField(value, "gitWorktreeId"),
    lockReasonDigest: stringField(value, "lockTokenDigest"),
    generation,
    state,
    ...(clean === null ? {} : { cleanStatusDigest: clean }),
  });
}

/** Strict adapter from the native worktree store to Rust's fenced lifecycle rows. */
export class NativeRustWorkerWorktreeStore implements NativeWorkerWorktreeStore {
  readonly #client: NativeRustWorkerLifecycleClient;

  constructor(client: NativeRustWorkerLifecycleClient) {
    this.#client = client;
  }

  async reserve(record: NativeWorkerWorktreeRecordV1, authority: WorkerAuthorityV1): Promise<NativeWorkerWorktreeRecordV1> {
    assertOwnership(authority, record.authorityDigest, record.generation);
    if (
      record.workspaceId !== authority.workspaceId ||
      record.sessionId !== String(authority.parentSessionId) ||
      record.workerId !== String(authority.workerId) ||
      record.state !== "requested"
    ) throw new RuntimeFailure("conflict", "Worker worktree ownership record is inconsistent");
    await this.#client.workerWorktreeReserve({
      ...worktreeKey(authority, record.authorityDigest),
      repositoryId: record.repositoryRoot,
      commonDirId: record.commonDir,
      generatedPath: record.path,
      baseOid: record.baseOid,
      currentHeadOid: record.headOid,
      privateRef: record.privateRef,
      gitWorktreeId: record.gitWorktreeId,
      lockTokenDigest: record.lockReasonDigest,
      createdAt: lifecycleTimestamp(record.authorityDigest, String(record.generation), "worktree.reserve"),
    });
    const durable = await this.read(record.authorityDigest, authority);
    if (durable === undefined) throw new RuntimeFailure("persistence", "Reserved Rust worker worktree disappeared");
    return durable;
  }

  async transition(input: Parameters<NativeWorkerWorktreeStore["transition"]>[0]): Promise<NativeWorkerWorktreeRecordV1> {
    assertOwnership(input.authority, input.authorityDigest, input.generation);
    const current = await this.read(input.authorityDigest, input.authority);
    if (current === undefined) throw new RuntimeFailure("persistence", "Rust worker worktree does not exist");
    if (current.state === input.to) {
      if (
        (input.headOid !== undefined && input.headOid !== current.headOid) ||
        (input.cleanStatusDigest !== undefined && input.cleanStatusDigest !== current.cleanStatusDigest)
      ) throw new RuntimeFailure("conflict", "Worker worktree transition replay has different content");
      return current;
    }
    if (!input.from.includes(current.state))
      throw new RuntimeFailure("conflict", "Worker worktree state changed");
    await this.#client.workerWorktreeTransition({
      ...worktreeKey(input.authority, input.authorityDigest),
      expectedState: current.state,
      targetState: input.to,
      ...(input.headOid === undefined ? {} : { currentHeadOid: input.headOid }),
      ...(input.cleanStatusDigest === undefined ? {} : { lastCleanStatusDigest: input.cleanStatusDigest }),
      updatedAt: lifecycleTimestamp(input.authorityDigest, String(input.generation), `worktree.${current.state}.${input.to}`),
    });
    const durable = await this.read(input.authorityDigest, input.authority);
    if (durable === undefined || durable.state !== input.to)
      throw new RuntimeFailure("persistence", "Rust worker worktree transition was not committed");
    return durable;
  }

  async read(authorityDigest: string, authority: WorkerAuthorityV1): Promise<NativeWorkerWorktreeRecordV1 | undefined> {
    assertOwnership(authority, authorityDigest, authority.ownershipGeneration);
    return decodeWorktree(
      await this.#client.workerWorktreeGet(worktreeKey(authority, authorityDigest)),
      authority,
      authorityDigest,
    );
  }
}

interface HandoffSnapshot {
  readonly authority: WorkerAuthorityV1;
  readonly authorityDigest: string;
  readonly ownershipGeneration: number;
  readonly handoffId: string;
  state: NativeWorkerHandoffState;
  generation: number;
  receipt?: NativeWorkerHandoffReceiptV1;
  receiptDigest?: string;
  parentAcknowledged: boolean;
}

function handoffRecord(snapshot: HandoffSnapshot): NativeWorkerHandoffRecordV1 {
  return Object.freeze({
    schemaVersion: 1,
    handoffId: snapshot.handoffId,
    authorityDigest: snapshot.authorityDigest,
    ownershipGeneration: snapshot.ownershipGeneration,
    state: snapshot.state,
    ...(snapshot.receipt === undefined ? {} : { receipt: snapshot.receipt }),
    parentAcknowledged: snapshot.parentAcknowledged,
  });
}

/** Strict, phase-generation-aware adapter from native handoff semantics to Rust. */
export class NativeRustWorkerHandoffStore implements NativeWorkerHandoffStore {
  readonly #client: NativeRustWorkerLifecycleClient;
  readonly #snapshots = new Map<string, HandoffSnapshot>();

  constructor(client: NativeRustWorkerLifecycleClient) {
    this.#client = client;
  }

  async begin(input: Parameters<NativeWorkerHandoffStore["begin"]>[0]): Promise<NativeWorkerHandoffRecordV1> {
    this.#assertInput(input);
    const result = await this.#client.workerHandoffOpen({
      ...this.#key(input),
      createdAt: lifecycleTimestamp(input.authorityDigest, input.handoffId, "handoff.open"),
    });
    this.#assertHandoffResult(result, input.handoffId);
    const state = this.#state(result);
    const generation = this.#generation(result);
    const prior = this.#snapshots.get(input.handoffId);
    const snapshot: HandoffSnapshot = {
      authority: input.authority,
      authorityDigest: input.authorityDigest,
      ownershipGeneration: input.ownershipGeneration,
      handoffId: input.handoffId,
      state,
      generation,
      ...(prior?.receipt === undefined ? {} : { receipt: prior.receipt, receiptDigest: prior.receiptDigest }),
      parentAcknowledged: prior?.parentAcknowledged ?? false,
    };
    this.#snapshots.set(input.handoffId, snapshot);
    return handoffRecord(snapshot);
  }

  async transition(input: Parameters<NativeWorkerHandoffStore["transition"]>[0]): Promise<NativeWorkerHandoffRecordV1> {
    this.#assertInput(input);
    const snapshot = this.#requiredSnapshot(input.handoffId);
    if (snapshot.state === input.to) {
      if (input.receipt !== undefined && stableJson(input.receipt) !== stableJson(snapshot.receipt))
        throw new RuntimeFailure("conflict", "Worker handoff replay has different receipt content");
      return handoffRecord(snapshot);
    }
    if (!input.from.includes(snapshot.state))
      throw new RuntimeFailure("conflict", "Worker handoff state changed");
    const phase = `handoff.${snapshot.state}.${input.to}`;
    let result: NativeRustWorkerHandoffMutationResult;
    if (input.to === "sealing") {
      if (snapshot.state !== "open") throw new RuntimeFailure("conflict", "Worker handoff can only seal from open");
      result = await this.#client.workerHandoffSeal({
        ...this.#key(input),
        expectedGeneration: snapshot.generation,
        updatedAt: lifecycleTimestamp(input.authorityDigest, input.handoffId, phase),
      });
    } else if (input.to === "handed-off") {
      if (input.receipt === undefined)
        throw new RuntimeFailure("validation", "Worker handoff settlement requires a receipt");
      if (input.receipt.handoffId !== input.handoffId || input.receipt.authorityDigest !== input.authorityDigest)
        throw new RuntimeFailure("conflict", "Worker handoff receipt ownership is stale");
      const receiptDigest = sha256(stableJson(input.receipt));
      const outcome = { state: input.receipt.outcome } as NativeRustCoreObject;
      result = await this.#client.workerHandoffSettle({
        ...this.#key(input),
        expectedGeneration: snapshot.generation,
        outcome,
        outcomeDigest: sha256(stableJson(outcome)),
        receipt: input.receipt as unknown as NativeRustCoreObject,
        receiptDigest,
        settledAt: lifecycleTimestamp(input.authorityDigest, input.handoffId, phase),
      });
      if (result.receipt === undefined || stableJson(result.receipt) !== stableJson(input.receipt) || result.receiptDigest !== receiptDigest)
        throw new RuntimeFailure("persistence", "Rust worker handoff settlement receipt is malformed");
      snapshot.receipt = input.receipt;
      snapshot.receiptDigest = receiptDigest;
    } else {
      result = await this.#client.workerHandoffTransition({
        ...this.#key(input),
        expectedGeneration: snapshot.generation,
        expectedState: snapshot.state,
        targetState: input.to,
        updatedAt: lifecycleTimestamp(input.authorityDigest, input.handoffId, phase),
      });
    }
    this.#assertHandoffResult(result, input.handoffId);
    snapshot.state = this.#state(result, input.to);
    const nextGeneration = this.#generation(result);
    if (nextGeneration !== snapshot.generation + 1)
      throw new RuntimeFailure("persistence", "Rust worker handoff generation did not advance exactly once");
    snapshot.generation = nextGeneration;
    return handoffRecord(snapshot);
  }

  async acknowledge(input: Parameters<NativeWorkerHandoffStore["acknowledge"]>[0]): Promise<NativeWorkerHandoffRecordV1> {
    this.#assertInput(input);
    const snapshot = this.#requiredSnapshot(input.handoffId);
    if (snapshot.state !== "handed-off" || snapshot.receipt === undefined || snapshot.receiptDigest === undefined)
      throw new RuntimeFailure("conflict", "Worker handoff is not ready for acknowledgement");
    const acknowledgedAt = lifecycleTimestamp(input.authorityDigest, input.handoffId, "ack");
    const result = await this.#client.workerHandoffAck({
      ...this.#key(input),
      receiptDigest: snapshot.receiptDigest,
      acknowledgedAt,
    });
    this.#assertHandoffResult(result, input.handoffId);
    if (result.acknowledgedAt !== acknowledgedAt)
      throw new RuntimeFailure("persistence", "Rust worker handoff acknowledgement is malformed");
    snapshot.parentAcknowledged = true;
    return handoffRecord(snapshot);
  }

  #assertInput(input: { authority: WorkerAuthorityV1; authorityDigest: string; ownershipGeneration: number; handoffId: string }): void {
    assertOwnership(input.authority, input.authorityDigest, input.ownershipGeneration);
    if (!input.handoffId || input.handoffId.includes("\0"))
      throw new RuntimeFailure("validation", "Worker handoff id is invalid");
    const snapshot = this.#snapshots.get(input.handoffId);
    if (snapshot !== undefined && (
      snapshot.authorityDigest !== input.authorityDigest ||
      snapshot.ownershipGeneration !== input.ownershipGeneration ||
      stableJson(snapshot.authority) !== stableJson(input.authority)
    )) throw new RuntimeFailure("conflict", "Worker handoff authority is stale");
  }

  #key(input: { authority: WorkerAuthorityV1; authorityDigest: string; ownershipGeneration: number; handoffId: string }): NativeRustWorkerHandoffKey {
    return {
      authority: rustAuthority(input.authority),
      authorityDigest: input.authorityDigest,
      mailboxGeneration: input.ownershipGeneration,
      handoffId: input.handoffId,
    };
  }

  #requiredSnapshot(handoffId: string): HandoffSnapshot {
    const snapshot = this.#snapshots.get(handoffId);
    if (snapshot === undefined)
      throw new RuntimeFailure("persistence", "Worker handoff must be opened before mutation");
    return snapshot;
  }

  #state(result: NativeRustWorkerHandoffMutationResult, expected?: NativeWorkerHandoffState): NativeWorkerHandoffState {
    const state = result.state as NativeWorkerHandoffState | undefined;
    if (state === undefined || !HANDOFF_STATES.has(state) || (expected !== undefined && state !== expected))
      throw new RuntimeFailure("persistence", "Rust worker handoff state is malformed");
    return state;
  }

  #generation(result: NativeRustWorkerHandoffMutationResult): number {
    if (!Number.isSafeInteger(result.generation) || Number(result.generation) < 0)
      throw new RuntimeFailure("persistence", "Rust worker handoff generation is malformed");
    return Number(result.generation);
  }

  #assertHandoffResult(result: NativeRustWorkerHandoffMutationResult, handoffId: string): void {
    if (result.handoffId !== handoffId)
      throw new RuntimeFailure("persistence", "Rust worker handoff identity is malformed");
  }
}
