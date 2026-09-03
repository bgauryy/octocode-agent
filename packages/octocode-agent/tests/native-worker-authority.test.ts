import {
  correlationId,
  sessionId,
  workerId,
  type ToolAdmissionContextV1,
  type WorkerCapabilities,
} from '@octocodeai/agent-core';
import { describe, expect, it } from 'vitest';
import {
  createNativeWorkerAuthorityRoot,
  mintNativeWorkerAuthority,
  nativeWorkerCapabilityDigest,
} from '../src/native-worker-authority.js';

const admission: ToolAdmissionContextV1 = {
  schemaVersion: 1,
  effectAdmissionId: 'effect:worker:1',
  receiptDigest: 'receipt:1',
  trustRevision: 'trust:1',
  permissionMode: 'default',
  policyRevision: 3,
  planRevision: 7,
  workerAuthorityRoot: {
    rootAgentId: 'root:1',
    workspaceId: 'workspace:1',
    workspaceGeneration: 2,
    ownershipGeneration: 4,
  },
};

const capabilities: WorkerCapabilities = {
  tools: ['read', 'octocode'],
  octocodeTools: ['localSearch', 'lspGetSemantics'],
  models: [
    { providerId: 'openai', modelId: 'gpt-5' },
    { providerId: 'anthropic', modelId: 'claude' },
  ],
  maxTurns: 8,
};

describe('native worker authority', () => {
  it('derives a stable workspace identity from canonical root and Git common-dir', async () => {
    const canonicalizePath = async (path: string) => `/real${path}`;
    const root = await createNativeWorkerAuthorityRoot({
      rootAgentId: 'root:1',
      workspaceRoot: '/workspace',
      workspaceGeneration: 2,
      ownershipGeneration: 4,
      canonicalizePath,
      resolveGitCommonDir: async (workspaceRoot) => {
        expect(workspaceRoot).toBe('/real/workspace');
        return '/git/common';
      },
    });
    const repeated = await createNativeWorkerAuthorityRoot({
      rootAgentId: 'root:1',
      workspaceRoot: '/workspace',
      workspaceGeneration: 2,
      ownershipGeneration: 4,
      canonicalizePath,
      resolveGitCommonDir: async () => '/git/common',
    });

    expect(root).toEqual(repeated);
    expect(root.workspaceId).toMatch(/^[a-f0-9]{64}$/u);
    expect(root).toMatchObject({
      rootAgentId: 'root:1',
      workspaceGeneration: 2,
      ownershipGeneration: 4,
    });
    expect(Object.isFrozen(root)).toBe(true);
  });

  it('mints the exact immutable authority from admission and host identity', () => {
    const authority = mintNativeWorkerAuthority({
      admission,
      sessionId: sessionId('session:1'),
      workerId: workerId('worker:1'),
      correlationId: correlationId('correlation:1'),
      capabilities,
      planStepId: 'step:1',
    });

    expect(authority).toEqual({
      schemaVersion: 1,
      workerId: 'worker:1',
      correlationId: 'correlation:1',
      rootAgentId: 'root:1',
      parentSessionId: 'session:1',
      workspaceId: 'workspace:1',
      workspaceGeneration: 2,
      trustRevision: 'trust:1',
      permissionMode: 'default',
      capabilityDigest: nativeWorkerCapabilityDigest(capabilities),
      effectAdmissionId: 'effect:worker:1',
      ownershipGeneration: 4,
    });
    expect(authority).not.toHaveProperty('planRevision');
    expect(authority).not.toHaveProperty('planStepId');
    expect(Object.isFrozen(authority)).toBe(true);
  });

  it('uses an order-independent canonical capability digest', () => {
    const reordered: WorkerCapabilities = {
      ...capabilities,
      tools: [...capabilities.tools].reverse(),
      octocodeTools: [...capabilities.octocodeTools!].reverse(),
      models: [...capabilities.models].reverse(),
    };
    expect(nativeWorkerCapabilityDigest(reordered)).toBe(
      nativeWorkerCapabilityDigest(capabilities),
    );
    expect(
      nativeWorkerCapabilityDigest({ ...capabilities, maxTurns: 9 }),
    ).not.toBe(nativeWorkerCapabilityDigest(capabilities));
  });

  it('fails closed without effect admission or a host-owned root', () => {
    const base = {
      sessionId: sessionId('session:1'),
      workerId: workerId('worker:1'),
      correlationId: correlationId('correlation:1'),
      capabilities,
    };
    expect(() =>
      mintNativeWorkerAuthority({ ...base, admission: undefined }),
    ).toThrow(/admission/i);
    expect(() =>
      mintNativeWorkerAuthority({
        ...base,
        admission: { ...admission, workerAuthorityRoot: undefined },
      }),
    ).toThrow(/root/i);
  });
});
