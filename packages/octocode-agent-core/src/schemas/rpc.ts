import { RuntimeFailure } from "../contracts/errors.js";
import type { RuntimeErrorData } from "../contracts/errors.js";
import { assertContextProjectionReceipt } from "../contracts/context-artifacts.js";
import { assertCheckpointEventPayloadV1 } from "../events/checkpoints.js";
import {
  AGENT_EVENT_PAYLOAD_TYPES,
  AGENT_EVENT_TYPES,
  RUNTIME_MODES,
  RUNTIME_OUTPUT_FORMATS,
  type RuntimeEvent,
} from "../contracts/events.js";
import type { RpcEvent, RpcRequest, RpcResponse } from "../contracts/rpc.js";

const ERROR_CATEGORIES = new Set([
  "validation",
  "protocol",
  "unsupported-version",
  "unsupported-capability",
  "trust",
  "approval",
  "plan-policy",
  "peer-lock",
  "cancelled",
  "timeout",
  "provider",
  "model",
  "tool-execution",
  "session-conflict",
  "session-corruption",
  "session-migration",
  "persistence",
  "compaction",
  "adapter-compatibility",
  "adapter-translation",
  "conflict",
  "plugin",
  "internal-invariant",
]);
const EVENT_TYPES: ReadonlySet<string> = new Set(AGENT_EVENT_TYPES);
const EVENT_PAYLOAD_TYPES: ReadonlySet<string> = new Set(
  AGENT_EVENT_PAYLOAD_TYPES,
);
const EVENT_PHASES = new Set(["before", "permission", "after", "notification"]);
const RPC_RUNTIME_MODES: ReadonlySet<string> = new Set(RUNTIME_MODES);
const RPC_OUTPUT_FORMATS: ReadonlySet<string> = new Set(RUNTIME_OUTPUT_FORMATS);
const WORKER_TERMINAL_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "aborted",
  "killed",
]);

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const isBoundedSessionCount = (value: unknown): value is number | "unknown" =>
  value === "unknown" ||
  (isNonNegativeInteger(value) && (value as number) <= 10_000_000);

function isBoundedSessionDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= 120 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function isSessionContextOccupancy(value: unknown): boolean {
  if (value === "unknown") return true;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["used", "limit"]) ||
    !Object.hasOwn(value, "used") ||
    !Object.hasOwn(value, "limit") ||
    !isBoundedSessionCount(value.used) ||
    !isBoundedSessionCount(value.limit)
  ) {
    return false;
  }
  return (
    typeof value.used !== "number" ||
    typeof value.limit !== "number" ||
    value.used <= value.limit
  );
}

function isSessionReceipt(type: unknown, value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "transition",
      "displayName",
      "shortPublicId",
      "state",
      "restoredVisibleMessageCount",
      "retainedModelContextItemCount",
      "contextOccupancy",
      "committedCompaction",
    ]) ||
    value.schemaVersion !== 1 ||
    !isBoundedSessionDisplayName(value.displayName) ||
    typeof value.shortPublicId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{3,23}$/u.test(value.shortPublicId) ||
    !isBoundedSessionCount(value.restoredVisibleMessageCount) ||
    !isBoundedSessionCount(value.retainedModelContextItemCount) ||
    !isSessionContextOccupancy(value.contextOccupancy) ||
    (value.committedCompaction !== "none" &&
      value.committedCompaction !== "committed" &&
      value.committedCompaction !== "unknown")
  ) {
    return false;
  }

  if (type === "session.forked") {
    return value.transition === "fork" && value.state === "forked";
  }
  if (type !== "session.started") return false;
  if (value.transition === "create") {
    if (value.state !== "fresh") return false;
  } else if (value.transition === "resume" || value.transition === "switch") {
    if (
      value.state !== "resumed-empty" &&
      value.state !== "resumed" &&
      value.state !== "resumed-compacted" &&
      value.state !== "recovered-partially"
    ) {
      return false;
    }
  } else {
    return false;
  }

  if (value.state === "fresh" || value.state === "resumed-empty") {
    if (value.restoredVisibleMessageCount !== 0) return false;
  } else if (value.state === "resumed" || value.state === "resumed-compacted") {
    if (
      typeof value.restoredVisibleMessageCount !== "number" ||
      value.restoredVisibleMessageCount === 0
    ) {
      return false;
    }
  }
  if (value.state === "resumed-compacted") {
    return value.committedCompaction === "committed";
  }
  if (
    value.state === "fresh" ||
    value.state === "resumed-empty" ||
    value.state === "resumed"
  ) {
    return value.committedCompaction === "none";
  }
  return true;
}

function isUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
    ]) &&
    isNonNegativeInteger(value.inputTokens) &&
    isNonNegativeInteger(value.outputTokens) &&
    (value.cachedInputTokens === undefined ||
      isNonNegativeInteger(value.cachedInputTokens)) &&
    (value.cacheWriteInputTokens === undefined ||
      isNonNegativeInteger(value.cacheWriteInputTokens))
  );
}

function isContextUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "inputTokens",
      "outputTokens",
      "currentContextTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
    ]) &&
    isNonNegativeInteger(value.inputTokens) &&
    isNonNegativeInteger(value.outputTokens) &&
    isNonNegativeInteger(value.currentContextTokens) &&
    (value.cachedInputTokens === undefined ||
      isNonNegativeInteger(value.cachedInputTokens)) &&
    (value.cacheWriteInputTokens === undefined ||
      isNonNegativeInteger(value.cacheWriteInputTokens))
  );
}

function isInputAttachments(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= 8 && value.every((attachment) =>
    isRecord(attachment) &&
    hasOnlyKeys(attachment, ["schemaVersion", "type", "partIndex", "mediaType", "byteLength", "filename"]) &&
    attachment.schemaVersion === 1 && attachment.type === "image" &&
    isNonNegativeInteger(attachment.partIndex) &&
    (attachment.mediaType === "image/png" || attachment.mediaType === "image/jpeg" || attachment.mediaType === "image/gif" || attachment.mediaType === "image/webp") &&
    isNonNegativeInteger(attachment.byteLength) &&
    attachment.byteLength <= 10 * 1_048_576 &&
    isOptionalString(attachment.filename)
  ));
}

function isMappedEventPayload(type: unknown, payload: unknown): boolean {
  if (
    type === "runtime.ready" ||
    type === "runtime.stopping" ||
    type === "runtime.stopped"
  ) {
    return isRecord(payload) && hasOnlyKeys(payload, []);
  }
  if (type === "runtime.failed") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["message"]) &&
      typeof payload.message === "string"
    );
  }
  if (type === "session.started" || type === "session.forked") {
    return isSessionReceipt(type, payload);
  }
  if (type === "session.starting" || type === "session.stopping") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["reason"]) &&
      isOptionalString(payload.reason)
    );
  }
  if (type === "input.received") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["text", "attachments", "kind", "source"]) &&
      typeof payload.text === "string" &&
      isInputAttachments(payload.attachments) &&
      (payload.kind === undefined ||
        payload.kind === "steer" ||
        payload.kind === "follow-up") &&
      isOptionalString(payload.source)
    );
  }
  if (type === "input.queued") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["kind", "text", "attachments", "position"]) &&
      (payload.kind === "steer" || payload.kind === "follow-up") &&
      typeof payload.text === "string" &&
      isInputAttachments(payload.attachments) &&
      isNonNegativeInteger(payload.position)
    );
  }
  if (type === "input.rejected") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["kind", "text", "attachments", "reason", "limit"]) &&
      (payload.kind === undefined ||
        payload.kind === "steer" ||
        payload.kind === "follow-up") &&
      typeof payload.text === "string" &&
      isInputAttachments(payload.attachments) &&
      typeof payload.reason === "string" &&
      (payload.limit === undefined || isNonNegativeInteger(payload.limit))
    );
  }
  if (type === "agent.ended" || type === "turn.ended") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["turnId", "stop"]) &&
      isNonEmptyString(payload.turnId) &&
      typeof payload.stop === "string"
    );
  }
  if (type === "turn.started") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["turnId"]) &&
      isNonEmptyString(payload.turnId)
    );
  }
  if (type === "tool.requested") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["callId", "name", "input", "origin"]) &&
      isNonEmptyString(payload.callId) &&
      isNonEmptyString(payload.name) &&
      Object.hasOwn(payload, "input") &&
      (payload.origin === undefined || payload.origin === "runtime")
    );
  }
  if (type === "permission.requested") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["callId", "name", "input", "policy"]) &&
      isNonEmptyString(payload.callId) &&
      isNonEmptyString(payload.name) &&
      Object.hasOwn(payload, "input") &&
      Object.hasOwn(payload, "policy")
    );
  }
  if (type === "tool.blocked") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["callId", "name", "error", "category"]) &&
      isNonEmptyString(payload.callId) &&
      isNonEmptyString(payload.name) &&
      typeof payload.error === "string" &&
      isOptionalString(payload.category)
    );
  }
  if (type === "tool.started") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["callId", "name"]) &&
      isNonEmptyString(payload.callId) &&
      isNonEmptyString(payload.name)
    );
  }
  if (type === "tool.updated") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["callId", "name", "update"]) &&
      isNonEmptyString(payload.callId) &&
      isNonEmptyString(payload.name) &&
      Object.hasOwn(payload, "update")
    );
  }
  if (type === "tool.ended") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, [
        "callId",
        "name",
        "outcome",
        "input",
        "result",
        "error",
        "message",
        "category",
      ]) &&
      isNonEmptyString(payload.callId) &&
      isNonEmptyString(payload.name) &&
      (payload.outcome === "success" ||
        payload.outcome === "failed" ||
        payload.outcome === "blocked" ||
        payload.outcome === "cancelled" ||
        payload.outcome === "error") &&
      (payload.error === undefined ||
        typeof payload.error === "string" ||
        isRuntimeErrorData(payload.error)) &&
      isOptionalString(payload.message) &&
      isOptionalString(payload.category)
    );
  }
  if (type === "worker.started") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["workerId", "agentType", "state"]) &&
      isNonEmptyString(payload.workerId) &&
      isOptionalString(payload.agentType) &&
      payload.state === "running"
    );
  }
  if (type === "worker.progress") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, [
        "workerId",
        "agentType",
        "state",
        "active",
        "queued",
        "maxActive",
        "planStepId",
        "taskLabel",
      ]) &&
      isNonEmptyString(payload.workerId) &&
      isOptionalString(payload.agentType) &&
      (payload.state === "queued" ||
        payload.state === "running" ||
        WORKER_TERMINAL_STATES.has(String(payload.state))) &&
      isNonNegativeInteger(payload.active) &&
      isNonNegativeInteger(payload.queued) &&
      isNonNegativeInteger(payload.maxActive) &&
      payload.maxActive > 0 &&
      payload.active <= payload.maxActive &&
      isOptionalString(payload.planStepId) &&
      isOptionalString(payload.taskLabel)
    );
  }
  if (type === "worker.stopped") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["workerId", "agentType", "state"]) &&
      isNonEmptyString(payload.workerId) &&
      isOptionalString(payload.agentType) &&
      typeof payload.state === "string" &&
      WORKER_TERMINAL_STATES.has(payload.state)
    );
  }
  if (type === "context.compaction-started") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["reason"]) &&
      (payload.reason === "manual" ||
        payload.reason === "threshold" ||
        payload.reason === "overflow")
    );
  }
  if (type === "context.artifacts-projected") {
    try {
      assertContextProjectionReceipt(payload);
      return true;
    } catch {
      return false;
    }
  }
  if (type === "context.compacted") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["reason", "summary"]) &&
      (payload.reason === "manual" ||
        payload.reason === "threshold" ||
        payload.reason === "overflow") &&
      typeof payload.summary === "string"
    );
  }
  if (type === "context.compaction-failed") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["reason", "category", "message"]) &&
      (payload.reason === "manual" ||
        payload.reason === "threshold" ||
        payload.reason === "overflow") &&
      typeof payload.category === "string" &&
      ERROR_CATEGORIES.has(payload.category) &&
      typeof payload.message === "string"
    );
  }
  if (type === "context.appended") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["eventId", "text", "provenance"]) &&
      isNonEmptyString(payload.eventId) &&
      isNonEmptyString(payload.text) &&
      payload.provenance === "peer-attributed-data"
    );
  }
  if (type === "message.started") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, [
        "requestId",
        "messageId",
        "role",
        "iteration",
        "attempt",
      ]) &&
      isNonEmptyString(payload.requestId) &&
      isNonEmptyString(payload.messageId) &&
      payload.role === "assistant" &&
      isNonNegativeInteger(payload.iteration) &&
      isNonNegativeInteger(payload.attempt)
    );
  }
  if (type === "message.delta") {
    if (
      !isRecord(payload) ||
      !isNonEmptyString(payload.requestId) ||
      !isNonEmptyString(payload.messageId)
    )
      return false;
    if (payload.type === "text" || payload.type === "thinking") {
      return (
        hasOnlyKeys(payload, [
          "type",
          "text",
          "requestId",
          "messageId",
          "segment",
        ]) &&
        typeof payload.text === "string" &&
        (payload.segment === undefined ||
          (payload.type === "thinking" && payload.segment === "thinking"))
      );
    }
    return (
      payload.type === "tool-call" &&
      hasOnlyKeys(payload, [
        "type",
        "id",
        "name",
        "input",
        "requestId",
        "messageId",
      ]) &&
      isNonEmptyString(payload.id) &&
      isNonEmptyString(payload.name) &&
      Object.hasOwn(payload, "input")
    );
  }
  if (type === "message.ended") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, ["requestId", "messageId", "status", "retrying"]) &&
      isNonEmptyString(payload.requestId) &&
      isNonEmptyString(payload.messageId) &&
      (payload.status === "complete" ||
        payload.status === "cancelled" ||
        payload.status === "error") &&
      (payload.retrying === undefined || typeof payload.retrying === "boolean")
    );
  }
  if (type === "provider.request-started") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, [
        "requestId",
        "iteration",
        "attempt",
        "maxAttempts",
      ]) &&
      isNonEmptyString(payload.requestId) &&
      isNonNegativeInteger(payload.iteration) &&
      isNonNegativeInteger(payload.attempt) &&
      isNonNegativeInteger(payload.maxAttempts)
    );
  }
  if (type === "provider.response-received") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, [
        "requestId",
        "iteration",
        "attempt",
        "maxAttempts",
        "durationMs",
        "ttftMs",
        "stop",
        "usage",
      ]) &&
      isNonEmptyString(payload.requestId) &&
      isNonNegativeInteger(payload.iteration) &&
      isNonNegativeInteger(payload.attempt) &&
      isNonNegativeInteger(payload.maxAttempts) &&
      isNonNegativeNumber(payload.durationMs) &&
      (payload.ttftMs === undefined || isNonNegativeNumber(payload.ttftMs)) &&
      (payload.stop === "complete" ||
        payload.stop === "tool" ||
        payload.stop === "cancelled" ||
        payload.stop === "length" ||
        payload.stop === "error") &&
      isUsage(payload.usage)
    );
  }
  if (type === "provider.failed") {
    return (
      isRecord(payload) &&
      hasOnlyKeys(payload, [
        "requestId",
        "iteration",
        "attempt",
        "maxAttempts",
        "retrying",
        "category",
        "durationMs",
        "delayMs",
        "message",
      ]) &&
      (payload.requestId === undefined ||
        isNonEmptyString(payload.requestId)) &&
      isNonNegativeInteger(payload.iteration) &&
      (payload.attempt === undefined ||
        isNonNegativeInteger(payload.attempt)) &&
      (payload.maxAttempts === undefined ||
        isNonNegativeInteger(payload.maxAttempts)) &&
      (payload.retrying === undefined ||
        typeof payload.retrying === "boolean") &&
      (payload.category === undefined ||
        (typeof payload.category === "string" &&
          ERROR_CATEGORIES.has(payload.category))) &&
      (payload.durationMs === undefined ||
        isNonNegativeNumber(payload.durationMs)) &&
      (payload.delayMs === undefined || isNonNegativeNumber(payload.delayMs)) &&
      typeof payload.message === "string"
    );
  }
  if (type === "context.usage-changed") return isContextUsage(payload);
  if (
    type === "checkpoint.prepared" ||
    type === "checkpoint.recovered" ||
    type === "rewind.prepared" ||
    type === "rewind.completed"
  ) {
    if (!isRecord(payload)) return false;
    try {
      assertCheckpointEventPayloadV1(type, payload);
      return true;
    } catch {
      return false;
    }
  }
  return !EVENT_PAYLOAD_TYPES.has(String(type));
}

function isRuntimeErrorData(value: unknown): value is RuntimeErrorData {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "category",
      "message",
      "retry",
      "userVisible",
      "redaction",
      "terminalEffect",
      "safeCause",
      "retryAfterMs",
    ])
  )
    return false;
  return (
    typeof value.category === "string" &&
    ERROR_CATEGORIES.has(value.category) &&
    typeof value.message === "string" &&
    (value.retry === "safe" ||
      value.retry === "unsafe" ||
      value.retry === "unknown") &&
    typeof value.userVisible === "boolean" &&
    (value.redaction === "public" ||
      value.redaction === "sensitive" ||
      value.redaction === "secret" ||
      value.redaction === "internal") &&
    (value.terminalEffect === "none" ||
      value.terminalEffect === "operation" ||
      value.terminalEffect === "session" ||
      value.terminalEffect === "runtime") &&
    isOptionalString(value.safeCause) &&
    (value.retryAfterMs === undefined ||
      (typeof value.retryAfterMs === "number" &&
        Number.isFinite(value.retryAfterMs) &&
        value.retryAfterMs >= 0))
  );
}

function isModelRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["providerId", "modelId"]) &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.modelId)
  );
}

function isTrustSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["workspace", "managedOnly"]) &&
    (value.workspace === "trusted" ||
      value.workspace === "untrusted" ||
      value.workspace === "unknown") &&
    typeof value.managedOnly === "boolean"
  );
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "eventVersion",
      "id",
      "type",
      "phase",
      "sessionId",
      "turnId",
      "parentEventId",
      "timestamp",
      "cwd",
      "mode",
      "outputFormat",
      "model",
      "trust",
      "payload",
    ])
  )
    return false;
  return (
    value.schemaVersion === 1 &&
    value.eventVersion === 1 &&
    isNonEmptyString(value.id) &&
    typeof value.type === "string" &&
    EVENT_TYPES.has(value.type) &&
    typeof value.phase === "string" &&
    EVENT_PHASES.has(value.phase) &&
    isNonEmptyString(value.sessionId) &&
    (value.turnId === undefined || isNonEmptyString(value.turnId)) &&
    (value.parentEventId === undefined ||
      isNonEmptyString(value.parentEventId)) &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    typeof value.cwd === "string" &&
    typeof value.mode === "string" &&
    RPC_RUNTIME_MODES.has(value.mode) &&
    (value.outputFormat === undefined ||
      (typeof value.outputFormat === "string" &&
        RPC_OUTPUT_FORMATS.has(value.outputFormat))) &&
    (value.model === undefined || isModelRef(value.model)) &&
    isTrustSnapshot(value.trust) &&
    Object.hasOwn(value, "payload") &&
    value.payload !== undefined &&
    isMappedEventPayload(value.type, value.payload)
  );
}

function isRuntimeCommand(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "input.submit":
    case "input.steer":
    case "input.follow-up":
      return (
        typeof command.text === "string" &&
        hasOnlyKeys(command, ["type", "text"])
      );
    case "input.cancel":
      return (
        isOptionalString(command.reason) &&
        hasOnlyKeys(command, ["type", "reason"])
      );
    case "session.create":
      return (
        isOptionalString(command.id) &&
        isOptionalString(command.name) &&
        hasOnlyKeys(command, ["type", "id", "name"])
      );
    case "session.resume":
    case "session.switch":
    case "session.fork":
      return (
        typeof command.id === "string" && hasOnlyKeys(command, ["type", "id"])
      );
    case "session.navigate":
      return (
        (command.direction === "parent" ||
          command.direction === "child" ||
          command.direction === "previous" ||
          command.direction === "next") &&
        hasOnlyKeys(command, ["type", "direction"])
      );
    case "session.name":
      return (
        typeof command.name === "string" &&
        hasOnlyKeys(command, ["type", "name"])
      );
    case "model.select":
      return (
        typeof command.providerId === "string" &&
        typeof command.modelId === "string" &&
        hasOnlyKeys(command, ["type", "providerId", "modelId"])
      );
    case "model.thinking":
      return (
        typeof command.level === "string" &&
        hasOnlyKeys(command, ["type", "level"])
      );
    case "context.compact":
      return (
        (command.reason === "manual" ||
          command.reason === "threshold" ||
          command.reason === "overflow") &&
        hasOnlyKeys(command, ["type", "reason"])
      );
    case "context.append":
      return (
        isNonEmptyString(command.eventId) &&
        isNonEmptyString(command.text) &&
        command.provenance === "peer-attributed-data" &&
        hasOnlyKeys(command, ["type", "eventId", "text", "provenance"])
      );
    case "tools.activate":
      return (
        typeof command.name === "string" &&
        hasOnlyKeys(command, ["type", "name"])
      );
    case "session.export":
    case "context.cancel-compaction":
    case "context.usage":
    case "tools.list":
    case "monitoring.snapshot":
    case "runtime.snapshot":
    case "runtime.stop":
      return hasOnlyKeys(command, ["type"]);
    default:
      return false;
  }
}

export const parseRpcRequest = (input: unknown): RpcRequest => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new RuntimeFailure("protocol", "RPC request must be an object");
  const value = input as Record<string, unknown>;
  if (value.protocolVersion !== 1)
    throw new RuntimeFailure(
      "unsupported-version",
      "Unsupported RPC protocol major version",
    );
  if (typeof value.requestId !== "string" || value.requestId.length === 0)
    throw new RuntimeFailure("validation", "Malformed RPC request ID");
  if (
    !hasOnlyKeys(value, ["protocolVersion", "requestId", "command"]) ||
    !isRuntimeCommand(value.command)
  )
    throw new RuntimeFailure("validation", "Malformed RPC command");
  return value as unknown as RpcRequest;
};

export const parseRpcResponse = (input: unknown): RpcResponse => {
  if (!isRecord(input))
    throw new RuntimeFailure("protocol", "RPC response must be an object");
  if (input.protocolVersion !== 1)
    throw new RuntimeFailure(
      "unsupported-version",
      "Unsupported RPC protocol major version",
    );
  if (!isNonEmptyString(input.requestId) || typeof input.ok !== "boolean")
    throw new RuntimeFailure("validation", "Malformed RPC response");
  if (input.ok) {
    if (!hasOnlyKeys(input, ["protocolVersion", "requestId", "ok", "data"]))
      throw new RuntimeFailure("validation", "Malformed RPC response");
  } else if (
    !hasOnlyKeys(input, ["protocolVersion", "requestId", "ok", "error"]) ||
    !isRuntimeErrorData(input.error)
  ) {
    throw new RuntimeFailure("validation", "Malformed RPC response error");
  }
  return input as unknown as RpcResponse;
};

export const parseRpcEvent = (input: unknown): RpcEvent => {
  if (!isRecord(input))
    throw new RuntimeFailure("protocol", "RPC event must be an object");
  if (input.protocolVersion !== 1)
    throw new RuntimeFailure(
      "unsupported-version",
      "Unsupported RPC protocol major version",
    );
  if (
    !hasOnlyKeys(input, ["protocolVersion", "sequence", "event"]) ||
    !Number.isSafeInteger(input.sequence) ||
    (input.sequence as number) <= 0
  ) {
    throw new RuntimeFailure("validation", "Malformed RPC event");
  }
  if (!isRuntimeEvent(input.event)) {
    const payloadInvalid =
      isRecord(input.event) &&
      (!Object.hasOwn(input.event, "payload") ||
        input.event.payload === undefined ||
        !isMappedEventPayload(input.event.type, input.event.payload));
    throw new RuntimeFailure(
      "validation",
      payloadInvalid
        ? "Malformed RPC event payload"
        : "Malformed RPC event envelope",
    );
  }
  return input as unknown as RpcEvent;
};
