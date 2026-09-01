import type { RuntimeErrorData } from "./errors.js";
import type { EventId, SessionId, ToolCallId, TurnId } from "./identity.js";
import type {
  WorkerOperationalState,
  WorkerTerminalOutcome,
} from "./workers.js";
import type { ContextProjectionReceiptV1 } from "./context-artifacts.js";
import type { RuntimeUserAttachmentMetadataV1 } from "./user-input.js";
import type {
  CheckpointRecoveryV1,
  CheckpointTransitionV1,
} from "./checkpoints.js";

export const RUNTIME_MODES = Object.freeze([
  "interactive",
  "print",
  "json",
  "rpc",
  "headless",
  "acp",
] as const);
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export const RUNTIME_OUTPUT_FORMATS = Object.freeze(["text", "json"] as const);
export type RuntimeOutputFormat = (typeof RUNTIME_OUTPUT_FORMATS)[number];
export interface TrustSnapshot {
  readonly workspace: "trusted" | "untrusted" | "unknown";
  readonly managedOnly: boolean;
}
export interface ModelRef {
  readonly providerId: string;
  readonly modelId: string;
}
export interface ToolCancelledPayload {
  readonly callId: ToolCallId;
  readonly name: string;
  readonly outcome: "cancelled";
  readonly category: "cancelled";
  readonly message: string;
  /** Compatibility error envelope for consumers that still read `payload.error`. */
  readonly error: RuntimeErrorData;
}
export type EventPhase = "before" | "permission" | "after" | "notification";
export const AGENT_EVENT_TYPES = Object.freeze([
  "runtime.ready",
  "runtime.stopping",
  "runtime.stopped",
  "runtime.failed",
  "session.starting",
  "session.started",
  "session.switching",
  "session.forked",
  "session.tree-changed",
  "session.metadata-changed",
  "session.stopping",
  "session.before-switch",
  "session.before-fork",
  "input.received",
  "input.transformed",
  "input.handled",
  "input.queued",
  "input.rejected",
  "agent.starting",
  "agent.started",
  "agent.settled",
  "agent.ended",
  "turn.started",
  "turn.ended",
  "message.started",
  "message.delta",
  "message.ended",
  "tool.requested",
  "permission.requested",
  "tool.blocked",
  "tool.started",
  "tool.updated",
  "tool.ended",
  "checkpoint.prepared",
  "checkpoint.recovered",
  "rewind.prepared",
  "rewind.completed",
  "worker.started",
  "worker.progress",
  "worker.stopped",
  "model.selected",
  "model.thinking-level-selected",
  "provider.request-started",
  "provider.response-received",
  "provider.failed",
  "context.appended",
  "context.usage-changed",
  "context.artifacts-projected",
  "context.compaction-started",
  "context.compaction-retrying",
  "context.compacted",
  "context.compaction-failed",
  "ui.interaction-requested",
  "ui.interaction-resolved",
  "ui.notification",
  "ui.status-changed",
  "ui.presentation-changed",
  "resources.discovering",
  "resources.discovered",
  "trust.resolving",
  "trust.resolved",
  "prompt.assembling",
  "prompt.assembled",
  "context.preparing",
  "agent.before-start",
  "settings.changed",
  "plugin.lifecycle",
] as const);
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface AgentEventPayloadMap {
  readonly "runtime.ready": Record<string, never>;
  readonly "runtime.stopping": Record<string, never>;
  readonly "runtime.stopped": Record<string, never>;
  readonly "runtime.failed": { readonly message: string };
  readonly "session.starting": { readonly reason?: string };
  readonly "session.stopping": { readonly reason?: string };
  readonly "input.received": {
    readonly text: string;
    readonly attachments?: readonly RuntimeUserAttachmentMetadataV1[];
    readonly kind?: "steer" | "follow-up";
    readonly source?: string;
  };
  readonly "input.queued": {
    readonly kind: "steer" | "follow-up";
    readonly text: string;
    readonly attachments?: readonly RuntimeUserAttachmentMetadataV1[];
    readonly position: number;
  };
  readonly "input.rejected": {
    readonly kind?: "steer" | "follow-up";
    readonly text: string;
    readonly attachments?: readonly RuntimeUserAttachmentMetadataV1[];
    readonly reason: string;
    readonly limit?: number;
  };
  readonly "agent.ended": {
    readonly turnId: TurnId;
    readonly stop: string;
  };
  readonly "turn.started": { readonly turnId: TurnId };
  readonly "turn.ended": { readonly turnId: TurnId; readonly stop: string };
  readonly "tool.requested": {
    readonly callId: ToolCallId;
    readonly name: string;
    readonly input: unknown;
    readonly origin?: "runtime";
  };
  readonly "tool.blocked": {
    readonly callId: ToolCallId;
    readonly name: string;
    readonly error: string;
    readonly category?: string;
  };
  readonly "tool.started": {
    readonly callId: ToolCallId;
    readonly name: string;
  };
  readonly "tool.updated": {
    readonly callId: ToolCallId;
    readonly name: string;
    readonly update: unknown;
  };
  readonly "permission.requested": {
    readonly callId: string;
    readonly name: string;
    readonly input: unknown;
    readonly policy: unknown;
  };
  readonly "tool.ended": {
    readonly callId: ToolCallId;
    readonly name: string;
    readonly outcome: "success" | "failed" | "blocked" | "cancelled" | "error";
    readonly input?: unknown;
    readonly result?: unknown;
    readonly error?: string | RuntimeErrorData;
    readonly message?: string;
    readonly category?: string;
  };
  readonly "checkpoint.prepared": {
    readonly schemaVersion: 1;
    readonly transition: CheckpointTransitionV1;
  };
  readonly "checkpoint.recovered": {
    readonly schemaVersion: 1;
    readonly recovery: CheckpointRecoveryV1;
  };
  readonly "rewind.prepared": {
    readonly schemaVersion: 1;
    readonly transition: CheckpointTransitionV1;
  };
  readonly "rewind.completed": {
    readonly schemaVersion: 1;
    readonly recovery: CheckpointRecoveryV1;
  };
  readonly "worker.started": {
    readonly workerId: string;
    readonly agentType?: string;
    readonly state: "running";
  };
  readonly "worker.progress": {
    readonly workerId: string;
    readonly agentType?: string;
    readonly state: WorkerOperationalState;
    readonly active: number;
    readonly queued: number;
    readonly maxActive: number;
    readonly planStepId?: string;
    readonly taskLabel?: string;
  };
  readonly "worker.stopped": {
    readonly workerId: string;
    readonly agentType?: string;
    readonly state: WorkerTerminalOutcome;
  };
  readonly "context.compaction-started": {
    readonly reason: "manual" | "threshold" | "overflow";
  };
  readonly "context.compacted": {
    readonly reason: "manual" | "threshold" | "overflow";
    readonly summary: string;
  };
  readonly "context.compaction-failed": {
    readonly reason: "manual" | "threshold" | "overflow";
    readonly category: RuntimeErrorData["category"];
    readonly message: string;
  };
  readonly "message.started": {
    readonly requestId: string;
    readonly messageId: string;
    readonly role: "assistant";
    readonly iteration: number;
    readonly attempt: number;
  };
  readonly "message.delta": (
    | {
        readonly type: "text" | "thinking";
        readonly text: string;
        readonly segment?: "thinking";
      }
    | {
        readonly type: "tool-call";
        readonly id: string;
        readonly name: string;
        readonly input: unknown;
      }
  ) & { readonly requestId: string; readonly messageId: string };
  readonly "message.ended": {
    readonly requestId: string;
    readonly messageId: string;
    readonly status: "complete" | "cancelled" | "error";
    readonly retrying?: boolean;
  };
  readonly "provider.request-started": {
    readonly requestId: string;
    readonly iteration: number;
    readonly attempt: number;
    readonly maxAttempts: number;
  };
  readonly "provider.response-received": {
    readonly requestId: string;
    readonly iteration: number;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly durationMs: number;
    readonly ttftMs?: number;
    readonly stop: "complete" | "tool" | "cancelled" | "length" | "error";
    readonly usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens?: number;
      readonly cacheWriteInputTokens?: number;
    };
  };
  readonly "provider.failed": {
    readonly requestId?: string;
    readonly iteration: number;
    readonly attempt?: number;
    readonly maxAttempts?: number;
    readonly retrying?: boolean;
    readonly category?: RuntimeErrorData["category"];
    readonly durationMs?: number;
    readonly delayMs?: number;
    readonly message: string;
  };
  readonly "context.usage-changed": {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
  };
  readonly "context.appended": {
    readonly eventId: string;
    readonly text: string;
    readonly provenance: "peer-attributed-data";
  };
  readonly "context.artifacts-projected": ContextProjectionReceiptV1;
}

function exhaustiveEventPayloadTypes<
  const TTypes extends readonly (keyof AgentEventPayloadMap)[],
>(
  types: TTypes &
    (Exclude<keyof AgentEventPayloadMap, TTypes[number]> extends never
      ? unknown
      : never),
): TTypes {
  return types;
}

export const AGENT_EVENT_PAYLOAD_TYPES = Object.freeze(
  exhaustiveEventPayloadTypes([
    "runtime.ready",
    "runtime.stopping",
    "runtime.stopped",
    "runtime.failed",
    "session.starting",
    "session.stopping",
    "input.received",
    "input.queued",
    "input.rejected",
    "agent.ended",
    "turn.started",
    "turn.ended",
    "tool.requested",
    "tool.blocked",
    "tool.started",
    "tool.updated",
    "permission.requested",
    "tool.ended",
    "checkpoint.prepared",
    "checkpoint.recovered",
    "rewind.prepared",
    "rewind.completed",
    "worker.started",
    "worker.progress",
    "worker.stopped",
    "context.compaction-started",
    "context.compacted",
    "context.compaction-failed",
    "message.started",
    "message.delta",
    "message.ended",
    "provider.request-started",
    "provider.response-received",
    "provider.failed",
    "context.usage-changed",
    "context.appended",
    "context.artifacts-projected",
  ] as const),
);

export interface AgentEventEnvelope<
  TType extends AgentEventType = AgentEventType,
  TPayload = unknown,
> {
  readonly schemaVersion: 1;
  readonly eventVersion: 1;
  readonly id: EventId;
  readonly type: TType;
  readonly phase: EventPhase;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly parentEventId?: EventId;
  readonly timestamp: number;
  readonly cwd: string;
  readonly mode: RuntimeMode;
  readonly outputFormat?: RuntimeOutputFormat;
  readonly model?: ModelRef;
  readonly trust: TrustSnapshot;
  readonly payload: Readonly<TPayload>;
}
export type RuntimeEventByType = {
  readonly [TType in AgentEventType]: AgentEventEnvelope<
    TType,
    TType extends keyof AgentEventPayloadMap
      ? AgentEventPayloadMap[TType]
      : unknown
  >;
};
export type RuntimeEventOf<TType extends AgentEventType> =
  RuntimeEventByType[TType];
export type RuntimeEventPayload<TType extends AgentEventType> =
  RuntimeEventOf<TType>["payload"];
export type TypedRuntimeEvent<TType extends keyof AgentEventPayloadMap> =
  RuntimeEventOf<TType>;
export type OpaqueAgentEventType = Exclude<
  AgentEventType,
  keyof AgentEventPayloadMap
>;
export type OpaqueRuntimeEvent<
  TType extends OpaqueAgentEventType = OpaqueAgentEventType,
> = AgentEventEnvelope<TType, unknown>;
export type RuntimeEvent =
  RuntimeEventByType[keyof AgentEventPayloadMap] | OpaqueRuntimeEvent;
