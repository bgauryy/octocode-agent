import { describe, expect, it } from 'vitest';
import {
  resolveNativeWorkerDepthPolicy,
  workerCapabilityTools,
} from '../src/native-worker-depth.js';

describe('native worker depth policy', () => {
  it('makes every child a leaf by default', () => {
    const root = resolveNativeWorkerDepthPolicy({});
    const child = resolveNativeWorkerDepthPolicy({
      OCTOCODE_NATIVE_WORKER: '1',
      OCTOCODE_NATIVE_WORKER_DEPTH: '1',
      OCTOCODE_NATIVE_WORKER_MAX_DEPTH: '1',
    });

    expect(root).toMatchObject({ depth: 0, maxDepth: 1, canSpawn: true, childCanSpawn: false, maxActive: 4 });
    expect(child).toMatchObject({ depth: 1, maxDepth: 1, canSpawn: false, childCanSpawn: false, maxActive: 0 });
    expect(workerCapabilityTools(['read', 'worker'], root)).toEqual(['read']);
    expect(workerCapabilityTools(['read', 'worker'], child)).toEqual(['read']);
  });

  it('keeps the legacy worker marker non-recursive and rejects malformed depth metadata', () => {
    expect(resolveNativeWorkerDepthPolicy({ OCTOCODE_NATIVE_WORKER: '1' }))
      .toMatchObject({ depth: 1, maxDepth: 1, canSpawn: false });
    expect(() => resolveNativeWorkerDepthPolicy({ OCTOCODE_NATIVE_WORKER_DEPTH: '-1' }))
      .toThrow(/depth/i);
    expect(() => resolveNativeWorkerDepthPolicy({
      OCTOCODE_NATIVE_WORKER: '1',
      OCTOCODE_NATIVE_WORKER_DEPTH: '0',
      OCTOCODE_NATIVE_WORKER_MAX_DEPTH: '1',
    })).toThrow(/child marker/i);
    expect(() => resolveNativeWorkerDepthPolicy({
      OCTOCODE_NATIVE_WORKER_DEPTH: '1',
      OCTOCODE_NATIVE_WORKER_MAX_DEPTH: '2',
    })).toThrow(/maximum depth/i);
  });
});
