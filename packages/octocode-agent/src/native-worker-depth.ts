import { RuntimeFailure } from '@octocodeai/agent-core';

const DEFAULT_MAX_DEPTH = 1;
const HARD_MAX_DEPTH = 1;
const WORKER_TOOL = 'worker';

export interface NativeWorkerDepthPolicy {
  readonly depth: number;
  readonly maxDepth: number;
  readonly canSpawn: boolean;
  readonly childCanSpawn: boolean;
  readonly maxActive: number;
}

function integer(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === '') return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RuntimeFailure('validation', `${label} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RuntimeFailure('validation', `${label} is out of range`);
  return parsed;
}

export function resolveNativeWorkerDepthPolicy(env: NodeJS.ProcessEnv): NativeWorkerDepthPolicy {
  const legacyChild = env.OCTOCODE_NATIVE_WORKER === '1';
  const depth = integer(env.OCTOCODE_NATIVE_WORKER_DEPTH, legacyChild ? 1 : 0, 'Native worker depth');
  if (legacyChild && depth !== 1) {
    throw new RuntimeFailure('validation', 'Native worker child marker requires depth 1');
  }
  const maxDepth = integer(
    env.OCTOCODE_NATIVE_WORKER_MAX_DEPTH,
    legacyChild && env.OCTOCODE_NATIVE_WORKER_DEPTH === undefined ? 1 : DEFAULT_MAX_DEPTH,
    'Native worker maximum depth',
  );
  if (maxDepth < 1 || maxDepth > HARD_MAX_DEPTH) {
    throw new RuntimeFailure('validation', `Native worker maximum depth must be between 1 and ${HARD_MAX_DEPTH}`);
  }
  if (depth > maxDepth) throw new RuntimeFailure('validation', 'Native worker depth cannot exceed its maximum');
  return Object.freeze({
    depth,
    maxDepth,
    canSpawn: depth < maxDepth,
    childCanSpawn: depth + 1 < maxDepth,
    maxActive: depth >= maxDepth ? 0 : Math.max(1, 4 >> depth),
  });
}

/** Capabilities delegated to the next process generation. */
export function workerCapabilityTools(
  tools: readonly string[],
  policy: NativeWorkerDepthPolicy,
): readonly string[] {
  const delegated = tools.filter((name) => name !== WORKER_TOOL);
  if (policy.childCanSpawn) delegated.push(WORKER_TOOL);
  return Object.freeze(delegated);
}
