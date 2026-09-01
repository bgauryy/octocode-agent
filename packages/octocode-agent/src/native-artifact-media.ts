import fs from 'node:fs';
import path from 'node:path';

import {
  RuntimeFailure,
  assertArtifactDescriptorV1,
  assertModelToolResultV1,
  createEffectSet,
  jsonSchemaError,
  type ArtifactDescriptorV1,
  type ArtifactKind,
  type JsonSchema,
  type ModelToolResultImagePartV1,
  type ModelToolResultV1,
  type ToolDefinition,
  type ToolExecutionInput,
} from '@octocodeai/agent-core';

import {
  nativeFfmpegProcessPort,
  resolveNativeFfmpegBinary,
  type NativeFfmpegProcessPort,
} from './native-ffmpeg-tool.js';
import type { NativeFileBinarySnapshot, NativeFileSystemPort } from './native-file-tool.js';
import { createNativeImageInputResolver } from './native-user-input.js';

type MediaOperation =
  | { readonly operation: 'inspect'; readonly path: string }
  | { readonly operation: 'extract-frame'; readonly path: string; readonly outputPath: string; readonly atSeconds?: number };

export interface NativeArtifactMediaToolOptions {
  readonly workspace: string;
  readonly fileSystem: NativeFileSystemPort;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxMediaBytes?: number;
  readonly timeoutMs?: number;
  readonly resolveBinary?: (name: 'ffmpeg' | 'ffprobe') => string | undefined;
  readonly process?: NativeFfmpegProcessPort;
}

export const NATIVE_ARTIFACT_MEDIA_MAX_BYTES = 64 * 1_048_576;
const MAX_PROBE_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 64 * 1_024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 1_800_000;
const PATH_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 4_096 };

export const NATIVE_ARTIFACT_MEDIA_INPUT_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['operation', 'path'],
      properties: { operation: { const: 'inspect' }, path: PATH_SCHEMA },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['operation', 'path', 'outputPath'],
      properties: {
        operation: { const: 'extract-frame' },
        path: PATH_SCHEMA,
        outputPath: PATH_SCHEMA,
        atSeconds: { type: 'number', minimum: 0, maximum: 86_400 },
      },
      additionalProperties: false,
    },
  ],
};

const outputSchema: JsonSchema = {
  type: 'object',
  required: ['schemaVersion', 'parts'],
  properties: {
    schemaVersion: { const: 1 },
    parts: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object' } },
  },
  additionalProperties: false,
};

function boundedInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum)
    throw new RuntimeFailure('validation', `${label} must be between 1 and ${maximum}`);
  return resolved;
}

function artifactFor(
  snapshot: NativeFileBinarySnapshot,
  kind: ArtifactKind,
  mediaType: string,
): ArtifactDescriptorV1 {
  return assertArtifactDescriptorV1({
    schemaVersion: 1,
    artifactId: `artifact-${snapshot.sha256.slice(0, 20)}`,
    kind,
    path: snapshot.path,
    mediaType,
    byteLength: snapshot.bytes,
    sha256: snapshot.sha256,
    title: path.posix.basename(snapshot.path),
  });
}

function imageFromSnapshot(
  resolver: ReturnType<typeof createNativeImageInputResolver>,
  snapshot: NativeFileBinarySnapshot,
): ModelToolResultImagePartV1 | undefined {
  try {
    const image = resolver.fromBinary(
      Buffer.from(snapshot.contentBase64, 'base64'),
      undefined,
      path.posix.basename(snapshot.path),
    );
    return Object.freeze({
      type: 'image', mediaType: image.mediaType, data: image.data,
      byteLength: image.byteLength, ...(image.filename === undefined ? {} : { filename: image.filename }),
    });
  } catch (error) {
    if (error instanceof RuntimeFailure && error.category === 'validation') return undefined;
    throw error;
  }
}

function mediaTypeFor(kind: 'audio' | 'video', file: string): string {
  const extension = path.posix.extname(file).toLowerCase();
  const known: Readonly<Record<string, string>> = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
    '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  };
  return known[extension] ?? `${kind}/octet-stream`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProbe(stdout: Buffer, hostPath: string, displayPath: string): {
  readonly kind: 'audio' | 'video';
  readonly mediaType: string;
  readonly text: string;
} {
  if (stdout.byteLength === 0 || stdout.byteLength > MAX_PROBE_BYTES)
    throw new RuntimeFailure('adapter-translation', 'FFprobe returned invalid media metadata');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.toString('utf8'));
  } catch {
    throw new RuntimeFailure('adapter-translation', 'FFprobe returned invalid media metadata');
  }
  if (!record(parsed) || !Array.isArray(parsed.streams) || !record(parsed.format))
    throw new RuntimeFailure('adapter-translation', 'FFprobe returned invalid media metadata');
  if (parsed.streams.length > 128 || parsed.streams.some((stream) => !record(stream)))
    throw new RuntimeFailure('adapter-translation', 'FFprobe returned invalid media metadata');
  const kind = parsed.streams.some((stream) => stream.codec_type === 'video')
    ? 'video'
    : parsed.streams.some((stream) => stream.codec_type === 'audio')
      ? 'audio'
      : undefined;
  if (kind === undefined) throw new RuntimeFailure('adapter-translation', 'FFprobe found no supported audio or video stream');
  const serialized = JSON.stringify(parsed).split(hostPath).join(displayPath);
  return { kind, mediaType: mediaTypeFor(kind, displayPath), text: serialized };
}

function assertProcessOutcome(
  outcome: Awaited<ReturnType<NativeFfmpegProcessPort['run']>>,
  binary: 'ffmpeg' | 'ffprobe',
): void {
  if (outcome.cancelled) throw new RuntimeFailure('cancelled', `${binary} was cancelled`);
  if (outcome.timedOut) throw new RuntimeFailure('timeout', `${binary} timed out`);
  if (outcome.stdoutExceeded) throw new RuntimeFailure('tool-execution', `${binary} exceeded its output limit`);
  if (outcome.exitCode !== 0) throw new RuntimeFailure('tool-execution', `${binary} failed`);
}

function result(parts: ModelToolResultV1['parts']): ModelToolResultV1 {
  return assertModelToolResultV1({ schemaVersion: 1, parts });
}

async function requiredSnapshot(
  fileSystem: NativeFileSystemPort,
  file: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<NativeFileBinarySnapshot> {
  const snapshot = await fileSystem.readBinary(file, maxBytes, signal);
  if (snapshot === null) throw new RuntimeFailure('validation', 'Media file was not found');
  return snapshot;
}

export function createNativeArtifactMediaTool(options: NativeArtifactMediaToolOptions): ToolDefinition {
  const workspace = fs.realpathSync(path.resolve(options.workspace));
  if (!fs.statSync(workspace).isDirectory())
    throw new RuntimeFailure('validation', 'Artifact media workspace must be a directory');
  const maxMediaBytes = boundedInteger(
    options.maxMediaBytes,
    NATIVE_ARTIFACT_MEDIA_MAX_BYTES,
    NATIVE_ARTIFACT_MEDIA_MAX_BYTES,
    'Artifact media limit',
  );
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'Artifact media timeout');
  const env = options.env ?? process.env;
  const runner = options.process ?? nativeFfmpegProcessPort;
  const resolveBinary = options.resolveBinary ?? ((name: 'ffmpeg' | 'ffprobe') => resolveNativeFfmpegBinary(name, env));
  const imageResolver = createNativeImageInputResolver({ cwd: workspace, fileSystem: options.fileSystem });

  return {
    name: 'artifactMedia',
    label: 'Artifact media',
    description: 'Inspect bounded workspace images, audio, and video or extract one verified image frame using supervised FFmpeg.',
    schemaVersion: 1,
    inputSchema: NATIVE_ARTIFACT_MEDIA_INPUT_SCHEMA,
    outputSchema,
    outputVersion: 1,
    policy: {
      effects: createEffectSet('read', 'process', 'write'),
      trust: 'workspace',
      approval: 'on-request',
      plan: 'forbidden',
      resolve(value) {
        const writes = record(value) && value.operation === 'extract-frame';
        return {
          effects: writes ? createEffectSet('read', 'process', 'write') : createEffectSet('read', 'process'),
          trust: 'workspace', approval: 'on-request',
        };
      },
      lockTarget(value) {
        return record(value) && value.operation === 'extract-frame' && typeof value.outputPath === 'string'
          ? [value.outputPath]
          : [];
      },
      concurrency: () => ({ lane: 'native-ffmpeg', maxActive: 1 }),
    },
    async execute(execution: ToolExecutionInput) {
      const invalid = jsonSchemaError(execution.input, NATIVE_ARTIFACT_MEDIA_INPUT_SCHEMA);
      if (invalid) throw new RuntimeFailure('validation', invalid);
      const input = execution.input as MediaOperation;
      if (input.operation === 'inspect') {
        const snapshot = await requiredSnapshot(options.fileSystem, input.path, maxMediaBytes, execution.signal);
        const image = imageFromSnapshot(imageResolver, snapshot);
        if (image !== undefined) {
          const descriptor = artifactFor(snapshot, 'image', image.mediaType);
          return {
            ok: true,
            content: result([
              { type: 'text', text: `Inspected image ${snapshot.path} (${image.mediaType}, ${snapshot.bytes} bytes).` },
              image,
              { type: 'artifact', artifact: descriptor },
            ]),
            detailsVersion: 1,
          };
        }
        const binaryPath = resolveBinary('ffprobe');
        if (binaryPath === undefined || !path.isAbsolute(binaryPath))
          throw new RuntimeFailure('unsupported-capability', 'ffprobe is not available');
        const authorized = await options.fileSystem.authorizeExternalPath(input.path, 'input', execution.signal);
        const outcome = await runner.run({
          binaryPath,
          args: ['-hide_banner', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', authorized.hostPath],
          cwd: workspace, env, signal: execution.signal, timeoutMs,
          maxStdoutBytes: MAX_PROBE_BYTES, maxStderrBytes: MAX_STDERR_BYTES,
          captureStdout: true, progress: false,
        });
        assertProcessOutcome(outcome, 'ffprobe');
        const probe = parseProbe(outcome.stdout, authorized.hostPath, snapshot.path);
        return {
          ok: true,
          content: result([
            { type: 'text', text: `Inspected ${probe.kind} ${snapshot.path} (${probe.mediaType}, ${snapshot.bytes} bytes).\n${probe.text}` },
            { type: 'artifact', artifact: artifactFor(snapshot, probe.kind, probe.mediaType) },
          ]),
          detailsVersion: 1,
        };
      }

      const binaryPath = resolveBinary('ffmpeg');
      if (binaryPath === undefined || !path.isAbsolute(binaryPath))
        throw new RuntimeFailure('unsupported-capability', 'ffmpeg is not available');
      const [source, output] = await Promise.all([
        options.fileSystem.authorizeExternalPath(input.path, 'input', execution.signal),
        options.fileSystem.authorizeExternalPath(input.outputPath, 'output', execution.signal),
      ]);
      const atSeconds = input.atSeconds ?? 0;
      const outcome = await runner.run({
        binaryPath,
        args: [
          '-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:3',
          '-ss', String(atSeconds), '-i', source.hostPath,
          '-frames:v', '1', '-f', 'image2', '-y', output.hostPath,
        ],
        cwd: workspace, env, signal: execution.signal, timeoutMs,
        maxStdoutBytes: 1, maxStderrBytes: MAX_STDERR_BYTES,
        captureStdout: false, progress: true,
        onProgress: (progress) => {
          const message = [progress.frame && `frame=${progress.frame}`, progress.out_time && `time=${progress.out_time}`]
            .filter(Boolean).join(' ');
          void execution.update({ version: 1, kind: 'progress', message: message || 'Extracting frame' });
        },
      });
      assertProcessOutcome(outcome, 'ffmpeg');
      const snapshot = await requiredSnapshot(options.fileSystem, input.outputPath, maxMediaBytes, execution.signal);
      const image = imageFromSnapshot(imageResolver, snapshot);
      if (image === undefined) throw new RuntimeFailure('adapter-translation', 'FFmpeg output is not a supported image');
      return {
        ok: true,
        content: result([
          { type: 'text', text: `Extracted frame at ${atSeconds} seconds to ${snapshot.path}.` },
          image,
          { type: 'artifact', artifact: artifactFor(snapshot, 'image', image.mediaType) },
        ]),
        detailsVersion: 1,
      };
    },
  };
}
