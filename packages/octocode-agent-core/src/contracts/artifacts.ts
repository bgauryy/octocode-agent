import { RuntimeFailure } from './errors.js';
import {
  assertRuntimeUserInputV1,
  type RuntimeUserImageMediaType,
} from './user-input.js';

export const MODEL_TOOL_RESULT_MAX_PARTS = 32;
export const MODEL_TOOL_RESULT_MAX_TEXT_BYTES = 1_048_576;
export const MODEL_TOOL_RESULT_MAX_IMAGES = 8;
export const MODEL_TOOL_RESULT_MAX_INLINE_IMAGE_BYTES = 10 * 1_048_576;
export const MODEL_TOOL_RESULT_MAX_TOTAL_IMAGE_BYTES = 20 * 1_048_576;
export const ARTIFACT_DESCRIPTOR_MAX_BYTES = 1_099_511_627_776;

export type ArtifactKind = 'image' | 'audio' | 'video' | 'document' | 'data';

export interface ArtifactDescriptorV1 {
  readonly schemaVersion: 1;
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  /** Canonical POSIX-style path relative to the workspace capability root. */
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly title?: string;
}

export interface ModelToolResultTextPartV1 {
  readonly type: 'text';
  readonly text: string;
}

export interface ModelToolResultImagePartV1 {
  readonly type: 'image';
  readonly mediaType: RuntimeUserImageMediaType;
  readonly data: { readonly encoding: 'base64'; readonly value: string };
  readonly byteLength: number;
  readonly filename?: string;
}

export interface ModelToolResultArtifactPartV1 {
  readonly type: 'artifact';
  readonly artifact: ArtifactDescriptorV1;
}

export type ModelToolResultPartV1 =
  | ModelToolResultTextPartV1
  | ModelToolResultImagePartV1
  | ModelToolResultArtifactPartV1;

export interface ModelToolResultV1 {
  readonly schemaVersion: 1;
  readonly parts: readonly ModelToolResultPartV1[];
}

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;
const KINDS = new Set<ArtifactKind>(['image', 'audio', 'video', 'document', 'data']);

function fail(message: string): never {
  throw new RuntimeFailure('validation', message);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertExactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string,
): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) fail(`Unexpected ${label} field: ${unexpected}`);
}

function assertWorkspacePath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4_096
    || value.startsWith('/')
    || /^[A-Za-z]:/u.test(value)
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail('Artifact path must be a canonical workspace-relative path');
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
    fail('Artifact path must be a canonical workspace-relative path');
  return value;
}

function assertTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > 200
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail('Artifact title must contain 1-200 visible characters');
  return value;
}

export function assertArtifactDescriptorV1(value: unknown): ArtifactDescriptorV1 {
  if (!isRecord(value) || value.schemaVersion !== 1)
    fail('Artifact descriptor must use ArtifactDescriptorV1');
  assertExactFields(
    value,
    ['schemaVersion', 'artifactId', 'kind', 'path', 'mediaType', 'byteLength', 'sha256', 'title'],
    'artifact descriptor',
  );
  if (typeof value.artifactId !== 'string' || !ARTIFACT_ID.test(value.artifactId))
    fail('Artifact artifactId must be a bounded stable identifier');
  if (typeof value.kind !== 'string' || !KINDS.has(value.kind as ArtifactKind))
    fail('Artifact kind is unsupported');
  const path = assertWorkspacePath(value.path);
  if (typeof value.mediaType !== 'string' || !MEDIA_TYPE.test(value.mediaType))
    fail('Artifact media type must be a bounded canonical IANA media type');
  if (
    !Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) < 0
    || (value.byteLength as number) > ARTIFACT_DESCRIPTOR_MAX_BYTES
  ) fail('Artifact byteLength is outside the supported range');
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256))
    fail('Artifact sha256 must be a lowercase SHA-256 digest');
  const title = assertTitle(value.title);
  const kind = value.kind as ArtifactKind;
  if (
    (kind === 'image' || kind === 'audio' || kind === 'video')
    && !value.mediaType.startsWith(`${kind}/`)
  ) fail(`Artifact ${kind} kind does not match its media type`);
  return Object.freeze({
    schemaVersion: 1,
    artifactId: value.artifactId,
    kind,
    path,
    mediaType: value.mediaType,
    byteLength: value.byteLength as number,
    sha256: value.sha256,
    ...(title === undefined ? {} : { title }),
  });
}

export function assertModelToolResultV1(value: unknown): ModelToolResultV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.parts))
    fail('Tool result must use ModelToolResultV1');
  assertExactFields(value, ['schemaVersion', 'parts'], 'tool result');
  if (value.parts.length === 0 || value.parts.length > MODEL_TOOL_RESULT_MAX_PARTS)
    fail(`Tool result must contain 1-${MODEL_TOOL_RESULT_MAX_PARTS} parts`);
  const parts: ModelToolResultPartV1[] = [];
  let textBytes = 0;
  let imageBytes = 0;
  let images = 0;
  for (const part of value.parts as readonly unknown[]) {
    if (!isRecord(part) || typeof part.type !== 'string') fail('Tool result parts must be typed objects');
    if (part.type === 'text') {
      assertExactFields(part, ['type', 'text'], 'tool result text part');
      if (typeof part.text !== 'string') fail('Tool result text part requires text');
      textBytes += UTF8_ENCODER.encode(part.text).byteLength;
      if (textBytes > MODEL_TOOL_RESULT_MAX_TEXT_BYTES)
        fail(`Tool result text exceeds ${MODEL_TOOL_RESULT_MAX_TEXT_BYTES} bytes`);
      parts.push(Object.freeze({ type: 'text', text: part.text }));
      continue;
    }
    if (part.type === 'image') {
      assertExactFields(part, ['type', 'mediaType', 'data', 'byteLength', 'filename'], 'tool result image part');
      if (!isRecord(part.data)) fail('Tool result image requires inline canonical base64 data');
      assertExactFields(part.data, ['encoding', 'value'], 'tool result image data');
      const image = assertRuntimeUserInputV1({ schemaVersion: 1, parts: [part] }).parts[0];
      if (image?.type !== 'image') fail('Tool result image is invalid');
      if (image.byteLength > MODEL_TOOL_RESULT_MAX_INLINE_IMAGE_BYTES)
        fail(`Tool result image exceeds ${MODEL_TOOL_RESULT_MAX_INLINE_IMAGE_BYTES} bytes`);
      images += 1;
      imageBytes += image.byteLength;
      if (images > MODEL_TOOL_RESULT_MAX_IMAGES)
        fail(`Tool result exceeds ${MODEL_TOOL_RESULT_MAX_IMAGES} images`);
      if (imageBytes > MODEL_TOOL_RESULT_MAX_TOTAL_IMAGE_BYTES)
        fail(`Tool result images exceed ${MODEL_TOOL_RESULT_MAX_TOTAL_IMAGE_BYTES} bytes`);
      parts.push(Object.freeze({
        type: 'image',
        mediaType: image.mediaType,
        data: Object.freeze({ ...image.data }),
        byteLength: image.byteLength,
        ...(image.filename === undefined ? {} : { filename: image.filename }),
      }));
      continue;
    }
    if (part.type === 'artifact') {
      assertExactFields(part, ['type', 'artifact'], 'tool result artifact part');
      parts.push(Object.freeze({ type: 'artifact', artifact: assertArtifactDescriptorV1(part.artifact) }));
      continue;
    }
    fail('Unsupported tool result part type');
  }
  return Object.freeze({ schemaVersion: 1, parts: Object.freeze(parts) });
}

function bytesLabel(value: number): string {
  return `${value} ${value === 1 ? 'byte' : 'bytes'}`;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const encoded = UTF8_ENCODER.encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  return UTF8_DECODER.decode(encoded.subarray(0, maximumBytes));
}

/** A content-safe fallback for adapters that cannot carry one or more structured parts. */
export function modelToolResultTextFallback(value: ModelToolResultV1): string {
  const result = assertModelToolResultV1(value);
  const lines = result.parts.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'image') {
      const name = part.filename ?? 'unnamed image';
      return `Image ${name} (${part.mediaType}, ${bytesLabel(part.byteLength)}) is available as structured tool output.`;
    }
    const descriptor = part.artifact;
    const title = descriptor.title ?? descriptor.artifactId;
    return `Artifact ${title} (${descriptor.mediaType}, ${bytesLabel(descriptor.byteLength)}) is available at workspace path ${descriptor.path}.`;
  });
  return utf8Prefix(lines.join('\n'), MODEL_TOOL_RESULT_MAX_TEXT_BYTES);
}
