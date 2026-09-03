import { describe, expect, it } from "vitest";
import {
  eventId,
  sessionId,
  toolCallId,
  turnId,
  type ModelMessage,
  type RuntimeEvent,
  type RuntimeEventOf,
} from "@octocodeai/agent-core";

import {
  presentationEvents,
  presentationEventsForHistory,
} from "../src/native-runtime-presentation.js";

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

  it("keeps context usage structured when the selected model limit is known", () => {
    expect(
      presentationEvents(
        event("context.usage-changed", {
          inputTokens: 32_000,
          outputTokens: 2_000,
          currentContextTokens: 34_000,
          cachedInputTokens: 8_000,
          cacheWriteInputTokens: 1_000,
        }),
        undefined,
        { contextLimit: 128_000 },
      ),
    ).toEqual([
      {
        type: "context-usage-changed",
        used: 34_000,
        limit: 128_000,
        inputTokens: 32_000,
        outputTokens: 2_000,
        cachedInputTokens: 8_000,
        cacheWriteInputTokens: 1_000,
      },
    ]);
  });

  it("projects user-relevant session, model, provider, and discovery lifecycle", () => {
    expect(presentationEvents(event("session.starting", { reason: "resume" }))).toEqual([
      { type: "status-changed", name: "session", text: "Resuming session…" },
    ]);
    expect(presentationEvents(event("session.started", {
      schemaVersion: 1,
      transition: "resume",
      state: "resumed-compacted",
      displayName: "Terminal polish",
      shortPublicId: "abc12345",
      restoredVisibleMessageCount: 12,
      retainedModelContextItemCount: 7,
      contextOccupancy: { used: 34_000, limit: 128_000 },
      committedCompaction: "committed",
    }))).toEqual([
      { type: "session-replaced" },
      { type: "status-changed", name: "session" },
      {
        type: "notification",
        severity: "success",
        message: "Terminal polish · abc12345 · Resumed compacted · 12 messages · 7 context items · 34000/128000 context tokens · compacted",
      },
    ]);
    expect(
      presentationEvents(
        event("model.selected", { providerId: "anthropic", modelId: "claude-sonnet" }),
      ),
    ).toEqual([
      {
        type: "notification",
        severity: "success",
        message: "Model selected · anthropic/claude-sonnet",
      },
    ]);
    expect(
      presentationEvents(event("model.thinking-level-selected", { level: "high" })),
    ).toEqual([
      { type: "status-changed", name: "model.thinking", text: "Thinking level · high" },
    ]);
    expect(
      presentationEvents(
        event("provider.request-started", {
          requestId: "request:1",
          iteration: 1,
          attempt: 2,
          maxAttempts: 3,
        }),
      ),
    ).toEqual([
      { type: "status-changed", name: "provider", text: "Waiting for model · attempt 2/3" },
    ]);
    expect(
      presentationEvents(
        event("provider.response-received", {
          requestId: "request:1",
          iteration: 1,
          attempt: 2,
          maxAttempts: 3,
          durationMs: 250,
          stop: "complete",
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      ),
    ).toEqual([{ type: "status-changed", name: "provider" }]);
    expect(presentationEvents(event("resources.discovering", {}))).toEqual([
      {
        type: "status-changed",
        name: "resources",
        text: "Discovering tools, MCP servers, and Skills…",
      },
    ]);
    expect(presentationEvents(event("resources.discovered", {}))).toEqual([
      { type: "status-changed", name: "resources" },
      {
        type: "notification",
        severity: "success",
        message: "Tools, MCP servers, and Skills ready",
      },
    ]);
    expect(presentationEvents(event("trust.resolving", {}))).toEqual([
      { type: "status-changed", name: "trust", text: "Checking workspace trust…" },
    ]);
    expect(presentationEvents(event("trust.resolved", {}))).toEqual([
      { type: "status-changed", name: "trust" },
    ]);
    expect(presentationEvents(event("settings.changed", {}))).toEqual([
      { type: "notification", severity: "success", message: "Settings updated" },
    ]);
    expect(presentationEvents(event("plugin.lifecycle", {}))).toEqual([
      { type: "notification", severity: "info", message: "Extension state changed" },
    ]);
  });

  it("rehydrates only user-visible resumed history and completed tools", () => {
    const projected = presentationEventsForHistory([
      { role: "system", content: "PRIVATE_SYSTEM_PROMPT" },
      { role: "user", content: "Review the patch" },
      {
        role: "assistant",
        content: "I’ll inspect it.",
        toolCalls: [{ id: "call:resume", name: "file", input: { path: "src/a.ts" } }],
      },
      {
        role: "tool",
        toolCallId: "call:resume",
        content: "done",
      },
    ]);

    expect(projected).toEqual([
      { type: "user-message", text: "Review the patch", messageId: "history:1" },
      { type: "message-started", messageId: "history:2", role: "assistant" },
      { type: "message-delta", messageId: "history:2", role: "assistant", segment: "text", text: "I’ll inspect it." },
      { type: "message-ended", messageId: "history:2", status: "complete" },
      { type: "tool-prepared", callId: "call:resume", name: "file", input: '{"path":"src/a.ts"}' },
      { type: "tool-ended", callId: "call:resume", name: "file", result: "done" },
    ]);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_SYSTEM_PROMPT");
  });

  it("projects Skill lifecycle through bounded public summaries without raw arguments", () => {
    expect(presentationEvents(event("tool.requested", {
      callId: toolCallId("skill:enable:private"),
      name: "skill",
      input: {
        action: "enable",
        name: "research",
        source: "/Users/private/skill",
        token: "secret-value",
      },
    }))).toEqual([{
      type: "tool-requested",
      callId: "skill:enable:private",
      name: "skill",
      input: '{"action":"enable","name":"research"}',
    }]);
    expect(presentationEvents(event("permission.requested", {
      callId: "skill:enable:private",
      name: "skill",
      input: { action: "enable", source: "/private" },
      policy: { token: "secret-value" },
    }))).toEqual([
      {
        type: "tool-updated",
        callId: "skill:enable:private",
        name: "skill",
        message: "approval-required",
      },
      {
        type: "notification",
        severity: "warning",
        message: "Approval required · Agent Skill",
        key: "approval:skill:enable:private",
      },
    ]);
    const completed = presentationEvents(event("tool.ended", {
      callId: toolCallId("skill:list:private"),
      name: "skill",
      outcome: "success",
      result: {
        skills: [{
          name: "research",
          provenance: {
            scope: "workspace",
            path: "/Users/private/skill/SKILL.md",
            token: "secret-value",
          },
        }],
      },
    }));
    expect(completed).toEqual([{
      type: "tool-ended",
      callId: "skill:list:private",
      name: "skill",
      result: '{"skills":[{"sourceScope":"Workspace","count":1}]}',
    }]);
    expect(JSON.stringify(completed)).not.toContain("/Users/private");
    expect(JSON.stringify(completed)).not.toContain("secret-value");
    expect(presentationEvents(event("tool.blocked", {
      callId: toolCallId("skill:blocked"),
      name: "skill",
      error: "token=secret-value /private/path",
      category: "policy",
    }))).toEqual([{
      type: "tool-blocked",
      callId: "skill:blocked",
      name: "skill",
      message: "Skill action rejected by policy",
      category: "policy",
    }]);
  });

  it("projects worker tool lifecycle through action and state summaries without private routing data", () => {
    const privateValues = [
      "PRIVATE_WORKER_PROMPT",
      "PRIVATE_STEER_TEXT",
      "worker-private-id",
      "correlation-private-id",
      "PRIVATE_HANDBACK",
    ];
    const requested = presentationEvents(event("tool.requested", {
      callId: toolCallId("worker:private"),
      name: "worker",
      input: {
        action: "steer",
        workerId: privateValues[2],
        correlationId: privateValues[3],
        task: privateValues[0],
        text: privateValues[1],
      },
    }));
    expect(requested).toEqual([{
      type: "tool-requested",
      callId: "worker:private",
      name: "worker",
      input: '{"action":"steer"}',
    }]);

    const completed = presentationEvents(event("tool.ended", {
      callId: toolCallId("worker:private"),
      name: "worker",
      outcome: "success",
      result: {
        ok: true,
        content: {
          action: "wait",
          worker: {
            workerId: privateValues[2],
            correlationId: privateValues[3],
            state: "succeeded",
            handback: { text: privateValues[4] },
          },
        },
      },
    }));
    expect(completed).toEqual([{
      type: "tool-ended",
      callId: "worker:private",
      name: "worker",
      result: '{"action":"wait","state":"succeeded","status":"success"}',
    }]);
    expect(JSON.stringify([...requested, ...completed])).not.toContain("PRIVATE_");
    expect(JSON.stringify([...requested, ...completed])).not.toContain("worker-private-id");
    expect(JSON.stringify([...requested, ...completed])).not.toContain("correlation-private-id");

    expect(presentationEvents(event("tool.blocked", {
      callId: toolCallId("worker:blocked"),
      name: "worker",
      error: "worker-private-id rejected PRIVATE_WORKER_PROMPT",
      category: "policy",
    }))).toEqual([{
      type: "tool-blocked",
      callId: "worker:blocked",
      name: "worker",
      message: "Worker action rejected by policy",
      category: "policy",
    }]);
  });

  it("redacts worker tool arguments and results while rehydrating history", () => {
    const projected = presentationEventsForHistory([
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "worker:history",
          name: "worker",
          input: {
            action: "spawn",
            task: "PRIVATE_HISTORY_PROMPT",
            workerId: "worker-history-private",
          },
        }],
      },
      {
        role: "tool",
        toolCallId: "worker:history",
        content: "PRIVATE_HISTORY_HANDBACK",
        result: {
          ok: true,
          content: {
            action: "spawn",
            worker: { workerId: "worker-history-private", state: "running" },
          },
        },
      },
    ] as unknown as ModelMessage[]);
    expect(projected).toEqual([
      { type: "tool-prepared", callId: "worker:history", name: "worker", input: '{"action":"spawn"}' },
      { type: "tool-ended", callId: "worker:history", name: "worker", result: '{"action":"spawn","state":"running","status":"success"}' },
    ]);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_HISTORY");
    expect(JSON.stringify(projected)).not.toContain("worker-history-private");
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
        message: "Context refreshed · 3 of 4 artifacts available · 1 omitted",
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
        key: "approval:call:permission",
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
        message: "Subagent · SUCCEEDED",
        key: "worker:dff0a13fe986",
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
