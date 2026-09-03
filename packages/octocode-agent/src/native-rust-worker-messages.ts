import { createHash } from "node:crypto";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { z } from "zod";
import {
  RuntimeFailure,
  type WorkerAuthorityV1,
} from "@octocodeai/agent-core";
import type {
  NativeRustCommunicationAbandonPrefixResult,
  NativeRustCoreObject,
  NativeRustWorkerAuthority,
  NativeRustWorkerMailboxClaimInput,
  NativeRustWorkerMailboxClaimResult,
  NativeRustWorkerMailboxEnqueueInput,
  NativeRustWorkerMailboxExtendInput,
  NativeRustWorkerMailboxKey,
  NativeRustWorkerMailboxLeaseInput,
  NativeRustWorkerMailboxListInput,
  NativeRustWorkerMailboxListResult,
  NativeRustWorkerMailboxMutationResult,
  NativeRustWorkerMailboxOpenInput,
  NativeRustWorkerMailboxOpenResult,
  NativeRustWorkerMailboxSettleInput,
  NativeRustWorkerMailboxTerminalizeInput,
} from "./native-rust-core.js";
import { nativeWorkerAuthorityDigest } from "./native-worker-worktrees.js";
export { nativeWorkerAuthorityDigest } from "./native-worker-worktrees.js";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"));
const commandTypeSchema = z.enum([
  "input.submit",
  "input.follow-up",
  "input.steer",
  "input.cancel",
]);
const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("octocode.worker.input"),
    workerId: identifierSchema,
    correlationId: identifierSchema,
    sessionId: identifierSchema,
    parentAgentId: identifierSchema,
    requestId: identifierSchema,
    commandType: commandTypeSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type NativeWorkerInputCommand =
  | {
      readonly type: "input.submit" | "input.follow-up" | "input.steer";
      readonly text: string;
    }
  | { readonly type: "input.cancel"; readonly reason: string };

export type NativeWorkerMessageMetadata = z.infer<typeof metadataSchema>;
export interface NativeWorkerInputMessage extends UIMessage<NativeWorkerMessageMetadata> {
  readonly metadata: NativeWorkerMessageMetadata;
}

export interface NativeWorkerMessageStageInput {
  readonly workerId: string;
  readonly correlationId: string;
  readonly sessionId: string;
  readonly parentAgentId: string;
  readonly requestId: string;
  readonly command: NativeWorkerInputCommand;
  readonly authority: WorkerAuthorityV1;
  readonly authorityDigest?: string;
  readonly mailboxGeneration: number;
}

export interface NativeWorkerMailboxAddress {
  readonly authority: WorkerAuthorityV1;
  readonly authorityDigest?: string;
  readonly mailboxGeneration: number;
}

export interface NativeWorkerMessageLease {
  readonly message: NativeWorkerInputMessage;
  readonly command: NativeWorkerInputCommand;
  readonly sequence: number;
  readonly pressure?: {
    readonly messages: number;
    readonly bytes: number;
    readonly highWater: boolean;
  };
  markWritten(): Promise<void>;
  extend(): Promise<void>;
  ack(outcomeDigest?: string): Promise<void>;
  release(): Promise<void>;
  uncertain(outcomeDigest?: string): Promise<void>;
  deadLetter(outcomeDigest?: string): Promise<void>;
}

export interface NativeWorkerMessageJournal {
  stage(
    input: NativeWorkerMessageStageInput,
  ): Promise<NativeWorkerMessageLease>;
  openMailbox(address: NativeWorkerMailboxAddress): Promise<NativeRustWorkerMailboxOpenResult>;
  listMailbox(address: NativeWorkerMailboxAddress): Promise<NativeRustWorkerMailboxListResult>;
  abandonSession(sessionId: string): Promise<{ readonly abandoned: number }>;
}

/** Narrow Rust queue surface, separated from process control for deterministic tests. */
export interface NativeWorkerCommunicationCore {
  workerMailboxOpen(input: NativeRustWorkerMailboxOpenInput): Promise<NativeRustWorkerMailboxOpenResult>;
  workerMailboxEnqueue(input: NativeRustWorkerMailboxEnqueueInput): Promise<NativeRustWorkerMailboxMutationResult>;
  workerMailboxClaim(input: NativeRustWorkerMailboxClaimInput): Promise<NativeRustWorkerMailboxClaimResult>;
  workerMailboxExtend(input: NativeRustWorkerMailboxExtendInput): Promise<NativeRustWorkerMailboxMutationResult>;
  workerMailboxRelease(input: NativeRustWorkerMailboxLeaseInput): Promise<NativeRustWorkerMailboxMutationResult>;
  workerMailboxMarkWritten(input: NativeRustWorkerMailboxLeaseInput): Promise<NativeRustWorkerMailboxMutationResult>;
  workerMailboxAck(input: NativeRustWorkerMailboxSettleInput): Promise<NativeRustWorkerMailboxMutationResult>;
  workerMailboxTerminalize(input: NativeRustWorkerMailboxTerminalizeInput): Promise<NativeRustWorkerMailboxMutationResult>;
  workerMailboxList(input: NativeRustWorkerMailboxListInput): Promise<NativeRustWorkerMailboxListResult>;
  communicationAbandonPrefix(input: {
    readonly channelPrefix: string;
    readonly limit: number;
  }): Promise<NativeRustCommunicationAbandonPrefixResult>;
}

export interface NativeRustWorkerMessageJournalOptions {
  readonly consumerId?: string;
  readonly leaseMs?: number;
  readonly now?: () => number;
  readonly tombstoneRetentionMs?: number;
  readonly maxMessages?: number;
  readonly maxBytes?: number;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function safeIdentifier(value: string, label: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success)
    throw new RuntimeFailure("validation", `${label} is invalid`);
  return parsed.data;
}

function nonnegativeInteger(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new RuntimeFailure("validation", `${label} must be a non-negative integer`);
  return Number(value);
}

function durableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1)
    throw new RuntimeFailure(
      "validation",
      `${label} must be a positive integer`,
    );
  return selected;
}

function commandText(command: NativeWorkerInputCommand): string {
  const value = command.type === "input.cancel" ? command.reason : command.text;
  if (!value.trim() || value.includes("\0"))
    throw new RuntimeFailure("validation", "Worker message text is invalid");
  return value;
}

function messageCommand(
  message: NativeWorkerInputMessage,
): NativeWorkerInputCommand {
  if (message.parts.length !== 1 || message.parts[0]?.type !== "text") {
    throw new RuntimeFailure(
      "persistence",
      "Rust worker AI message must contain exactly one text part",
    );
  }
  const text = message.parts[0].text;
  return message.metadata.commandType === "input.cancel"
    ? { type: "input.cancel", reason: text }
    : { type: message.metadata.commandType, text };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Durable parent-to-worker message journal. AI SDK UIMessage owns the semantic
 * envelope; Rust owns staging, leasing, acknowledgement, and retry state.
 */
export class NativeRustWorkerMessageJournal implements NativeWorkerMessageJournal {
  readonly #core: NativeWorkerCommunicationCore;
  readonly #consumerId: string;
  readonly #leaseMs: number;
  readonly #tombstoneRetentionMs: number;
  readonly #maxMessages?: number;
  readonly #maxBytes?: number;
  readonly #now: () => number;

  constructor(
    core: NativeWorkerCommunicationCore,
    options: NativeRustWorkerMessageJournalOptions = {},
  ) {
    this.#core = core;
    this.#consumerId = safeIdentifier(
      options.consumerId ?? `native-worker-process:${process.pid}`,
      "Worker message consumer id",
    );
    this.#leaseMs = positiveInteger(
      options.leaseMs,
      DEFAULT_LEASE_MS,
      "Worker message leaseMs",
    );
    this.#tombstoneRetentionMs = positiveInteger(
      options.tombstoneRetentionMs,
      DEFAULT_TOMBSTONE_RETENTION_MS,
      "Worker message tombstone retention",
    );
    this.#maxMessages = options.maxMessages;
    this.#maxBytes = options.maxBytes;
    this.#now = options.now ?? Date.now;
  }

  #address(input: NativeWorkerMailboxAddress): NativeRustWorkerMailboxKey {
    return {
      authority: input.authority as unknown as NativeRustWorkerAuthority,
      authorityDigest:
        input.authorityDigest ?? nativeWorkerAuthorityDigest(input.authority),
      mailboxGeneration: nonnegativeInteger(
        input.mailboxGeneration,
        "Worker mailbox generation",
      ),
    };
  }

  async openMailbox(
    address: NativeWorkerMailboxAddress,
  ): Promise<NativeRustWorkerMailboxOpenResult> {
    const now = this.#timestamp();
    return await this.#core.workerMailboxOpen({
      ...this.#address(address),
      createdAt: now,
      ...(this.#maxMessages === undefined
        ? {}
        : { maxMessages: this.#maxMessages }),
      ...(this.#maxBytes === undefined ? {} : { maxBytes: this.#maxBytes }),
    });
  }

  async listMailbox(
    address: NativeWorkerMailboxAddress,
  ): Promise<NativeRustWorkerMailboxListResult> {
    const records: NativeRustWorkerMailboxListResult[number][] = [];
    let afterSequence = 0;
    for (;;) {
      const page = await this.#core.workerMailboxList({
        ...this.#address(address),
        afterSequence,
        limit: 100,
      });
      records.push(...page);
      if (page.length < 100) return Object.freeze(records);
      const next = page.at(-1)?.sequence;
      if (!Number.isSafeInteger(next) || Number(next) <= afterSequence)
        throw new RuntimeFailure('persistence', 'Worker mailbox pagination did not advance');
      afterSequence = Number(next);
    }
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RuntimeFailure(
        "validation",
        "Worker message timestamp is invalid",
      );
    return value;
  }

  async abandonSession(
    sessionIdValue: string,
  ): Promise<{ readonly abandoned: number }> {
    const sessionId = safeIdentifier(sessionIdValue, "Worker session id");
    const channelPrefix = `worker-input:${sessionId}:`;
    let abandoned = 0;
    for (;;) {
      const settled = await this.#core.communicationAbandonPrefix({
        channelPrefix,
        limit: 1_000,
      });
      abandoned += settled.length;
      if (settled.length < 1_000) return Object.freeze({ abandoned });
    }
  }

  async stage(
    input: NativeWorkerMessageStageInput,
  ): Promise<NativeWorkerMessageLease> {
    if (input.authority === undefined || input.mailboxGeneration === undefined)
      throw new RuntimeFailure(
        "validation",
        "Worker authority and mailbox generation are required",
      );
    const workerId = safeIdentifier(input.workerId, "Worker id");
    const correlationId = safeIdentifier(
      input.correlationId,
      "Worker correlation id",
    );
    const sessionId = safeIdentifier(input.sessionId, "Worker session id");
    const parentAgentId = safeIdentifier(
      input.parentAgentId,
      "Parent agent id",
    );
    const requestId = safeIdentifier(input.requestId, "Worker request id");
    if (
      String(input.authority.workerId) !== workerId ||
      String(input.authority.correlationId) !== correlationId ||
      String(input.authority.parentSessionId) !== sessionId ||
      String(input.authority.rootAgentId) !== parentAgentId
    )
      throw new RuntimeFailure(
        "validation",
        "Worker authority does not match the staged message",
      );
    const address = this.#address({
      authority: input.authority,
      authorityDigest: input.authorityDigest,
      mailboxGeneration: input.mailboxGeneration,
    });
    const createdAt = this.#timestamp();
    const candidate: NativeWorkerInputMessage = {
      id: requestId,
      role: "user",
      metadata: {
        schemaVersion: 1,
        kind: "octocode.worker.input",
        workerId,
        correlationId,
        sessionId,
        parentAgentId,
        requestId,
        commandType: input.command.type,
        createdAt,
      },
      parts: [{ type: "text", text: commandText(input.command) }],
    };
    const validated = await safeValidateUIMessages<NativeWorkerInputMessage>({
      messages: [candidate],
      metadataSchema,
    });
    if (!validated.success || validated.data.length !== 1) {
      throw new RuntimeFailure(
        "validation",
        "Worker AI message envelope is invalid",
      );
    }
    const message = validated.data[0]!;
    await this.#core.workerMailboxOpen({
      ...address,
      createdAt,
      ...(this.#maxMessages === undefined
        ? {}
        : { maxMessages: this.#maxMessages }),
      ...(this.#maxBytes === undefined ? {} : { maxBytes: this.#maxBytes }),
    });
    const payload = {
      schemaVersion: 1,
      message,
    } as unknown as NativeRustCoreObject;
    const staged = await this.#core.workerMailboxEnqueue({
      ...address,
      messageId: requestId,
      sender: String(input.authority.rootAgentId),
      recipient: workerId,
      commandKind: input.command.type === "input.cancel" ? "cancel" : input.command.type,
      lane: input.command.type === "input.cancel" ? "control" : "data",
      payload,
      payloadDigest: durableDigest(payload),
      availableAt: createdAt,
      createdAt,
    });
    const claims = await this.#core.workerMailboxClaim({
      ...address,
      consumerId: this.#consumerId,
      now: createdAt,
      leaseMs: this.#leaseMs,
      limit: 1,
    });
    const claimed = claims[0];
    let leaseGeneration: number | undefined;
    let durableMessage: NativeWorkerInputMessage;
    let durableCommand: NativeWorkerInputCommand;
    try {
      if (
        claims.length !== 1 ||
        !isObject(claimed) ||
        claimed["messageId"] !== requestId ||
        claimed["sequence"] !== staged.sequence ||
        !isObject(claimed["payload"]) ||
        !Number.isSafeInteger(claimed["leaseGeneration"]) ||
        Number(claimed["leaseGeneration"]) < 1
      ) {
        throw new RuntimeFailure(
          "persistence",
          "Rust worker message claim is malformed",
        );
      }
      leaseGeneration = Number(claimed["leaseGeneration"]);
      const claimedPayload = claimed["payload"];
      if (claimedPayload["schemaVersion"] !== 1)
        throw new RuntimeFailure(
          "persistence",
          "Rust worker message envelope is malformed",
        );
      const parsed = await safeValidateUIMessages<NativeWorkerInputMessage>({
        messages: [claimedPayload["message"]],
        metadataSchema,
      });
      const claimedMessage =
        parsed.success && parsed.data.length === 1 ? parsed.data[0] : undefined;
      if (
        !claimedMessage ||
        claimedMessage.id !== requestId ||
        claimedMessage.metadata?.workerId !== workerId ||
        claimedMessage.metadata.correlationId !== correlationId ||
        claimedMessage.metadata.sessionId !== sessionId ||
        claimedMessage.metadata.parentAgentId !== parentAgentId ||
        claimedMessage.metadata.commandType !== input.command.type
      ) {
        throw new RuntimeFailure(
          "persistence",
          "Rust worker AI message envelope is malformed or mismatched",
        );
      }
      durableMessage = claimedMessage;
      durableCommand = messageCommand(claimedMessage);
      if (commandText(durableCommand) !== commandText(input.command)) {
        throw new RuntimeFailure(
          "persistence",
          "Rust worker AI message text does not match the requested input",
        );
      }
    } catch (error) {
      if (leaseGeneration !== undefined) {
        await this.#core
          .workerMailboxRelease({
            ...address,
            messageId: requestId,
            consumerId: this.#consumerId,
            leaseGeneration,
            now: this.#timestamp(),
          })
          .catch(() => undefined);
      }
      throw error;
    }
    const receipt = {
      ...address,
      messageId: requestId,
      consumerId: this.#consumerId,
      leaseGeneration,
    };
    const pressure = staged.pressure as
      | { readonly messages: number; readonly bytes: number; readonly highWater: boolean }
      | undefined;
    let written = false;
    let settled = false;
    return Object.freeze({
      message: durableMessage,
      command: durableCommand,
      sequence: Number(staged.sequence),
      ...(pressure === undefined ? {} : { pressure }),
      markWritten: async (): Promise<void> => {
        if (settled)
          throw new RuntimeFailure("persistence", "Worker message is already terminal");
        await this.#core.workerMailboxMarkWritten({
          ...receipt,
          now: this.#timestamp(),
        });
        written = true;
      },
      extend: async (): Promise<void> => {
        if (settled)
          throw new RuntimeFailure("persistence", "Worker message is already terminal");
        if (written)
          throw new RuntimeFailure(
            "persistence",
            "Written worker messages cannot extend a delivery lease",
          );
        await this.#core.workerMailboxExtend({
          ...receipt,
          now: this.#timestamp(),
          leaseMs: this.#leaseMs,
        });
      },
      ack: async (outcomeDigest?: string): Promise<void> => {
        if (settled) return;
        if (!written)
          throw new RuntimeFailure(
            "persistence",
            "Worker message must be marked written before acknowledgement",
          );
        const now = this.#timestamp();
        await this.#core.workerMailboxAck({
          ...receipt,
          outcomeDigest:
            outcomeDigest ?? durableDigest({ messageId: requestId, state: "acknowledged" }),
          now,
          tombstoneExpiresAt: now + this.#tombstoneRetentionMs,
        });
        settled = true;
      },
      release: async (): Promise<void> => {
        if (settled) return;
        if (written)
          throw new RuntimeFailure(
            "persistence",
            "Written worker messages cannot return to pending",
          );
        await this.#core.workerMailboxRelease({
          ...receipt,
          now: this.#timestamp(),
        });
        settled = true;
      },
      uncertain: async (outcomeDigest?: string): Promise<void> => {
        if (settled) return;
        if (!written)
          throw new RuntimeFailure(
            "persistence",
            "Only written worker messages can become uncertain",
          );
        const now = this.#timestamp();
        await this.#core.workerMailboxTerminalize({
          ...receipt,
          state: "uncertain",
          outcomeDigest:
            outcomeDigest ?? durableDigest({ messageId: requestId, state: "uncertain" }),
          now,
          tombstoneExpiresAt: now + this.#tombstoneRetentionMs,
        });
        settled = true;
      },
      deadLetter: async (outcomeDigest?: string): Promise<void> => {
        if (settled) return;
        if (written)
          throw new RuntimeFailure(
            "persistence",
            "Written worker messages must become uncertain, not dead-lettered",
          );
        const now = this.#timestamp();
        await this.#core.workerMailboxTerminalize({
          ...receipt,
          state: "dead-lettered",
          outcomeDigest:
            outcomeDigest ?? durableDigest({ messageId: requestId, state: "dead-lettered" }),
          now,
          tombstoneExpiresAt: now + this.#tombstoneRetentionMs,
        });
        settled = true;
      },
    });
  }
}
