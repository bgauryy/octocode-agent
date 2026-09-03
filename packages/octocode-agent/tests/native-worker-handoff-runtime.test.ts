import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packetId, type WorkerAuthorityV1, type WorkerSpawnPacket, type WorkerTerminalPacket } from "@octocodeai/agent-core";
import type { NativeWorkerHandoffStore } from "../src/native-worker-handoff.js";
import { createNativeWorkerHandoffPort } from "../src/native-worker-handoff-runtime.js";
import { workerAuthorityFixture } from "./worker-authority-fixture.js";
import { NativeRustCoreClient } from "../src/native-rust-core.js";
import { NativeRustWorkerMessageJournal } from "../src/native-rust-worker-messages.js";
import { NativeRustWorkerHandoffStore } from "../src/native-rust-worker-lifecycle.js";
import { nativeWorkerAuthorityDigest } from "../src/native-worker-worktrees.js";

function spawn(authority: WorkerAuthorityV1): WorkerSpawnPacket {
  return { schemaVersion: 1, type: "worker.spawn", packetId: packetId("handoff-spawn"), workerId: authority.workerId, correlationId: authority.correlationId, sessionId: authority.parentSessionId, redaction: "internal", authority, prompt: "work", promptSnapshotId: "prompt", workspace: { mode: "shared" }, capabilities: { tools: [], models: [], maxTurns: 1 } };
}

function terminal(authority: WorkerAuthorityV1): WorkerTerminalPacket {
  return { schemaVersion: 1, type: "worker.terminal", packetId: packetId("handoff-terminal"), workerId: authority.workerId, correlationId: authority.correlationId, sessionId: authority.parentSessionId, redaction: "internal", authority, outcome: "failed" };
}

describe("native worker handoff runtime", () => {
  it("refuses handoff while the addressed mailbox contains written unknown delivery", async () => {
    const authority = workerAuthorityFixture();
    let state: "open" | "sealing" | "draining" | "uncertain" = "open";
    const store: NativeWorkerHandoffStore = {
      async begin(input) { return { schemaVersion: 1, handoffId: input.handoffId, authorityDigest: input.authorityDigest, ownershipGeneration: input.ownershipGeneration, state, parentAcknowledged: false }; },
      async transition(input) { state = input.to as typeof state; return { schemaVersion: 1, handoffId: input.handoffId, authorityDigest: input.authorityDigest, ownershipGeneration: input.ownershipGeneration, state, parentAcknowledged: false }; },
      async acknowledge() { throw new Error("unreachable"); },
    };
    const journal = {
      openMailbox: vi.fn(async () => ({ schemaVersion: 1 as const, mailboxGeneration: authority.ownershipGeneration, nextSequence: 2, sealed: false, idempotent: false })),
      listMailbox: vi.fn(async () => [{ schemaVersion: 1 as const, messageId: "m", sequence: 1, sender: "parent", recipient: "worker", commandKind: "input.submit", lane: "data", payloadDigest: "digest", state: "written", leaseGeneration: 1, outcomeDigest: null, tombstoneExpiresAt: null }]),
      stage: vi.fn(),
      abandonSession: vi.fn(),
    };
    const port = createNativeWorkerHandoffPort({ store, journal });
    await expect(port.settle(spawn(authority), terminal(authority))).rejects.toThrow(/unsettled delivery/u);
  });

  const debugBinary = path.resolve(import.meta.dirname, "../../octocode-agent-core-rust/target/debug/octocode-agent-core-rust");
  it.skipIf(!fs.existsSync(debugBinary))("settles and acknowledges a real Rust handoff", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-handoff-runtime-"));
    const client = new NativeRustCoreClient({ binaryPath: debugBinary, dbPath: path.join(root, "core.sqlite3") });
    const authority = workerAuthorityFixture();
    const digest = nativeWorkerAuthorityDigest(authority);
    const handoffId = "real-handoff";
    const store = new NativeRustWorkerHandoffStore(client);
    try {
      await new NativeRustWorkerMessageJournal(client, { now: () => 100 }).openMailbox({ authority, mailboxGeneration: authority.ownershipGeneration });
      await expect(store.begin({ authority, authorityDigest: digest, ownershipGeneration: authority.ownershipGeneration, handoffId })).resolves.toMatchObject({ state: "open" });
      await expect(store.transition({ authority, authorityDigest: digest, ownershipGeneration: authority.ownershipGeneration, handoffId, from: ["open"], to: "sealing" })).resolves.toMatchObject({ state: "sealing" });
      await expect(store.transition({ authority, authorityDigest: digest, ownershipGeneration: authority.ownershipGeneration, handoffId, from: ["sealing"], to: "draining" })).resolves.toMatchObject({ state: "draining" });
      await expect(store.transition({ authority, authorityDigest: digest, ownershipGeneration: authority.ownershipGeneration, handoffId, from: ["draining"], to: "terminalizing" })).resolves.toMatchObject({ state: "terminalizing" });
      const receipt = { schemaVersion: 1 as const, handoffId, authorityDigest: digest, outcome: "succeeded" as const, publicSummary: "done", privateArtifactRefs: [], settledEffectIds: [], mailboxHighWater: 0, worktreeState: "shared", nextSafeActions: [] };
      await expect(store.transition({ authority, authorityDigest: digest, ownershipGeneration: authority.ownershipGeneration, handoffId, from: ["terminalizing"], to: "handed-off", receipt })).resolves.toMatchObject({ state: "handed-off" });
      await expect(store.acknowledge({ authority, authorityDigest: digest, ownershipGeneration: authority.ownershipGeneration, handoffId })).resolves.toMatchObject({ parentAcknowledged: true });
    } finally {
      await client.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
