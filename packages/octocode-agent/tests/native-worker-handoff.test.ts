import assert from "node:assert/strict";
import { test } from "vitest";
import { correlationId, sessionId, workerId, type WorkerAuthorityV1 } from "@octocodeai/agent-core";
import { NativeWorkerHandoffCoordinator, type NativeWorkerHandoffRecordV1, type NativeWorkerHandoffStore } from "../src/native-worker-handoff.js";

function authority(): WorkerAuthorityV1 {
  const wid = workerId("handoff-worker");
  const cid = correlationId("handoff-correlation");
  const sid = sessionId("handoff-session");
  return { schemaVersion: 1, workerId: wid, correlationId: cid, rootAgentId: "root", parentSessionId: sid, workspaceId: "workspace", workspaceGeneration: 2, trustRevision: "trust", permissionMode: "default", capabilityDigest: "capability", effectAdmissionId: "effect", ownershipGeneration: 4 };
}

class MemoryStore implements NativeWorkerHandoffStore {
  record?: NativeWorkerHandoffRecordV1;
  transitions: string[] = [];
  async begin(input: Parameters<NativeWorkerHandoffStore["begin"]>[0]): Promise<NativeWorkerHandoffRecordV1> {
    this.record ??= { schemaVersion: 1, ...input, state: "open", parentAcknowledged: false };
    return this.record;
  }
  async transition(input: Parameters<NativeWorkerHandoffStore["transition"]>[0]): Promise<NativeWorkerHandoffRecordV1> {
    assert.ok(this.record);
    assert.ok(input.from.includes(this.record.state));
    this.transitions.push(input.to);
    this.record = { ...this.record, state: input.to, ...(input.receipt === undefined ? {} : { receipt: input.receipt }) };
    return this.record;
  }
  async acknowledge(): Promise<NativeWorkerHandoffRecordV1> {
    assert.ok(this.record);
    this.record = { ...this.record, parentAcknowledged: true };
    return this.record;
  }
}

test("handoff seals, drains, terminalizes once, and retry returns the committed receipt", async () => {
  const store = new MemoryStore();
  const calls: string[] = [];
  const coordinator = new NativeWorkerHandoffCoordinator({ store, mailbox: {
    async seal() { calls.push("seal"); },
    async drain() { calls.push("drain"); },
    async terminalize() { calls.push("terminalize"); return { mailboxHighWater: 9, settledEffectIds: ["effect"] }; },
  }, now: () => 100, graceMs: 50 });
  const input = { authority: authority(), outcome: "succeeded" as const, publicSummary: "done", privateArtifactRefs: ["artifact:private"], worktreeState: "ready-to-integrate", nextSafeActions: ["inspect", "integrate"] };
  const first = await coordinator.handoff(input, new AbortController().signal);
  const retry = await coordinator.handoff(input, new AbortController().signal);
  assert.deepEqual(retry, first);
  assert.deepEqual(calls, ["seal", "drain", "terminalize"]);
  assert.deepEqual(store.transitions, ["sealing", "draining", "terminalizing", "handed-off"]);
  assert.equal((await coordinator.acknowledge(input.authority)).handoffId, first.handoffId);
  assert.equal(store.record?.parentAcknowledged, true);
});

test("failure after sealing becomes uncertain and is never reported as handed off", async () => {
  const store = new MemoryStore();
  const coordinator = new NativeWorkerHandoffCoordinator({ store, mailbox: {
    async seal() {},
    async drain() { throw new Error("dead pipe"); },
    async terminalize() { throw new Error("unreachable"); },
  } });
  await assert.rejects(coordinator.handoff({ authority: authority(), outcome: "failed", publicSummary: "failed", worktreeState: "retained" }, new AbortController().signal), /dead pipe/u);
  assert.equal(store.record?.state, "uncertain");
  assert.equal(store.record?.receipt, undefined);
});
