import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  correlationId,
  sessionId,
  workerId,
  type WorkerAuthorityV1,
} from "@octocodeai/agent-core";
import {
  NativeRustWorkerHandoffStore,
  NativeRustWorkerWorktreeStore,
  type NativeRustWorkerLifecycleClient,
} from "../src/native-rust-worker-lifecycle.js";
import {
  nativeWorkerAuthorityDigest,
  type NativeWorkerWorktreeRecordV1,
} from "../src/native-worker-worktrees.js";
import type { NativeWorkerHandoffReceiptV1 } from "../src/native-worker-handoff.js";

type WorktreeReserveInput = Parameters<NativeRustWorkerLifecycleClient["workerWorktreeReserve"]>[0];
type WorktreeTransitionInput = Parameters<NativeRustWorkerLifecycleClient["workerWorktreeTransition"]>[0];
type HandoffGenerationInput = Parameters<NativeRustWorkerLifecycleClient["workerHandoffSeal"]>[0];
type HandoffTransitionInput = Parameters<NativeRustWorkerLifecycleClient["workerHandoffTransition"]>[0];
type HandoffSettleInput = Parameters<NativeRustWorkerLifecycleClient["workerHandoffSettle"]>[0];
type HandoffAckInput = Parameters<NativeRustWorkerLifecycleClient["workerHandoffAck"]>[0];

function authority(): WorkerAuthorityV1 {
  const wid = workerId("rust-lifecycle-worker");
  const cid = correlationId("rust-lifecycle-correlation");
  const sid = sessionId("rust-lifecycle-session");
  return {
    schemaVersion: 1,
    workerId: wid,
    correlationId: cid,
    rootAgentId: "root-agent",
    parentSessionId: sid,
    workspaceId: "workspace-1",
    workspaceGeneration: 3,
    trustRevision: "trust-1",
    permissionMode: "default",
    capabilityDigest: "capability-1",
    effectAdmissionId: "effect-1",
    ownershipGeneration: 7,
  };
}

function client(overrides: Partial<NativeRustWorkerLifecycleClient>): NativeRustWorkerLifecycleClient {
  const missing = async (): Promise<never> => {
    throw new Error("unexpected Rust lifecycle call");
  };
  return {
    workerWorktreeReserve: missing,
    workerWorktreeGet: missing,
    workerWorktreeTransition: missing,
    workerHandoffOpen: missing,
    workerHandoffSeal: missing,
    workerHandoffTransition: missing,
    workerHandoffSettle: missing,
    workerHandoffAck: missing,
    ...overrides,
  };
}

describe("NativeRustWorkerWorktreeStore", () => {
  test("strictly maps ownership and re-reads the authoritative record after reserve and transition", async () => {
    const owner = authority();
    const digest = nativeWorkerAuthorityDigest(owner);
    const requested: NativeWorkerWorktreeRecordV1 = {
      schemaVersion: 1,
      authorityDigest: digest,
      workspaceId: owner.workspaceId,
      sessionId: String(owner.parentSessionId),
      workerId: String(owner.workerId),
      repositoryRoot: "/repo",
      commonDir: "/repo/.git",
      path: "/worktrees/worker-1",
      baseOid: "a".repeat(40),
      headOid: "a".repeat(40),
      privateRef: "refs/octocode/workers/session/worker/7",
      gitWorktreeId: "git-worktree-id",
      lockReasonDigest: "lock-digest",
      generation: owner.ownershipGeneration,
      state: "requested",
    };
    let state = "requested";
    let clean: string | null = null;
    const reserveInputs: WorktreeReserveInput[] = [];
    const reserve: NativeRustWorkerLifecycleClient["workerWorktreeReserve"] = async (input) => {
      reserveInputs.push(input);
      return { schemaVersion: 1 as const, worktreeGeneration: 7, state, idempotent: false };
    };
    let getCalls = 0;
    const get: NativeRustWorkerLifecycleClient["workerWorktreeGet"] = async () => {
      getCalls += 1;
      return {
      schemaVersion: 1,
      worktreeGeneration: 7,
      repositoryId: "/repo",
      commonDirId: "/repo/.git",
      generatedPath: "/worktrees/worker-1",
      baseOid: "a".repeat(40),
      currentHeadOid: "a".repeat(40),
      privateRef: "refs/octocode/workers/session/worker/7",
      gitWorktreeId: "git-worktree-id",
      lockTokenDigest: "lock-digest",
      state,
      lastCleanStatusDigest: clean,
      };
    };
    const transitionInputs: WorktreeTransitionInput[] = [];
    const transition: NativeRustWorkerLifecycleClient["workerWorktreeTransition"] = async (input) => {
      transitionInputs.push(input);
      state = input.targetState;
      clean = input.lastCleanStatusDigest ?? clean;
      return { schemaVersion: 1 as const, worktreeGeneration: 7, state, idempotent: false };
    };
    const store = new NativeRustWorkerWorktreeStore(client({
      workerWorktreeReserve: reserve,
      workerWorktreeGet: get,
      workerWorktreeTransition: transition,
    }));

    assert.deepEqual(await store.reserve(requested, owner), requested);
    assert.equal(reserveInputs[0]?.authorityDigest, digest);
    assert.equal(reserveInputs[0]?.worktreeGeneration, 7);
    assert.equal(reserveInputs[0]?.repositoryId, "/repo");
    assert.equal(getCalls, 1);

    const active = await store.transition({
      authority: owner,
      authorityDigest: digest,
      generation: 7,
      from: ["requested", "recovery-needed"],
      to: "active",
      headOid: "b".repeat(40),
      cleanStatusDigest: "clean-digest",
    });
    assert.equal(active.state, "active");
    assert.equal(active.cleanStatusDigest, "clean-digest");
    assert.equal(transitionInputs[0]?.expectedState, "requested");
    assert.equal(transitionInputs[0]?.currentHeadOid, "b".repeat(40));
    assert.equal(getCalls, 3);
  });

  test("rejects authority, digest, and generation mismatches before Rust mutation", async () => {
    const owner = authority();
    let reserveCalls = 0;
    const reserve: NativeRustWorkerLifecycleClient["workerWorktreeReserve"] = async () => {
      reserveCalls += 1;
      throw new Error("unreachable");
    };
    const store = new NativeRustWorkerWorktreeStore(client({ workerWorktreeReserve: reserve }));
    const record = {
      schemaVersion: 1 as const,
      authorityDigest: "wrong",
      workspaceId: owner.workspaceId,
      sessionId: String(owner.parentSessionId),
      workerId: String(owner.workerId),
      repositoryRoot: "/repo",
      commonDir: "/repo/.git",
      path: "/worktree",
      baseOid: "base",
      headOid: "base",
      privateRef: "private",
      gitWorktreeId: "git-worktree-id",
      lockReasonDigest: "lock",
      generation: 6,
      state: "requested" as const,
    };
    await assert.rejects(store.reserve(record, owner), /ownership|authority/u);
    assert.equal(reserveCalls, 0);
  });
});

describe("NativeRustWorkerHandoffStore", () => {
  test("tracks phase generations, atomically seals, settles digested content, and acknowledges idempotently", async () => {
    const owner = authority();
    const digest = nativeWorkerAuthorityDigest(owner);
    let generation = 0;
    let state = "open";
    const open: NativeRustWorkerLifecycleClient["workerHandoffOpen"] = async () => ({ schemaVersion: 1 as const, handoffId: "handoff-1", state, generation, idempotent: false });
    const sealInputs: HandoffGenerationInput[] = [];
    const seal: NativeRustWorkerLifecycleClient["workerHandoffSeal"] = async (input) => {
      sealInputs.push(input);
      return { schemaVersion: 1 as const, handoffId: "handoff-1", state: "sealing", generation: ++generation, idempotent: false };
    };
    const transitionInputs: HandoffTransitionInput[] = [];
    const transition: NativeRustWorkerLifecycleClient["workerHandoffTransition"] = async (input) => {
      transitionInputs.push(input);
      return { schemaVersion: 1 as const, handoffId: "handoff-1", state: state = input.targetState, generation: ++generation, idempotent: false };
    };
    const settleInputs: HandoffSettleInput[] = [];
    const settle: NativeRustWorkerLifecycleClient["workerHandoffSettle"] = async (input) => {
      settleInputs.push(input);
      return {
      schemaVersion: 1 as const,
      handoffId: "handoff-1",
      state: state = "handed-off",
      generation: ++generation,
      receipt: input.receipt,
      receiptDigest: input.receiptDigest,
      idempotent: false,
      };
    };
    const ackInputs: HandoffAckInput[] = [];
    const ack: NativeRustWorkerLifecycleClient["workerHandoffAck"] = async (input) => {
      ackInputs.push(input);
      return { schemaVersion: 1 as const, handoffId: "handoff-1", acknowledgedAt: input.acknowledgedAt, idempotent: ackInputs.length > 1 };
    };
    const store = new NativeRustWorkerHandoffStore(client({
      workerHandoffOpen: open,
      workerHandoffSeal: seal,
      workerHandoffTransition: transition,
      workerHandoffSettle: settle,
      workerHandoffAck: ack,
    }));
    const base = { authority: owner, handoffId: "handoff-1", authorityDigest: digest, ownershipGeneration: 7 };
    assert.equal((await store.begin(base)).state, "open");
    await store.transition({ ...base, from: ["open"], to: "sealing" });
    await store.transition({ ...base, from: ["sealing"], to: "draining" });
    await store.transition({ ...base, from: ["draining"], to: "terminalizing" });
    const receipt: NativeWorkerHandoffReceiptV1 = {
      schemaVersion: 1,
      handoffId: "handoff-1",
      authorityDigest: digest,
      outcome: "succeeded",
      publicSummary: "done",
      privateArtifactRefs: ["artifact"],
      settledEffectIds: ["effect"],
      mailboxHighWater: 9,
      worktreeState: "ready-to-integrate",
      nextSafeActions: ["inspect"],
    };
    const handedOff = await store.transition({ ...base, from: ["terminalizing"], to: "handed-off", receipt });
    assert.deepEqual(handedOff.receipt, receipt);
    assert.deepEqual(sealInputs[0]?.expectedGeneration, 0);
    assert.deepEqual(transitionInputs.map((input) => input.expectedGeneration), [1, 2]);
    assert.equal(settleInputs[0]?.expectedGeneration, 3);
    assert.equal(settleInputs[0]?.outcome["state"], "succeeded");
    assert.match(settleInputs[0]?.receiptDigest ?? "", /^[0-9a-f]{64}$/u);

    const firstAck = await store.acknowledge(base);
    const secondAck = await store.acknowledge(base);
    assert.equal(firstAck.parentAcknowledged, true);
    assert.deepEqual(secondAck, firstAck);
    assert.equal(ackInputs[0]?.acknowledgedAt, ackInputs[1]?.acknowledgedAt);
  });
});
