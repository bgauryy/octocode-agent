import { createHash } from "node:crypto";
import type {
  ModelMessage,
  RuntimeErrorData,
  RuntimeEvent,
  SessionForkReceiptV1,
  SessionStartedReceiptV1,
} from "@octocodeai/agent-core";
import type { NativePresentationEvent } from "./presentation/contracts.js";

function workerNotificationKey(workerId: string): string {
  return `worker:${createHash("sha256").update(workerId).digest("hex").slice(0, 12)}`;
}

function historyJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

function opaqueRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedLifecycleLabel(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u.test(value)
    ? value
    : undefined;
}

function skillInputSummary(value: unknown): string {
  const input = opaqueRecord(value);
  const summary: Record<string, string> = {};
  for (const key of ["action", "name"] as const) {
    const bounded = boundedLifecycleLabel(input?.[key]);
    if (bounded !== undefined) summary[key] = bounded;
  }
  return JSON.stringify(summary);
}

function skillResultSummary(value: unknown): string {
  const skills = opaqueRecord(value)?.skills;
  const counts = new Map<string, number>();
  if (Array.isArray(skills)) {
    for (const item of skills) {
      const scope = boundedLifecycleLabel(
        opaqueRecord(opaqueRecord(item)?.provenance)?.scope,
      );
      if (scope === undefined) continue;
      const sourceScope = `${scope.slice(0, 1).toUpperCase()}${scope.slice(1)}`;
      counts.set(sourceScope, (counts.get(sourceScope) ?? 0) + 1);
    }
  }
  return JSON.stringify({
    skills: [...counts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceScope, count]) => ({ sourceScope, count })),
  });
}

const WORKER_ACTIONS = new Set([
  "spawn", "schedule", "list", "status", "wait", "send", "steer",
  "follow-up", "abort", "kill",
]);
const WORKER_STATES = new Set([
  "queued", "running", "succeeded", "failed", "aborting", "aborted",
  "killing", "killed",
]);

function workerAction(value: unknown): string | undefined {
  const action = opaqueRecord(value)?.action;
  return typeof action === "string" && WORKER_ACTIONS.has(action)
    ? action
    : undefined;
}

function workerInputSummary(value: unknown): string {
  const action = workerAction(value);
  return JSON.stringify(action === undefined ? {} : { action });
}

function workerResultSummary(value: unknown): string {
  const result = opaqueRecord(value);
  const content = opaqueRecord(result?.content);
  const worker = opaqueRecord(content?.worker);
  const action = workerAction(content);
  const stateValue = worker?.state;
  const state = typeof stateValue === "string" && WORKER_STATES.has(stateValue)
    ? stateValue
    : undefined;
  const status = result?.ok === true ? "success"
    : result?.ok === false ? "error"
      : undefined;
  return JSON.stringify({
    ...(action === undefined ? {} : { action }),
    ...(state === undefined ? {} : { state }),
    ...(status === undefined ? {} : { status }),
  });
}

function sessionReceiptMessage(
  receipt: SessionStartedReceiptV1 | SessionForkReceiptV1,
): string {
  const count = (value: number | "unknown", unit: string): string =>
    value === "unknown" ? `${unit} unknown` : `${value} ${unit}`;
  const state = receipt.state === "fresh" ? "Fresh"
    : receipt.state === "resumed-empty" ? "Resumed empty"
      : receipt.state === "resumed" ? "Resumed"
        : receipt.state === "resumed-compacted" ? "Resumed compacted"
          : receipt.state === "recovered-partially" ? "Partially recovered"
            : "Forked";
  const occupancy = receipt.contextOccupancy === "unknown"
    ? "context occupancy unknown"
    : `${receipt.contextOccupancy.used}/${receipt.contextOccupancy.limit} context tokens`;
  const compaction = receipt.committedCompaction === "committed"
    ? "compacted"
    : receipt.committedCompaction === "none"
      ? "not compacted"
      : "compaction unknown";
  return `${receipt.displayName} · ${receipt.shortPublicId} · ${state} · ${count(receipt.restoredVisibleMessageCount, "messages")} · ${count(receipt.retainedModelContextItemCount, "context items")} · ${occupancy} · ${compaction}`;
}

/** Rebuilds the visible transcript from retained model history without exposing system context. */
export function presentationEventsForHistory(
  messages: readonly ModelMessage[],
): readonly NativePresentationEvent[] {
  const events: NativePresentationEvent[] = [];
  const toolNames = new Map<string, string>();
  messages.forEach((message, index) => {
    const messageId = `history:${index}`;
    if (message.role === "system") return;
    if (message.role === "user") {
      if (message.content.trim()) {
        events.push({ type: "user-message", text: message.content, messageId });
      }
      return;
    }
    if (message.role === "assistant") {
      if (message.content.trim()) {
        events.push(
          { type: "message-started", messageId, role: "assistant" },
          { type: "message-delta", messageId, role: "assistant", segment: "text", text: message.content },
          { type: "message-ended", messageId, status: "complete" },
        );
      }
      for (const call of message.toolCalls ?? []) {
        toolNames.set(call.id, call.name);
        const input = call.name === "worker"
          ? workerInputSummary(call.input)
          : historyJson(call.input);
        events.push({
          type: "tool-prepared",
          callId: call.id,
          name: call.name,
          ...(input === undefined ? {} : { input }),
        });
      }
      return;
    }
    const name = toolNames.get(message.toolCallId) ?? "tool";
    events.push({
      type: "tool-ended",
      callId: message.toolCallId,
      name,
      result: name === "worker"
        ? workerResultSummary(message.result)
        : message.result === undefined
          ? message.content
          : historyJson(message.result),
    });
  });
  return events;
}

/** Translates host-neutral runtime events into terminal presentation semantics. */
export function presentationEvents(
  event: RuntimeEvent,
  activeTurnId?: string,
  options: { readonly contextLimit?: number } = {},
): readonly NativePresentationEvent[] {
  const turn = event.turnId === undefined ? activeTurnId : String(event.turnId);
  const stringify = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return "[unserializable]";
    }
  };
  const errorDetails = (payload: {
    readonly error?: string | RuntimeErrorData;
    readonly category?: string;
  }): { message: string; category?: string } => {
    if (typeof payload.error === "string")
      return {
        message: payload.error,
        ...(typeof payload.category === "string"
          ? { category: payload.category }
          : {}),
      };
    if (typeof payload.error === "object" && payload.error !== null) {
      const error = payload.error;
      return {
        message: error.message,
        ...(error.category
          ? { category: error.category }
          : typeof payload.category === "string"
            ? { category: payload.category }
            : {}),
      };
    }
    return {
      message: "Tool execution failed",
      ...(typeof payload.category === "string"
        ? { category: payload.category }
        : {}),
    };
  };
  switch (event.type) {
    case "runtime.ready":
      return [{ type: "runtime-ready" }];
    case "runtime.stopping":
      return [{ type: "runtime-stopping" }];
    case "runtime.failed":
      return [
        { type: "runtime-failed" },
        { type: "notification", severity: "error", message: event.payload.message },
      ];
    case "session.starting": {
      const action = event.payload.reason === "resume"
        ? "Resuming"
        : event.payload.reason === "fork"
          ? "Forking"
          : "Opening";
      return [{ type: "status-changed", name: "session", text: `${action} session…` }];
    }
    case "session.switching":
      return [{ type: "status-changed", name: "session", text: "Switching sessions…" }];
    case "session.started":
      return [
        { type: "session-replaced" },
        { type: "status-changed", name: "session" },
        { type: "notification", severity: "success", message: sessionReceiptMessage(event.payload) },
      ];
    case "session.forked":
      return [
        { type: "session-replaced" },
        { type: "status-changed", name: "session" },
        { type: "notification", severity: "success", message: sessionReceiptMessage(event.payload) },
      ];
    case "input.received":
      return [
        {
          type: "input-received",
          text: event.payload.text,
          ...(turn === undefined ? {} : { turnId: turn }),
        },
      ];
    case "input.queued": {
      const payload = event.payload;
      const position =
        typeof payload.position === "number" ? payload.position : undefined;
      const kind = payload.kind === "steer" ? "Steer" : "Follow-up";
      return [
        {
          type: "notification",
          severity: "info",
          message: `${kind} queued${position === undefined ? "" : ` · position ${position}`}`,
        },
      ];
    }
    case "input.rejected": {
      const payload = event.payload;
      const kind = payload.kind === "steer" ? "Steer" : "Follow-up";
      const reason =
        typeof payload.reason === "string"
          ? payload.reason
          : "runtime unavailable";
      return [
        {
          type: "notification",
          severity: "error",
          message: `${kind} rejected · ${reason}`,
        },
      ];
    }
    case "context.appended": {
      const payload = event.payload;
      const eventId = payload.eventId.trim();
      const text = payload.text.trim();
      if (!eventId || !text || payload.provenance !== "peer-attributed-data")
        return [];
      return [
        {
          type: "notification",
          severity: "info",
          message: "Peer context received and added to this session",
        },
      ];
    }
    case "worker.started": {
      return [
        {
          type: "worker-changed",
          worker: {
            workerId: event.payload.workerId,
            ...(event.payload.agentType === undefined
              ? {}
              : { agentType: event.payload.agentType }),
            state: event.payload.state,
            timestamp: event.timestamp,
          },
        },
      ];
    }
    case "worker.progress": {
      const {
        workerId,
        agentType,
        state,
        active,
        queued,
        maxActive,
        planStepId,
        taskLabel,
      } = event.payload;
      return [
        {
          type: "worker-changed",
          worker: {
            workerId,
            ...(agentType === undefined ? {} : { agentType }),
            state,
            active,
            queued,
            maxActive,
            ...(planStepId === undefined ? {} : { planStepId }),
            ...(taskLabel === undefined ? {} : { taskLabel }),
            timestamp: event.timestamp,
          },
        },
      ];
    }
    case "worker.stopped": {
      const { workerId, agentType, state } = event.payload;
      const severity =
        state === "succeeded"
          ? "success"
          : state === "aborted"
            ? "warning"
            : "error";
      return [
        {
          type: "worker-changed",
          worker: {
            workerId,
            ...(agentType === undefined ? {} : { agentType }),
            state,
            timestamp: event.timestamp,
          },
        },
        {
          type: "notification",
          severity,
          message: `${agentType ?? "Subagent"} · ${state.toUpperCase()}`,
          key: workerNotificationKey(workerId),
        },
      ];
    }
    case "permission.requested":
      return [
        ...(event.payload.name === "skill"
          ? [{
              type: "tool-updated" as const,
              callId: event.payload.callId,
              name: "skill",
              message: "approval-required",
            }]
          : []),
        {
          type: "notification",
          severity: "warning",
          message: `Approval required · ${event.payload.name === "skill" ? "Agent Skill" : event.payload.name}`,
          key: `approval:${event.payload.callId}`,
        },
      ];
    case "context.artifacts-projected": {
      const payload = event.payload;
      const artifactLabel = payload.sourceCount === 1 ? "artifact" : "artifacts";
      const phase = payload.phase === "compaction" ? "Context refreshed" : "Context ready";
      return [
        {
          type: "notification",
          severity: "info",
          message: `${phase} · ${payload.projectedCount} of ${payload.sourceCount} ${artifactLabel} available${payload.droppedCount === 0 ? "" : ` · ${payload.droppedCount} omitted`}`,
        },
      ];
    }
    case "context.compaction-started":
      return [
        {
          type: "status-changed",
          name: "context.compaction",
          text: `Compacting context · ${event.payload.reason}`,
        },
      ];
    case "context.compacted":
      return [
        { type: "status-changed", name: "context.compaction" },
        {
          type: "notification",
          severity: "success",
          message: `Context compacted · ${event.payload.reason}`,
        },
      ];
    case "context.compaction-failed":
      return [
        { type: "status-changed", name: "context.compaction" },
        {
          type: "notification",
          severity: "error",
          message: `Context compaction failed · ${event.payload.category}`,
        },
      ];
    case "turn.started":
      return [{ type: "turn-started", turnId: event.payload.turnId }];
    case "turn.ended": {
      const { turnId, stop } = event.payload;
      const outcome = stop === "cancelled"
        ? "cancelled" as const
        : stop === "complete" || stop === "length"
          ? "completed" as const
          : "error" as const;
      return [
        {
          type: "turn-ended",
          turnId,
          outcome,
        },
        ...(stop === "timeout"
          ? [{ type: "notification" as const, severity: "error" as const, message: "Turn timed out" }]
          : []),
      ];
    }
    case "message.started": {
      const payload = event.payload;
      const messageId = payload.messageId;
      const role = payload.role;
      return [
        {
          type: "message-started",
          messageId,
          role,
          ...(turn === undefined ? {} : { turnId: turn }),
        },
      ];
    }
    case "message.delta": {
      const payload = event.payload;
      return payload.type === "text" || payload.type === "thinking"
        ? [
            {
              type: "message-delta",
              text: payload.text,
              messageId:
                typeof payload.messageId === "string"
                  ? payload.messageId
                  : `assistant:${turn ?? "unscoped"}`,
              role: "assistant",
              ...(turn === undefined ? {} : { turnId: turn }),
              ...(payload.type === "thinking" || payload.segment === "thinking"
                ? { segment: "thinking" as const }
                : {}),
            },
          ]
        : [];
    }
    case "message.ended": {
      const payload = event.payload;
      const messageId = payload.messageId;
      return [
        {
          type: "message-ended",
          messageId,
          status:
            payload.status === "cancelled" || payload.status === "error"
              ? payload.status
              : "complete",
        },
      ];
    }
    case "tool.requested": {
      const payload = event.payload;
      return [
        {
          type: "tool-requested",
          callId: payload.callId,
          name: payload.name,
          ...(turn === undefined ? {} : { turnId: turn }),
          ...(payload.input === undefined
            ? {}
            : {
                input: payload.name === "skill"
                  ? skillInputSummary(payload.input)
                  : payload.name === "worker"
                    ? workerInputSummary(payload.input)
                    : stringify(payload.input),
              }),
        },
      ];
    }
    case "tool.started": {
      const payload = event.payload;
      return [
        {
          type: "tool-started",
          callId: payload.callId,
          name: payload.name,
          ...(turn === undefined ? {} : { turnId: turn }),
        },
      ];
    }
    case "tool.updated": {
      const payload = event.payload;
      const callId = payload.callId;
      const name = payload.name;
      const update =
        typeof payload.update === "object" && payload.update !== null
          ? (payload.update as Record<string, unknown>)
          : undefined;
      const value =
        typeof update?.value === "object" && update.value !== null
          ? (update.value as Record<string, unknown>)
          : undefined;
      return [
        {
          type: "tool-updated",
          callId,
          name,
          ...(typeof update?.message === "string"
            ? { message: name === "worker" ? "Worker action in progress" : update.message }
            : {}),
          ...(typeof value?.current === "number" ||
          typeof value?.progress === "number"
            ? {
                current:
                  typeof value.current === "number"
                    ? value.current
                    : (value.progress as number),
              }
            : {}),
          ...(typeof value?.total === "number" ? { total: value.total } : {}),
        },
      ];
    }
    case "tool.blocked": {
      const payload = event.payload;
      const error = errorDetails(payload);
       const message = payload.name === "skill"
         ? `Skill action rejected by ${error.category === "permission" ? "permission" : "policy"}`
         : payload.name === "worker"
           ? `Worker action rejected by ${error.category === "permission" ? "permission" : "policy"}`
         : error.message;
      return [
        {
          type: "tool-blocked",
          callId: payload.callId,
          name: payload.name,
          message,
          ...(error.category === undefined ? {} : { category: error.category }),
        },
      ];
    }
    case "tool.ended": {
      const payload = event.payload;
      const callId = payload.callId;
      const name = payload.name;
      if (payload.outcome === "cancelled" || payload.category === "cancelled") {
        const error = errorDetails(payload);
        return [
          {
            type: "tool-cancelled",
            callId,
            name,
             ...(name === "worker"
               ? { message: "Worker action cancelled" }
               : typeof payload.message === "string"
                 ? { message: payload.message }
               : error.message === "Tool execution failed"
                 ? {}
                 : { message: error.message }),
          },
        ];
      }
      if (payload.outcome !== undefined && payload.outcome !== "success") {
        const error = errorDetails(payload);
        const result = typeof payload.result === "object" && payload.result !== null
          ? payload.result as Record<string, unknown>
          : undefined;
         const message = name === "worker"
           ? "Worker action failed"
           : payload.error === undefined
           ? typeof payload.message === "string"
            ? payload.message
            : typeof result?.message === "string"
              ? result.message
              : stringify(payload.result) ?? error.message
          : error.message;
        const category = error.category ?? (typeof result?.category === "string" ? result.category : undefined);
        return [
          {
            type: "tool-ended",
            callId,
            name,
            error: message,
            ...(category === undefined
              ? {}
              : { category }),
          },
        ];
      }
      return [
        {
          type: "tool-ended",
          callId,
          name,
          ...(payload.result === undefined
            ? {}
              : {
                  result: name === "skill"
                    ? skillResultSummary(payload.result)
                    : name === "worker"
                      ? workerResultSummary(payload.result)
                      : stringify(payload.result),
                }),
        },
      ];
    }
    case "context.usage-changed": {
      const payload = event.payload;
      const inputTokens =
        typeof payload.inputTokens === "number"
          ? payload.inputTokens
          : undefined;
      const outputTokens =
        typeof payload.outputTokens === "number"
          ? payload.outputTokens
          : undefined;
      const currentContextTokens =
        typeof payload.currentContextTokens === "number"
          ? payload.currentContextTokens
          : undefined;
      const cachedInputTokens =
        typeof payload.cachedInputTokens === "number"
          ? payload.cachedInputTokens
          : undefined;
      const cacheWriteInputTokens =
        typeof payload.cacheWriteInputTokens === "number"
          ? payload.cacheWriteInputTokens
          : undefined;
      if (inputTokens === undefined || outputTokens === undefined || currentContextTokens === undefined) return [];
      const contextLimit = options.contextLimit;
      if (
        Number.isSafeInteger(contextLimit) &&
        contextLimit! > 0 &&
        currentContextTokens >= 0 &&
        currentContextTokens <= contextLimit!
      ) {
        return [{
          type: "context-usage-changed",
          used: currentContextTokens,
          limit: contextLimit!,
          inputTokens,
          outputTokens,
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
        }];
      }
      return [{
        type: "status-changed",
        name: "context.usage",
        text: `${inputTokens} input · ${outputTokens} output${cachedInputTokens === undefined ? "" : ` · ${cachedInputTokens} cached`}${cacheWriteInputTokens === undefined ? "" : ` · ${cacheWriteInputTokens} cache write`} tokens`,
      }];
    }
    case "model.selected": {
      const payload = opaqueRecord(event.payload);
      const providerId = boundedLifecycleLabel(payload?.providerId);
      const modelId = boundedLifecycleLabel(payload?.modelId);
      return providerId === undefined || modelId === undefined
        ? []
        : [{
            type: "notification",
            severity: "success",
            message: `Model selected · ${providerId}/${modelId}`,
          }];
    }
    case "model.thinking-level-selected": {
      const level = boundedLifecycleLabel(opaqueRecord(event.payload)?.level);
      return level === undefined
        ? []
        : [{ type: "status-changed", name: "model.thinking", text: `Thinking level · ${level}` }];
    }
    case "provider.request-started":
      return [{
        type: "status-changed",
        name: "provider",
        text: `Waiting for model · attempt ${event.payload.attempt}/${event.payload.maxAttempts}`,
      }];
    case "provider.response-received":
      return [{ type: "status-changed", name: "provider" }];
    case "resources.discovering":
      return [{
        type: "status-changed",
        name: "resources",
        text: "Discovering tools, MCP servers, and Skills…",
      }];
    case "resources.discovered":
      return [
        { type: "status-changed", name: "resources" },
        {
          type: "notification",
          severity: "success",
          message: "Tools, MCP servers, and Skills ready",
        },
      ];
    case "trust.resolving":
      return [{ type: "status-changed", name: "trust", text: "Checking workspace trust…" }];
    case "trust.resolved":
      return [{ type: "status-changed", name: "trust" }];
    case "settings.changed":
      return [{ type: "notification", severity: "success", message: "Settings updated" }];
    case "plugin.lifecycle":
      return [{ type: "notification", severity: "info", message: "Extension state changed" }];
    case "ui.notification": {
      const payload = event.payload as Record<string, unknown>;
      if (payload.kind === "mcp.catalog-invalidated") {
        if (
          typeof payload.server !== "string" ||
          !/^[A-Za-z0-9_.-]{1,64}$/.test(payload.server)
        )
          return [];
        return [
          {
            type: "notification",
            severity: "info",
            message: `MCP tool catalog changed · ${payload.server} · refresh required`,
          },
        ];
      }
      if (typeof payload.message !== "string") return [];
      const severity = payload.severity;
      return [
        {
          type: "notification",
          message: payload.message,
          severity:
            severity === "success" ||
            severity === "warning" ||
            severity === "error"
              ? severity
              : "info",
        },
      ];
    }
    case "ui.status-changed": {
      const payload = event.payload as Record<string, unknown>;
      return typeof payload.name === "string"
        ? [
            {
              type: "status-changed",
              name: payload.name,
              text: typeof payload.text === "string" ? payload.text : undefined,
            },
          ]
        : [];
    }
    case "context.compaction-retrying": {
      const payload = event.payload as Record<string, unknown>;
      const attempt = typeof payload.attempt === "number" ? ` · attempt ${payload.attempt}` : "";
      return [
        {
          type: "status-changed",
          name: "context.compaction",
          text: `Retrying context compaction${attempt}`,
        },
        {
          type: "notification",
          severity: "warning",
          message: `Context compaction retrying${attempt}`,
        },
      ];
    }
    case "provider.failed": {
      const payload = event.payload;
      const attempt = payload.attempt === undefined ? "" : ` · attempt ${payload.attempt}${payload.maxAttempts === undefined ? "" : `/${payload.maxAttempts}`}`;
      const delay = payload.delayMs === undefined ? "" : ` · retry in ${payload.delayMs}ms`;
      return [
        {
          type: "status-changed",
          name: "provider",
          ...(payload.retrying ? { text: `Provider retrying${attempt}${delay}` } : {}),
        },
        {
          type: "notification",
          severity: payload.retrying ? "warning" : "error",
          message: `Provider request failed${attempt} · ${payload.message}`,
        },
      ];
    }
    case "checkpoint.prepared":
      return [{
        type: "notification",
        severity: "info",
        message: `Checkpoint prepared · ${event.payload.transition.path}`,
      }];
    case "checkpoint.recovered":
      return [{
        type: "notification",
        severity: event.payload.recovery.state === "uncertain" ? "warning" : "info",
        message: `Checkpoint ${event.payload.recovery.state} · ${event.payload.recovery.path}`,
      }];
    case "rewind.prepared":
      return [{
        type: "notification",
        severity: "warning",
        message: `Rewind prepared · ${event.payload.transition.path}`,
      }];
    case "rewind.completed":
      return [{
        type: "notification",
        severity: "info",
        message: `Rewind completed · ${event.payload.recovery.path}`,
      }];
    case "runtime.stopped":
    case "session.tree-changed":
    case "session.metadata-changed":
    case "session.stopping":
    case "session.before-switch":
    case "session.before-fork":
    case "input.transformed":
    case "input.handled":
    case "agent.starting":
    case "agent.started":
    case "agent.settled":
    case "agent.ended":
    case "ui.interaction-requested":
    case "ui.interaction-resolved":
    case "ui.presentation-changed":
    case "prompt.assembling":
    case "prompt.assembled":
    case "context.preparing":
    case "agent.before-start":
      return [];
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}
