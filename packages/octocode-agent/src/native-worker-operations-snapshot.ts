import type { WorkerSnapshot, WorkerState } from '@octocodeai/agent-core';

const TERMINAL_STATES: ReadonlySet<WorkerState> = new Set(['succeeded', 'failed', 'aborted', 'killed']);

export type NativeWorkerInboxAction = 'inspect' | 'send' | 'follow-up' | 'steer' | 'abort';

export interface NativeWorkerInboxEntry {
  readonly workerId: string;
  readonly state: WorkerState;
  readonly queueDepth: number;
  readonly planStepId?: string;
  readonly taskLabel?: string;
  readonly workspaceMode?: 'shared' | 'worktree';
  readonly lifecyclePhase?: string;
  readonly changedFileCount?: number;
  readonly checks?: { readonly passed: number; readonly failed: number };
  readonly mailboxPressure?: 'normal' | 'high' | 'full';
  readonly retainedResourceCount?: number;
  readonly requiresAction?: boolean;
  readonly terminalOutcome?: 'succeeded' | 'failed' | 'aborted' | 'killed';
  readonly availableActions: readonly NativeWorkerInboxAction[];
  readonly forceKillAvailable: boolean;
}

export interface NativeWorkerInboxSnapshot {
  readonly authority: 'runtime';
  readonly generation: number;
  readonly capturedAt: number;
  readonly selectedWorkerId?: string;
  readonly workers: readonly NativeWorkerInboxEntry[];
}

export interface NativeWorkerPresentationMetadata {
  readonly planStepId?: string;
  readonly taskLabel?: string;
  readonly workspaceMode?: 'shared' | 'worktree';
  readonly lifecyclePhase?: string;
  readonly changedFileCount?: number;
  readonly checks?: { readonly passed: number; readonly failed: number };
  readonly mailboxPressure?: 'normal' | 'high' | 'full';
  readonly retainedResourceCount?: number;
  readonly requiresAction?: boolean;
}

function boundedCount(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && value! >= 0 ? value : undefined;
}

function boundedPhase(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= 64 && !value.includes('\0') ? value : undefined;
}

function availableActions(state: WorkerState): readonly NativeWorkerInboxAction[] {
  if (TERMINAL_STATES.has(state) || state === 'aborting' || state === 'killing') {
    return Object.freeze(['inspect'] as const);
  }
  return Object.freeze(['inspect', 'send', 'follow-up', 'steer', 'abort'] as const);
}

/** Strict allowlist projection: private routing, capability, prompt, process, and handback data cannot cross it. */
export function projectNativeWorkerInboxEntry(
  value: WorkerSnapshot,
  presentation?: NativeWorkerPresentationMetadata,
): NativeWorkerInboxEntry {
  const terminalOutcome = TERMINAL_STATES.has(value.state)
    ? value.state as 'succeeded' | 'failed' | 'aborted' | 'killed'
    : undefined;
  const changedFileCount = boundedCount(presentation?.changedFileCount);
  const retainedResourceCount = boundedCount(presentation?.retainedResourceCount);
  const passed = boundedCount(presentation?.checks?.passed);
  const failed = boundedCount(presentation?.checks?.failed);
  const lifecyclePhase = boundedPhase(presentation?.lifecyclePhase);
  return Object.freeze({
    workerId: String(value.workerId),
    state: value.state,
    queueDepth: value.queueDepth,
    ...(presentation?.planStepId === undefined ? {} : { planStepId: presentation.planStepId }),
    ...(presentation?.taskLabel === undefined ? {} : { taskLabel: presentation.taskLabel }),
    ...(presentation?.workspaceMode === undefined ? {} : { workspaceMode: presentation.workspaceMode }),
    ...(lifecyclePhase === undefined ? {} : { lifecyclePhase }),
    ...(changedFileCount === undefined ? {} : { changedFileCount }),
    ...(passed === undefined || failed === undefined ? {} : { checks: Object.freeze({ passed, failed }) }),
    ...(presentation?.mailboxPressure === undefined ? {} : { mailboxPressure: presentation.mailboxPressure }),
    ...(retainedResourceCount === undefined ? {} : { retainedResourceCount }),
    ...(presentation?.requiresAction === undefined ? {} : { requiresAction: presentation.requiresAction }),
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
    availableActions: availableActions(value.state),
    forceKillAvailable: !TERMINAL_STATES.has(value.state),
  });
}
