import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  RuntimeFailure,
  createEffectSet,
  jsonSchemaError,
  type JsonSchema,
  type ToolDefinition,
  type ToolResult,
} from '@octocodeai/agent-core';

import type { NativeFileSystemPort } from './native-file-tool.js';

type FfmpegBinary = 'ffmpeg' | 'ffprobe';
type ProgressRecord = Readonly<Record<string, string>>;

export interface NativeFfmpegProcessRequest {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly captureStdout: boolean;
  readonly progress: boolean;
  readonly onProgress?: (record: ProgressRecord) => void;
}

export interface NativeFfmpegProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stdoutExceeded?: boolean;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
}

export interface NativeFfmpegProcessPort {
  run(request: NativeFfmpegProcessRequest): Promise<NativeFfmpegProcessOutcome>;
}

export interface NativeFfmpegToolOptions {
  readonly workspace: string;
  readonly fileSystem: NativeFileSystemPort;
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultTimeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly resolveBinary?: (name: FfmpegBinary) => string | undefined;
  readonly process?: NativeFfmpegProcessPort;
}

interface FfmpegInput {
  readonly binary?: FfmpegBinary;
  readonly args: readonly string[];
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly captureStdout?: boolean;
  readonly timeoutMs?: number;
}

const SECRET_ENV = /(?:api_?key|token|secret|password|passwd|credential|private_?key|cookie|authorization|auth)/iu;
const PLACEHOLDER = /^\{\{(input|output):(\d+)\}\}$/u;
const PLACEHOLDER_FRAGMENT = /\{\{(?:input|output):/u;
const PROTOCOL = /^[a-z][a-z0-9+.-]*:\/\//iu;
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/iu;
const LIKELY_MEDIA_PATH = /\.(?:aac|aiff?|avi|bmp|flac|gif|jpe?g|m4a|mkv|mov|mp3|mp4|mpeg|ogg|opus|png|svg|tiff?|wav|webm|webp|m3u8)(?:$|[?#])/iu;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 1_800_000;
const DEFAULT_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_STDERR_BYTES = 64 * 1024;

export const NATIVE_FFMPEG_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['args'],
  properties: {
    binary: { enum: ['ffmpeg', 'ffprobe'] },
    args: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', minLength: 1, maxLength: 8192 } },
    inputs: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 4096 } },
    outputs: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 4096 } },
    captureStdout: { type: 'boolean' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
  },
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: 'object',
  required: ['binary', 'exitCode', 'signal', 'stderr', 'stderrTruncated', 'timedOut', 'cancelled', 'durationMs'],
  properties: {
    binary: { enum: ['ffmpeg', 'ffprobe'] },
    exitCode: { type: ['integer', 'null'] },
    signal: { type: ['string', 'null'] },
    stdout: {
      type: 'object',
      required: ['encoding', 'value', 'byteLength'],
      properties: { encoding: { const: 'base64' }, value: { type: 'string' }, byteLength: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
    stderr: { type: 'string' },
    stderrTruncated: { type: 'boolean' },
    stdoutExceeded: { type: 'boolean' },
    timedOut: { type: 'boolean' },
    cancelled: { type: 'boolean' },
    durationMs: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

function bounded(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum)
    throw new RuntimeFailure('validation', `${label} must be between 1 and ${maximum}`);
  return selected;
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) if (value !== undefined && !SECRET_ENV.test(name)) output[name] = value;
  return output;
}

export function resolveNativeFfmpegBinary(name: FfmpegBinary, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  for (const directory of (env.PATH ?? '').split(path.delimiter)) if (directory) candidates.push(path.join(directory, name));
  if (process.platform === 'win32') {
    candidates.push(`C:\\ffmpeg\\bin\\${name}.exe`);
  } else {
    candidates.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`);
  }
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function isRawPathLike(value: string): boolean {
  return path.isAbsolute(value) || WINDOWS_ABSOLUTE.test(value) || value.startsWith('./') || value.startsWith('../') ||
    value.startsWith('~') || value.includes('\\') || LIKELY_MEDIA_PATH.test(value);
}

function assertArgvSafe(input: FfmpegInput): void {
  const usedInputs = new Set<number>();
  const usedOutputs = new Set<number>();
  for (let index = 0; index < input.args.length; index += 1) {
    const value = input.args[index]!;
    if (value.includes('\0')) throw new RuntimeFailure('validation', 'FFmpeg arguments cannot contain NUL bytes');
    const match = PLACEHOLDER.exec(value);
    if (match) {
      const placeholderIndex = Number(match[2]);
      const paths = match[1] === 'input' ? input.inputs ?? [] : input.outputs ?? [];
      if (placeholderIndex >= paths.length) throw new RuntimeFailure('validation', 'FFmpeg path placeholder is out of range');
      (match[1] === 'input' ? usedInputs : usedOutputs).add(placeholderIndex);
      continue;
    }
    if (PLACEHOLDER_FRAGMENT.test(value)) throw new RuntimeFailure('validation', 'FFmpeg path placeholders must occupy a complete argument');
    if (PROTOCOL.test(value)) throw new RuntimeFailure('validation', 'FFmpeg protocol inputs are not supported by the workspace tool');
    if (input.args[index - 1] === '-i' && value !== '-' && !/^pipe:\d+$/u.test(value))
      throw new RuntimeFailure('validation', 'Every FFmpeg input must use a declared input placeholder');
    if (isRawPathLike(value)) throw new RuntimeFailure('validation', 'Every FFmpeg file path must use a declared placeholder');
    if (value === '-progress') throw new RuntimeFailure('validation', 'FFmpeg progress output is managed by the runtime');
  }
  for (let index = 0; index < (input.inputs?.length ?? 0); index += 1)
    if (!usedInputs.has(index)) throw new RuntimeFailure('validation', 'Every declared FFmpeg input must be referenced');
  for (let index = 0; index < (input.outputs?.length ?? 0); index += 1)
    if (!usedOutputs.has(index)) throw new RuntimeFailure('validation', 'Every declared FFmpeg output must be referenced');
}

function parseProgress(buffer: string, emit?: (record: ProgressRecord) => void): string {
  let remaining = buffer;
  for (;;) {
    const boundary = remaining.indexOf('\nprogress=');
    if (boundary < 0) return remaining;
    const end = remaining.indexOf('\n', boundary + 1);
    if (end < 0) return remaining;
    const block = remaining.slice(0, end + 1);
    remaining = remaining.slice(end + 1);
    const record: Record<string, string> = {};
    for (const line of block.split(/\r?\n/u)) {
      const separator = line.indexOf('=');
      if (separator > 0) record[line.slice(0, separator)] = line.slice(separator + 1);
    }
    emit?.(record);
  }
}

export const nativeFfmpegProcessPort: NativeFfmpegProcessPort = {
  async run(request) {
    if (request.signal.aborted)
      return { exitCode: null, signal: null, stdout: Buffer.alloc(0), stderr: '', stderrTruncated: false, timedOut: false, cancelled: true, durationMs: 0 };
    const started = Date.now();
    return await new Promise((resolve, reject) => {
      const child = spawn(request.binaryPath, [...request.args], {
        cwd: request.cwd,
        env: safeEnvironment(request.env),
        detached: process.platform !== 'win32',
        stdio: request.progress ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      });
      let stdout = Buffer.alloc(0);
      let stdoutExceeded = false;
      let stderr = Buffer.alloc(0);
      let stderrTruncated = false;
      let progressBuffer = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let escalation: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          child.kill(signal);
        }
      };
      const terminate = (): void => {
        kill('SIGTERM');
        if (escalation === undefined) {
          escalation = setTimeout(() => { if (!settled) kill('SIGKILL'); }, 250);
          escalation.unref?.();
        }
      };
      const onAbort = (): void => { cancelled = true; terminate(); };
      request.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; terminate(); }, request.timeoutMs);
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!request.captureStdout || stdoutExceeded) return;
        if (stdout.byteLength + chunk.byteLength > request.maxStdoutBytes) {
          stdoutExceeded = true;
          stdout = Buffer.alloc(0);
          terminate();
          return;
        }
        stdout = Buffer.concat([stdout, chunk]);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const remaining = request.maxStderrBytes - stderr.byteLength;
        if (remaining <= 0) { stderrTruncated = true; return; }
        stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
        if (chunk.byteLength > remaining) stderrTruncated = true;
      });
      if (request.progress) {
        child.stdio[3]?.on('data', (chunk: Buffer) => {
          progressBuffer = parseProgress(progressBuffer + chunk.toString('utf8'), request.onProgress);
        });
      }
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        request.signal.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.once('close', (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        request.signal.removeEventListener('abort', onAbort);
        resolve({
          exitCode,
          signal: exitSignal,
          stdout,
          stdoutExceeded,
          stderr: stderr.toString('utf8'),
          stderrTruncated,
          timedOut,
          cancelled,
          durationMs: Math.max(0, Date.now() - started),
        });
      });
    });
  },
};

function progressMessage(record: ProgressRecord): string {
  const frame = record.frame ? `frame=${record.frame}` : undefined;
  const time = record.out_time ? `time=${record.out_time}` : undefined;
  const speed = record.speed ? `speed=${record.speed}` : undefined;
  return [frame, time, speed].filter(Boolean).join(' ') || 'FFmpeg is running';
}

export function createNativeFfmpegTool(options: NativeFfmpegToolOptions): ToolDefinition {
  const workspace = fs.realpathSync(path.resolve(options.workspace));
  if (!fs.statSync(workspace).isDirectory()) throw new RuntimeFailure('validation', 'FFmpeg workspace must be a directory');
  const env = options.env ?? process.env;
  const defaultTimeoutMs = bounded(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'FFmpeg timeout');
  const maxStdoutBytes = bounded(options.maxStdoutBytes, DEFAULT_STDOUT_BYTES, 8 * 1024 * 1024, 'FFmpeg stdout limit');
  const maxStderrBytes = bounded(options.maxStderrBytes, DEFAULT_STDERR_BYTES, 1024 * 1024, 'FFmpeg stderr limit');
  const runner = options.process ?? nativeFfmpegProcessPort;
  const resolveBinary = options.resolveBinary ?? ((name: FfmpegBinary) => resolveNativeFfmpegBinary(name, env));
  return {
    name: 'runFfmpeg',
    label: 'FFmpeg',
    description: 'Run ffmpeg or ffprobe without a shell against explicitly declared, Rust-authorized workspace files.',
    schemaVersion: 1,
    inputSchema: NATIVE_FFMPEG_INPUT_SCHEMA,
    outputSchema,
    outputVersion: 1,
    policy: {
      effects: createEffectSet('read', 'process', 'write'),
      trust: 'workspace',
      approval: 'on-request',
      plan: 'forbidden',
      resolve(value) {
        const hasOutputs = typeof value === 'object' && value !== null && Array.isArray((value as { outputs?: unknown }).outputs) &&
          ((value as { outputs: unknown[] }).outputs.length > 0);
        return { effects: hasOutputs ? createEffectSet('read', 'process', 'write') : createEffectSet('read', 'process'), trust: 'workspace', approval: 'on-request' };
      },
      lockTarget(value) {
        if (typeof value !== 'object' || value === null || !Array.isArray((value as { outputs?: unknown }).outputs)) return [];
        return [...new Set((value as { outputs: unknown[] }).outputs.filter((item): item is string => typeof item === 'string'))].sort();
      },
      concurrency: () => ({ lane: 'native-ffmpeg', maxActive: 1 }),
    },
    async execute(execution): Promise<ToolResult> {
      const invalid = jsonSchemaError(execution.input, NATIVE_FFMPEG_INPUT_SCHEMA);
      if (invalid) throw new RuntimeFailure('validation', invalid);
      const input = execution.input as FfmpegInput;
      assertArgvSafe(input);
      const binary = input.binary ?? 'ffmpeg';
      const binaryPath = resolveBinary(binary);
      if (binaryPath === undefined || !path.isAbsolute(binaryPath))
        throw new RuntimeFailure('unsupported-capability', `${binary} is not available`);
      const inputPaths = await Promise.all((input.inputs ?? []).map((file) => options.fileSystem.authorizeExternalPath(file, 'input', execution.signal)));
      const outputPaths = await Promise.all((input.outputs ?? []).map((file) => options.fileSystem.authorizeExternalPath(file, 'output', execution.signal)));
      const args = input.args.map((value) => {
        const match = PLACEHOLDER.exec(value);
        if (!match) return value;
        return (match[1] === 'input' ? inputPaths : outputPaths)[Number(match[2])]!.hostPath;
      });
      const progress = binary === 'ffmpeg';
      const invocationArgs = ['-hide_banner', ...(progress ? ['-nostdin', '-nostats', '-progress', 'pipe:3'] : []), ...args];
      const outcome = await runner.run({
        binaryPath,
        args: invocationArgs,
        cwd: workspace,
        env,
        signal: execution.signal,
        timeoutMs: input.timeoutMs ?? defaultTimeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
        captureStdout: input.captureStdout === true,
        progress,
        onProgress: (record) => { void execution.update?.({ version: 1, kind: 'progress', message: progressMessage(record) }); },
      });
      const content = {
        binary,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        ...(input.captureStdout === true ? { stdout: { encoding: 'base64', value: outcome.stdout.toString('base64'), byteLength: outcome.stdout.byteLength } } : {}),
        stderr: outcome.stderr,
        stderrTruncated: outcome.stderrTruncated,
        ...(outcome.stdoutExceeded ? { stdoutExceeded: true } : {}),
        timedOut: outcome.timedOut,
        cancelled: outcome.cancelled,
        durationMs: outcome.durationMs,
      };
      if (outcome.cancelled) return { ok: false, category: 'cancelled', content, detailsVersion: 1 };
      if (outcome.timedOut) return { ok: false, category: 'timeout', content, detailsVersion: 1 };
      if (outcome.stdoutExceeded) return { ok: false, category: 'output-limit', content, detailsVersion: 1 };
      if (outcome.exitCode !== 0) return { ok: false, category: 'process-exit', content, detailsVersion: 1 };
      return { ok: true, content, detailsVersion: 1 };
    },
  };
}

export function registerNativeFfmpegTool(
  registry: { register(definition: ToolDefinition, owner?: string): void },
  options: NativeFfmpegToolOptions,
): void {
  registry.register(createNativeFfmpegTool(options), 'octocode-agent');
}
