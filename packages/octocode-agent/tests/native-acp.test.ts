import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { PassThrough } from "node:stream";
import {
  correlationId,
  packetId,
  sessionId,
  workerId,
  type AgentRuntime,
  type RuntimeEvent,
} from "@octocodeai/agent-core";
import {
  createNativeAcpWorkerAuthorizer,
  createAgentRuntimeAcpAdapter,
  createNativeAcpAdapter,
  serveNativeAcpStdio,
  type NativeAcpRuntime,
} from "../src/native-acp.js";
import { NativeWorkerTransportProjection } from "../src/native-worker-projection.js";
import { createNativeInteractionBroker, type NativeInteractionBroker } from "../src/native-interactions.js";
import type {
  NativeProcessSignal,
  NativeSignalSource,
} from "../src/native-signal-scope.js";

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

function runtime(overrides: Partial<NativeAcpRuntime> = {}): NativeAcpRuntime {
  return {
    createSession: async () => ({ sessionId: "session-1" }),
    prompt: async () => ({ stopReason: "end_turn" }),
    cancel: async () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}

describe("native ACP adapter", () => {
  it("maps worker process approval to one-shot ACP permission without exposing the prompt", async () => {
    const requestPermission = vi.fn(async () => ({ outcome: { outcome: "selected" as const, optionId: "allow-once" } }));
    const authorize = createNativeAcpWorkerAuthorizer(requestPermission);
    const allowed = await authorize({
      sessionId: sessionId("permission-session"),
      policy: { effect: "process", trust: "workspace", approval: "on-request" },
      command: {
        type: "spawn",
        packet: {
          schemaVersion: 1, type: "worker.spawn", packetId: packetId("spawn-permission"), workerId: workerId("worker-permission"),
          correlationId: correlationId("correlation-permission"), sessionId: sessionId("permission-session"), redaction: "sensitive",
          prompt: "private worker prompt", promptSnapshotId: "digest", workspace: { mode: "shared" },
          capabilities: { tools: [], models: [], maxTurns: 1 },
        },
      },
    });
    expect(allowed).toBe(true);
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "permission-session",
      toolCall: expect.objectContaining({ toolCallId: "spawn-permission", kind: "execute", rawInput: { action: "spawn", workerId: "worker-permission" } }),
      options: [
        { kind: "allow_once", name: "Allow this worker operation", optionId: "allow-once" },
        { kind: "reject_once", name: "Reject this worker operation", optionId: "reject-once" },
      ],
    }));
    expect(JSON.stringify(requestPermission.mock.calls)).not.toContain("private worker prompt");
    await expect(createNativeAcpWorkerAuthorizer(async () => ({ outcome: { outcome: "cancelled" } }))({
      sessionId: sessionId("permission-session"), command: { type: "list" },
      policy: { effect: "process", trust: "workspace", approval: "on-request" },
    })).resolves.toBe(false);
  });

  it("exposes the guarded worker projection as the ACP/editor integration API", async () => {
    const workers = { execute: vi.fn(async () => ({
      response: { protocolVersion: 1 as const, projection: 'worker' as const, requestId: 'r1', ok: true as const, data: { action: 'list', workers: [] } },
      update: { kind: 'worker' as const, requestId: 'r1', action: 'list', workers: [] },
    })) };
    const adapter = createNativeAcpAdapter({ ...runtime(), workers });
    await expect(adapter.workers?.execute({ requestId: 'r1' })).resolves.toMatchObject({
      response: { ok: true, data: { action: 'list' } },
      update: { kind: 'worker', action: 'list' },
    });
    expect(workers.execute).toHaveBeenCalledOnce();
  });
  it("negotiates v1 capabilities and maps session creation, prompt, and cancel", async () => {
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const createSession = vi.fn(async () => ({ sessionId: "session-1" }));
    const cancel = vi.fn(async () => undefined);
    const prompt = vi.fn<NativeAcpRuntime["prompt"]>(async ({ signal }) => {
      reportStarted();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
      return { stopReason: "end_turn" };
    });
    const adapter = createNativeAcpAdapter(
      runtime({ createSession, prompt, cancel }),
    );

    await client({ name: "test-client" }).connectWith(
      adapter.app,
      async (agent) => {
        await expect(
          agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          }),
        ).resolves.toMatchObject({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
          authMethods: [],
          agentInfo: { name: "octocode-agent" },
        });
        await expect(
          agent.request(methods.agent.session.new, {
            cwd: "/workspace",
            mcpServers: [],
          }),
        ).resolves.toEqual({ sessionId: "session-1" });
        const turn = agent.request(methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "hello" }],
        });
        await started;
        await agent.notify(methods.agent.session.cancel, {
          sessionId: "session-1",
        });
        await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
      },
    );

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace", mcpServers: [] }),
    );
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "hello" }],
      }),
    );
    expect(cancel).toHaveBeenCalledWith("session-1");
  });

  it("translates content, thought progress, tool, and plan events into SDK session updates", async () => {
    const updates: SessionUpdate[] = [];
    const adapter = createNativeAcpAdapter(
      runtime({
        prompt: async ({ emit }) => {
          await emit({
            kind: "content",
            content: { type: "text", text: "answer" },
            messageId: "message-1",
          });
          await emit({
            kind: "progress",
            text: "Checking files",
            messageId: "thought-1",
          });
          await emit({
            kind: "tool-call",
            call: {
              toolCallId: "tool-1",
              title: "Search",
              kind: "search",
              status: "in_progress",
            },
          });
          await emit({
            kind: "tool-update",
            update: {
              toolCallId: "tool-1",
              status: "completed",
              rawOutput: { matches: 2 },
            },
          });
          await emit({
            kind: "plan",
            entries: [
              {
                content: "Verify result",
                priority: "high",
                status: "in_progress",
              },
            ],
          });
          return { stopReason: "end_turn" };
        },
      }),
    );
    const testClient = client({ name: "test-client" }).onNotification(
      methods.client.session.update,
      ({ params }) => {
        updates.push(params.update);
      },
    );

    await testClient.connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await agent.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      await expect(
        agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "work" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
    });

    expect(updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "answer" },
        messageId: "message-1",
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Checking files" },
        messageId: "thought-1",
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Search",
        kind: "search",
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { matches: 2 },
      },
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Verify result", priority: "high", status: "in_progress" },
        ],
      },
    ]);
  });

  it("preserves SDK request errors and closes the runtime once on protocol shutdown", async () => {
    const close = vi.fn(async () => undefined);
    const adapter = createNativeAcpAdapter(runtime({ close }));
    const connection = client({ name: "test-client" }).connect(adapter.app);
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    await expect(
      connection.agent.request(methods.agent.authenticate, {
        methodId: "unsupported",
      }),
    ).rejects.toMatchObject({
      code: RequestError.methodNotFound(methods.agent.authenticate).code,
    });
    connection.close(new Error("transport failed"));
    await connection.closed;
    await adapter.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("owns one canonical runtime per session, subscribes before submit, and fails closed on non-text prompts", async () => {
    const order: string[] = [];
    const runtimes: Array<AgentRuntime & { emit(event: RuntimeEvent): void }> =
      [];
    const createRuntime = vi.fn(async () => {
      const listeners = new Set<(event: RuntimeEvent) => void>();
      const id = `runtime-${runtimes.length + 1}`;
      const runtime = {
        start: vi.fn(async () => undefined),
        submit: vi.fn(async () => {
          order.push("submit");
          runtime.emit({
            type: "message.delta",
            payload: { type: "text", text: "hello", messageId: "m1" },
          } as RuntimeEvent);
          runtime.emit({
            type: "ui.status-changed",
            payload: { name: "research", text: "Checking" },
          } as RuntimeEvent);
          runtime.emit({
            type: "turn.ended",
            payload: { stop: "complete" },
          } as RuntimeEvent);
        }),
        cancel: vi.fn(async () => undefined),
        execute: vi.fn(async () => ({ ok: true as const })),
        snapshot: () => ({
          schemaVersion: 1 as const,
          state: "ready" as const,
          sessionId: id as never,
          activeTurn: false,
          model: null,
          thinkingLevel: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          revision: 0,
        }),
        subscribe: vi.fn((listener: (event: RuntimeEvent) => void) => {
          order.push("subscribe");
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        stop: vi.fn(async () => undefined),
        emit: (event: RuntimeEvent) => {
          for (const listener of listeners) listener(event);
        },
      } satisfies AgentRuntime & { emit(event: RuntimeEvent): void };
      runtimes.push(runtime);
      return runtime;
    });
    const updates: SessionUpdate[] = [];
    const adapter = createAgentRuntimeAcpAdapter({ createRuntime });
    const testClient = client({ name: "test-client" }).onNotification(
      methods.client.session.update,
      ({ params }) => {
        updates.push(params.update);
      },
    );

    await testClient.connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const first = await agent.request(methods.agent.session.new, {
        cwd: "/one",
        mcpServers: [],
      });
      const second = await agent.request(methods.agent.session.new, {
        cwd: "/two",
        mcpServers: [],
      });
      await expect(
        agent.request(methods.agent.session.prompt, {
          sessionId: first.sessionId,
          prompt: [{ type: "text", text: "do work" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      await expect(
        agent.request(methods.agent.session.prompt, {
          sessionId: second.sessionId,
          prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
    });

    expect(createRuntime.mock.calls.map(([cwd]) => cwd)).toEqual([
      "/one",
      "/two",
    ]);
    expect(order.slice(0, 2)).toEqual(["subscribe", "submit"]);
    expect(runtimes[1]!.submit).not.toHaveBeenCalled();
    expect(updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
        messageId: "m1",
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Checking" },
      },
    ]);
    await adapter.close();
    await adapter.close();
    expect(
      runtimes.map(({ stop }) => vi.mocked(stop).mock.calls.length),
    ).toEqual([1, 1]);
  });

  it("maps the native timeout terminal state to ACP max-turn exhaustion", async () => {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const nativeRuntime = {
      start: vi.fn(async () => undefined),
      submit: vi.fn(async () => {
        for (const listener of listeners)
          listener({
            type: "turn.ended",
            payload: { stop: "timeout" },
          } as RuntimeEvent);
      }),
      cancel: vi.fn(async () => undefined),
      execute: vi.fn(async () => ({ ok: true as const })),
      snapshot: () => ({
        schemaVersion: 1 as const,
        state: "ready" as const,
        sessionId: "timeout-session" as never,
        activeTurn: false,
        model: null,
        thinkingLevel: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        revision: 0,
      }),
      subscribe: vi.fn((listener: (event: RuntimeEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      stop: vi.fn(async () => undefined),
    } satisfies AgentRuntime;
    const adapter = createAgentRuntimeAcpAdapter({
      createRuntime: async () => nativeRuntime,
    });

    await client({ name: "test-client" }).connectWith(
      adapter.app,
      async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await agent.request(methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        await expect(
          agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "work" }],
          }),
        ).resolves.toEqual({ stopReason: "max_turn_requests" });
      },
    );
  });

  it("cancels active agent-runtime work before exact-once adapter close", async () => {
    let releaseSubmit!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const nativeRuntime = {
      start: vi.fn(async () => undefined),
      submit: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseSubmit = resolve;
            markStarted();
          }),
      ),
      cancel: vi.fn(async () => {
        releaseSubmit();
      }),
      execute: vi.fn(async () => ({ ok: true as const })),
      snapshot: () => ({
        schemaVersion: 1 as const,
        state: "ready" as const,
        sessionId: "signal-session" as never,
        activeTurn: false,
        model: null,
        thinkingLevel: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        revision: 0,
      }),
      subscribe: vi.fn(() => vi.fn()),
      stop: vi.fn(async () => undefined),
    } satisfies AgentRuntime;
    const adapter = createAgentRuntimeAcpAdapter({
      createRuntime: async () => nativeRuntime,
    });

    await client({ name: "test-client" }).connectWith(
      adapter.app,
      async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await agent.request(methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        const prompt = agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "work" }],
        });
        await started;
        await adapter.close(new Error("process terminated"));
        await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      },
    );

    expect(nativeRuntime.cancel).toHaveBeenCalledOnce();
    expect(nativeRuntime.stop).toHaveBeenCalledOnce();
  });

  it("removes worker projections before awaiting runtime shutdown", async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const execute = vi.fn(async () => []);
    const runtime = {
      start: vi.fn(async () => undefined), submit: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
      execute: vi.fn(async () => ({ ok: true as const })),
      snapshot: () => ({ schemaVersion: 1 as const, state: "ready" as const, sessionId: sessionId("closing-session"), activeTurn: false, model: null, thinkingLevel: null, usage: { inputTokens: 0, outputTokens: 0 }, revision: 0 }),
      subscribe: vi.fn(() => vi.fn()), stop: vi.fn(() => stopGate),
    } satisfies AgentRuntime;
    const projection = new NativeWorkerTransportProjection({ execute }, {
      activeSessionId: sessionId("closing-session"), promptSnapshotId: "digest",
      capabilities: { tools: [], models: [], maxTurns: 1 }, authorize: async () => true,
    });
    const adapter = createAgentRuntimeAcpAdapter({ createRuntime: async () => runtime, workerProjection: () => projection });
    const connection = client({ name: "test-client" }).connect(adapter.app);
    await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await connection.agent.request(methods.agent.session.new, { cwd: "/workspace", mcpServers: [] });
    const closing = adapter.close();
    await Promise.resolve();
    await Promise.resolve();
    await expect(adapter.workers?.execute({
      protocolVersion: 1, projection: "worker", requestId: "during-close", sessionId: "closing-session", command: { type: "list" },
    })).resolves.toMatchObject({ response: { ok: false, error: { category: "correlation" } } });
    expect(execute).not.toHaveBeenCalled();
    releaseStop();
    await closing;
    connection.close();
  });

  it("resolves the current worker projection after ACP session creation", async () => {
    const executeFirst = vi.fn(async () => []);
    const executeSecond = vi.fn(async () => []);
    const runtime = {
      start: vi.fn(async () => undefined), submit: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
      execute: vi.fn(async () => ({ ok: true as const })),
      snapshot: () => ({ schemaVersion: 1 as const, state: "ready" as const, sessionId: sessionId("dynamic-session"), activeTurn: false, model: null, thinkingLevel: null, usage: { inputTokens: 0, outputTokens: 0 }, revision: 0 }),
      subscribe: vi.fn(() => vi.fn()), stop: vi.fn(async () => undefined),
    } satisfies AgentRuntime;
    const projection = (execute: typeof executeFirst, activeSessionId: string) => new NativeWorkerTransportProjection({ execute }, {
      activeSessionId: sessionId(activeSessionId), promptSnapshotId: "digest", capabilities: { tools: [], models: [], maxTurns: 1 }, authorize: async () => true,
    });
    let current = projection(executeFirst, "dynamic-session");
    const adapter = createAgentRuntimeAcpAdapter({ createRuntime: async () => runtime, workerProjection: () => current });
    const connection = client({ name: "dynamic-client" }).connect(adapter.app);
    await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const created = await connection.agent.request(methods.agent.session.new, { cwd: "/workspace", mcpServers: [] });
    current = projection(executeSecond, created.sessionId);
    const request = { protocolVersion: 1 as const, projection: "worker" as const, requestId: "dynamic", sessionId: created.sessionId, command: { type: "list" as const } };
    expect(await current.execute(request)).toMatchObject({ ok: true });
    const response = await adapter.workers?.execute(request);
    expect(response).toMatchObject({ response: { ok: true } });
    expect(executeFirst).not.toHaveBeenCalled();
    expect(executeSecond).toHaveBeenCalledWith({ type: "list" });
    await adapter.close();
    connection.close();
  });

  it("isolates concurrent session interactions through ACP permission and detaches after each prompt", async () => {
    const brokers = new Map<string, NativeInteractionBroker>();
    const interactionResults = new Map<string, unknown[]>();
    const createRuntime = vi.fn(async (cwd: string) => {
      const id = cwd.endsWith('/one') ? 'permission-one' : 'permission-two';
      const broker = createNativeInteractionBroker({ timeoutMs: 1_000 });
      brokers.set(id, broker);
      const runtime = {
        start: vi.fn(async () => undefined),
        submit: vi.fn(async () => {
          const signal = new AbortController().signal;
          const results = id === 'permission-one'
            ? [
                await broker.interact({ type: 'input', message: 'Secret text?' }, signal),
                await broker.interact({ type: 'confirm', message: 'Allow worker?' }, signal),
              ]
            : [await broker.interact({ type: 'select', message: 'Choose lane', options: ['alpha', 'beta'] }, signal)];
          interactionResults.set(id, results);
        }),
        cancel: vi.fn(async () => undefined), execute: vi.fn(async () => ({ ok: true as const })),
        snapshot: () => ({ schemaVersion: 1 as const, state: 'ready' as const, sessionId: sessionId(id), activeTurn: false, model: null, thinkingLevel: null, usage: { inputTokens: 0, outputTokens: 0 }, revision: 0 }),
        subscribe: vi.fn(() => vi.fn()), stop: vi.fn(async () => undefined),
      } satisfies AgentRuntime;
      return runtime;
    });
    const adapter = createAgentRuntimeAcpAdapter({
      createRuntime,
      interactions: (runtime) => brokers.get(String(runtime.snapshot().sessionId)),
    });
    const permissionRequests: string[] = [];
    const testClient = client({ name: 'permission-client' }).onRequest(
      methods.client.session.requestPermission,
      ({ params }) => {
        permissionRequests.push(params.sessionId);
        return {
          outcome: {
            outcome: 'selected' as const,
            optionId: params.sessionId === 'permission-one' ? 'confirm:true' : 'select:1',
          },
        };
      },
    );
    await testClient.connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const one = await agent.request(methods.agent.session.new, { cwd: '/workspace/one', mcpServers: [] });
      const two = await agent.request(methods.agent.session.new, { cwd: '/workspace/two', mcpServers: [] });
      await Promise.all([
        agent.request(methods.agent.session.prompt, { sessionId: one.sessionId, prompt: [{ type: 'text', text: 'one' }] }),
        agent.request(methods.agent.session.prompt, { sessionId: two.sessionId, prompt: [{ type: 'text', text: 'two' }] }),
      ]);
    });
    expect(interactionResults.get('permission-one')).toEqual([
      { status: 'unsupported' }, { status: 'accepted', value: true },
    ]);
    expect(interactionResults.get('permission-two')).toEqual([{ status: 'accepted', value: 'beta' }]);
    expect(permissionRequests.sort()).toEqual(['permission-one', 'permission-two']);
    for (const broker of brokers.values()) {
      await expect(broker.interact({ type: 'confirm', message: 'after prompt' }, new AbortController().signal, 10))
        .resolves.toEqual({ status: 'unsupported' });
    }
  });

  it("serves an official SDK stdio connection and closes it without parsing protocol data", async () => {
    const close = vi.fn(async () => undefined);
    const adapter = createNativeAcpAdapter(runtime({ close }));
    const input = new PassThrough();
    const output = new PassThrough();
    const connection = serveNativeAcpStdio(adapter, { input, output });

    connection.close();
    await connection.closed;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("owns process signals on the stdio adapter and reports the conventional status", async () => {
    const close = vi.fn(async () => undefined);
    const adapter = createNativeAcpAdapter(runtime({ close }));
    const input = new PassThrough();
    const output = new PassThrough();
    const signals = signalFixture();
    const connection = serveNativeAcpStdio(
      adapter,
      { input, output },
      { signalSource: signals },
    );

    signals.emit("SIGTERM");

    await expect(connection.exitCode).resolves.toBe(143);
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds ACP signal cleanup when a runtime close does not settle", async () => {
    const adapter = createNativeAcpAdapter(
      runtime({
        close: async () => new Promise<void>(() => undefined),
      }),
    );
    const signals = signalFixture();
    const connection = serveNativeAcpStdio(
      adapter,
      { input: new PassThrough(), output: new PassThrough() },
      { signalSource: signals, cleanupTimeoutMs: 5 },
    );

    signals.emit("SIGINT");

    await expect(
      Promise.race([
        connection.exitCode,
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(-1), 50);
        }),
      ]),
    ).resolves.toBe(130);
  });
});
