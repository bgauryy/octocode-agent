import {
  correlationId,
  sessionId,
  workerId,
  type CorrelationId,
  type SessionId,
  type WorkerAuthorityV1,
  type WorkerId,
} from '@octocodeai/agent-core';

export interface WorkerAuthorityFixtureIdentity {
  readonly workerId?: WorkerId;
  readonly correlationId?: CorrelationId;
  readonly sessionId?: SessionId;
}

export function workerAuthorityFixture(
  identity: WorkerAuthorityFixtureIdentity = {},
  overrides: Partial<WorkerAuthorityV1> = {},
): WorkerAuthorityV1 {
  const resolvedWorkerId = identity.workerId ?? workerId('worker-fixture');
  const resolvedCorrelationId = identity.correlationId ?? correlationId('correlation-fixture');
  const resolvedSessionId = identity.sessionId ?? sessionId('session-fixture');
  return Object.freeze({
    schemaVersion: 1,
    workerId: resolvedWorkerId,
    correlationId: resolvedCorrelationId,
    rootAgentId: 'root-fixture',
    parentSessionId: resolvedSessionId,
    workspaceId: 'workspace-fixture',
    workspaceGeneration: 1,
    trustRevision: 'trust-fixture',
    permissionMode: 'default',
    capabilityDigest: 'capabilities-fixture',
    effectAdmissionId: 'effect-fixture',
    ownershipGeneration: 1,
    ...overrides,
  });
}
