import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  RuntimeFailure,
  type CorrelationId,
  type SessionId,
  type ToolAdmissionContextV1,
  type WorkerAuthorityV1,
  type WorkerAuthorityRootV1,
  type WorkerCapabilities,
  type WorkerId,
} from '@octocodeai/agent-core';

const execFileAsync = promisify(execFile);

type AdmittedWorkerContext = ToolAdmissionContextV1 & {
  readonly workerAuthorityRoot: NonNullable<
    ToolAdmissionContextV1['workerAuthorityRoot']
  >;
};

const validString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const validGeneration = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

async function defaultGitCommonDir(
  workspaceRoot: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: workspaceRoot, timeout: 5_000, maxBuffer: 16_384 },
    );
    const commonDir = stdout.trim();
    return commonDir.length === 0 ? undefined : await realpath(commonDir);
  } catch {
    return undefined;
  }
}

export async function createNativeWorkerAuthorityRoot(input: {
  readonly rootAgentId: string;
  readonly workspaceRoot: string;
  readonly workspaceGeneration: number;
  readonly ownershipGeneration: number;
  readonly canonicalizePath?: (path: string) => Promise<string>;
  readonly resolveGitCommonDir?: (
    workspaceRoot: string,
  ) => Promise<string | undefined>;
}): Promise<WorkerAuthorityRootV1> {
  if (
    !validString(input.rootAgentId) ||
    !validString(input.workspaceRoot) ||
    !validGeneration(input.workspaceGeneration) ||
    !validGeneration(input.ownershipGeneration)
  )
    throw new RuntimeFailure(
      'validation',
      'Worker authority root identity is invalid',
    );
  const canonicalize = input.canonicalizePath ?? realpath;
  const workspaceRoot = await canonicalize(input.workspaceRoot);
  const discovered = await (
    input.resolveGitCommonDir ?? defaultGitCommonDir
  )(workspaceRoot);
  const gitCommonDir =
    discovered === undefined ? undefined : await canonicalize(discovered);
  const workspaceId = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        workspaceRoot,
        gitCommonDir: gitCommonDir ?? null,
      }),
    )
    .digest('hex');
  return Object.freeze({
    rootAgentId: input.rootAgentId,
    workspaceId,
    workspaceGeneration: input.workspaceGeneration,
    ownershipGeneration: input.ownershipGeneration,
  });
}

export function requireNativeWorkerAdmission(
  admission: ToolAdmissionContextV1 | undefined,
): AdmittedWorkerContext {
  if (
    admission?.schemaVersion !== 1 ||
    !validString(admission.effectAdmissionId) ||
    !validString(admission.receiptDigest) ||
    !validString(admission.trustRevision) ||
    !validGeneration(admission.policyRevision) ||
    !validGeneration(admission.planRevision)
  )
    throw new RuntimeFailure(
      'approval',
      'Worker authority requires a valid effect admission',
    );
  const root = admission.workerAuthorityRoot;
  if (
    root === undefined ||
    !validString(root.rootAgentId) ||
    !validString(root.workspaceId) ||
    !validGeneration(root.workspaceGeneration) ||
    !validGeneration(root.ownershipGeneration)
  )
    throw new RuntimeFailure(
      'approval',
      'Worker authority requires a host-owned root',
    );
  return admission as AdmittedWorkerContext;
}

export function nativeWorkerCapabilityDigest(
  capabilities: WorkerCapabilities,
): string {
  const canonical = JSON.stringify({
    schemaVersion: 1,
    tools: [...new Set(capabilities.tools)].sort(),
    octocodeTools: [...new Set(capabilities.octocodeTools ?? [])].sort(),
    models: [...capabilities.models]
      .map(({ providerId, modelId }) => ({ providerId, modelId }))
      .sort((left, right) =>
        `${left.providerId}\0${left.modelId}`.localeCompare(
          `${right.providerId}\0${right.modelId}`,
        ),
      ),
    maxTurns: capabilities.maxTurns,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function mintNativeWorkerAuthority(input: {
  readonly admission: ToolAdmissionContextV1 | undefined;
  readonly sessionId: SessionId;
  readonly workerId: WorkerId;
  readonly correlationId: CorrelationId;
  readonly capabilities: WorkerCapabilities;
  readonly planStepId?: string;
}): WorkerAuthorityV1 {
  const admission = requireNativeWorkerAdmission(input.admission);
  const root = admission.workerAuthorityRoot;
  return Object.freeze({
    schemaVersion: 1,
    workerId: input.workerId,
    correlationId: input.correlationId,
    rootAgentId: root.rootAgentId,
    parentSessionId: input.sessionId,
    workspaceId: root.workspaceId,
    workspaceGeneration: root.workspaceGeneration,
    trustRevision: admission.trustRevision,
    permissionMode: admission.permissionMode,
    capabilityDigest: nativeWorkerCapabilityDigest(input.capabilities),
    // Optional plan fields are an all-or-nothing identity group. The runtime
    // admission receipt does not yet expose a durable planId, so emitting an
    // orphan revision or step would be both ambiguous and rejected by Rust.
    effectAdmissionId: admission.effectAdmissionId,
    ownershipGeneration: root.ownershipGeneration,
  });
}

export function assertNativeWorkerAuthorityContext(
  authority: WorkerAuthorityV1,
  admission: ToolAdmissionContextV1 | undefined,
  activeSessionId: SessionId,
): void {
  const current = requireNativeWorkerAdmission(admission);
  const root = current.workerAuthorityRoot;
  if (
    authority.parentSessionId !== activeSessionId ||
    authority.rootAgentId !== root.rootAgentId ||
    authority.workspaceId !== root.workspaceId ||
    authority.workspaceGeneration !== root.workspaceGeneration ||
    authority.ownershipGeneration !== root.ownershipGeneration ||
    authority.trustRevision !== current.trustRevision ||
    authority.permissionMode !== current.permissionMode
  )
    throw new RuntimeFailure(
      'conflict',
      'Worker authority is stale for the active execution context',
    );
}
