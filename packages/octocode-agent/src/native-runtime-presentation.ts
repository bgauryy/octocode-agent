import type { RuntimeErrorData, RuntimeEvent } from "@octocodeai/agent-core";
import type { NativePresentationEvent } from "./presentation/contracts.js";

/** Translates host-neutral runtime events into terminal presentation semantics. */
export function presentationEvents(
  event: RuntimeEvent,
  activeTurnId?: string,
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
          message: `${workerId} · ${state.toUpperCase()}`,
        },
      ];
    }
    case "permission.requested":
      return [
        {
          type: "notification",
          severity: "warning",
          message: `Approval required · ${event.payload.name}`,
        },
      ];
    case "context.artifacts-projected": {
      const payload = event.payload;
      return [
        {
          type: "notification",
          severity: "info",
          message: `Context artifacts projected · ${payload.phase} · ${payload.projectedCount}/${payload.sourceCount} kept · ${payload.droppedCount} dropped · ${payload.stablePrefixDigest}`,
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
            : { input: stringify(payload.input) }),
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
            ? { message: update.message }
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
      return [
        {
          type: "tool-blocked",
          callId: payload.callId,
          name: payload.name,
          message: error.message,
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
            ...(typeof payload.message === "string"
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
        const message = payload.error === undefined
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
            : { result: stringify(payload.result) }),
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
      const cachedInputTokens =
        typeof payload.cachedInputTokens === "number"
          ? payload.cachedInputTokens
          : undefined;
      const cacheWriteInputTokens =
        typeof payload.cacheWriteInputTokens === "number"
          ? payload.cacheWriteInputTokens
          : undefined;
      return inputTokens === undefined || outputTokens === undefined
        ? []
        : [
            {
              type: "status-changed",
              name: "context.usage",
              text: `${inputTokens} input · ${outputTokens} output${cachedInputTokens === undefined ? "" : ` · ${cachedInputTokens} cached`}${cacheWriteInputTokens === undefined ? "" : ` · ${cacheWriteInputTokens} cache write`} tokens`,
            },
          ];
    }
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
    case "session.starting":
    case "session.started":
    case "session.switching":
    case "session.forked":
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
    case "model.selected":
    case "model.thinking-level-selected":
    case "provider.request-started":
    case "provider.response-received":
    case "ui.interaction-requested":
    case "ui.interaction-resolved":
    case "ui.presentation-changed":
    case "resources.discovering":
    case "resources.discovered":
    case "trust.resolving":
    case "trust.resolved":
    case "prompt.assembling":
    case "prompt.assembled":
    case "context.preparing":
    case "agent.before-start":
    case "settings.changed":
    case "plugin.lifecycle":
      return [];
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}
