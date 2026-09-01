import { describe, expect, it } from 'vitest';
import {
  MAX_NATIVE_WORKER_BOOTSTRAP_BYTES,
  assertNativeWorkerBootstrapBindingV1,
  decodeNativeWorkerBootstrapPacketV1,
  encodeNativeWorkerBootstrapPacketV1,
  parseNativeWorkerBootstrapPacketV1,
  type NativeWorkerBootstrapPacketV1,
} from '../src/native-worker-bootstrap.js';

function packet(): NativeWorkerBootstrapPacketV1 {
  return {
    schemaVersion: 1,
    type: 'native.worker.bootstrap',
    workerId: 'worker-1',
    correlationId: 'correlation-1',
    promptSnapshotId: 'a'.repeat(64),
    customization: {
      schemaVersion: 1,
      id: 'com.acme.portable',
      entrypoint: {
        kind: 'module',
        moduleUrl: 'file:///tmp/customization.mjs',
        exportName: 'activate',
        integrity: `sha256-${'b'.repeat(64)}`,
      },
      config: { enabled: true },
      workerContributions: ['tool:portableTool'],
      manifestSha256: 'c'.repeat(64),
    },
  };
}

describe('native worker bootstrap packet', () => {
  it('round-trips one bounded, frozen, closed packet', () => {
    const encoded = encodeNativeWorkerBootstrapPacketV1(packet());
    const decoded = decodeNativeWorkerBootstrapPacketV1(encoded);
    expect(decoded).toEqual(packet());
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.customization)).toBe(true);
    expect(encoded.at(-1)).toBe(10);
  });

  it('rejects unknown fields, malformed versions, and oversized input', () => {
    expect(() => parseNativeWorkerBootstrapPacketV1({ ...packet(), extra: true })).toThrow(/closed|unknown/i);
    expect(() => parseNativeWorkerBootstrapPacketV1({ ...packet(), schemaVersion: 2 })).toThrow(/version/i);
    expect(() => decodeNativeWorkerBootstrapPacketV1(new Uint8Array(MAX_NATIVE_WORKER_BOOTSTRAP_BYTES + 1)))
      .toThrow(/bytes|large|size/i);
  });

  it('binds worker, correlation, and prompt identities exactly', () => {
    const parsed = parseNativeWorkerBootstrapPacketV1(packet());
    expect(() => assertNativeWorkerBootstrapBindingV1(parsed, {
      workerId: 'worker-1', correlationId: 'correlation-1', promptSnapshotId: 'a'.repeat(64),
    })).not.toThrow();
    expect(() => assertNativeWorkerBootstrapBindingV1(parsed, {
      workerId: 'worker-2', correlationId: 'correlation-1', promptSnapshotId: 'a'.repeat(64),
    })).toThrow(/binding|worker/i);
  });

  it('rejects multiple frames and malformed resolved customization descriptors', () => {
    const encoded = encodeNativeWorkerBootstrapPacketV1(packet());
    const duplicated = new Uint8Array([...encoded, ...encoded]);
    expect(() => decodeNativeWorkerBootstrapPacketV1(duplicated)).toThrow(/frame|json|trailing/i);
    expect(() => parseNativeWorkerBootstrapPacketV1({
      ...packet(),
      customization: { ...packet().customization!, manifestSha256: 'bad' },
    })).toThrow(/manifest/i);
  });

  it('carries a bounded data-only prompt overlay without an environment transport', () => {
    const input: NativeWorkerBootstrapPacketV1 = {
      ...packet(),
      customization: undefined,
      promptCustomization: {
        schemaVersion: 1,
        id: 'com.acme.prompt',
        productPolicyOverlay: { mode: 'append', content: 'Use Acme terminology.' },
      },
    };
    expect(decodeNativeWorkerBootstrapPacketV1(encodeNativeWorkerBootstrapPacketV1(input)))
      .toMatchObject({ promptCustomization: { id: 'com.acme.prompt' } });
    expect(() => parseNativeWorkerBootstrapPacketV1({
      ...packet(),
      promptCustomization: input.promptCustomization,
    })).toThrow(/two customization|cannot contain/i);
  });
});
