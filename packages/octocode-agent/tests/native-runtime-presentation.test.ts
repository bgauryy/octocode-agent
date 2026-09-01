import { describe, expect, it } from "vitest";
import {
  eventId,
  sessionId,
  toolCallId,
  turnId,
  type RuntimeEvent,
  type RuntimeEventOf,
} from "@octocodeai/agent-core";

import { presentationEvents } from "../src/native-runtime-presentation.js";

function event<TType extends RuntimeEvent["type"]>(
  type: TType,
  payload: RuntimeEventOf<TType>["payload"],
): RuntimeEventOf<TType> {
  return {
    schemaVersion: 1,
    eventVersion: 1,
    id: eventId(`event:${type}`),
    type,
    phase: "notification",
    sessionId: sessionId("session:1"),
    timestamp: 1,
    cwd: "/workspace",
    mode: "interactive",
    trust: { workspace: "trusted", managedOnly: false },
    payload,
  } as RuntimeEventOf<TType>;
}

describe("runtime presentation projection", () => {
  it("projects typed turn and queued-input payloads without renderer knowledge", () => {
    expect(
      presentationEvents(event("turn.started", { turnId: turnId("turn:1") })),
    ).toEqual([{ type: "turn-started", turnId: "turn:1" }]);
    expect(
      presentationEvents(
        event("input.queued", {
          kind: "follow-up",
          text: "later",
          position: 2,
        }),
      ),
    ).toEqual([
      {
        type: "notification",
        severity: "info",
        message: "Follow-up queued · position 2",
      },
    ]);
  });

  it("projects typed tool lifecycle payloads and ignores tool-call deltas as text", () => {
    expect(
      presentationEvents(
        event("tool.started", {
          callId: toolCallId("call:1"),
          name: "file",
        }),
        "turn:1",
      ),
    ).toEqual([
      {
        type: "tool-started",
        callId: "call:1",
        name: "file",
        turnId: "turn:1",
      },
    ]);
    expect(
      presentationEvents(
        event("message.delta", {
          type: "tool-call",
          id: "call:1",
          name: "file",
          input: {},
          requestId: "request:1",
          messageId: "message:1",
        }),
      ),
    ).toEqual([]);
  });

  it("classifies thinking from the authoritative delta type when segment is absent", () => {
    expect(
      presentationEvents(
        event("message.delta", {
          type: "thinking",
          text: "PRIVATE_REASONING",
          requestId: "request:thinking",
          messageId: "message:thinking",
        }),
        "turn:1",
      ),
    ).toEqual([
      {
        type: "message-delta",
        text: "PRIVATE_REASONING",
        messageId: "message:thinking",
        role: "assistant",
        turnId: "turn:1",
        segment: "thinking",
      },
    ]);
  });

  it("keeps failures, retries, and timeout outcomes truthful", () => {
    expect(presentationEvents(event("tool.ended", {
      callId: toolCallId("call:failed"),
      name: "file",
      outcome: "error",
      result: { ok: false, category: "tool-execution", message: "write failed" },
    }))).toEqual([{
      type: "tool-ended",
      callId: "call:failed",
      name: "file",
      error: "write failed",
      category: "tool-execution",
    }]);
    expect(presentationEvents(event("provider.failed", {
      iteration: 1, attempt: 2, maxAttempts: 3, retrying: true,
      delayMs: 50, message: "temporary failure",
    }))).toEqual([
      { type: "status-changed", name: "provider", text: "Provider retrying · attempt 2/3 · retry in 50ms" },
      { type: "notification", severity: "warning", message: "Provider request failed · attempt 2/3 · temporary failure" },
    ]);
    expect(presentationEvents(event("turn.ended", {
      turnId: turnId("turn:timeout"), stop: "timeout",
    }))).toEqual([
      { type: "turn-ended", turnId: "turn:timeout", outcome: "error" },
      { type: "notification", severity: "error", message: "Turn timed out" },
    ]);
    expect(presentationEvents(event("runtime.failed", { message: "provider failed" }))).toEqual([
      { type: "runtime-failed" },
      { type: "notification", severity: "error", message: "provider failed" },
    ]);
  });

  it("normalizes MCP protocol progress into renderer current/total values", () => {
    expect(
      presentationEvents(
        event("tool.updated", {
          callId: toolCallId("call:mcp"),
          name: "MCPTool",
          update: {
            version: 1,
            kind: "progress",
            message: "Discovering MCP tools",
            value: { progress: 2, total: 5 },
          },
        }),
      ),
    ).toEqual([
      {
        type: "tool-updated",
        callId: "call:mcp",
        name: "MCPTool",
        message: "Discovering MCP tools",
        current: 2,
        total: 5,
      },
    ]);
  });

  it("projects bounded semantic MCP catalog invalidation without raw notification data", () => {
    expect(
      presentationEvents(
        event("ui.notification", {
          schemaVersion: 1,
          kind: "mcp.catalog-invalidated",
          severity: "info",
          server: "docs",
          message: "ignored raw message",
          raw: { authorization: "secret" },
        }),
      ),
    ).toEqual([
      {
        type: "notification",
        severity: "info",
        message: "MCP tool catalog changed · docs · refresh required",
      },
    ]);
  });

  it("projects redacted permission and compaction activity without raw payloads", () => {
    expect(
      presentationEvents(
        event("context.artifacts-projected", {
          phase: "compaction",
          sourceCount: 4,
          projectedCount: 3,
          droppedCount: 1,
          stablePrefixDigest: "a".repeat(64),
        }),
      ),
    ).toEqual([
      {
        type: "notification",
        severity: "info",
        message: `Context artifacts projected · compaction · 3/4 kept · 1 dropped · ${"a".repeat(64)}`,
      },
    ]);
    expect(
      presentationEvents(
        event("permission.requested", {
          callId: "call:permission",
          name: "bash",
          input: { command: "secret command" },
          policy: { secret: true },
        }),
      ),
    ).toEqual([
      {
        type: "notification",
        severity: "warning",
        message: "Approval required · bash",
      },
    ]);
    expect(
      presentationEvents(
        event("context.compaction-started", { reason: "overflow" }),
      ),
    ).toEqual([
      {
        type: "status-changed",
        name: "context.compaction",
        text: "Compacting context · overflow",
      },
    ]);
    expect(
      presentationEvents(
        event("context.compacted", {
          reason: "overflow",
          summary: "private context summary",
        }),
      ),
    ).toEqual([
      { type: "status-changed", name: "context.compaction" },
      {
        type: "notification",
        severity: "success",
        message: "Context compacted · overflow",
      },
    ]);
  });

  it("projects only canonical worker state into dedicated presentation updates", () => {
    expect(
      presentationEvents(
        event("worker.started", {
          workerId: "worker:research-1",
          state: "running",
        }),
      ),
    ).toEqual([
      {
        type: "worker-changed",
        worker: {
          workerId: "worker:research-1",
          state: "running",
          timestamp: 1,
        },
      },
    ]);
    expect(
      presentationEvents(
        event("worker.stopped", {
          workerId: "worker:research-1",
          state: "succeeded",
        }),
      ),
    ).toEqual([
      {
        type: "worker-changed",
        worker: {
          workerId: "worker:research-1",
          state: "succeeded",
          timestamp: 1,
        },
      },
      {
        type: "notification",
        severity: "success",
        message: "worker:research-1 · SUCCEEDED",
      },
    ]);
  });

  it("projects safe queued worker progress without prompt or handback data", () => {
    expect(
      presentationEvents(
        event("worker.progress", {
          workerId: "worker:research-2",
          state: "queued",
          active: 1,
          queued: 2,
          maxActive: 4,
          planStepId: "step-research",
          taskLabel: "Research",
        }),
      ),
    ).toEqual([
      {
        type: "worker-changed",
        worker: {
          workerId: "worker:research-2",
          state: "queued",
          active: 1,
          queued: 2,
          maxActive: 4,
          planStepId: "step-research",
          taskLabel: "Research",
          timestamp: 1,
        },
      },
    ]);
  });
});
