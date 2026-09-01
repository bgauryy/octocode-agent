import { safeValidateUIMessages, type UIMessage } from "ai";
import { z } from "zod";
import { RuntimeFailure } from "@octocodeai/agent-core";
import type {
  NativeRustCommunicationClaimInput,
  NativeRustCommunicationClaimResult,
  NativeRustCommunicationAbandonPrefixResult,
  NativeRustCommunicationEnqueueInput,
  NativeRustCommunicationMutationResult,
  NativeRustCommunicationReceiptInput,
} from "./native-rust-core.js";
import { NativeRustCoreError } from "./native-rust-core.js";

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
}

export interface NativeWorkerMessageLease {
  readonly message: NativeWorkerInputMessage;
  readonly command: NativeWorkerInputCommand;
  ack(): Promise<void>;
  release(): Promise<void>;
}

export interface NativeWorkerMessageJournal {
  stage(
    input: NativeWorkerMessageStageInput,
  ): Promise<NativeWorkerMessageLease>;
  abandonSession(sessionId: string): Promise<{ readonly abandoned: number }>;
}

/** Narrow Rust queue surface, separated from process control for deterministic tests. */
export interface NativeWorkerCommunicationCore {
  communicationEnqueue(
    input: NativeRustCommunicationEnqueueInput,
  ): Promise<NativeRustCommunicationMutationResult>;
  communicationClaim(
    input: NativeRustCommunicationClaimInput,
  ): Promise<NativeRustCommunicationClaimResult>;
  communicationAck(
    input: NativeRustCommunicationReceiptInput,
  ): Promise<NativeRustCommunicationMutationResult>;
  communicationRelease(
    input: NativeRustCommunicationReceiptInput,
  ): Promise<NativeRustCommunicationMutationResult>;
  communicationAbandonPrefix(input: {
    readonly channelPrefix: string;
    readonly limit: number;
  }): Promise<NativeRustCommunicationAbandonPrefixResult>;
}

export interface NativeRustWorkerMessageJournalOptions {
  readonly consumerId?: string;
  readonly leaseMs?: number;
  readonly now?: () => number;
}

const DEFAULT_LEASE_MS = 30_000;

function safeIdentifier(value: string, label: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success)
    throw new RuntimeFailure("validation", `${label} is invalid`);
  return parsed.data;
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
    this.#now = options.now ?? Date.now;
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
    const createdAt = this.#now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0)
      throw new RuntimeFailure(
        "validation",
        "Worker message timestamp is invalid",
      );
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
    const channel = `worker-input:${sessionId}:${workerId}:${requestId}`;
    try {
      await this.#core.communicationEnqueue({
        channel,
        messageId: requestId,
        availableAt: createdAt,
        payload: {
          schemaVersion: 1,
          message,
        } as unknown as NativeRustCommunicationEnqueueInput["payload"],
      });
    } catch (error) {
      if (!(
        error instanceof NativeRustCoreError &&
        error.category === "remote" &&
        error.code === "CONFLICT"
      ))
        throw error;
    }
    const claims = await this.#core.communicationClaim({
      channel,
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
          .communicationRelease({
            channel,
            messageId: requestId,
            consumerId: this.#consumerId,
            leaseGeneration,
          })
          .catch(() => undefined);
      }
      throw error;
    }
    const receipt = {
      channel,
      messageId: requestId,
      consumerId: this.#consumerId,
      leaseGeneration,
    };
    let settled = false;
    return Object.freeze({
      message: durableMessage,
      command: durableCommand,
      ack: async (): Promise<void> => {
        if (settled) return;
        await this.#core.communicationAck(receipt);
        settled = true;
      },
      release: async (): Promise<void> => {
        if (settled) return;
        await this.#core.communicationRelease(receipt);
        settled = true;
      },
    });
  }
}
