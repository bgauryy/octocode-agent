import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { RuntimeFailure } from "@octocodeai/agent-core";

import {
  parseNativeCheckpointRecovery,
  parseNativeCheckpointTransition,
  type NativeCheckpointDeleteInput,
  type NativeCheckpointFileSystemPort,
  type NativeCheckpointRecovery,
  type NativeCheckpointReplaceInput,
  type NativeCheckpointTransition,
  type NativeRewindInput,
} from "./native-checkpoints.js";

import type {
  NativeFileBinarySnapshot,
  NativeFileDeleteResult,
  NativeExternalPathAuthorization,
  NativeFileReplaceInput,
  NativeFileReplaceResult,
  NativeFileSnapshot,
  NativeFileSystemPort,
} from "./native-file-tool.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface NativeRustFileSystemChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

type NativeRustFileSystemSpawn = (
  binaryPath: string,
  args: readonly string[],
) => NativeRustFileSystemChild;

export interface NativeRustFileSystemOptions {
  readonly binaryPath: string;
  readonly workspace: string;
  readonly maxBytes?: number;
  readonly maxFrameBytes?: number;
  readonly closeGraceMs?: number;
  readonly spawn?: NativeRustFileSystemSpawn;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: NativeRustFileSystemRemoteError) => void;
}

class NativeRustFileSystemRemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly committed: boolean,
  ) {
    super(message);
    this.name = "NativeRustFileSystemRemoteError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1)
    throw new RuntimeFailure("validation", `${label} must be a positive integer`);
  return selected;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function runtimeFailure(error: unknown): RuntimeFailure {
  if (!(error instanceof NativeRustFileSystemRemoteError))
    return new RuntimeFailure(
      "tool-execution",
      "Rust filesystem operation failed",
      "unknown",
    );
  if (error.committed)
    return new RuntimeFailure(
      "tool-execution",
      "File operation committed but durability confirmation failed",
      "unsafe",
    );
  if (error.code === "CANCELLED")
    return new RuntimeFailure("cancelled", "File operation cancelled", "safe");
  if (
    [
      "INVALID_REQUEST",
      "INVALID_PATH",
      "INVALID_WORKSPACE",
      "SYMLINK_FORBIDDEN",
      "NOT_REGULAR_FILE",
      "ALREADY_EXISTS",
      "PRECONDITION_FAILED",
      "TOO_LARGE",
      "CHECKPOINT_EXISTS",
      "CHECKPOINT_NOT_FOUND",
      "ALREADY_APPLIED",
    ].includes(error.code)
  )
    return new RuntimeFailure("validation", error.message, "safe");
  if (error.code === "BUSY")
    return new RuntimeFailure("tool-execution", "Rust filesystem service is busy", "safe");
  return new RuntimeFailure(
    "tool-execution",
    error.code === "PERMISSION_DENIED"
      ? "File operation was not permitted"
      : "Rust filesystem operation failed",
    "unknown",
  );
}

/** Typed subprocess adapter for the dedicated, capability-rooted Rust filesystem service. */
export class NativeRustFileSystemClient implements NativeFileSystemPort, NativeCheckpointFileSystemPort {
  readonly #child: NativeRustFileSystemChild;
  readonly #maxBytes: number;
  readonly #maxFrameBytes: number;
  readonly #closeGraceMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  #sequence = 0;
  #stdout = Buffer.alloc(0);
  #writeTail: Promise<void> = Promise.resolve();
  #closed = false;
  #closing = false;
  #checkpointJournal = false;
  readonly #exit: Promise<void>;
  readonly #resolveExit: () => void;

  constructor(options: NativeRustFileSystemOptions) {
    if (!path.isAbsolute(options.binaryPath) || !path.isAbsolute(options.workspace))
      throw new RuntimeFailure(
        "validation",
        "Rust filesystem binary and workspace paths must be absolute",
      );
    this.#maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES, "Rust filesystem maxBytes");
    if (this.#maxBytes > DEFAULT_MAX_BYTES)
      throw new RuntimeFailure("validation", "Rust filesystem maxBytes exceeds 10 MiB");
    this.#maxFrameBytes = positive(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      "Rust filesystem frame limit",
    );
    this.#closeGraceMs = positive(options.closeGraceMs, 1_000, "Rust filesystem close grace");
    const create = options.spawn ?? ((binaryPath, args) => spawn(binaryPath, args, { stdio: ["pipe", "pipe", "pipe"] }));
    this.#child = create(options.binaryPath, [
      "--workspace",
      options.workspace,
      "--max-bytes",
      String(this.#maxBytes),
    ]);
    let resolveExit!: () => void;
    this.#exit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.#resolveExit = resolveExit;
    this.#child.stdout.on("data", (chunk: Buffer | string) =>
      this.#capture(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    this.#child.stderr?.resume();
    this.#child.stdin.on("error", () =>
      this.#fail("Rust filesystem request stream failed"),
    );
    this.#child.once("error", () => this.#fail("Rust filesystem process failed"));
    this.#child.once("close", () => {
      this.#closed = true;
      this.#rejectAll("Rust filesystem process closed");
      this.#resolveExit();
    });
  }

  async ready(): Promise<void> {
    try {
      const value = await this.#call("health", {});
      if (
        !record(value) ||
        value.status !== "ok" ||
        value.schemaVersion !== 1 ||
        value.maxBytes !== this.#maxBytes ||
        value.cancellation !== "cooperative-before-commit"
      )
        throw new RuntimeFailure("protocol", "Rust filesystem health response is malformed");
      this.#checkpointJournal = value.checkpointJournal === "content-addressed-v1";
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw runtimeFailure(error);
    }
  }

  async authorizeExternalPath(
    filePath: string,
    kind: "input" | "output",
    signal: AbortSignal,
  ): Promise<NativeExternalPathAuthorization> {
    try {
      const value = await this.#call("fs.authorizeExternalPath", { path: filePath, kind }, signal);
      if (
        !record(value) ||
        typeof value.path !== "string" ||
        typeof value.hostPath !== "string" ||
        !path.isAbsolute(value.hostPath) ||
        value.kind !== kind
      )
        throw new RuntimeFailure("protocol", "Rust filesystem external-path result is malformed");
      return { path: value.path, hostPath: value.hostPath, kind };
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw runtimeFailure(error);
    }
  }

  async snapshot(
    filePath: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<NativeFileSnapshot | null> {
    const value = await this.readBinary(filePath, maxBytes, signal);
    if (value === null) return null;
    const bytes = Buffer.from(value.contentBase64, "base64");
    const content = bytes.toString("utf8");
    return {
      path: value.path,
      content,
      validUtf8: Buffer.from(content, "utf8").equals(bytes),
      bytes: value.bytes,
      sha256: value.sha256,
    };
  }

  async readBinary(
    filePath: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<NativeFileBinarySnapshot | null> {
    try {
      const value = await this.#call("fs.read", { path: filePath, maxBytes }, signal);
      if (
        !record(value) ||
        typeof value.path !== "string" ||
        !integer(value.bytes) ||
        !sha256(value.sha256) ||
        typeof value.validUtf8 !== "boolean" ||
        typeof value.contentBase64 !== "string"
      )
        throw new RuntimeFailure("protocol", "Rust filesystem read result is malformed");
      const bytes = Buffer.from(value.contentBase64, "base64");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.toString("base64") !== value.contentBase64 ||
        bytes.byteLength !== value.bytes ||
        bytes.byteLength > maxBytes ||
        digest !== value.sha256
      )
        throw new RuntimeFailure("protocol", "Rust filesystem read payload is malformed");
      return {
        path: value.path,
        contentBase64: value.contentBase64,
        bytes: value.bytes,
        sha256: value.sha256,
      };
    } catch (error) {
      if (error instanceof NativeRustFileSystemRemoteError && error.code === "NOT_FOUND") return null;
      if (error instanceof RuntimeFailure) throw error;
      throw runtimeFailure(error);
    }
  }

  async replace(
    input: NativeFileReplaceInput,
    signal: AbortSignal,
  ): Promise<NativeFileReplaceResult> {
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.byteLength > input.maxBytes)
      throw new RuntimeFailure("validation", `File exceeds maximum ${input.maxBytes} bytes`);
    try {
      const value = await this.#call(
        "fs.replace",
        {
          path: input.path,
          contentBase64: bytes.toString("base64"),
          expectedSha256: input.expectedSha256,
          maxBytes: input.maxBytes,
        },
        signal,
      );
      if (
        !record(value) ||
        value.committed !== true ||
        typeof value.path !== "string" ||
        !integer(value.bytes) ||
        !sha256(value.sha256) ||
        !(value.previousSha256 === null || sha256(value.previousSha256))
      )
        throw new RuntimeFailure("protocol", "Rust filesystem replace result is malformed");
      if (
        value.bytes !== bytes.byteLength ||
        value.sha256 !== createHash("sha256").update(bytes).digest("hex")
      )
        throw new RuntimeFailure("protocol", "Rust filesystem replace result does not match input");
      return {
        path: value.path,
        bytes: value.bytes,
        sha256: value.sha256,
        previousSha256: value.previousSha256,
      };
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw runtimeFailure(error);
    }
  }

  async delete(
    filePath: string,
    expectedSha256: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<NativeFileDeleteResult> {
    try {
      const value = await this.#call(
        "fs.delete",
        { path: filePath, expectedSha256, maxBytes },
        signal,
      );
      if (
        !record(value) ||
        value.committed !== true ||
        typeof value.path !== "string" ||
        !sha256(value.previousSha256)
      )
        throw new RuntimeFailure("protocol", "Rust filesystem delete result is malformed");
      return { path: value.path, previousSha256: value.previousSha256 };
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw runtimeFailure(error);
    }
  }

  async prepareCheckpointReplace(
    input: NativeCheckpointReplaceInput,
    signal: AbortSignal,
  ): Promise<NativeCheckpointTransition> {
    this.#requireCheckpointJournal();
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.byteLength > input.maxBytes)
      throw new RuntimeFailure("validation", `File exceeds maximum ${input.maxBytes} bytes`);
    try {
      const transition = parseNativeCheckpointTransition(
        await this.#call(
          "fs.checkpoint.prepareReplace",
          {
            checkpointId: input.checkpointId,
            operation: input.operation,
            path: input.path,
            contentBase64: bytes.toString("base64"),
            expectedSha256: input.expectedSha256,
            maxBytes: input.maxBytes,
          },
          signal,
        ),
      );
      const after = transition.after;
      if (
        transition.attemptId !== input.checkpointId ||
        transition.checkpointId !== input.checkpointId ||
        transition.attemptKind !== "mutation" ||
        transition.operation !== input.operation ||
        after.kind !== "present" ||
        after.bytes !== bytes.byteLength ||
        after.sha256 !== createHash("sha256").update(bytes).digest("hex")
      )
        throw new RuntimeFailure("protocol", "Rust checkpoint replace receipt does not match the request");
      return transition;
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw runtimeFailure(error);
    }
  }

  async prepareCheckpointDelete(
    input: NativeCheckpointDeleteInput,
    signal: AbortSignal,
  ): Promise<NativeCheckpointTransition> {
    this.#requireCheckpointJournal();
    try {
      const transition = parseNativeCheckpointTransition(
        await this.#call(
          "fs.checkpoint.prepareDelete",
          {
            checkpointId: input.checkpointId,
            path: input.path,
            expectedSha256: input.expectedSha256,
            maxBytes: input.maxBytes,
          },
          signal,
        ),
      );
      if (
        transition.attemptId !== input.checkpointId ||
        transition.checkpointId !== input.checkpointId ||
        transition.attemptKind !== "mutation" ||
        transition.operation !== "delete" ||
        transition.before.kind !== "present" ||
        transition.before.sha256 !== input.expectedSha256 ||
        transition.after.kind !== "absent"
      )
        throw new RuntimeFailure("protocol", "Rust checkpoint delete receipt does not match the request");
      return transition;
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw runtimeFailure(error);
    }
  }

  async prepareRewind(
    input: NativeRewindInput,
    signal: AbortSignal,
  ): Promise<NativeCheckpointTransition> {
    this.#requireCheckpointJournal();
    try {
      const transition = parseNativeCheckpointTransition(
        await this.#call(
          "fs.checkpoint.prepareRewind",
          {
            checkpointId: input.checkpointId,
            rewindId: input.rewindId,
            path: input.path,
            expectedPostimageSha256: input.expectedPostimageSha256,
            maxBytes: input.maxBytes,
          },
          signal,
        ),
      );
      const beforeDigest = transition.before.kind === "present" ? transition.before.sha256 : null;
      if (
        transition.attemptId !== input.rewindId ||
        transition.checkpointId !== input.checkpointId ||
        transition.attemptKind !== "rewind" ||
        transition.operation !== "rewind" ||
        transition.path !== input.path ||
        beforeDigest !== input.expectedPostimageSha256
      )
        throw new RuntimeFailure("protocol", "Rust rewind receipt does not match the request");
      return transition;
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw runtimeFailure(error);
    }
  }

  async applyCheckpointAttempt(
    attemptId: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<NativeCheckpointRecovery> {
    this.#requireCheckpointJournal();
    try {
      const recovery = parseNativeCheckpointRecovery(
        await this.#call("fs.checkpoint.apply", { attemptId, maxBytes }, signal),
      );
      if (recovery.attemptId !== attemptId || recovery.state !== "complete")
        throw new RuntimeFailure("protocol", "Rust checkpoint apply receipt does not match the request");
      return recovery;
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw runtimeFailure(error);
    }
  }

  async recoverCheckpointAttempt(
    attemptId: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<NativeCheckpointRecovery> {
    this.#requireCheckpointJournal();
    try {
      const recovery = parseNativeCheckpointRecovery(
        await this.#call("fs.checkpoint.recover", { attemptId, maxBytes }, signal),
      );
      if (recovery.attemptId !== attemptId)
        throw new RuntimeFailure("protocol", "Rust checkpoint recovery receipt does not match the request");
      return recovery;
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw runtimeFailure(error);
    }
  }

  async close(): Promise<void> {
    if (this.#closed || this.#closing) return this.#exit;
    this.#closing = true;
    await this.#writeTail.catch(() => undefined);
    if (!this.#child.stdin.destroyed && !this.#child.stdin.writableEnded)
      this.#child.stdin.end();
    const timer = new Promise<false>((resolve) => setTimeout(() => resolve(false), this.#closeGraceMs));
    if (await Promise.race([this.#exit.then(() => true), timer])) return;
    this.#child.kill("SIGTERM");
    await Promise.race([this.#exit, new Promise<void>((resolve) => setTimeout(resolve, this.#closeGraceMs))]);
  }

  supportsCheckpoints(): boolean {
    return this.#checkpointJournal;
  }

  #requireCheckpointJournal(): void {
    if (!this.#checkpointJournal)
      throw new RuntimeFailure(
        "unsupported-capability",
        "Rust filesystem checkpoint journal is unavailable on this platform",
      );
  }

  async #call(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closing || this.#closed)
      throw new RuntimeFailure("tool-execution", "Rust filesystem service is closed");
    if (signal?.aborted)
      throw new RuntimeFailure("cancelled", "File operation cancelled", "safe");
    const id = `native-fs:${++this.#sequence}`;
    const encoded = `${JSON.stringify({ schemaVersion: 1, id, method, params })}\n`;
    if (Buffer.byteLength(encoded) > this.#maxFrameBytes)
      throw new RuntimeFailure("validation", "Rust filesystem request exceeds the frame limit");
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    let written = false;
    const cancel = (): void => {
      if (!written) return;
      void this.#call("cancel", { requestId: id }).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const write = this.#writeTail.then(async () => {
      if (signal?.aborted) {
        this.#pending.delete(id);
        throw new RuntimeFailure("cancelled", "File operation cancelled", "safe");
      }
      await new Promise<void>((resolve, reject) => {
        this.#child.stdin.write(encoded, "utf8", (error) =>
          error === null || error === undefined ? resolve() : reject(error),
        );
      });
      written = true;
      if (signal?.aborted) cancel();
    });
    this.#writeTail = write.catch(() => undefined);
    try {
      try {
        await write;
      } catch (error) {
        this.#pending.get(id)?.reject(
          new NativeRustFileSystemRemoteError(
            "PROCESS_FAILURE",
            "Rust filesystem request stream failed",
            false,
          ),
        );
        await response.catch(() => undefined);
        if (error instanceof RuntimeFailure) throw error;
        throw runtimeFailure(error);
      }
      return await response;
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.#pending.delete(id);
    }
  }

  #capture(chunk: Buffer): void {
    if (this.#closed) return;
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    for (;;) {
      const newline = this.#stdout.indexOf(0x0a);
      if (newline < 0) {
        if (this.#stdout.byteLength > this.#maxFrameBytes)
          this.#fail("Rust filesystem response exceeds the frame limit");
        return;
      }
      if (newline > this.#maxFrameBytes) {
        this.#fail("Rust filesystem response exceeds the frame limit");
        return;
      }
      const line = this.#stdout.subarray(0, newline).toString("utf8");
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (!line) continue;
      this.#handleLine(line);
      if (this.#closed) return;
    }
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#fail("Rust filesystem emitted malformed JSON");
      return;
    }
    if (
      !record(value) ||
      value.schemaVersion !== 1 ||
      typeof value.id !== "string" ||
      typeof value.ok !== "boolean"
    ) {
      this.#fail("Rust filesystem emitted a malformed response");
      return;
    }
    const pending = this.#pending.get(value.id);
    if (!pending) {
      this.#fail("Rust filesystem response correlation is invalid");
      return;
    }
    this.#pending.delete(value.id);
    if (value.ok) {
      pending.resolve(value.result);
      return;
    }
    if (
      !record(value.error) ||
      typeof value.error.code !== "string" ||
      typeof value.error.message !== "string" ||
      typeof value.error.committed !== "boolean"
    ) {
      this.#fail("Rust filesystem error response is malformed");
      return;
    }
    pending.reject(
      new NativeRustFileSystemRemoteError(
        value.error.code,
        value.error.message,
        value.error.committed,
      ),
    );
  }

  #fail(message: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(message);
    this.#child.kill("SIGTERM");
  }

  #rejectAll(message: string): void {
    const error = new NativeRustFileSystemRemoteError("PROCESS_FAILURE", message, false);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
