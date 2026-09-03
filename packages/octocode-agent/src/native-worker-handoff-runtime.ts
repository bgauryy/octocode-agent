import { RuntimeFailure, type WorkerSpawnPacket, type WorkerTerminalPacket } from "@octocodeai/agent-core";
import { NativeWorkerHandoffCoordinator, type NativeWorkerHandoffStore } from "./native-worker-handoff.js";
import type { NativeWorkerMessageJournal } from "./native-rust-worker-messages.js";

export interface NativeWorkerHandoffPort {
  settle(packet: WorkerSpawnPacket, terminal: WorkerTerminalPacket): Promise<void>;
}

/** Composes durable handoff phases with the addressed mailbox after process settlement. */
export function createNativeWorkerHandoffPort(options: {
  readonly store: NativeWorkerHandoffStore;
  readonly journal: NativeWorkerMessageJournal;
  readonly graceMs?: number;
  readonly now?: () => number;
}): NativeWorkerHandoffPort {
  const address = (packet: WorkerSpawnPacket) => ({
    authority: packet.authority,
    mailboxGeneration: packet.authority.ownershipGeneration,
  });
  const coordinator = new NativeWorkerHandoffCoordinator({
    store: options.store,
    graceMs: options.graceMs,
    now: options.now,
    mailbox: {
      // Rust's handoff seal transition atomically seals the addressed mailbox.
      async seal() {},
      async drain(authority, _deadlineAt, signal) {
        if (signal.aborted) throw new RuntimeFailure("cancelled", "Worker handoff drain was cancelled");
        const records = await options.journal.listMailbox({
          authority,
          mailboxGeneration: authority.ownershipGeneration,
        });
        if (records.some((record) => record.state === "pending" || record.state === "leased" || record.state === "written"))
          throw new RuntimeFailure("conflict", "Worker mailbox still has unsettled delivery");
      },
      async terminalize(authority) {
        const records = await options.journal.listMailbox({
          authority,
          mailboxGeneration: authority.ownershipGeneration,
        });
        return {
          mailboxHighWater: records.reduce((high, record) => {
            if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) < 0)
              throw new RuntimeFailure("persistence", "Worker mailbox sequence is malformed");
            return Math.max(high, Number(record.sequence));
          }, 0),
          settledEffectIds: Object.freeze([]),
        };
      },
    },
  });
  const port: NativeWorkerHandoffPort = {
    async settle(packet, terminal) {
      await options.journal.openMailbox(address(packet));
      await coordinator.handoff({
        authority: packet.authority,
        outcome: terminal.outcome,
        publicSummary: `Worker ${terminal.outcome}`,
        worktreeState: packet.workspace.mode === "shared" ? "shared" : "active",
        nextSafeActions: packet.workspace.mode === "shared"
          ? []
          : terminal.outcome === "succeeded"
            ? ["inspect", "integrate", "retain", "discard"]
            : ["inspect", "retain", "discard"],
      }, new AbortController().signal);
      await coordinator.acknowledge(packet.authority);
    },
  };
  return Object.freeze(port);
}
