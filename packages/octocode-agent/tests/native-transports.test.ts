import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRuntime,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeEvent,
  RuntimeSnapshot,
} from "@octocodeai/agent-core";
import {
  correlationId,
  sessionId,
  workerId,
  type WorkerController,
} from "@octocodeai/agent-core";

import {
  parseNativeWorkerProjectionRequest,
  runJsonTransport,
  runPrintTransport,
  runRpcTransport,
} from "../src/native-transports.js";
import type {
  NativeProcessSignal,
  NativeSignalSource,
} from "../src/native-signal-scope.js";
import { NativeWorkerTransportProjection } from "../src/native-worker-projection.js";
import { workerAuthorityFixture } from "./worker-authority-fixture.js";

function signalFixture(): NativeSignalSource & {
  emit(signal: NativeProcessSignal): void;
} {
  const listeners = new Map<NativeProcessSignal, Set<() => void>>();
  return {
    on(signal, listener) {
      const current = listeners.get(signal) ?? new Set();
      current.add(listener);
      listeners.set(signal, current);
    },
    off(signal, listener) {
      listeners.get(signal)?.delete(listener);
    },
    emit(signal) {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
  };
}

function runtimeFixture(): {
  runtime: AgentRuntime;
  emit(event: RuntimeEvent): void;
  execute: ReturnType<
    typeof vi.fn<(command: RuntimeCommand) => Promise<RuntimeCommandResult>>
  >;
} {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const execute = vi.fn(async () => ({
    ok: true as const,
    data: { state: "ready" },
  }));
  const runtime: AgentRuntime = {
    start: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    execute,
    snapshot: vi.fn(() => ({ state: "ready" }) as RuntimeSnapshot),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: vi.fn(async () => undefined),
  };
  return {
    runtime,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    execute,
  };
}

function event(type: RuntimeEvent["type"], payload: unknown): RuntimeEvent {
  return { type, payload } as RuntimeEvent;
}

describe("native noninteractive transports", () => {
  it("prints only semantic message deltas in text mode", async () => {
    const fixture = runtimeFixture();
    const writes: string[] = [];
    const run = runPrintTransport(fixture.runtime, "hello", {
      format: "text",
      write: (value) => writes.push(value),
    });
    await Promise.resolve();
    fixture.emit(
      event("message.delta", { type: "thinking", text: "private reasoning" }),
    );
    fixture.emit(event("message.delta", { type: "text", text: "answer" }));
    await run;

    expect(writes.join("")).toBe("answer");
    expect(fixture.runtime.submit).toHaveBeenCalledWith("hello");
    expect(fixture.runtime.stop).toHaveBeenCalledOnce();
  });

  it("emits JSONL events without terminal initialization", async () => {
    const fixture = runtimeFixture();
    const writes: string[] = [];
    const run = runJsonTransport(fixture.runtime, "hello", (value) =>
      writes.push(value),
    );
    await Promise.resolve();
    fixture.emit(event("runtime.ready", {}));
    await run;

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toMatchObject({
      protocolVersion: 1,
      sequence: 1,
    });
  });

  it("redacts private context messages from JSON events", async () => {
    const fixture = runtimeFixture();
    const writes: string[] = [];
    vi.mocked(fixture.runtime.submit).mockImplementation(async () => {
      fixture.emit(
        event("context.preparing", {
          messages: [
            { role: "system", content: "PRIVATE SYSTEM INSTRUCTIONS" },
          ],
        }),
      );
    });

    await runJsonTransport(fixture.runtime, "hello", (value) =>
      writes.push(value),
    );

    const encoded = writes.join("");
    expect(encoded).not.toContain("PRIVATE SYSTEM INSTRUCTIONS");
    expect(JSON.parse(writes[0]!)).toMatchObject({
      event: { type: "context.preparing", payload: { messageCount: 1 } },
    });
  });

  it("redacts private context messages from RPC events", async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on("data", (chunk) => writes.push(String(chunk)));
    vi.mocked(fixture.runtime.start).mockImplementation(async () => {
      fixture.emit(
        event("context.preparing", {
          messages: [{ role: "system", content: "PRIVATE REPOSITORY CONTEXT" }],
        }),
      );
    });

    const run = runRpcTransport(fixture.runtime, { input, output });
    input.end();
    await run;

    const encoded = writes.join("");
    expect(encoded).not.toContain("PRIVATE REPOSITORY CONTEXT");
    expect(JSON.parse(encoded.trim())).toMatchObject({
      event: { type: "context.preparing", payload: { messageCount: 1 } },
    });
  });

  it("subscribes before start and remains subscribed through stopped", async () => {
    const fixture = runtimeFixture();
    const writes: string[] = [];
    vi.mocked(fixture.runtime.start).mockImplementation(async () => {
      fixture.emit(event("runtime.ready", {}));
    });
    vi.mocked(fixture.runtime.stop).mockImplementation(async () => {
      fixture.emit(event("runtime.stopped", {}));
    });

    await runJsonTransport(fixture.runtime, "hello", (value) =>
      writes.push(value),
    );

    expect(writes.map((line) => JSON.parse(line).event.type)).toEqual([
      "runtime.ready",
      "runtime.stopped",
    ]);
  });

  it.each([
    [
      "runtime failure",
      event("runtime.failed", { message: "provider failed" }),
    ],
    [
      "terminal turn error",
      event("turn.ended", { turnId: "turn-1", stop: "error" }),
    ],
    [
      "terminal turn timeout",
      event("turn.ended", { turnId: "turn-1", stop: "timeout" }),
    ],
  ])("returns a nonzero exit code for %s", async (_name, terminalEvent) => {
    const fixture = runtimeFixture();
    vi.mocked(fixture.runtime.submit).mockImplementation(async () => {
      fixture.emit(terminalEvent);
    });

    await expect(
      runPrintTransport(fixture.runtime, "hello", {
        format: "text",
        write: vi.fn(),
      }),
    ).resolves.toBe(1);
  });

  it.each(["complete", "length", "cancelled", "deny", "stop"])(
    "preserves the existing successful exit contract for terminal stop %s",
    async (stop) => {
      const fixture = runtimeFixture();
      vi.mocked(fixture.runtime.submit).mockImplementation(async () => {
        fixture.emit(event("turn.ended", { turnId: "turn-1", stop }));
      });

      await expect(
        runJsonTransport(fixture.runtime, "hello", vi.fn()),
      ).resolves.toBe(0);
    },
  );

  it("returns the timeout failure status through the JSON wrapper", async () => {
    const fixture = runtimeFixture();
    vi.mocked(fixture.runtime.submit).mockImplementation(async () => {
      fixture.emit(event("turn.ended", { turnId: "turn-1", stop: "timeout" }));
    });

    await expect(
      runJsonTransport(fixture.runtime, "hello", vi.fn()),
    ).resolves.toBe(1);
  });

  it.each([
    ["SIGINT", 130, "user interrupt"],
    ["SIGTERM", 143, "process terminated"],
  ] as const)(
    "cancels print work on %s, stops once, and returns %s",
    async (signal, status, reason) => {
      const fixture = runtimeFixture();
      const signals = signalFixture();
      let submitStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        submitStarted = resolve;
      });
      let releaseSubmit!: () => void;
      vi.mocked(fixture.runtime.submit).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            submitStarted();
            releaseSubmit = resolve;
          }),
      );
      vi.mocked(fixture.runtime.cancel).mockImplementation(async () => {
        releaseSubmit();
      });

      const run = runPrintTransport(fixture.runtime, "hello", {
        format: "text",
        write: vi.fn(),
        signalSource: signals,
        cleanupTimeoutMs: 25,
      });
      await started;
      signals.emit(signal);

      await expect(run).resolves.toBe(status);
      expect(fixture.runtime.cancel).toHaveBeenCalledOnce();
      expect(fixture.runtime.cancel).toHaveBeenCalledWith(reason);
      expect(fixture.runtime.stop).toHaveBeenCalledOnce();
    },
  );

  it("bounds signal cleanup when runtime stop does not settle", async () => {
    const fixture = runtimeFixture();
    const signals = signalFixture();
    let submitStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      submitStarted = resolve;
    });
    vi.mocked(fixture.runtime.submit).mockImplementation(async () => {
      submitStarted();
      await new Promise<void>(() => undefined);
    });
    vi.mocked(fixture.runtime.stop).mockImplementation(async () => {
      await new Promise<void>(() => undefined);
    });

    const run = runJsonTransport(fixture.runtime, "hello", vi.fn(), {
      signalSource: signals,
      cleanupTimeoutMs: 5,
    });
    await started;
    signals.emit("SIGINT");

    await expect(
      Promise.race([
        run,
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(-1), 50);
        }),
      ]),
    ).resolves.toBe(130);
    expect(fixture.runtime.stop).toHaveBeenCalledOnce();
  });

  it("observes RPC startup failure before waiting for controller input and still stops once", async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    vi.mocked(fixture.runtime.start).mockRejectedValue(
      new Error("runtime startup failed"),
    );

    const run = runRpcTransport(fixture.runtime, { input, output });
    const outcome = await Promise.race([
      run.then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.message : "rejected",
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still waiting for input"), 25);
      }),
    ]);
    input.end();
    await run.catch(() => undefined);

    expect(outcome).toBe("runtime startup failed");
    expect(fixture.runtime.stop).toHaveBeenCalledOnce();
  });

  it("cancels an RPC runtime on SIGTERM without waiting for controller input", async () => {
    const fixture = runtimeFixture();
    const signals = signalFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const run = runRpcTransport(
      fixture.runtime,
      { input, output },
      {
        signalSource: signals,
        cleanupTimeoutMs: 25,
      },
    );
    await vi.waitFor(() =>
      expect(fixture.runtime.start).toHaveBeenCalledOnce(),
    );

    signals.emit("SIGTERM");

    await expect(run).resolves.toBe(143);
    expect(fixture.runtime.cancel).toHaveBeenCalledWith("process terminated");
    expect(fixture.runtime.stop).toHaveBeenCalledOnce();
  });

  it("validates versioned RPC lines and correlates responses", async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on("data", (chunk) => writes.push(String(chunk)));

    const run = runRpcTransport(fixture.runtime, { input, output });
    input.write(
      `${JSON.stringify({
        protocolVersion: 1,
        requestId: "r1",
        command: { type: "runtime.snapshot" },
      })}\n`,
    );
    input.write("{bad json}\n");
    input.end();
    await run;

    const lines = writes
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      protocolVersion: 1,
      requestId: "r1",
      ok: true,
    });
    expect(lines[1]).toMatchObject({ category: "parse" });
    expect(fixture.execute).toHaveBeenCalledWith({ type: "runtime.snapshot" });
  });

  it("rejects oversized RPC frames by UTF-8 bytes and continues with the next frame", async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on("data", (chunk) => writes.push(String(chunk)));

    const run = runRpcTransport(fixture.runtime, { input, output });
    input.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
    input.write(`${"🙂".repeat(1024 * 1024 / 4 + 1)}\n`);
    input.write(`${JSON.stringify({ protocolVersion: 1, requestId: "after-large", command: { type: "runtime.snapshot" } })}\n`);
    input.end();
    await run;

    const lines = writes
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.slice(0, 2)).toEqual([
      expect.objectContaining({ category: "validation", message: expect.stringMatching(/frame.*1048576 bytes/i) }),
      expect.objectContaining({ category: "validation", message: expect.stringMatching(/frame.*1048576 bytes/i) }),
    ]);
    expect(lines[2]).toMatchObject({ protocolVersion: 1, requestId: "after-large", ok: true });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("waits for RPC output backpressure without corrupting JSONL frames", async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        setImmediate(() => {
          chunks.push(String(chunk));
          callback();
        });
      },
    });

    const run = runRpcTransport(fixture.runtime, { input, output });
    input.write(
      `${JSON.stringify({ protocolVersion: 1, requestId: "slow", command: { type: "runtime.snapshot" } })}\n`,
    );
    input.end();
    await run;

    expect(
      chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([expect.objectContaining({ requestId: "slow", ok: true })]);
  });

  it("fails fast on RPC output saturation before dispatching later commands", async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        // Deliberately never drain: the transport must fail instead of continuing
        // to execute commands whose responses can no longer be delivered.
      },
    });

    const run = runRpcTransport(fixture.runtime, { input, output }, { maxPendingOutputBytes: 256 });
    for (let index = 0; index < 20; index += 1) {
      input.write(`${JSON.stringify({ protocolVersion: 1, requestId: `blocked-${index}`, command: { type: "runtime.snapshot" } })}\n`);
    }

    await expect(run).rejects.toThrow(/output queue exceeded 256 bytes/i);
    expect(fixture.execute.mock.calls.length).toBeLessThan(20);
  });

  it("uses a safe public event projection unless full exposure is explicit", async () => {
    const safe = runtimeFixture();
    const safeWrites: string[] = [];
    vi.mocked(safe.runtime.submit).mockImplementation(async () => {
      safe.emit(event("input.received", { text: "PRIVATE PROMPT", source: "user" }));
      safe.emit(event("message.delta", {
        type: "thinking",
        text: "PRIVATE THINKING",
        requestId: "request:1",
        messageId: "message:1",
      }));
      safe.emit(event("message.delta", {
        type: "text",
        text: "VISIBLE ANSWER",
        requestId: "request:1",
        messageId: "message:1",
      }));
      safe.emit(event("message.delta", {
        type: "tool-call",
        id: "call:model",
        name: "probe",
        input: { token: "PRIVATE MODEL INPUT" },
        requestId: "request:1",
        messageId: "message:1",
      }));
      safe.emit(event("tool.requested", { callId: "call:1", name: "probe", input: { token: "PRIVATE TOKEN" } }));
      safe.emit(event("tool.ended", { callId: "call:1", name: "probe", result: { content: "PRIVATE RESULT" } }));
    });
    await runJsonTransport(safe.runtime, "hello", (value) => safeWrites.push(value));
    expect(safeWrites.join("")).not.toMatch(
      /PRIVATE PROMPT|PRIVATE THINKING|PRIVATE MODEL INPUT|PRIVATE TOKEN|PRIVATE RESULT/,
    );
    expect(safeWrites.join("")).toContain("VISIBLE ANSWER");

    const full = runtimeFixture();
    const fullWrites: string[] = [];
    vi.mocked(full.runtime.submit).mockImplementation(async () => {
      full.emit(event("tool.ended", { callId: "call:2", name: "probe", result: { content: "VISIBLE RESULT" } }));
    });
    await runJsonTransport(full.runtime, "hello", (value) => fullWrites.push(value), { eventExposure: "full" });
    expect(fullWrites.join("")).toContain("VISIBLE RESULT");
  });

  it("returns runtime command failures as correlated outer failures and rejects malformed commands", async () => {
    const fixture = runtimeFixture();
    fixture.execute.mockResolvedValueOnce({
      ok: false,
      error: {
        category: "unsupported-capability",
        message: "not available",
        retry: "unsafe",
        userVisible: true,
        redaction: "public",
        terminalEffect: "operation",
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on("data", (chunk) => writes.push(String(chunk)));

    const run = runRpcTransport(fixture.runtime, { input, output });
    input.write(
      `${JSON.stringify({ protocolVersion: 1, requestId: "failed", command: { type: "tools.list" } })}\n`,
    );
    input.write(
      `${JSON.stringify({ protocolVersion: 1, requestId: "malformed", command: { type: "input.submit" } })}\n`,
    );
    input.end();
    await run;

    const lines = writes
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      protocolVersion: 1,
      requestId: "failed",
      ok: false,
      error: { category: "unsupported-capability" },
    });
    expect(lines[0]).not.toHaveProperty("data");
    expect(lines[1]).toMatchObject({
      protocolVersion: 1,
      requestId: "malformed",
      category: "validation",
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("dispatches RPC commands concurrently so control input can interrupt an active submit", async () => {
    const fixture = runtimeFixture();
    let releaseSubmit!: () => void;
    const submitReleased = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    let markSubmitStarted!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      markSubmitStarted = resolve;
    });
    fixture.execute.mockImplementation(async (command) => {
      if (command.type === "input.submit") {
        markSubmitStarted();
        await submitReleased;
      }
      return { ok: true, data: { type: command.type } };
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on("data", (chunk) => writes.push(String(chunk)));

    const run = runRpcTransport(fixture.runtime, { input, output });
    input.write(
      `${JSON.stringify({ protocolVersion: 1, requestId: "submit", command: { type: "input.submit", text: "work" } })}\n`,
    );
    input.write(
      `${JSON.stringify({ protocolVersion: 1, requestId: "cancel", command: { type: "input.cancel", reason: "user" } })}\n`,
    );
    input.end();
    await submitStarted;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const dispatchedBeforeSubmitSettled = fixture.execute.mock.calls.map(
      ([command]) => command.type,
    );
    releaseSubmit();
    await run;

    expect(dispatchedBeforeSubmitSettled).toEqual([
      "input.submit",
      "input.cancel",
    ]);
    const responses = writes
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(responses.map((response) => response.requestId)).toEqual([
      "cancel",
      "submit",
    ]);
    expect(fixture.runtime.stop).toHaveBeenCalledOnce();
  });

  it("strictly parses the distinguishable worker projection envelope", () => {
    expect(
      parseNativeWorkerProjectionRequest({
        protocolVersion: 1,
        projection: "worker",
        requestId: "worker-request",
        sessionId: "session-1",
        command: { type: "list" },
      }),
    ).toEqual({
      protocolVersion: 1,
      projection: "worker",
      requestId: "worker-request",
      sessionId: "session-1",
      command: { type: "list" },
    });
    expect(() =>
      parseNativeWorkerProjectionRequest({
        protocolVersion: 1,
        projection: "worker",
        requestId: "bad",
        sessionId: "session-1",
        command: { type: "list", injected: true },
      }),
    ).toThrow("closed");
    expect(() =>
      parseNativeWorkerProjectionRequest({
        protocolVersion: 1,
        projection: "worker",
        requestId: "bad",
        sessionId: "session-1",
        command: { type: "list" },
        extra: true,
      }),
    ).toThrow("closed");
    expect(() =>
      parseNativeWorkerProjectionRequest({
        protocolVersion: 1,
        projection: "worker",
        requestId: "bad",
        sessionId: "session-1",
        command: {
          type: "abort",
          workerId: "worker-1",
          reason: "x".repeat(4097),
        },
      }),
    ).toThrow("reason");
  });

  it("coexists with normal runtime RPC and preserves worker request correlation", async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on("data", (chunk) => writes.push(String(chunk)));
    const workerExecute = vi.fn(async () => ({
      workerId: workerId("worker-1"),
      correlationId: correlationId("correlation-1"),
      sessionId: sessionId("session-1"),
      state: "running",
      queueDepth: 0,
      capabilities: { tools: [], models: [], maxTurns: 1 },
    }));
    const workerProjection = new NativeWorkerTransportProjection(
      { execute: workerExecute } as WorkerController,
      {
        activeSessionId: sessionId("session-1"),
        promptSnapshotId: "digest",
        capabilities: { tools: [], models: [], maxTurns: 1 },
        resolveAuthority: () => workerAuthorityFixture({ workerId: workerId("worker-1"), correlationId: correlationId("correlation-1"), sessionId: sessionId("session-1") }),
      },
    );

    const run = runRpcTransport(
      fixture.runtime,
      { input, output },
      { workerProjection },
    );
    input.write(
      `${JSON.stringify({ protocolVersion: 1, requestId: "runtime-1", command: { type: "runtime.snapshot" } })}\n`,
    );
    input.write(
      `${JSON.stringify({
        protocolVersion: 1,
        projection: "worker",
        requestId: "worker-1",
        sessionId: "session-1",
        correlationId: "correlation-1",
        command: { type: "status", workerId: "worker-1" },
      })}\n`,
    );
    input.end();
    await run;

    const responses = writes
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          protocolVersion: 1,
          requestId: "runtime-1",
          ok: true,
        }),
        expect.objectContaining({
          protocolVersion: 1,
          projection: "worker",
          requestId: "worker-1",
          ok: true,
          data: {
            action: "status",
            worker: {
              workerId: "worker-1",
              correlationId: "correlation-1",
              state: "running",
              queueDepth: 0,
            },
          },
        }),
      ]),
    );
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(workerExecute).toHaveBeenCalledWith({
      type: "status",
      workerId: "worker-1",
      authority: workerAuthorityFixture({ workerId: workerId("worker-1"), correlationId: correlationId("correlation-1"), sessionId: sessionId("session-1") }),
    });
  });

  it("resolves the current worker projection for each RPC envelope", async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const secondExecute = vi.fn(async () => []);
    const first = new NativeWorkerTransportProjection({ execute: vi.fn(async () => []) } as WorkerController, {
      activeSessionId: sessionId("session-1"), promptSnapshotId: "first", capabilities: { tools: [], models: [], maxTurns: 1 },
      resolveAuthority: () => workerAuthorityFixture({ sessionId: sessionId("session-1") }),
    });
    const second = new NativeWorkerTransportProjection({ execute: secondExecute } as WorkerController, {
      activeSessionId: sessionId("session-2"), promptSnapshotId: "second", capabilities: { tools: [], models: [], maxTurns: 1 },
      resolveAuthority: () => workerAuthorityFixture({ sessionId: sessionId("session-2") }),
    });
    let current = first;
    const run = runRpcTransport(fixture.runtime, { input, output }, { getWorkerProjection: () => current });
    current = second;
    input.end(`${JSON.stringify({ protocolVersion: 1, projection: "worker", requestId: "current", sessionId: "session-2", command: { type: "list" } })}\n`);
    await run;
    expect(secondExecute).toHaveBeenCalledWith({ type: "list" });
  });

  it("fails closed when a worker envelope arrives without a configured projection", async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    let encoded = "";
    output.on("data", (chunk) => {
      encoded += String(chunk);
    });
    const run = runRpcTransport(fixture.runtime, { input, output });
    input.end(
      `${JSON.stringify({
        protocolVersion: 1,
        projection: "worker",
        requestId: "worker-unavailable",
        sessionId: "session-1",
        command: { type: "list" },
      })}\n`,
    );
    await run;
    expect(JSON.parse(encoded.trim())).toMatchObject({
      protocolVersion: 1,
      projection: "worker",
      requestId: "worker-unavailable",
      ok: false,
      error: {
        category: "validation",
        message: "Worker projection is unavailable",
      },
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("keeps duplicate runtime and worker request IDs distinguishable", async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    let encoded = "";
    output.on("data", (chunk) => {
      encoded += String(chunk);
    });
    const workerProjection = new NativeWorkerTransportProjection(
      { execute: async () => [] } as WorkerController,
      {
        activeSessionId: sessionId("session-1"),
        promptSnapshotId: "digest",
        capabilities: { tools: [], models: [], maxTurns: 1 },
        resolveAuthority: () => workerAuthorityFixture({ sessionId: sessionId("session-1") }),
      },
    );
    const run = runRpcTransport(
      fixture.runtime,
      { input, output },
      { workerProjection },
    );
    input.write(
      `${JSON.stringify({ protocolVersion: 1, requestId: "duplicate", command: { type: "runtime.snapshot" } })}\n`,
    );
    input.end(
      `${JSON.stringify({ protocolVersion: 1, projection: "worker", requestId: "duplicate", sessionId: "session-1", command: { type: "list" } })}\n`,
    );
    await run;
    const responses = encoded
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      responses.filter((response) => response.requestId === "duplicate"),
    ).toHaveLength(2);
    expect(responses.some((response) => response.projection === "worker")).toBe(
      true,
    );
    expect(
      responses.some(
        (response) => response.projection === undefined && response.ok === true,
      ),
    ).toBe(true);
  });
});
