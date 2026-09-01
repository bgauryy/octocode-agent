import {
  AGENT_EVENT_TYPES,
  type AgentEventEnvelope,
  type AgentEventType,
  type RuntimeEvent,
} from "@octocodeai/agent-core";
import type {
  AgentControlEventByTypeV1,
  AgentControlEventTypeV1,
  AgentLifecycleEventTypeV1,
  AgentLifecycleEventV1,
} from "./api/v1.js";

const OPAQUE_REDACTED_KEYS_V1 = Object.freeze([
  "callId",
  "name",
  "outcome",
  "category",
  "source",
  "workerId",
  "turnId",
  "stop",
  "status",
  "current",
  "total",
  "attempt",
] as const);
const NONE = Object.freeze([] as const);
const CALL = Object.freeze(["callId", "name"] as const);
const OPAQUE = OPAQUE_REDACTED_KEYS_V1;

export const PUBLIC_REDACTED_PAYLOAD_KEYS_V1 = Object.freeze({
  "runtime.ready": NONE,
  "runtime.stopping": NONE,
  "runtime.stopped": NONE,
  "runtime.failed": NONE,
  "session.starting": NONE,
  "session.started": OPAQUE,
  "session.switching": OPAQUE,
  "session.forked": OPAQUE,
  "session.tree-changed": OPAQUE,
  "session.metadata-changed": OPAQUE,
  "session.stopping": NONE,
  "session.before-switch": OPAQUE,
  "session.before-fork": OPAQUE,
  "input.received": Object.freeze(["source"] as const),
  "input.transformed": OPAQUE,
  "input.handled": OPAQUE,
  "input.queued": NONE,
  "input.rejected": NONE,
  "agent.starting": OPAQUE,
  "agent.started": OPAQUE,
  "agent.settled": OPAQUE,
  "agent.ended": Object.freeze(["turnId", "stop"] as const),
  "turn.started": Object.freeze(["turnId"] as const),
  "turn.ended": Object.freeze(["turnId", "stop"] as const),
  "message.started": Object.freeze(["attempt"] as const),
  "message.delta": Object.freeze(["name"] as const),
  "message.ended": Object.freeze(["status"] as const),
  "tool.requested": CALL,
  "permission.requested": CALL,
  "tool.blocked": Object.freeze(["callId", "name", "category"] as const),
  "tool.started": CALL,
  "tool.updated": CALL,
  "tool.ended": Object.freeze([
    "callId",
    "name",
    "outcome",
    "category",
  ] as const),
  "checkpoint.prepared": Object.freeze(["schemaVersion"] as const),
  "checkpoint.recovered": Object.freeze(["schemaVersion"] as const),
  "rewind.prepared": Object.freeze(["schemaVersion"] as const),
  "rewind.completed": Object.freeze(["schemaVersion"] as const),
  "worker.started": Object.freeze(["workerId"] as const),
  "worker.progress": Object.freeze([
    "workerId",
    "agentType",
    "state",
    "active",
    "queued",
    "maxActive",
    "planStepId",
    "taskLabel",
  ] as const),
  "worker.stopped": Object.freeze(["workerId"] as const),
  "model.selected": OPAQUE,
  "model.thinking-level-selected": OPAQUE,
  "provider.request-started": Object.freeze(["attempt"] as const),
  "provider.response-received": Object.freeze(["attempt", "stop"] as const),
  "provider.failed": Object.freeze(["attempt", "category"] as const),
  "context.appended": NONE,
  "context.usage-changed": NONE,
  "context.artifacts-projected": Object.freeze([
    "phase",
    "sourceCount",
    "projectedCount",
    "droppedCount",
    "stablePrefixDigest",
  ] as const),
  "context.compaction-started": NONE,
  "context.compaction-retrying": OPAQUE,
  "context.compacted": NONE,
  "context.compaction-failed": Object.freeze(["category"] as const),
  "ui.interaction-requested": OPAQUE,
  "ui.interaction-resolved": OPAQUE,
  "ui.notification": OPAQUE,
  "ui.status-changed": OPAQUE,
  "ui.presentation-changed": OPAQUE,
  "resources.discovering": OPAQUE,
  "resources.discovered": OPAQUE,
  "trust.resolving": OPAQUE,
  "trust.resolved": OPAQUE,
  "prompt.assembling": OPAQUE,
  "prompt.assembled": OPAQUE,
  "context.preparing": OPAQUE,
  "agent.before-start": OPAQUE,
  "settings.changed": OPAQUE,
  "plugin.lifecycle": OPAQUE,
} satisfies Record<AgentEventType, readonly string[]>);

const _publicEventVocabularyAlignment: Readonly<
  Record<AgentControlEventTypeV1, true>
> = Object.freeze(
  Object.fromEntries(AGENT_EVENT_TYPES.map((type) => [type, true])),
) as Readonly<Record<AgentControlEventTypeV1, true>>;
void _publicEventVocabularyAlignment;

export function projectControlEventV1(
  event: RuntimeEvent,
): AgentControlEventByTypeV1 {
  return deepFreeze({
    ...publicMetadata(event, false),
    schemaVersion: 1 as const,
    type: event.type,
    dataClassification: "redacted" as const,
    payload: redactedPayload(event.type, event.payload),
  }) as AgentControlEventByTypeV1;
}

export function projectSensitiveLifecycleEventV1<
  TEvent extends AgentLifecycleEventTypeV1,
>(
  event: AgentEventEnvelope<AgentEventType, unknown>,
  eventType: TEvent,
): AgentLifecycleEventV1<TEvent, "sensitive"> {
  assertLifecycleType(event, eventType);
  return deepFreeze({
    ...publicMetadata(event, true),
    schemaVersion: 1 as const,
    type: eventType,
    eventType,
    dataClassification: "sensitive" as const,
    payload: structuredClone(event.payload),
  }) as AgentLifecycleEventV1<TEvent, "sensitive">;
}

export function projectObservedLifecycleEventV1<
  TEvent extends AgentLifecycleEventTypeV1,
>(
  event: AgentEventEnvelope<AgentEventType, unknown>,
  eventType: TEvent,
): AgentLifecycleEventV1<TEvent, "redacted"> {
  assertLifecycleType(event, eventType);
  return deepFreeze({
    ...publicMetadata(event, false),
    schemaVersion: 1 as const,
    type: eventType,
    eventType,
    dataClassification: "redacted" as const,
    payload: redactedPayload(event.type, event.payload),
  }) as AgentLifecycleEventV1<TEvent, "redacted">;
}

function assertLifecycleType(
  event: AgentEventEnvelope<AgentEventType, unknown>,
  eventType: AgentLifecycleEventTypeV1,
): void {
  if (event.type !== eventType)
    throw new TypeError(
      `Lifecycle event type mismatch: expected ${eventType}, received ${event.type}`,
    );
}

function publicMetadata(
  event: AgentEventEnvelope<AgentEventType, unknown>,
  includeSensitive: boolean,
): Record<string, unknown> {
  return {
    id: String(event.id),
    type: event.type,
    phase: event.phase,
    sessionId: String(event.sessionId),
    timestamp: event.timestamp,
    ...(includeSensitive ? { cwd: event.cwd } : {}),
    mode: event.mode,
    ...(event.outputFormat === undefined
      ? {}
      : { outputFormat: event.outputFormat }),
    ...(event.model === undefined
      ? {}
      : { model: structuredClone(event.model) }),
    trust: structuredClone(event.trust),
  };
}

function redactedPayload(
  type: AgentEventType,
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return Object.freeze({});
  const projected: Record<string, string | number | boolean | null> = {};
  for (const key of PUBLIC_REDACTED_PAYLOAD_KEYS_V1[type]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const child = (value as Record<string, unknown>)[key];
    if (
      typeof child === "string" ||
      typeof child === "number" ||
      typeof child === "boolean" ||
      child === null
    )
      projected[key] = child;
  }
  return Object.freeze(projected);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
