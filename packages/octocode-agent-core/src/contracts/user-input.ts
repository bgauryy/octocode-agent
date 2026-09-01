import { RuntimeFailure } from './errors.js';

export const RUNTIME_USER_INPUT_MAX_PARTS = 32;
export const RUNTIME_USER_INPUT_MAX_TEXT_BYTES = 1_048_576;
export const RUNTIME_USER_INPUT_MAX_IMAGES = 8;
export const RUNTIME_USER_INPUT_MAX_IMAGE_BYTES = 10 * 1_048_576;
export const RUNTIME_USER_INPUT_MAX_TOTAL_IMAGE_BYTES = 20 * 1_048_576;
export const RUNTIME_USER_IMAGE_MEDIA_TYPES = Object.freeze([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
] as const);
export type RuntimeUserImageMediaType = (typeof RUNTIME_USER_IMAGE_MEDIA_TYPES)[number];

export interface RuntimeUserTextPartV1 { readonly type: 'text'; readonly text: string; }
/** Bounded inline bridge until durable hosts provide integrity-bound blob references. */
export interface RuntimeUserImagePartV1 {
  readonly type: 'image';
  readonly mediaType: RuntimeUserImageMediaType;
  readonly data: { readonly encoding: 'base64'; readonly value: string };
  readonly byteLength: number;
  readonly filename?: string;
}
export type RuntimeUserInputPartV1 = RuntimeUserTextPartV1 | RuntimeUserImagePartV1;
export interface RuntimeUserInputV1 { readonly schemaVersion: 1; readonly parts: readonly RuntimeUserInputPartV1[]; }
export interface RuntimeUserAttachmentMetadataV1 {
  readonly schemaVersion: 1;
  readonly type: 'image';
  readonly partIndex: number;
  readonly mediaType: RuntimeUserImageMediaType;
  readonly byteLength: number;
  readonly filename?: string;
}

const UTF8_ENCODER = new TextEncoder();
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MEDIA_TYPES = new Set<string>(RUNTIME_USER_IMAGE_MEDIA_TYPES);
const fail = (message: string): never => { throw new RuntimeFailure('validation', message); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function decodedBase64Length(value: string): number {
  if (value.length === 0 || !BASE64.test(value)) fail('Image data must be canonical base64');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding === 2 && (BASE64_ALPHABET.indexOf(value.at(-3)!) & 0x0f) !== 0)
    fail('Image data must be canonical base64');
  if (padding === 1 && (BASE64_ALPHABET.indexOf(value.at(-2)!) & 0x03) !== 0)
    fail('Image data must be canonical base64');
  return (value.length / 4) * 3 - padding;
}

function base64Prefix(value: string, maximum = 12): readonly number[] {
  const result: number[] = [];
  for (let offset = 0; offset < value.length && result.length < maximum; offset += 4) {
    const a = BASE64_ALPHABET.indexOf(value[offset]!);
    const b = BASE64_ALPHABET.indexOf(value[offset + 1]!);
    const c = value[offset + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[offset + 2]!);
    const d = value[offset + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[offset + 3]!);
    result.push((a << 2) | (b >> 4));
    if (value[offset + 2] !== '=' && result.length < maximum)
      result.push(((b & 0x0f) << 4) | (c >> 2));
    if (value[offset + 3] !== '=' && result.length < maximum)
      result.push(((c & 0x03) << 6) | d);
  }
  return result;
}

function hasImageSignature(
  value: string,
  mediaType: RuntimeUserImageMediaType,
): boolean {
  const bytes = base64Prefix(value);
  if (mediaType === 'image/png')
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((byte, index) => bytes[index] === byte);
  if (mediaType === 'image/jpeg')
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === 'image/gif')
    return bytes.slice(0, 6).map((byte) => String.fromCharCode(byte)).join('') === 'GIF87a'
      || bytes.slice(0, 6).map((byte) => String.fromCharCode(byte)).join('') === 'GIF89a';
  return bytes.slice(0, 4).map((byte) => String.fromCharCode(byte)).join('') === 'RIFF'
    && bytes.slice(8, 12).map((byte) => String.fromCharCode(byte)).join('') === 'WEBP';
}

function assertFilename(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value === '.' || value === '..' || /[\u0000-\u001f\u007f/\\]/u.test(value))
    fail('Image filename must be a bounded basename');
  return value as string;
}

export function assertRuntimeUserInputV1(value: unknown): RuntimeUserInputV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.parts)) fail('User input must use RuntimeUserInputV1');
  const raw = value as { readonly parts: readonly unknown[] };
  if (raw.parts.length === 0 || raw.parts.length > RUNTIME_USER_INPUT_MAX_PARTS) fail(`User input must contain 1-${RUNTIME_USER_INPUT_MAX_PARTS} parts`);
  let textBytes = 0;
  let imageBytes = 0;
  let images = 0;
  const parts: RuntimeUserInputPartV1[] = [];
  for (const part of raw.parts) {
    if (!isRecord(part)) throw new RuntimeFailure('validation', 'User input parts must be objects');
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw new RuntimeFailure('validation', 'Text input part requires text');
      textBytes += UTF8_ENCODER.encode(part.text).byteLength;
      if (textBytes > RUNTIME_USER_INPUT_MAX_TEXT_BYTES) fail(`User input text exceeds ${RUNTIME_USER_INPUT_MAX_TEXT_BYTES} bytes`);
      parts.push(Object.freeze({ type: 'text', text: part.text }));
      continue;
    }
    if (part.type !== 'image') fail('Unsupported user input part type');
    if (typeof part.mediaType !== 'string' || !MEDIA_TYPES.has(part.mediaType)) fail('Unsupported image media type');
    if (!isRecord(part.data) || part.data.encoding !== 'base64' || typeof part.data.value !== 'string')
      throw new RuntimeFailure('validation', 'Image input requires inline canonical base64 data');
    const imageData = part.data as { readonly encoding: 'base64'; readonly value: string };
    const byteLength = decodedBase64Length(imageData.value);
    if (!Number.isSafeInteger(part.byteLength) || part.byteLength !== byteLength) fail('Image byteLength does not match its base64 payload');
    if (byteLength > RUNTIME_USER_INPUT_MAX_IMAGE_BYTES) fail(`Image exceeds ${RUNTIME_USER_INPUT_MAX_IMAGE_BYTES} bytes`);
    images += 1;
    imageBytes += byteLength;
    if (images > RUNTIME_USER_INPUT_MAX_IMAGES) fail(`User input exceeds ${RUNTIME_USER_INPUT_MAX_IMAGES} images`);
    if (imageBytes > RUNTIME_USER_INPUT_MAX_TOTAL_IMAGE_BYTES) fail(`User input images exceed ${RUNTIME_USER_INPUT_MAX_TOTAL_IMAGE_BYTES} bytes`);
    if (!hasImageSignature(imageData.value, part.mediaType as RuntimeUserImageMediaType))
      fail('Image media type does not match its file signature');
    const filename = assertFilename(part.filename);
    parts.push(Object.freeze({
      type: 'image', mediaType: part.mediaType as RuntimeUserImageMediaType,
      data: Object.freeze({ encoding: 'base64', value: imageData.value }), byteLength,
      ...(filename === undefined ? {} : { filename }),
    }));
  }
  if (textBytes === 0 && images === 0) fail('User input must contain text or an image');
  return Object.freeze({ schemaVersion: 1, parts: Object.freeze(parts) });
}

export const runtimeUserInputFromText = (text: string): RuntimeUserInputV1 =>
  assertRuntimeUserInputV1({ schemaVersion: 1, parts: [{ type: 'text', text }] });
export const runtimeUserInputText = (input: RuntimeUserInputV1): string =>
  input.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
export const runtimeUserInputAttachments = (input: RuntimeUserInputV1): readonly RuntimeUserAttachmentMetadataV1[] =>
  Object.freeze(input.parts.flatMap((part, partIndex) => part.type === 'image' ? [Object.freeze({
    schemaVersion: 1 as const, type: 'image' as const, partIndex, mediaType: part.mediaType,
    byteLength: part.byteLength, ...(part.filename === undefined ? {} : { filename: part.filename }),
  })] : []));

export function runtimeUserInputWithText(input: RuntimeUserInputV1, text: string): RuntimeUserInputV1 {
  if (runtimeUserInputText(input) === text) return input;
  const firstText = input.parts.findIndex((part) => part.type === 'text');
  const parts: RuntimeUserInputPartV1[] = [];
  for (let index = 0; index < input.parts.length; index += 1) {
    const part = input.parts[index]!;
    if (part.type === 'image') parts.push(part);
    else if (index === firstText) parts.push({ type: 'text', text });
  }
  if (firstText === -1 && text.length > 0) parts.unshift({ type: 'text', text });
  return assertRuntimeUserInputV1({ schemaVersion: 1, parts });
}
