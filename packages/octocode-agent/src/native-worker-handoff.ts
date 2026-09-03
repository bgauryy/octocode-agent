import { createHash } from "node:crypto";
import { RuntimeFailure, type WorkerAuthorityV1, type WorkerTerminalOutcome } from "@octocodeai/agent-core";
import { nativeWorkerAuthorityDigest } from "./native-worker-worktrees.js";

export type NativeWorkerHandoffState = "open" | "sealing" | "draining" | "terminalizing" | "handed-off" | "uncertain";

export interface NativeWorkerHandoffReceiptV1 {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly authorityDigest: string;
  readonly outcome: WorkerTerminalOutcome;
  readonly publicSummary: string;
  readonly privateArtifactRefs: readonly string[];
  readonly settledEffectIds: readonly string[];
  readonly mailboxHighWater: number;
  readonly worktreeState: string;
  readonly nextSafeActions: readonly string[];
}

export interface NativeWorkerHandoffRecordV1 {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly authorityDigest: string;
  readonly ownershipGeneration: number;
  readonly state: NativeWorkerHandoffState;
  readonly receipt?: NativeWorkerHandoffReceiptV1;
  readonly parentAcknowledged: boolean;
}

export interface NativeWorkerHandoffStore {
  begin(input: { readonly authority: WorkerAuthorityV1; readonly handoffId: string; readonly authorityDigest: string; readonly ownershipGeneration: number }): Promise<NativeWorkerHandoffRecordV1>;
  transition(input: { readonly authority: WorkerAuthorityV1; readonly handoffId: string; readonly authorityDigest: string; readonly ownershipGeneration: number; readonly from: readonly NativeWorkerHandoffState[]; readonly to: NativeWorkerHandoffState; readonly receipt?: NativeWorkerHandoffReceiptV1 }): Promise<NativeWorkerHandoffRecordV1>;
  acknowledge(input: { readonly authority: WorkerAuthorityV1; readonly handoffId: string; readonly authorityDigest: string; readonly ownershipGeneration: number }): Promise<NativeWorkerHandoffRecordV1>;
}

export interface NativeWorkerHandoffMailbox {
  seal(authority: WorkerAuthorityV1): Promise<void>;
  drain(authority: WorkerAuthorityV1, deadlineAt: number, signal: AbortSignal): Promise<void>;
  terminalize(authority: WorkerAuthorityV1, outcome: WorkerTerminalOutcome): Promise<{ readonly mailboxHighWater: number; readonly settledEffectIds: readonly string[] }>;
}

export interface NativeWorkerHandoffInput {
  readonly authority: WorkerAuthorityV1;
  readonly outcome: WorkerTerminalOutcome;
  readonly publicSummary: string;
  readonly privateArtifactRefs?: readonly string[];
  readonly worktreeState: string;
  readonly nextSafeActions?: readonly string[];
}

const MAX_PUBLIC_SUMMARY_BYTES = 4 * 1024;
const MAX_REFERENCES = 256;

function boundedText(value: string, maxBytes: number, label: string): string {
  if (value.includes("\0")) throw new RuntimeFailure("validation", `${label} contains a null byte`);
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function boundedList(values: readonly string[] | undefined, label: string): readonly string[] {
  const list = values ?? [];
  if (list.length > MAX_REFERENCES) throw new RuntimeFailure("validation", `${label} exceeds ${MAX_REFERENCES} entries`);
  return Object.freeze(list.map((value) => boundedText(value, 2_048, label)));
}

/** Coordinates the durable one-shot seal/drain/terminalize worker handoff. */
export class NativeWorkerHandoffCoordinator {
  readonly #store: NativeWorkerHandoffStore;
  readonly #mailbox: NativeWorkerHandoffMailbox;
  readonly #graceMs: number;
  readonly #now: () => number;

  constructor(options: { readonly store: NativeWorkerHandoffStore; readonly mailbox: NativeWorkerHandoffMailbox; readonly graceMs?: number; readonly now?: () => number }) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#graceMs = options.graceMs ?? 5_000;
    if (!Number.isSafeInteger(this.#graceMs) || this.#graceMs <= 0) throw new RuntimeFailure("validation", "Handoff grace must be positive");
    this.#now = options.now ?? Date.now;
  }

  async handoff(input: NativeWorkerHandoffInput, signal: AbortSignal): Promise<NativeWorkerHandoffReceiptV1> {
    const authorityDigest = nativeWorkerAuthorityDigest(input.authority);
    const handoffId = createHash("sha256").update(`${authorityDigest}\0handoff`).digest("hex");
    let record = await this.#store.begin({ authority: input.authority, handoffId, authorityDigest, ownershipGeneration: input.authority.ownershipGeneration });
    if (record.receipt !== undefined && record.state === "handed-off") return record.receipt;
    try {
      record = await this.#store.transition({ authority: input.authority, handoffId, authorityDigest, ownershipGeneration: input.authority.ownershipGeneration, from: ["open", "uncertain"], to: "sealing" });
      await this.#mailbox.seal(input.authority);
      record = await this.#store.transition({ authority: input.authority, handoffId, authorityDigest, ownershipGeneration: input.authority.ownershipGeneration, from: ["sealing"], to: "draining" });
      await this.#mailbox.drain(input.authority, this.#now() + this.#graceMs, signal);
      record = await this.#store.transition({ authority: input.authority, handoffId, authorityDigest, ownershipGeneration: input.authority.ownershipGeneration, from: ["draining"], to: "terminalizing" });
      const terminal = await this.#mailbox.terminalize(input.authority, input.outcome);
      const receipt: NativeWorkerHandoffReceiptV1 = Object.freeze({
        schemaVersion: 1,
        handoffId,
        authorityDigest,
        outcome: input.outcome,
        publicSummary: boundedText(input.publicSummary, MAX_PUBLIC_SUMMARY_BYTES, "Worker public summary"),
        privateArtifactRefs: boundedList(input.privateArtifactRefs, "Worker private artifact references"),
        settledEffectIds: boundedList(terminal.settledEffectIds, "Worker settled effects"),
        mailboxHighWater: terminal.mailboxHighWater,
        worktreeState: boundedText(input.worktreeState, 256, "Worker worktree state"),
        nextSafeActions: boundedList(input.nextSafeActions, "Worker next actions"),
      });
      record = await this.#store.transition({ authority: input.authority, handoffId, authorityDigest, ownershipGeneration: input.authority.ownershipGeneration, from: ["terminalizing"], to: "handed-off", receipt });
      if (record.receipt === undefined) throw new RuntimeFailure("persistence", "Handoff receipt was not committed");
      return record.receipt;
    } catch (error) {
      if (record.state !== "handed-off") {
        await this.#store.transition({ authority: input.authority, handoffId, authorityDigest, ownershipGeneration: input.authority.ownershipGeneration, from: ["open", "sealing", "draining", "terminalizing", "uncertain"], to: "uncertain" }).catch(() => undefined);
      }
      throw error;
    }
  }

  async acknowledge(authority: WorkerAuthorityV1): Promise<NativeWorkerHandoffReceiptV1> {
    const authorityDigest = nativeWorkerAuthorityDigest(authority);
    const handoffId = createHash("sha256").update(`${authorityDigest}\0handoff`).digest("hex");
    const record = await this.#store.acknowledge({ authority, handoffId, authorityDigest, ownershipGeneration: authority.ownershipGeneration });
    if (record.state !== "handed-off" || record.receipt === undefined) throw new RuntimeFailure("conflict", "Worker handoff is not ready for acknowledgement");
    return record.receipt;
  }
}
