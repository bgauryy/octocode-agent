import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import type {
  AgentRuntime,
  RpcEvent,
  RpcProtocolError,
  RpcRequest,
  RpcResponse,
  OpaqueRuntimeEvent,
  RuntimeEvent,
} from "@octocodeai/agent-core";
import {
  parseRpcRequest as parseCoreRpcRequest,
  RuntimeFailure,
} from "@octocodeai/agent-core";
import {
  parseNativeWorkerProjectionRequest,
  type NativeWorkerTransportProjection,
} from "./native-worker-projection.js";
import {
  createNativeSignalScope,
  nativeSignalExitCode,
  nativeSignalReason,
  settleNativeCleanup,
  type NativeSignalSource,
} from "./native-signal-scope.js";

export { parseNativeWorkerProjectionRequest } from "./native-worker-projection.js";

type Write = (value: string) => void;

export interface NativeTransportLifecycleOptions {
  readonly signalSource?: NativeSignalSource;
  readonly cleanupTimeoutMs?: number;
  /** Safe by default: model inputs and tool payloads are redacted from public JSONL. */
  readonly eventExposure?: "safe" | "full";
  /** Bounded for fail-fast RPC delivery; primarily configurable for deterministic hosts/tests. */
  readonly maxPendingOutputBytes?: number;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
const MAX_RPC_INPUT_FRAME_BYTES = 1024 * 1024;

type RpcInputFrame = { readonly line: string } | { readonly tooLarge: true };

async function* readRpcInputFrames(
  input: Readable,
  maxFrameBytes = MAX_RPC_INPUT_FRAME_BYTES,
): AsyncGenerator<RpcInputFrame> {
  let fragments: Buffer[] = [];
  let frameBytes = 0;
  let tooLarge = false;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    let cursor = 0;
    while (cursor < buffer.length) {
      const newline = buffer.indexOf(0x0a, cursor);
      const end = newline < 0 ? buffer.length : newline;
      const segment = buffer.subarray(cursor, end);
      if (!tooLarge) {
        if (frameBytes + segment.length > maxFrameBytes) {
          fragments = [];
          frameBytes = 0;
          tooLarge = true;
        } else if (segment.length > 0) {
          fragments.push(Buffer.from(segment));
          frameBytes += segment.length;
        }
      }
      if (newline < 0) break;
      if (tooLarge) yield { tooLarge: true };
      else {
        let frame = Buffer.concat(fragments, frameBytes);
        if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
        yield { line: frame.toString("utf8") };
      }
      fragments = [];
      frameBytes = 0;
      tooLarge = false;
      cursor = newline + 1;
    }
  }
  if (tooLarge) yield { tooLarge: true };
  else if (frameBytes > 0) yield { line: Buffer.concat(fragments, frameBytes).toString("utf8") };
}

function eventText(event: RuntimeEvent): string | undefined {
  if (event.type !== "message.delta") return undefined;
  const payload = event.payload as { type?: unknown; text?: unknown };
  return payload.type === "text" && typeof payload.text === "string"
    ? payload.text
    : undefined;
}

/** Project internal lifecycle events onto the versioned public transport surface. */
function publicRuntimeEvent(event: RuntimeEvent, exposure: "safe" | "full" = "safe"): RuntimeEvent {
  if (exposure === "full") return event;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  if (event.type === "context.preparing") {
    return {
      ...event,
      payload: { messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0 },
    };
  }
  const redact = (source: OpaqueRuntimeEvent, key: string): RuntimeEvent => ({
    ...source,
    payload: { ...payload, ...(key in payload ? { [key]: "[REDACTED]" } : {}) },
  });
  if (event.type === "input.received" || event.type === "input.transformed" || event.type === "input.handled" || event.type === "input.queued" || event.type === "input.rejected" || event.type === "context.appended") {
    return redact(event, "text");
  }
  if (event.type === "tool.requested" || event.type === "permission.requested") return redact(event, "input");
  if (event.type === "tool.updated") return redact(event, "update");
  if (event.type === "tool.ended") return redact(event, "result");
  if (event.type === "ui.interaction-resolved") return redact(event, "value");
  if (event.type === "prompt.assembled") {
    return { ...event, payload: { redacted: true } };
  }
  return event;
}

function terminalStopExitCode(stop: unknown): 0 | 1 {
  switch (stop) {
    case "error":
    case "timeout":
      return 1;
    case "complete":
    case "length":
    case "cancelled":
    case "deny":
    case "stop":
    default:
      return 0;
  }
}

export async function runPrintTransport(
  runtime: AgentRuntime,
  input: string,
  options: {
    format: "text" | "json";
    write: Write;
  } & NativeTransportLifecycleOptions,
): Promise<number> {
  let sequence = 0;
  let exitCode = 0;
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type === "runtime.failed") exitCode = 1;
    else if (event.type === "turn.ended") {
      exitCode = Math.max(
        exitCode,
        terminalStopExitCode((event.payload as { stop?: unknown }).stop),
      );
    }
    if (options.format === "json") {
      const envelope: RpcEvent = {
        protocolVersion: 1,
        sequence: ++sequence,
        event: publicRuntimeEvent(event, options.eventExposure),
      };
      options.write(`${JSON.stringify(envelope)}\n`);
      return;
    }
    const text = eventText(event);
    if (text != null) options.write(text);
  });
  const signals = createNativeSignalScope({
    source: options.signalSource,
    onSignal: (signal) => runtime.cancel(nativeSignalReason(signal)),
  });
  try {
    const operation = (async () => {
      await runtime.start();
      if (signals.signal === undefined) await runtime.submit(input);
    })();
    await Promise.race([operation, signals.interrupted]);
  } finally {
    try {
      const stop = runtime.stop();
      if (signals.signal === undefined) await stop;
      else {
        await settleNativeCleanup(
          Promise.all([signals.settled, stop]),
          options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
        );
      }
    } finally {
      unsubscribe();
      signals.close();
    }
  }
  return signals.signal === undefined
    ? exitCode
    : nativeSignalExitCode(signals.signal);
}

export function runJsonTransport(
  runtime: AgentRuntime,
  input: string,
  write: Write,
  options: NativeTransportLifecycleOptions = {},
): Promise<number> {
  return runPrintTransport(runtime, input, {
    format: "json",
    write,
    ...options,
  });
}

function protocolError(
  category: RpcProtocolError["category"],
  message: string,
  requestId?: string,
  protocolVersion?: number,
): RpcProtocolError {
  return { protocolVersion, requestId, category, message };
}

function parseRpcRequest(line: string): RpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw protocolError("parse", "RPC input must be valid JSON");
  }
  const value =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const requestId =
    typeof value.requestId === "string" ? value.requestId : undefined;
  const version =
    typeof value.protocolVersion === "number"
      ? value.protocolVersion
      : undefined;
  try {
    return parseCoreRpcRequest(parsed);
  } catch (error) {
    if (
      error instanceof RuntimeFailure &&
      error.category === "unsupported-version"
    ) {
      throw protocolError("version", error.message, requestId, version);
    }
    throw protocolError(
      error instanceof RuntimeFailure && error.category === "protocol"
        ? "parse"
        : "validation",
      error instanceof Error ? error.message : "Invalid RPC request",
      requestId,
      version,
    );
  }
}

function createJsonLineWriter(
  stream: Writable,
  maxPendingBytes = 1024 * 1024,
): {
  enqueue(value: unknown): void;
  assertHealthy(): void;
  flush(): Promise<void>;
} {
  let pendingBytes = 0;
  let tail = Promise.resolve();
  let failure: Error | undefined;
  return {
    assertHealthy() {
      if (failure) throw failure;
    },
    enqueue(value) {
      if (failure) throw failure;
      const line = `${JSON.stringify(value)}\n`;
      const bytes = Buffer.byteLength(line);
      if (pendingBytes + bytes > maxPendingBytes) {
        failure = new RuntimeFailure(
          "protocol",
          `RPC output queue exceeded ${maxPendingBytes} bytes`,
        );
        throw failure;
      }
      pendingBytes += bytes;
      tail = tail
        .then(async () => {
          if (!stream.write(line)) await once(stream, "drain");
          pendingBytes -= bytes;
        })
        .catch((error: unknown) => {
          failure =
            error instanceof Error ? error : new Error("RPC output failed");
        });
    },
    async flush() {
      if (failure) throw failure;
      await tail;
      if (failure) throw failure;
    },
  };
}

export async function runRpcTransport(
  runtime: AgentRuntime,
  streams: { input: Readable; output: Writable },
  options: {
    readonly workerProjection?: NativeWorkerTransportProjection;
    readonly getWorkerProjection?: () => NativeWorkerTransportProjection | undefined;
  } & NativeTransportLifecycleOptions = {},
): Promise<number> {
  let sequence = 0;
  const writer = createJsonLineWriter(streams.output, options.maxPendingOutputBytes);
  const unsubscribe = runtime.subscribe((event) => {
    const envelope: RpcEvent = {
      protocolVersion: 1,
      sequence: ++sequence,
      event: publicRuntimeEvent(event, options.eventExposure),
    };
    writer.enqueue(envelope);
  });
  const signals = createNativeSignalScope({
    source: options.signalSource,
    onSignal: async (signal) => {
      streams.input.destroy();
      await runtime.cancel(nativeSignalReason(signal));
    },
  });

  try {
    const operation = (async () => {
      await runtime.start();
      if (signals.signal !== undefined) return;
      const pending = new Set<Promise<void>>();
      const dispatch = async (line: string): Promise<void> => {
        writer.assertHealthy();
        try {
          let candidate: unknown;
          try {
            candidate = JSON.parse(line);
          } catch {
            candidate = undefined;
          }
          if (
            candidate &&
            typeof candidate === "object" &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>)["projection"] === "worker"
          ) {
            const value = candidate as Record<string, unknown>;
            const requestId =
              typeof value["requestId"] === "string"
                ? value["requestId"]
                : "invalid-worker-request";
            const workerFailure = (message: string): void =>
              writer.enqueue({
                protocolVersion: 1,
                projection: "worker",
                requestId,
                ok: false,
                error: { category: "validation", message },
              });
            const workerProjection = options.getWorkerProjection?.() ?? options.workerProjection;
            if (!workerProjection) {
              workerFailure("Worker projection is unavailable");
              return;
            }
            let request;
            try {
              request = parseNativeWorkerProjectionRequest(candidate);
            } catch (error) {
              workerFailure(
                error instanceof Error
                  ? error.message
                  : "Invalid worker projection request",
              );
              return;
            }
            writer.enqueue(await workerProjection.execute(request));
            return;
          }
          const request = parseRpcRequest(line);
          const result = await runtime.execute(request.command);
          const response: RpcResponse = result.ok
            ? {
                protocolVersion: 1,
                requestId: request.requestId,
                ok: true,
                ...(result.data === undefined ? {} : { data: result.data }),
              }
            : {
                protocolVersion: 1,
                requestId: request.requestId,
                ok: false,
                error: result.error,
              };
          writer.enqueue(response);
        } catch (error) {
          const safe = error as Partial<RpcProtocolError>;
          writer.enqueue(
            protocolError(
              safe.category ?? "validation",
              typeof safe.message === "string"
                ? safe.message
                : "Invalid RPC request",
              safe.requestId,
              safe.protocolVersion,
            ),
          );
        }
      };
      for await (const frame of readRpcInputFrames(streams.input)) {
        if ("tooLarge" in frame) {
          writer.enqueue(protocolError("validation", `RPC input frame exceeds ${MAX_RPC_INPUT_FRAME_BYTES} bytes`));
          continue;
        }
        const line = frame.line;
        if (!line.trim()) continue;
        while (pending.size >= 2) await Promise.race(pending);
        writer.assertHealthy();
        const task = dispatch(line);
        pending.add(task);
        void task.then(
          () => pending.delete(task),
          () => pending.delete(task),
        );
      }
      await Promise.all(pending);
      await writer.flush();
    })();
    await Promise.race([operation, signals.interrupted]);
    return signals.signal === undefined
      ? 0
      : nativeSignalExitCode(signals.signal);
  } finally {
    try {
      const cleanup = (async () => {
        try {
          const stop = runtime.stop();
          if (signals.signal === undefined) await stop;
          else await Promise.all([signals.settled, stop]);
        } finally {
          unsubscribe();
          await writer.flush();
        }
      })();
      if (signals.signal === undefined) await cleanup;
      else
        await settleNativeCleanup(
          cleanup,
          options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
        );
    } finally {
      signals.close();
    }
  }
}
