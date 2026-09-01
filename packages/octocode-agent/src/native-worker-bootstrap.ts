import {
  parseNativeResolvedPortableCustomizationDescriptorV1,
  type NativeResolvedPortableCustomizationDescriptorV1,
} from './native-portable-customization.js';
import type { ProductPolicyOverlayV1 } from './api/v1.js';

export const MAX_NATIVE_WORKER_BOOTSTRAP_BYTES = 1_048_576;
const MAX_ID_CHARS = 512;

export interface NativeWorkerBootstrapPacketV1 {
  readonly schemaVersion: 1;
  readonly type: 'native.worker.bootstrap';
  readonly workerId: string;
  readonly correlationId: string;
  readonly promptSnapshotId: string;
  readonly customization?: NativeResolvedPortableCustomizationDescriptorV1;
  readonly promptCustomization?: NativeWorkerPromptCustomizationV1;
}

export interface NativeWorkerPromptCustomizationV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly productPolicyOverlay: ProductPolicyOverlayV1;
}

export interface NativeWorkerBootstrapBindingV1 {
  readonly workerId: string;
  readonly correlationId: string;
  readonly promptSnapshotId: string;
}

export function parseNativeWorkerBootstrapPacketV1(
  input: unknown,
): NativeWorkerBootstrapPacketV1 {
  const value = record(input, 'native worker bootstrap packet');
  closed(
    value,
    ['schemaVersion', 'type', 'workerId', 'correlationId', 'promptSnapshotId', 'customization', 'promptCustomization'],
    'native worker bootstrap packet',
  );
  if (value['schemaVersion'] !== 1 || value['type'] !== 'native.worker.bootstrap')
    throw new TypeError('Native worker bootstrap packet version or type is unsupported');
  const customization = value['customization'] === undefined
    ? undefined
    : parseNativeResolvedPortableCustomizationDescriptorV1(value['customization']);
  const promptCustomization = value['promptCustomization'] === undefined
    ? undefined
    : parsePromptCustomization(value['promptCustomization']);
  if (customization !== undefined && promptCustomization !== undefined)
    throw new TypeError('Native worker bootstrap cannot contain two customization transports');
  return deepFreeze({
    schemaVersion: 1,
    type: 'native.worker.bootstrap',
    workerId: bounded(value['workerId'], 'workerId'),
    correlationId: bounded(value['correlationId'], 'correlationId'),
    promptSnapshotId: bounded(value['promptSnapshotId'], 'promptSnapshotId'),
    ...(customization === undefined ? {} : { customization }),
    ...(promptCustomization === undefined ? {} : { promptCustomization }),
  });
}

function parsePromptCustomization(input: unknown): NativeWorkerPromptCustomizationV1 {
  const value = record(input, 'native worker prompt customization');
  closed(value, ['schemaVersion', 'id', 'productPolicyOverlay'], 'native worker prompt customization');
  if (value['schemaVersion'] !== 1)
    throw new TypeError('Native worker prompt customization version is unsupported');
  const id = bounded(value['id'], 'customization id');
  const overlay = record(value['productPolicyOverlay'], 'native worker product policy overlay');
  closed(overlay, ['mode', 'content'], 'native worker product policy overlay');
  if (!['prepend', 'append', 'replace'].includes(String(overlay['mode'])) ||
      typeof overlay['content'] !== 'string' || !overlay['content'].trim() ||
      Buffer.byteLength(overlay['content']) > 128 * 1024)
    throw new TypeError('Native worker product policy overlay is invalid');
  return deepFreeze({
    schemaVersion: 1,
    id,
    productPolicyOverlay: {
      mode: overlay['mode'] as ProductPolicyOverlayV1['mode'],
      content: overlay['content'],
    },
  });
}

export function encodeNativeWorkerBootstrapPacketV1(
  input: NativeWorkerBootstrapPacketV1,
): Uint8Array {
  const packet = parseNativeWorkerBootstrapPacketV1(input);
  const encoded = Buffer.from(`${JSON.stringify(packet)}\n`, 'utf8');
  if (encoded.byteLength > MAX_NATIVE_WORKER_BOOTSTRAP_BYTES)
    throw new TypeError(`Native worker bootstrap packet exceeds ${MAX_NATIVE_WORKER_BOOTSTRAP_BYTES} bytes`);
  return encoded;
}

export function decodeNativeWorkerBootstrapPacketV1(
  input: Uint8Array | string,
): NativeWorkerBootstrapPacketV1 {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.byteLength === 0) throw new TypeError('Native worker bootstrap packet is empty');
  if (bytes.byteLength > MAX_NATIVE_WORKER_BOOTSTRAP_BYTES)
    throw new TypeError(`Native worker bootstrap packet exceeds ${MAX_NATIVE_WORKER_BOOTSTRAP_BYTES} bytes`);
  const text = bytes.toString('utf8');
  const firstNewline = text.indexOf('\n');
  const frame = firstNewline === -1 ? text : text.slice(0, firstNewline);
  const trailing = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  if (trailing.trim()) throw new TypeError('Native worker bootstrap transport contains more than one frame');
  let parsed: unknown;
  try { parsed = JSON.parse(frame); }
  catch { throw new TypeError('Native worker bootstrap frame is malformed JSON'); }
  return parseNativeWorkerBootstrapPacketV1(parsed);
}

export function assertNativeWorkerBootstrapBindingV1(
  packet: NativeWorkerBootstrapPacketV1,
  expected: NativeWorkerBootstrapBindingV1,
): void {
  if (
    packet.workerId !== expected.workerId ||
    packet.correlationId !== expected.correlationId ||
    packet.promptSnapshotId !== expected.promptSnapshotId
  ) {
    throw new TypeError('Native worker bootstrap binding does not match the spawn identity');
  }
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${label} must be a plain object`);
  return input as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new TypeError(`${label} must be closed; unknown field ${unknown}`);
}

function bounded(input: unknown, label: string): string {
  if (
    typeof input !== 'string' ||
    input.length < 1 ||
    input.length > MAX_ID_CHARS ||
    /\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)
  ) {
    throw new TypeError(`Native worker bootstrap ${label} must be a bounded string`);
  }
  return input;
}

function deepFreeze<T>(input: T): T {
  if (typeof input !== 'object' || input === null || Object.isFrozen(input)) return input;
  Object.freeze(input);
  for (const value of Object.values(input)) deepFreeze(value);
  return input;
}
