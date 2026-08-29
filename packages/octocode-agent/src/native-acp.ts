import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  ndJsonStream,
  type AcpConnection,
  type AgentApp,
  type ContentBlock,
  type NewSessionRequest,
  type NewSessionResponse,
  type PlanEntry,
  type PromptResponse,
  type SessionUpdate,
  type ToolCall,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import type { AgentRuntime, RuntimeEvent } from "@octocodeai/agent-core";
import type { SessionId } from "@octocodeai/agent-core";
import {
  createNativeWorkerEditorProjectionResolver,
  type NativeWorkerProjectionAuthorizationRequest,
  type NativeWorkerEditorProjection,
  type NativeWorkerTransportProjection,
} from "./native-worker-projection.js";
import type { NativeInteractionBroker, NativeInteractionHandler } from "./native-interactions.js";
import {
  createNativeSignalScope,
  nativeSignalExitCode,
  nativeSignalReason,
  settleNativeCleanup,
  type NativeSignalSource,
} from "./native-signal-scope.js";

const DEFAULT_ACP_CLEANUP_TIMEOUT_MS = 1_000;

export type NativeAcpEvent =
  | {
      kind: "content";
      content: ContentBlock;
      messageId?: string;
      thought?: boolean;
    }
  | { kind: "progress"; text: string; messageId?: string }
  | { kind: "tool-call"; call: ToolCall }
  | { kind: "tool-update"; update: ToolCallUpdate }
  | { kind: "plan"; entries: PlanEntry[] };

export interface NativeAcpRuntime {
  createSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  prompt(input: {
    sessionId: string;
    prompt: ContentBlock[];
    signal: AbortSignal;
    emit(event: NativeAcpEvent): Promise<void>;
    requestPermission(request: NativeAcpWorkerPermissionRequest): ReturnType<NativeAcpWorkerPermissionRequester>;
  }): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  close?(): Promise<void>;
  readonly workers?: NativeWorkerEditorProjection;
}

export interface NativeAcpAdapter {
  app: AgentApp;
  close(reason?: unknown): Promise<void>;
  readonly workers?: NativeWorkerEditorProjection;
}

export interface NativeAcpStdioConnection extends AcpConnection {
  readonly exitCode: Promise<number>;
}

export interface AgentRuntimeAcpOptions {
  createRuntime(cwd: string, request: NewSessionRequest): Promise<AgentRuntime>;
  planEntries?(event: RuntimeEvent): PlanEntry[] | undefined;
  workerProjection?(runtime: AgentRuntime, sessionId: SessionId): NativeWorkerTransportProjection | undefined;
  interactions?(runtime: AgentRuntime, sessionId: SessionId): NativeInteractionBroker | undefined;
}

export interface NativeAcpWorkerPermissionRequest {
  readonly sessionId: string;
  readonly toolCall: ToolCall;
  readonly options: readonly {
    readonly kind: "allow_once" | "reject_once";
    readonly name: string;
    readonly optionId: string;
  }[];
}

export type NativeAcpWorkerPermissionRequester = (request: NativeAcpWorkerPermissionRequest) => Promise<{
  readonly outcome: { readonly outcome: "cancelled" } | { readonly outcome: "selected"; readonly optionId: string };
}>;

/** Least-authority ACP approval seam: one operation, no persistent grant, fail closed. */
export function createNativeAcpWorkerAuthorizer(
  requestPermission: NativeAcpWorkerPermissionRequester,
): (request: NativeWorkerProjectionAuthorizationRequest) => Promise<boolean> {
  return async (request) => {
    const command = request.command;
    const addressedWorker = command.type === "spawn" || command.type === "send" || command.type === "steer" || command.type === "follow-up"
      ? String(command.packet.workerId)
      : "workerId" in command ? String(command.workerId) : undefined;
    const callId = command.type === "spawn" || command.type === "send" || command.type === "steer" || command.type === "follow-up"
      ? String(command.packet.packetId)
      : `worker:${command.type}:${addressedWorker ?? "session"}`;
    try {
      const response = await requestPermission({
        sessionId: String(request.sessionId),
        toolCall: {
          toolCallId: callId,
          title: `Worker process: ${command.type}`,
          kind: "execute",
          status: "pending",
          rawInput: { action: command.type, ...(addressedWorker === undefined ? {} : { workerId: addressedWorker }) },
        },
        options: [
          { kind: "allow_once", name: "Allow this worker operation", optionId: "allow-once" },
          { kind: "reject_once", name: "Reject this worker operation", optionId: "reject-once" },
        ],
      });
      return response.outcome.outcome === "selected" && response.outcome.optionId === "allow-once";
    } catch {
      return false;
    }
  };
}

function createNativeAcpInteractionHandler(
  sessionId: string,
  requestPermission: NativeAcpWorkerPermissionRequester,
): NativeInteractionHandler {
  let sequence = 0;
  return async (request, signal) => {
    if (request.type !== "confirm" && request.type !== "select") return { status: "unsupported" };
    if (signal.aborted) return { status: "cancelled" };
    const selectOptions = request.type === "select" ? request.options : undefined;
    const options = request.type === "confirm"
      ? [
          { kind: "allow_once" as const, name: "Allow", optionId: "confirm:true" },
          { kind: "reject_once" as const, name: "Reject", optionId: "confirm:false" },
        ]
      : [
          ...(selectOptions ?? []).map((name, index) => ({ kind: "allow_once" as const, name, optionId: `select:${index}` })),
          { kind: "reject_once" as const, name: "Cancel", optionId: "select:cancel" },
        ];
    try {
      const response = await requestPermission({
        sessionId,
        toolCall: {
          toolCallId: `interaction:${sessionId}:${++sequence}`,
          title: request.message,
          kind: "other",
          status: "pending",
          rawInput: { type: request.type },
        },
        options,
      });
      if (signal.aborted || response.outcome.outcome === "cancelled") return { status: "cancelled" };
      if (request.type === "confirm") {
        if (response.outcome.optionId === "confirm:true") return { status: "accepted", value: true };
        if (response.outcome.optionId === "confirm:false") return { status: "accepted", value: false };
        return { status: "unsupported" };
      }
      const match = /^select:(\d+)$/.exec(response.outcome.optionId);
      const index = match === null ? -1 : Number(match[1]);
      const value = selectOptions?.[index];
      return value === undefined ? { status: "cancelled" } : { status: "accepted", value };
    } catch {
      return signal.aborted ? { status: "cancelled" } : { status: "unsupported" };
    }
  };
}

export function toAcpSessionUpdate(event: NativeAcpEvent): SessionUpdate {
  switch (event.kind) {
    case "content":
      return {
        sessionUpdate: event.thought
          ? "agent_thought_chunk"
          : "agent_message_chunk",
        content: event.content,
        ...(event.messageId ? { messageId: event.messageId } : {}),
      };
    case "progress":
      return {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.text },
        ...(event.messageId ? { messageId: event.messageId } : {}),
      };
    case "tool-call":
      return { sessionUpdate: "tool_call", ...event.call };
    case "tool-update":
      return { sessionUpdate: "tool_call_update", ...event.update };
    case "plan":
      return { sessionUpdate: "plan", entries: event.entries };
  }
}

export function createNativeAcpAdapter(
  runtime: NativeAcpRuntime,
): NativeAcpAdapter {
  const sessions = new Set<string>();
  const activePrompts = new Map<string, AbortController>();
  const app = agent({ name: "octocode-agent" });
  let closePromise: Promise<void> | undefined;

  const close = (
    reason: unknown = new Error("ACP connection closed"),
  ): Promise<void> => {
    if (closePromise) return closePromise;
    const activeSessionIds = [...activePrompts.keys()];
    for (const controller of activePrompts.values()) controller.abort(reason);
    activePrompts.clear();
    sessions.clear();
    closePromise = Promise.resolve().then(async () => {
      await Promise.all(
        activeSessionIds.map((sessionId) => runtime.cancel(sessionId)),
      );
      await runtime.close?.();
    });
    return closePromise;
  };

  app.onConnect((connection) => {
    connection.signal.addEventListener(
      "abort",
      () => {
        void close(connection.signal.reason).catch(() => undefined);
      },
      { once: true },
    );
  });

  app.onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    authMethods: [],
    agentInfo: { name: "octocode-agent", version: "1.1.0" },
  }));

  app.onRequest(methods.agent.session.new, async ({ params }) => {
    const session = await runtime.createSession(params);
    sessions.add(session.sessionId);
    return session;
  });

  app.onRequest(
    methods.agent.session.prompt,
    async ({ params, signal, client: clientContext }) => {
      if (!sessions.has(params.sessionId)) {
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          "unknown ACP session",
        );
      }
      if (activePrompts.has(params.sessionId)) {
        throw RequestError.invalidRequest(
          { sessionId: params.sessionId },
          "prompt already active",
        );
      }
      const controller = new AbortController();
      const abortFromRequest = (): void => controller.abort(signal.reason);
      if (signal.aborted) abortFromRequest();
      else signal.addEventListener("abort", abortFromRequest, { once: true });
      activePrompts.set(params.sessionId, controller);
      try {
        return await runtime.prompt({
          sessionId: params.sessionId,
          prompt: params.prompt,
          signal: controller.signal,
          emit: async (event) =>
            clientContext.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: toAcpSessionUpdate(event),
            }),
          requestPermission: (request) => clientContext.request(methods.client.session.requestPermission, request),
        });
      } catch (error) {
        if (controller.signal.aborted) return { stopReason: "cancelled" };
        throw error;
      } finally {
        signal.removeEventListener("abort", abortFromRequest);
        if (activePrompts.get(params.sessionId) === controller)
          activePrompts.delete(params.sessionId);
      }
    },
  );

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    if (!sessions.has(params.sessionId)) return;
    activePrompts
      .get(params.sessionId)
      ?.abort(new Error("ACP prompt cancelled"));
    await runtime.cancel(params.sessionId);
  });

  return { app, close, ...(runtime.workers === undefined ? {} : { workers: runtime.workers }) };
}

function recordPayload(event: RuntimeEvent): Record<string, unknown> {
  return typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function runtimeEventToAcp(
  event: RuntimeEvent,
  planEntries?: AgentRuntimeAcpOptions["planEntries"],
): NativeAcpEvent | undefined {
  const payload = recordPayload(event);
  if (
    event.type === "message.delta" &&
    payload["type"] === "text" &&
    typeof payload["text"] === "string"
  ) {
    return {
      kind: "content",
      content: { type: "text", text: payload["text"] },
      ...(typeof payload["messageId"] === "string"
        ? { messageId: payload["messageId"] }
        : {}),
    };
  }
  if (
    event.type === "ui.status-changed" &&
    typeof payload["name"] === "string"
  ) {
    return {
      kind: "progress",
      text:
        typeof payload["text"] === "string" ? payload["text"] : payload["name"],
    };
  }
  if (
    event.type === "tool.started" &&
    typeof payload["callId"] === "string" &&
    typeof payload["name"] === "string"
  ) {
    return {
      kind: "tool-call",
      call: {
        toolCallId: payload["callId"],
        title: payload["name"],
        name: payload["name"],
        kind: "other",
        status: "in_progress",
      },
    };
  }
  if (event.type === "tool.updated" && typeof payload["callId"] === "string") {
    const update =
      typeof payload["update"] === "object" && payload["update"] !== null
        ? (payload["update"] as Record<string, unknown>)
        : {};
    return {
      kind: "tool-update",
      update: {
        toolCallId: payload["callId"],
        status: "in_progress",
        ...(typeof update["message"] === "string"
          ? { title: update["message"] }
          : {}),
        rawOutput: update,
      },
    };
  }
  if (event.type === "tool.ended" && typeof payload["callId"] === "string") {
    const successful =
      payload["outcome"] === "completed" || payload["outcome"] === "success";
    return {
      kind: "tool-update",
      update: {
        toolCallId: payload["callId"],
        status: successful ? "completed" : "failed",
        rawOutput: payload,
      },
    };
  }
  const entries = planEntries?.(event);
  return entries ? { kind: "plan", entries } : undefined;
}

function stopReasonFrom(value: unknown): PromptResponse["stopReason"] {
  if (value === "timeout") return "max_turn_requests";
  return value === "cancelled" ||
    value === "max_tokens" ||
    value === "max_turn_requests" ||
    value === "refusal"
    ? value
    : "end_turn";
}

export function createAgentRuntimeAcpAdapter(
  options: AgentRuntimeAcpOptions,
): NativeAcpAdapter {
  const sessions = new Map<
    string,
    { runtime: AgentRuntime; interactions?: NativeInteractionBroker; stop?: Promise<void> }
  >();
  const stopRuntime = (record: {
    runtime: AgentRuntime;
    stop?: Promise<void>;
  }): Promise<void> => {
    record.stop ??= record.runtime.stop();
    return record.stop;
  };
  return createNativeAcpAdapter({
    async createSession(request) {
      const runtime = await options.createRuntime(request.cwd, request);
      const sessionId = String(runtime.snapshot().sessionId);
      if (sessions.has(sessionId)) {
        await runtime.stop();
        throw RequestError.invalidRequest(
          { sessionId },
          "runtime returned a duplicate session id",
        );
      }
      try {
        await runtime.start();
      } catch (error) {
        await runtime.stop().catch(() => undefined);
        throw error;
      }
      sessions.set(sessionId, {
        runtime,
        ...(options.interactions === undefined ? {} : { interactions: options.interactions(runtime, sessionId as SessionId) }),
      });
      return { sessionId };
    },
    async prompt({ sessionId, prompt, signal, emit, requestPermission }) {
      const record = sessions.get(sessionId);
      if (!record)
        throw RequestError.invalidParams(
          { sessionId },
          "unknown canonical runtime session",
        );
      if (prompt.some((block) => block.type !== "text")) {
        throw RequestError.invalidParams(
          { sessionId },
          "native ACP currently accepts text content only",
        );
      }
      const text = prompt
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      let stopReason: unknown = "end_turn";
      let updates = Promise.resolve();
      const detachInteractions = record.interactions?.attach(createNativeAcpInteractionHandler(
        sessionId,
        requestPermission,
      ));
      const unsubscribe = record.runtime.subscribe((event) => {
        if (event.type === "turn.ended")
          stopReason = recordPayload(event)["stop"];
        const translated = runtimeEventToAcp(event, options.planEntries);
        if (translated) updates = updates.then(() => emit(translated));
      });
      try {
        if (signal.aborted) return { stopReason: "cancelled" };
        await record.runtime.submit(text);
        await updates;
        if (signal.aborted) return { stopReason: "cancelled" };
        return { stopReason: stopReasonFrom(stopReason) };
      } finally {
        detachInteractions?.();
        unsubscribe();
      }
    },
    async cancel(sessionId) {
      await sessions.get(sessionId)?.runtime.cancel("ACP session/cancel");
    },
    async close() {
      const records = [...sessions.values()];
      sessions.clear();
      await Promise.all(records.map(stopRuntime));
    },
    workers: createNativeWorkerEditorProjectionResolver((sessionId) => {
      const runtime = sessions.get(String(sessionId))?.runtime;
      return runtime === undefined ? undefined : options.workerProjection?.(runtime, sessionId);
    }),
  });
}

export function serveNativeAcpStdio(
  adapter: NativeAcpAdapter,
  streams: { input: Readable; output: Writable },
  options: {
    readonly signalSource?: NativeSignalSource;
    readonly cleanupTimeoutMs?: number;
  } = {},
): NativeAcpStdioConnection {
  const stream = ndJsonStream(
    Writable.toWeb(streams.output) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(streams.input) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = adapter.app.connect(stream);
  const signals = createNativeSignalScope({
    source: options.signalSource,
    onSignal: (signal) => {
      void adapter
        .close(new Error(nativeSignalReason(signal)))
        .catch(() => undefined);
      connection.close();
    },
  });
  const closed = connection.closed.finally(async () => {
    signals.close();
    const cleanup = adapter.close();
    if (signals.signal === undefined) await cleanup;
    else
      await settleNativeCleanup(
        cleanup,
        options.cleanupTimeoutMs ?? DEFAULT_ACP_CLEANUP_TIMEOUT_MS,
      );
  });
  return {
    signal: connection.signal,
    close: (error?: unknown) => connection.close(error),
    closed,
    exitCode: closed.then(
      () =>
        signals.signal === undefined ? 0 : nativeSignalExitCode(signals.signal),
      (error: unknown) => {
        if (signals.signal !== undefined)
          return nativeSignalExitCode(signals.signal);
        throw error;
      },
    ),
  };
}
