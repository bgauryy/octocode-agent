import { describe, expect, it } from "vitest";

import {
  AGENT_EVENT_PAYLOAD_TYPES,
  AGENT_EVENT_TYPES,
  RUNTIME_MODES,
  parseRpcRequest,
  parseRpcEvent,
  type AgentEventType,
  type RuntimeMode,
} from "../src/index.js";

const checkpointTransition = {
  schemaVersion: 1 as const,
  attemptId: "checkpoint-1",
  checkpointId: "checkpoint-1",
  attemptKind: "mutation" as const,
  operation: "edit" as const,
  path: "src/index.ts",
  before: { kind: "present" as const, sha256: "a".repeat(64), bytes: 4, mode: 0o640 },
  after: { kind: "present" as const, sha256: "b".repeat(64), bytes: 5, mode: 0o640 },
  journalSha256: "c".repeat(64),
};

const checkpointRecovery = {
  schemaVersion: 1 as const,
  attemptId: checkpointTransition.attemptId,
  checkpointId: checkpointTransition.checkpointId,
  attemptKind: checkpointTransition.attemptKind,
  path: checkpointTransition.path,
  state: "complete" as const,
  current: checkpointTransition.after,
  journalSha256: checkpointTransition.journalSha256,
};

function event(type: AgentEventType, mode: RuntimeMode) {
  const payload =
    type === "runtime.failed"
      ? { message: "failed" }
      : type === "session.starting" || type === "session.stopping"
        ? { reason: "test" }
        : type === "input.received"
          ? { text: "hello" }
          : type === "input.queued"
            ? { kind: "follow-up", text: "hello", position: 1 }
            : type === "input.rejected"
              ? { kind: "follow-up", text: "hello", reason: "busy" }
              : type === "agent.ended" || type === "turn.ended"
                ? { turnId: "turn-1", stop: "complete" }
                : type === "turn.started"
                  ? { turnId: "turn-1" }
                  : type === "tool.requested"
                    ? { callId: "call-1", name: "file", input: {} }
                    : type === "permission.requested"
                      ? {
                          callId: "call-1",
                          name: "file",
                          input: {},
                          policy: {},
                        }
                      : type === "tool.blocked"
                        ? {
                            callId: "call-1",
                            name: "file",
                            error: "blocked",
                            category: "trust",
                          }
                        : type === "tool.started"
                          ? { callId: "call-1", name: "file" }
                          : type === "tool.updated"
                            ? { callId: "call-1", name: "file", update: {} }
                            : type === "tool.ended"
                              ? {
                                  callId: "call-1",
                                  name: "file",
                                  outcome: "success",
                                }
                              : type === "worker.started"
                                ? { workerId: "worker-1", state: "running" }
                                : type === "worker.progress"
                                  ? {
                                      workerId: "worker-1",
                                      state: "queued",
                                      active: 1,
                                      queued: 1,
                                      maxActive: 4,
                                    }
                                  : type === "worker.stopped"
                                    ? {
                                        workerId: "worker-1",
                                        state: "succeeded",
                                      }
                                    : type === "context.compaction-started"
                                      ? { reason: "manual" }
                                      : type === "context.artifacts-projected"
                                        ? {
                                            phase: "initial",
                                            sourceCount: 2,
                                            projectedCount: 1,
                                            droppedCount: 1,
                                            stablePrefixDigest: "a".repeat(64),
                                          }
                                        : type === "checkpoint.prepared"
                                          ? {
                                              schemaVersion: 1,
                                              transition: checkpointTransition,
                                            }
                                          : type === "checkpoint.recovered"
                                            ? {
                                                schemaVersion: 1,
                                                recovery: checkpointRecovery,
                                              }
                                            : type === "rewind.prepared"
                                              ? {
                                                  schemaVersion: 1,
                                                  transition: {
                                                    ...checkpointTransition,
                                                    attemptId: "rewind-1",
                                                    attemptKind: "rewind",
                                                    operation: "rewind",
                                                  },
                                                }
                                              : type === "rewind.completed"
                                                ? {
                                                    schemaVersion: 1,
                                                    recovery: {
                                                      ...checkpointRecovery,
                                                      attemptId: "rewind-1",
                                                      attemptKind: "rewind",
                                                    },
                                                  }
                                        : type === "context.compacted"
                                          ? {
                                              reason: "manual",
                                              summary: "summary",
                                            }
                                          : type === "context.compaction-failed"
                                            ? {
                                                reason: "manual",
                                                category: "compaction",
                                                message: "failed",
                                              }
                                            : type === "context.appended"
                                              ? {
                                                  eventId: "peer-1",
                                                  text: "context",
                                                  provenance:
                                                    "peer-attributed-data",
                                                }
                                              : type === "message.started"
                                                ? {
                                                    requestId: "request-1",
                                                    messageId: "message-1",
                                                    role: "assistant",
                                                    iteration: 0,
                                                    attempt: 1,
                                                  }
                                                : type === "message.delta"
                                                  ? {
                                                      type: "text",
                                                      text: "hello",
                                                      requestId: "request-1",
                                                      messageId: "message-1",
                                                    }
                                                  : type === "message.ended"
                                                    ? {
                                                        requestId: "request-1",
                                                        messageId: "message-1",
                                                        status: "complete",
                                                      }
                                                    : type ===
                                                        "provider.request-started"
                                                      ? {
                                                          requestId:
                                                            "request-1",
                                                          iteration: 1,
                                                          attempt: 1,
                                                          maxAttempts: 1,
                                                        }
                                                      : type ===
                                                          "provider.response-received"
                                                        ? {
                                                            requestId:
                                                              "request-1",
                                                            iteration: 1,
                                                            attempt: 1,
                                                            maxAttempts: 1,
                                                            durationMs: 1,
                                                            stop: "complete",
                                                            usage: {
                                                              inputTokens: 0,
                                                              outputTokens: 0,
                                                            },
                                                          }
                                                        : type ===
                                                            "provider.failed"
                                                          ? {
                                                              iteration: 1,
                                                              message:
                                                                "provider failed",
                                                            }
                                                          : type ===
                                                              "context.usage-changed"
                                                            ? {
                                                                inputTokens: 0,
                                                                outputTokens: 0,
                                                              }
                                                            : {};
  return {
    schemaVersion: 1 as const,
    eventVersion: 1 as const,
    id: `event:${type}:${mode}`,
    type,
    phase: "notification" as const,
    sessionId: "session-1",
    timestamp: 1,
    cwd: "/workspace",
    mode,
    trust: { workspace: "trusted" as const, managedOnly: false },
    payload,
  };
}

describe("RPC event contract alignment", () => {
  it("accepts the complete typed external-context command and rejects extra fields", () => {
    const request = {
      protocolVersion: 1,
      requestId: "context-1",
      command: {
        type: "context.append",
        eventId: "peer:event:1",
        text: "Attributed peer context",
        provenance: "peer-attributed-data",
      },
    } as const;

    expect(parseRpcRequest(request).command).toEqual(request.command);
    expect(() =>
      parseRpcRequest({
        ...request,
        command: { ...request.command, source: "untyped-alias" },
      }),
    ).toThrow(/command/i);
  });

  it("accepts the safe monitoring snapshot command without extra fields", () => {
    expect(
      parseRpcRequest({
        protocolVersion: 1,
        requestId: "monitor-1",
        command: { type: "monitoring.snapshot" },
      }).command,
    ).toEqual({ type: "monitoring.snapshot" });
    expect(() =>
      parseRpcRequest({
        protocolVersion: 1,
        requestId: "monitor-2",
        command: { type: "monitoring.snapshot", prompt: "must not pass" },
      }),
    ).toThrow(/command/i);
  });

  it("accepts every canonical agent event type in every canonical runtime mode", () => {
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length);
    expect(new Set(RUNTIME_MODES).size).toBe(RUNTIME_MODES.length);

    for (const type of AGENT_EVENT_TYPES) {
      for (const mode of RUNTIME_MODES) {
        expect(
          parseRpcEvent({
            protocolVersion: 1,
            sequence: 1,
            event: event(type, mode),
          }).event,
        ).toMatchObject({ type, mode });
      }
    }
  });

  it("keeps near-miss wire values outside the canonical contract", () => {
    const valid = event(AGENT_EVENT_TYPES[0], RUNTIME_MODES[0]);
    expect(() =>
      parseRpcEvent({
        protocolVersion: 1,
        sequence: 1,
        event: { ...valid, type: "runtime.future" },
      }),
    ).toThrow(/event envelope/i);
    expect(() =>
      parseRpcEvent({
        protocolVersion: 1,
        sequence: 1,
        event: { ...valid, mode: "batch" },
      }),
    ).toThrow(/event envelope/i);
  });

  it("accepts only presentation-safe canonical worker lifecycle state", () => {
    const started = event("worker.started", "rpc");
    const stopped = event("worker.stopped", "rpc");

    expect(
      parseRpcEvent({
        protocolVersion: 1,
        sequence: 1,
        event: {
          ...started,
          payload: {
            workerId: "worker-1",
            agentType: "researcher",
            state: "running",
          },
        },
      }).event.payload,
    ).toEqual({
      workerId: "worker-1",
      agentType: "researcher",
      state: "running",
    });
    for (const state of ["succeeded", "failed", "aborted", "killed"] as const) {
      expect(
        parseRpcEvent({
          protocolVersion: 1,
          sequence: 2,
          event: {
            ...stopped,
            payload: { workerId: "worker-1", agentType: "researcher", state },
          },
        }).event.payload,
      ).toEqual({
        workerId: "worker-1",
        agentType: "researcher",
        state,
      });
    }

    for (const payload of [
      { workerId: "worker-1" },
      { workerId: "worker-1", state: "queued" },
      {
        workerId: "worker-1",
        state: "running",
        terminal: { outcome: "succeeded" },
      },
      { workerId: "worker-1", state: "running", handback: "secret" },
      { workerId: "worker-1", state: "running", reason: "secret" },
    ]) {
      expect(() =>
        parseRpcEvent({
          protocolVersion: 1,
          sequence: 3,
          event: { ...started, payload },
        }),
      ).toThrow(/event payload/i);
    }
    for (const payload of [
      { workerId: "worker-1" },
      { workerId: "worker-1", state: "running" },
      {
        workerId: "worker-1",
        state: "failed",
        terminal: { outcome: "failed" },
      },
      { workerId: "worker-1", state: "failed", outcome: "failed" },
      { workerId: "worker-1", state: "failed", handback: "secret" },
      { workerId: "worker-1", state: "failed", reason: "secret" },
    ]) {
      expect(() =>
        parseRpcEvent({
          protocolVersion: 1,
          sequence: 4,
          event: { ...stopped, payload },
        }),
      ).toThrow(/event payload/i);
    }
  });

  it("accepts only bounded presentation-safe worker progress", () => {
    const progress = event("worker.progress" as AgentEventType, "rpc");
    const payload = {
      workerId: "worker-1",
      agentType: "researcher",
      state: "queued",
      active: 1,
      queued: 2,
      maxActive: 4,
      planStepId: "step-1",
      taskLabel: "Research",
    };
    expect(
      parseRpcEvent({
        protocolVersion: 1,
        sequence: 1,
        event: { ...progress, type: "worker.progress", payload },
      }).event.payload,
    ).toEqual(payload);

    for (const unsafe of [
      { ...payload, prompt: "secret" },
      { ...payload, handback: { text: "secret" } },
      { ...payload, active: 5 },
      { ...payload, maxActive: 0 },
      { ...payload, state: "starting" },
    ]) {
      expect(() =>
        parseRpcEvent({
          protocolVersion: 1,
          sequence: 2,
          event: { ...progress, type: "worker.progress", payload: unsafe },
        }),
      ).toThrow(/event payload/i);
    }
  });

  it("rejects malformed payloads for every event declared canonical", () => {
    for (const type of [
      "input.received",
      "tool.ended",
      "worker.started",
      "worker.stopped",
      "context.compaction-started",
      "context.compacted",
      "context.compaction-failed",
    ] as const) {
      const valid = event(type, "rpc");
      expect(() =>
        parseRpcEvent({
          protocolVersion: 1,
          sequence: 1,
          event: { ...valid, payload: {} },
        }),
      ).toThrow(/event payload/i);
    }
    const session = event("session.starting", "rpc");
    expect(() =>
      parseRpcEvent({
        protocolVersion: 1,
        sequence: 1,
        event: { ...session, payload: { reason: 1 } },
      }),
    ).toThrow(/event payload/i);
  });

  it("rejects malformed payloads for every mapped event payload type", () => {
    for (const type of AGENT_EVENT_PAYLOAD_TYPES) {
      const valid = event(type, "rpc");
      expect(
        parseRpcEvent({
          protocolVersion: 1,
          sequence: 1,
          event: valid,
        }).event,
      ).toMatchObject({ type });
      expect(() =>
        parseRpcEvent({
          protocolVersion: 1,
          sequence: 2,
          event: { ...valid, payload: null },
        }),
      ).toThrow(/event payload/i);
    }
  });

  it("rejects checkpoint event payloads that expose absolute paths, content, or unversioned fields", () => {
    const prepared = event("checkpoint.prepared" as AgentEventType, "rpc");
    for (const payload of [
      {
        schemaVersion: 1,
        transition: { ...checkpointTransition, path: "/workspace/src/index.ts" },
      },
      {
        schemaVersion: 1,
        transition: checkpointTransition,
        content: "source text",
      },
      { transition: checkpointTransition },
    ]) {
      expect(() =>
        parseRpcEvent({
          protocolVersion: 1,
          sequence: 1,
          event: { ...prepared, payload },
        }),
      ).toThrow(/event payload/i);
    }
  });

  it("keeps unmapped adapter-owned event payloads opaque", () => {
    const mapped = new Set<string>(AGENT_EVENT_PAYLOAD_TYPES);
    for (const type of AGENT_EVENT_TYPES.filter((candidate) => !mapped.has(candidate))) {
      const opaquePayload = { adapterOwned: type, vendorData: [1, "two"] };
      expect(
        parseRpcEvent({
          protocolVersion: 1,
          sequence: 1,
          event: { ...event(type, "rpc"), payload: opaquePayload },
        }).event.payload,
      ).toEqual(opaquePayload);
    }
  });
});
