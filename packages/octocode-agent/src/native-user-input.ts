import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  RUNTIME_USER_IMAGE_MEDIA_TYPES,
  RUNTIME_USER_INPUT_MAX_IMAGE_BYTES,
  RuntimeFailure,
  assertRuntimeUserInputV1,
  type RuntimeUserImageMediaType,
  type RuntimeUserImagePartV1,
  type RuntimeUserInputPartV1,
  type RuntimeUserInputV1,
} from '@octocodeai/agent-core';

import type { NativeFileSystemPort } from './native-file-tool.js';

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp)$/iu;
const MEDIA_TYPES = new Set<string>(RUNTIME_USER_IMAGE_MEDIA_TYPES);

export interface NativeImageInputResolver {
  fromBinary(
    bytes: Uint8Array,
    mediaType?: string,
    filename?: string,
  ): RuntimeUserImagePartV1;
  fromWorkspacePath(
    rawPath: string,
    signal?: AbortSignal,
  ): Promise<RuntimeUserImagePartV1>;
}

export interface NativeImageInputResolverOptions {
  readonly cwd: string;
  readonly fileSystem: NativeFileSystemPort;
}

function detectedMediaType(bytes: Uint8Array): RuntimeUserImageMediaType | undefined {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((byte, index) => bytes[index] === byte)
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  const prefix = Buffer.from(bytes.subarray(0, 12)).toString('ascii');
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function defaultFilename(mediaType: RuntimeUserImageMediaType): string {
  return `pasted-image.${mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length)}`;
}

function normalizeFilename(value: string | undefined, mediaType: RuntimeUserImageMediaType): string {
  if (value === undefined) return defaultFilename(mediaType);
  const basename = path.basename(value);
  return basename.length > 0 ? basename : defaultFilename(mediaType);
}

export function parseNativeDraggedImagePath(value: string): string | undefined {
  let candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 4_096 || /[\r\n\u0000]/u.test(candidate))
    return undefined;
  if (
    (candidate.startsWith("'") && candidate.endsWith("'")) ||
    (candidate.startsWith('"') && candidate.endsWith('"'))
  ) candidate = candidate.slice(1, -1);
  candidate = candidate.replace(/\\([\\ '"()&])/gu, '$1');
  if (!IMAGE_EXTENSIONS.test(candidate)) return undefined;
  return candidate;
}

function relativeWorkspacePath(cwd: string, candidate: string): string {
  const relative = path.isAbsolute(candidate)
    ? path.relative(cwd, candidate)
    : path.normalize(candidate);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) throw new RuntimeFailure('validation', 'Image path must stay within the workspace');
  return relative.split(path.sep).join('/');
}

export function createNativeImageInputResolver(
  options: NativeImageInputResolverOptions,
): NativeImageInputResolver {
  const cwd = path.resolve(options.cwd);
  const fromBinary: NativeImageInputResolver['fromBinary'] = (
    input,
    mediaTypeHint,
    filename,
  ) => {
    if (input.byteLength > RUNTIME_USER_INPUT_MAX_IMAGE_BYTES)
      throw new RuntimeFailure(
        'validation',
        `Image exceeds ${RUNTIME_USER_INPUT_MAX_IMAGE_BYTES} bytes`,
      );
    if (mediaTypeHint !== undefined && !MEDIA_TYPES.has(mediaTypeHint))
      throw new RuntimeFailure('validation', 'Unsupported image media type');
    const mediaType = detectedMediaType(input);
    if (mediaType === undefined)
      throw new RuntimeFailure('validation', 'Pasted bytes are not a supported image');
    if (mediaTypeHint !== undefined && mediaTypeHint !== mediaType)
      throw new RuntimeFailure('validation', 'Image media type does not match its file signature');
    const bytes = Buffer.from(input);
    return assertRuntimeUserInputV1({
      schemaVersion: 1,
      parts: [{
        type: 'image',
        mediaType,
        data: { encoding: 'base64', value: bytes.toString('base64') },
        byteLength: bytes.byteLength,
        filename: normalizeFilename(filename, mediaType),
      }],
    }).parts[0] as RuntimeUserImagePartV1;
  };

  return Object.freeze({
    fromBinary,
    async fromWorkspacePath(rawPath: string, signal = new AbortController().signal) {
      const candidate = parseNativeDraggedImagePath(rawPath);
      if (candidate === undefined)
        throw new RuntimeFailure('validation', 'Paste exactly one PNG, JPEG, GIF, or WebP image path');
      const relative = relativeWorkspacePath(cwd, candidate);
      const snapshot = await options.fileSystem.readBinary(
        relative,
        RUNTIME_USER_INPUT_MAX_IMAGE_BYTES,
        signal,
      );
      if (snapshot === null)
        throw new RuntimeFailure('validation', 'Image file was not found');
      return fromBinary(
        Buffer.from(snapshot.contentBase64, 'base64'),
        undefined,
        path.basename(snapshot.path),
      );
    },
  });
}

interface StoredImage {
  readonly marker: string;
  readonly prefix: string;
  readonly part: RuntimeUserImagePartV1;
}

function displayFilename(value: string | undefined): string {
  const safe = (value ?? 'image')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .slice(0, 80);
  return safe || 'image';
}

function displayBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.ceil(value / 1_024)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function count(value: string, token: string): number {
  return value.split(token).length - 1;
}

/** Keeps image payloads outside the visual composer while preserving part order. */
export class NativeComposerImageStore {
  private nextId = 1;
  private readonly stored = new Map<string, StoredImage>();

  get size(): number { return this.stored.size; }

  add(part: RuntimeUserImagePartV1): { readonly marker: string } {
    const canonical = assertRuntimeUserInputV1({ schemaVersion: 1, parts: [part] })
      .parts[0] as RuntimeUserImagePartV1;
    const id = this.nextId++;
    const digest = createHash('sha256').update(canonical.data.value).digest('hex').slice(0, 12);
    const prefix = `[image #${id}:${digest}`;
    const kind = canonical.mediaType.slice('image/'.length).toUpperCase().replace('JPEG', 'JPG');
    const marker = `${prefix} ${displayFilename(canonical.filename)} · ${kind} · ${displayBytes(canonical.byteLength)}]`;
    this.stored.set(marker, Object.freeze({ marker, prefix, part: canonical }));
    return Object.freeze({ marker });
  }

  compose(draft: string): RuntimeUserInputV1 {
    for (const [marker, stored] of [...this.stored]) {
      const occurrences = count(draft, marker);
      if (occurrences > 1)
        throw new RuntimeFailure('validation', 'An image attachment marker is duplicated');
      if (occurrences === 0) {
        if (draft.includes(stored.prefix))
          throw new RuntimeFailure('validation', 'An image attachment marker is incomplete');
        this.stored.delete(marker);
      }
    }
    const matches = [...this.stored.values()]
      .map((stored) => ({ stored, index: draft.indexOf(stored.marker) }))
      .filter(({ index }) => index >= 0)
      .sort((left, right) => left.index - right.index);
    const parts: RuntimeUserInputPartV1[] = [];
    let offset = 0;
    for (const { stored, index } of matches) {
      if (index > offset) parts.push({ type: 'text', text: draft.slice(offset, index) });
      parts.push(stored.part);
      offset = index + stored.marker.length;
    }
    if (offset < draft.length) parts.push({ type: 'text', text: draft.slice(offset) });
    return assertRuntimeUserInputV1({ schemaVersion: 1, parts });
  }

  clear(): void {
    this.stored.clear();
    this.nextId = 1;
  }
}
