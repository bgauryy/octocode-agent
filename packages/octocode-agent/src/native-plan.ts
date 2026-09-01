import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createEffectSet,
  LiveRuntimePlanState,
  type RuntimePlanPolicySnapshot,
  type RuntimePlanStateProvider,
  type RuntimePlanStateUpdater,
  type ToolExecutionInput,
  type ToolResult,
  type ToolRegistry,
} from '@octocodeai/agent-core';
import { ensurePrivateDirectory, hardenPrivateFile } from './private-fs.js';
import type { NativeRustWorkDagStore } from './native-rust-work-dag.js';
import type {
  NativeWorkerDagPlanClaim,
  NativeWorkerDagPlanPort,
  NativeWorkerDagSchedule,
} from './native-worker-dag-scheduler.js';

const PLAN_LOCK_ATTEMPTS = 100;
const PLAN_LOCK_RETRY_MS = 5;
const PLAN_LOCK_STALE_MS = 30_000;

export type NativePlanAction =
  | 'set' | 'propose' | 'clarify' | 'add' | 'start' | 'complete' | 'remove' | 'clear' | 'show'
  | 'edit' | 'reorder' | 'dependency' | 'reopen'
  | 'approve' | 'reject' | 'change-request' | 'review';
export type NativePlanPhase = 'empty' | 'draft' | 'approved' | 'active' | 'complete';
export type NativePlanStepStatus = 'todo' | 'doing' | 'done';

export interface PlanScope {
  readonly sessionId: string;
  readonly workspace: string;
}

export interface PlanVerificationReceipt {
  readonly command: string;
  readonly status: 'SUCCESS' | 'FAILED';
  readonly message: string;
}

export interface NativePlanStep {
  readonly id: string;
  readonly text: string;
  readonly status: NativePlanStepStatus;
  readonly activeForm?: string;
  readonly dependsOn?: readonly number[];
  readonly checkCommand?: string;
  readonly receipt?: PlanVerificationReceipt;
  /** Native worker holding this step. Presence never implies verification or completion. */
  readonly workerId?: string;
}

export interface NativePlanDecision {
  readonly question: string;
  readonly answer: string;
}

export interface NativePlanSnapshot {
  readonly version: 1;
  readonly scope: PlanScope;
  readonly revision: number;
  readonly phase: NativePlanPhase;
  readonly steps: readonly NativePlanStep[];
  readonly decisions: readonly NativePlanDecision[];
}

export type NativePlanReviewIntent =
  | {
      readonly type: 'edit';
      readonly stepId: string;
      readonly text?: string;
      readonly activeForm?: string | null;
      readonly checkCommand?: string | null;
    }
  | { readonly type: 'reorder'; readonly stepIds: readonly string[] }
  | { readonly type: 'dependency'; readonly stepId: string; readonly dependsOnStepIds: readonly string[] }
  | { readonly type: 'reopen'; readonly stepId: string };

export type NativePlanOperationIntent =
  | (NativePlanReviewIntent & { readonly expectedRevision: number })
  | { readonly type: 'approve'; readonly expectedRevision: number }
  | { readonly type: 'reject' | 'change-request'; readonly expectedRevision: number; readonly feedback?: string }
  | { readonly type: 'review'; readonly expectedRevision: number; readonly intents: readonly NativePlanReviewIntent[] };

export type NativePlanReviewDiff =
  | {
      readonly type: 'step-edited';
      readonly stepId: string;
      readonly before: Pick<NativePlanStep, 'text' | 'activeForm' | 'checkCommand' | 'status'>;
      readonly after: Pick<NativePlanStep, 'text' | 'activeForm' | 'checkCommand' | 'status'>;
      readonly invalidatedStepIds: readonly string[];
    }
  | { readonly type: 'steps-reordered'; readonly beforeStepIds: readonly string[]; readonly afterStepIds: readonly string[] }
  | {
      readonly type: 'dependencies-changed';
      readonly stepId: string;
      readonly beforeStepIds: readonly string[];
      readonly afterStepIds: readonly string[];
      readonly invalidatedStepIds: readonly string[];
    }
  | {
      readonly type: 'step-reopened';
      readonly stepId: string;
      readonly beforeStatus: NativePlanStepStatus;
      readonly afterStatus: 'todo';
      readonly invalidatedStepIds: readonly string[];
    };

/** Read-only projection consumed by runtime presentation ports. */
export interface RuntimePlanSnapshot {
  readonly authority: 'runtime';
  readonly planId: string;
  readonly scope: PlanScope;
  readonly revision: number;
  readonly phase: NativePlanPhase;
  readonly steps: readonly {
    readonly id: string;
    readonly text: string;
    readonly status: NativePlanStepStatus;
    readonly activeForm?: string;
    readonly dependsOn?: readonly string[];
    readonly checkCommand?: string;
    readonly receipt?: PlanVerificationReceipt & { readonly authority: 'runtime' };
    readonly workerId?: string;
  }[];
}

export type RuntimePlanSnapshotSink = (snapshot: RuntimePlanSnapshot) => void;

/** Durable implementations must check the signal immediately before committing. */
export interface PlanStore {
  load(scope: PlanScope, signal?: AbortSignal): Promise<NativePlanSnapshot | undefined>;
  save(scope: PlanScope, expectedRevision: number, snapshot: NativePlanSnapshot, signal?: AbortSignal): Promise<void>;
}

export interface NativePlanWorkerOwnershipRequest {
  readonly scope: PlanScope;
  readonly planStepId: string;
  readonly workerId: string;
  readonly signal?: AbortSignal;
}

export interface NativePlanWorkerOwnershipResult {
  readonly planStepId: string;
  readonly workerId: string;
  readonly status: 'active' | 'released';
}

export interface NativePlanWorkerOwnershipPort {
  claim(request: NativePlanWorkerOwnershipRequest): Promise<NativePlanWorkerOwnershipResult>;
  release(request: NativePlanWorkerOwnershipRequest): Promise<NativePlanWorkerOwnershipResult>;
}

export interface NativePlanInteractionRequest {
  readonly action: 'propose' | 'clarify';
  readonly scope: PlanScope;
  readonly plan: NativePlanSnapshot;
  readonly questions?: readonly { readonly prompt: string }[];
}

export type NativePlanInteractionOutcome =
  | { readonly status: 'approved' }
  | { readonly status: 'rejected'; readonly reason?: string }
  | { readonly status: 'changes-requested'; readonly reason?: string }
  | { readonly status: 'pending'; readonly correlationId?: string }
  | { readonly status: 'answered'; readonly answers: readonly string[] };

export type NativePlanInteraction = (
  request: NativePlanInteractionRequest,
  signal: AbortSignal,
) => Promise<NativePlanInteractionOutcome>;

export interface NativePlanVerificationRequest {
  readonly scope: PlanScope;
  readonly command: string;
  readonly step: NativePlanStep;
  readonly plan: NativePlanSnapshot;
}

/** Host-owned verification boundary. The plan tool never executes check commands itself. */
export type NativePlanVerifier = (
  request: NativePlanVerificationRequest,
  signal: AbortSignal,
) => Promise<PlanVerificationReceipt>;

export interface NativePlanOptions {
  readonly store?: PlanStore;
  readonly interact?: NativePlanInteraction;
  /** Runs a configured check outside model-controlled plan input. */
  readonly verify?: NativePlanVerifier;
  /** Runtime policy state synchronized from the same committed revision as presentation. */
  readonly planState?: RuntimePlanStateUpdater;
  /** Observational only: sink failures never alter a committed plan operation. */
  readonly onSnapshot?: RuntimePlanSnapshotSink;
}

class PlanOperationError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

function scopeKey(scope: PlanScope): string {
  return `${scope.sessionId}\0${scope.workspace}`;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PlanOperationError('cancelled', 'Plan operation cancelled');
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function immutable(snapshot: NativePlanSnapshot): NativePlanSnapshot {
  return freeze(structuredClone(snapshot));
}

export function projectRuntimePlanSnapshot(snapshot: NativePlanSnapshot): RuntimePlanSnapshot {
  const stepIds = snapshot.steps.map((step) => step.id);
  return freeze({
    authority: 'runtime' as const,
    planId: `plan:${createHash('sha256').update(scopeKey(snapshot.scope)).digest('hex')}`,
    scope: { ...snapshot.scope },
    revision: snapshot.revision,
    phase: snapshot.phase,
    steps: snapshot.steps.map((step) => ({
      id: step.id,
      text: step.text,
      status: step.status,
      ...(step.activeForm === undefined ? {} : { activeForm: step.activeForm }),
      ...(step.dependsOn === undefined ? {} : { dependsOn: step.dependsOn.map((dependency) => stepIds[dependency - 1]!) }),
      ...(step.checkCommand === undefined ? {} : { checkCommand: step.checkCommand }),
      ...(step.receipt === undefined ? {} : { receipt: { authority: 'runtime' as const, ...step.receipt } }),
      ...(step.workerId === undefined ? {} : { workerId: step.workerId }),
    })),
  });
}

function emptyPlan(scope: PlanScope): NativePlanSnapshot {
  return immutable({ version: 1, scope: { ...scope }, revision: 0, phase: 'empty', steps: [], decisions: [] });
}

function assertClosed(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new PlanOperationError('invalid-plan', `${label} has unsupported field ${unexpected[0]}`);
}

function storedRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlanOperationError('invalid-plan', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function storedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new PlanOperationError('invalid-plan', `${label} must be a canonical non-empty string`);
  }
  return value;
}

function parseStoredReceipt(value: unknown, command: string): PlanVerificationReceipt {
  const input = storedRecord(value, 'receipt');
  assertClosed(input, ['command', 'status', 'message'], 'receipt');
  if (input.status !== 'SUCCESS' && input.status !== 'FAILED') {
    throw new PlanOperationError('invalid-plan', 'receipt.status is invalid');
  }
  const receiptCommand = storedText(input.command, 'receipt.command');
  if (receiptCommand !== command) throw new PlanOperationError('invalid-plan', 'receipt.command does not match checkCommand');
  return { command: receiptCommand, status: input.status, message: storedText(input.message, 'receipt.message') };
}

function parseStoredPlan(value: unknown, scope: PlanScope): NativePlanSnapshot {
  const input = storedRecord(value, 'plan');
  assertClosed(input, ['version', 'scope', 'revision', 'phase', 'steps', 'decisions'], 'plan');
  const storedScope = storedRecord(input.scope, 'scope');
  assertClosed(storedScope, ['sessionId', 'workspace'], 'scope');
  if (input.version !== 1 || !Number.isInteger(input.revision) || (input.revision as number) < 0) {
    throw new PlanOperationError('invalid-plan', 'Stored plan version or revision is invalid');
  }
  if (storedScope.sessionId !== scope.sessionId || storedScope.workspace !== scope.workspace) {
    throw new PlanOperationError('invalid-plan', 'Stored plan scope does not match its storage key');
  }
  if (input.phase !== 'empty' && input.phase !== 'draft' && input.phase !== 'approved' && input.phase !== 'active' && input.phase !== 'complete') {
    throw new PlanOperationError('invalid-plan', 'Stored plan phase is invalid');
  }
  if (!Array.isArray(input.steps) || !Array.isArray(input.decisions)) {
    throw new PlanOperationError('invalid-plan', 'Stored plan steps and decisions must be arrays');
  }
  const rawSteps = input.steps;
  const rawDecisions = input.decisions;

  const steps: NativePlanStep[] = rawSteps.map((value, position) => {
    const step = storedRecord(value, `step ${position + 1}`);
    assertClosed(step, ['id', 'text', 'status', 'activeForm', 'dependsOn', 'checkCommand', 'receipt', 'workerId'], `step ${position + 1}`);
    if (step.status !== 'todo' && step.status !== 'doing' && step.status !== 'done') {
      throw new PlanOperationError('invalid-plan', `step ${position + 1}.status is invalid`);
    }
    const checkCommand = step.checkCommand === undefined ? undefined : storedText(step.checkCommand, `step ${position + 1}.checkCommand`);
    let dependsOn: readonly number[] | undefined;
    try { dependsOn = dependencies(step.dependsOn, rawSteps.length, position + 1); }
    catch { throw new PlanOperationError('invalid-plan', `step ${position + 1}.dependsOn is invalid`); }
    let parsedReceipt: PlanVerificationReceipt | undefined;
    if (step.receipt !== undefined) {
      if (checkCommand === undefined) throw new PlanOperationError('invalid-plan', `step ${position + 1} has a receipt without checkCommand`);
      parsedReceipt = parseStoredReceipt(step.receipt, checkCommand);
    }
    if (step.status === 'todo' && parsedReceipt !== undefined) {
      throw new PlanOperationError('invalid-plan', `step ${position + 1} has a receipt before execution`);
    }
    if (step.status === 'doing' && parsedReceipt?.status === 'SUCCESS') {
      throw new PlanOperationError('invalid-plan', `step ${position + 1} has a successful receipt but is not done`);
    }
    if (step.status === 'done' && checkCommand !== undefined && parsedReceipt?.status !== 'SUCCESS') {
      throw new PlanOperationError('invalid-plan', `step ${position + 1} lacks successful verification`);
    }
    const owningWorkerId = step.workerId === undefined ? undefined : storedText(step.workerId, `step ${position + 1}.workerId`);
    if (owningWorkerId !== undefined && step.status !== 'doing') {
      throw new PlanOperationError('invalid-plan', `step ${position + 1} has worker ownership while not active`);
    }
    return {
      id: storedText(step.id, `step ${position + 1}.id`),
      text: storedText(step.text, `step ${position + 1}.text`),
      status: step.status,
      ...(step.activeForm === undefined ? {} : { activeForm: storedText(step.activeForm, `step ${position + 1}.activeForm`) }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
      ...(checkCommand === undefined ? {} : { checkCommand }),
      ...(parsedReceipt === undefined ? {} : { receipt: parsedReceipt }),
      ...(owningWorkerId === undefined ? {} : { workerId: owningWorkerId }),
    };
  });
  if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new PlanOperationError('invalid-plan', 'Stored plan step IDs must be unique');
  if (steps.filter((step) => step.status === 'doing').length > 4) throw new PlanOperationError('invalid-plan', 'Stored plan exceeds four concurrent active steps');
  try { validateGraph(steps); } catch { throw new PlanOperationError('invalid-plan', 'Stored plan dependency graph is invalid'); }
  for (const [position, step] of steps.entries()) {
    if ((step.dependsOn ?? []).some((dependency) => steps[dependency - 1]?.status !== 'done') && step.status !== 'todo') {
      throw new PlanOperationError('invalid-plan', `step ${position + 1} ran before its dependencies completed`);
    }
  }
  if (input.phase === 'empty' ? steps.length !== 0 : steps.length === 0) throw new PlanOperationError('invalid-plan', 'Stored plan phase does not match its steps');
  if (input.phase === 'complete' && !steps.every((step) => step.status === 'done')) throw new PlanOperationError('invalid-plan', 'Complete plan contains unfinished steps');
  if (input.phase === 'active' && steps.every((step) => step.status === 'done')) throw new PlanOperationError('invalid-plan', 'Active plan contains only completed steps');

  const decisions: NativePlanDecision[] = rawDecisions.map((value, position) => {
    const decision = storedRecord(value, `decision ${position + 1}`);
    assertClosed(decision, ['question', 'answer'], `decision ${position + 1}`);
    return { question: storedText(decision.question, `decision ${position + 1}.question`), answer: storedText(decision.answer, `decision ${position + 1}.answer`) };
  });
  if (input.phase === 'empty' && decisions.length > 0) throw new PlanOperationError('invalid-plan', 'Empty plan must not contain decisions');
  return immutable({ version: 1, scope: { ...scope }, revision: input.revision as number, phase: input.phase, steps, decisions });
}

export class InMemoryPlanStore implements PlanStore {
  readonly #plans = new Map<string, NativePlanSnapshot>();

  async load(scope: PlanScope, signal?: AbortSignal): Promise<NativePlanSnapshot | undefined> {
    abortIfNeeded(signal);
    const snapshot = this.#plans.get(scopeKey(scope));
    return snapshot === undefined ? undefined : immutable(snapshot);
  }

  async save(scope: PlanScope, expectedRevision: number, snapshot: NativePlanSnapshot, signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    const key = scopeKey(scope);
    const currentRevision = this.#plans.get(key)?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new PlanOperationError('plan-conflict', `Expected plan revision ${expectedRevision}, current ${currentRevision}`);
    }
    if (snapshot.scope.sessionId !== scope.sessionId || snapshot.scope.workspace !== scope.workspace) {
      throw new PlanOperationError('invalid-scope', 'Plan snapshot scope does not match its storage key');
    }
    abortIfNeeded(signal);
    this.#plans.set(key, immutable(snapshot));
  }
}

/** Durable CAS bridge between native worker lifecycle and native plan steps. */
export class NativePlanWorkerOwnership implements NativePlanWorkerOwnershipPort, NativeWorkerDagPlanPort {
  constructor(
    readonly store: PlanStore,
    /** Durable scheduling mechanism; worker execution remains policy-owned by the caller. */
    readonly dependencyWork?: Pick<NativeRustWorkDagStore, 'getGraph'>,
  ) {}

  async claim(request: NativePlanWorkerOwnershipRequest): Promise<NativePlanWorkerOwnershipResult> {
    abortIfNeeded(request.signal);
    const current = await this.store.load(request.scope, request.signal);
    if (current === undefined || current.phase !== 'active') throw new PlanOperationError('inactive-plan', 'Worker ownership requires an active plan');
    const selected = current.steps.findIndex((step) => step.id === request.planStepId);
    if (selected < 0) throw new PlanOperationError('invalid-target', `Plan step ${request.planStepId} was not found`);
    const target = current.steps[selected]!;
    if (target.status !== 'todo') throw new PlanOperationError('active-step-exists', `Plan step ${request.planStepId} is already active or complete`);
    if (current.steps.filter((step) => step.status === 'doing').length >= 4) {
      throw new PlanOperationError('active-step-limit', 'At most four plan steps may be active concurrently');
    }
    if (!(target.dependsOn ?? []).every((dependency) => current.steps[dependency - 1]?.status === 'done')) {
      throw new PlanOperationError('blocked-step', `Plan step ${request.planStepId} is blocked by dependencies`);
    }
    const worker = storedText(request.workerId, 'workerId');
    const steps = current.steps.map((step, position) => position === selected ? { ...step, status: 'doing' as const, workerId: worker } : step);
    await this.store.save(request.scope, current.revision, immutable({ ...current, revision: current.revision + 1, steps }), request.signal);
    return freeze({ planStepId: request.planStepId, workerId: worker, status: 'active' as const });
  }

  async release(request: NativePlanWorkerOwnershipRequest): Promise<NativePlanWorkerOwnershipResult> {
    abortIfNeeded(request.signal);
    const current = await this.store.load(request.scope, request.signal);
    if (current === undefined) throw new PlanOperationError('inactive-plan', 'Worker ownership requires an existing plan');
    const selected = current.steps.findIndex((step) => step.id === request.planStepId);
    if (selected < 0) throw new PlanOperationError('invalid-target', `Plan step ${request.planStepId} was not found`);
    const target = current.steps[selected]!;
    if (target.workerId !== request.workerId) throw new PlanOperationError('ownership-mismatch', `Plan step ${request.planStepId} is not owned by worker ${request.workerId}`);
    const steps = current.steps.map((step, position) => {
      if (position !== selected) return step;
      const { workerId: _workerId, receipt: previousReceipt, ...unowned } = step;
      return { ...unowned, status: 'todo' as const, ...(previousReceipt?.status === 'FAILED' ? { receipt: previousReceipt } : {}) };
    });
    await this.store.save(request.scope, current.revision, immutable({ ...current, revision: current.revision + 1, phase: 'active', steps }), request.signal);
    return freeze({ planStepId: request.planStepId, workerId: request.workerId, status: 'released' as const });
  }

  async prepare(scope: PlanScope, signal: AbortSignal): Promise<NativeWorkerDagSchedule> {
    abortIfNeeded(signal);
    const current = await this.store.load(scope, signal);
    if (current === undefined || current.phase !== 'active') {
      throw new PlanOperationError('inactive-plan', 'Worker dependency scheduling requires an active plan');
    }
    if (this.dependencyWork === undefined) {
      throw new PlanOperationError('unsupported-capability', 'Durable worker dependency scheduling is unavailable');
    }
    if (current.steps.length > 32) {
      throw new PlanOperationError('invalid-plan', 'Worker dependency schedules support at most 32 steps');
    }
    if (current.steps.some((step) => step.checkCommand !== undefined)) {
      throw new PlanOperationError('verification-required', 'Worker dependency scheduling cannot bypass host verification checks');
    }
    if (current.steps.some((step) => step.status === 'doing' && step.workerId === undefined)) {
      throw new PlanOperationError('active-step-exists', 'A manually started plan step must finish before dependency scheduling');
    }
    const unfinishedIds = new Set(
      current.steps
        .filter((step) => step.status !== 'done')
        .map((step) => step.id),
    );
    const definition = current.steps.flatMap((step, position) =>
      step.status === 'done'
        ? []
        : [{
            itemId: step.id,
            prompt: step.text,
            dependsOn: (step.dependsOn ?? [])
              .map((dependency) => current.steps[dependency - 1]!.id)
              .filter((dependency) => unfinishedIds.has(dependency)),
            ordinal: position,
          }],
    );
    const graphId = `plan:${createHash('sha256')
      .update(JSON.stringify({ scope, definition }))
      .digest('hex')}`;
    return freeze({
      graphId,
      scope: { ...scope },
      steps: definition.map(({ ordinal: _ordinal, ...step }) => step),
    });
  }

  async claimItem(request: NativeWorkerDagPlanClaim): Promise<void> {
    abortIfNeeded(request.signal);
    if (this.dependencyWork === undefined) {
      throw new PlanOperationError('unsupported-capability', 'Durable worker dependency scheduling is unavailable');
    }
    const [current, graph] = await Promise.all([
      this.store.load(request.scope, request.signal),
      this.dependencyWork.getGraph(request.graphId),
    ]);
    if (current === undefined || current.phase !== 'active' || graph === null) {
      throw new PlanOperationError('inactive-plan', 'Worker dependency schedule is unavailable');
    }
    const durable = graph.items.find((item) => item.itemId === request.itemId);
    if (
      durable?.state !== 'claimed' ||
      durable.ownerId !== request.workerId ||
      durable.fencingToken !== request.fencingToken
    ) {
      throw new PlanOperationError('ownership-mismatch', 'Rust work claim does not match the worker packet binding');
    }
    const selected = current.steps.findIndex((step) => step.id === request.itemId);
    if (selected < 0) throw new PlanOperationError('invalid-target', `Plan step ${request.itemId} was not found`);
    const target = current.steps[selected]!;
    if (target.status === 'done') throw new PlanOperationError('invalid-target', `Plan step ${request.itemId} is complete`);
    if (!(target.dependsOn ?? []).every((dependency) => current.steps[dependency - 1]?.status === 'done')) {
      throw new PlanOperationError('blocked-step', `Plan step ${request.itemId} is blocked by dependencies`);
    }
    if (target.status === 'doing' && target.workerId === request.workerId) return;
    if (target.status === 'doing' && target.workerId === undefined) {
      throw new PlanOperationError('active-step-exists', `Plan step ${request.itemId} is active without worker ownership`);
    }
    if (current.steps.filter((step) => step.status === 'doing').length >= 4) {
      throw new PlanOperationError('active-step-limit', 'At most four plan steps may be active concurrently');
    }
    const steps = current.steps.map((step, position) =>
      position === selected ? { ...step, status: 'doing' as const, workerId: request.workerId } : step,
    );
    await this.store.save(
      request.scope,
      current.revision,
      immutable({ ...current, revision: current.revision + 1, phase: 'active', steps }),
      request.signal,
    );
  }

  async reconcile(request: {
    readonly schedule: NativeWorkerDagSchedule;
    readonly graph: import('./native-rust-core.js').NativeRustWorkGraph;
    readonly signal: AbortSignal;
  }): Promise<void> {
    abortIfNeeded(request.signal);
    const current = await this.store.load(request.schedule.scope, request.signal);
    if (current === undefined) throw new PlanOperationError('inactive-plan', 'Worker dependency plan is unavailable');
    if (
      request.graph.graphId !== request.schedule.graphId ||
      request.graph.items.length !== request.schedule.steps.length
    ) {
      throw new PlanOperationError('ownership-mismatch', 'Worker dependency graph does not match the active plan');
    }
    const scheduledIds = new Set(request.schedule.steps.map((step) => step.itemId));
    if (
      scheduledIds.size !== request.schedule.steps.length ||
      request.schedule.steps.some((step) => !current.steps.some((candidate) => candidate.id === step.itemId)) ||
      current.steps.some((step) => step.status !== 'done' && !scheduledIds.has(step.id))
    ) {
      throw new PlanOperationError('ownership-mismatch', 'Worker dependency schedule does not match unfinished plan steps');
    }
    const byId = new Map(request.graph.items.map((item) => [item.itemId, item] as const));
    const steps = current.steps.map((step) => {
      const item = byId.get(step.id);
      if (item === undefined) {
        if (step.status !== 'done') throw new PlanOperationError('ownership-mismatch', `Missing work item ${step.id}`);
        return step;
      }
      if (item.state === 'succeeded') {
        const { workerId: _workerId, ...unowned } = step;
        return { ...unowned, status: 'done' as const };
      }
      if (item.state === 'claimed') {
        if (item.ownerId === null) throw new PlanOperationError('ownership-mismatch', `Claimed work item ${step.id} lacks an owner`);
        return { ...step, status: 'doing' as const, workerId: item.ownerId };
      }
      const { workerId: _workerId, ...unowned } = step;
      return { ...unowned, status: 'todo' as const };
    });
    for (const [position, step] of steps.entries()) {
      if ((step.dependsOn ?? []).some((dependency) => steps[dependency - 1]?.status !== 'done') && step.status !== 'todo') {
        throw new PlanOperationError('invalid-plan', `Scheduled step ${position + 1} ran before its dependencies completed`);
      }
    }
    const phase = steps.every((step) => step.status === 'done') ? 'complete' as const : 'active' as const;
    if (JSON.stringify(steps) === JSON.stringify(current.steps) && phase === current.phase) return;
    await this.store.save(
      request.schedule.scope,
      current.revision,
      immutable({ ...current, revision: current.revision + 1, phase, steps }),
      request.signal,
    );
  }
}

export class FilePlanStore implements PlanStore {
  constructor(readonly directory: string) {}

  #file(scope: PlanScope): string {
    const digest = createHash('sha256').update(scopeKey(scope)).digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }

  #read(scope: PlanScope): NativePlanSnapshot | undefined {
    const file = this.#file(scope);
    if (!fs.existsSync(file)) return undefined;
    if (fs.lstatSync(file).isSymbolicLink()) throw new PlanOperationError('invalid-scope', 'Plan path must not be a symbolic link');
    try { return parseStoredPlan(JSON.parse(fs.readFileSync(file, 'utf8')), scope); }
    catch (error) {
      if (error instanceof PlanOperationError) throw error;
      throw new PlanOperationError('invalid-plan', 'Stored plan is invalid');
    }
  }

  async load(scope: PlanScope, signal?: AbortSignal): Promise<NativePlanSnapshot | undefined> {
    abortIfNeeded(signal);
    return this.#read(scope);
  }

  /** Synchronous policy read used at tool-admission time to observe peer-process commits. */
  loadCurrent(scope: PlanScope): NativePlanSnapshot | undefined { return this.#read(scope); }

  async save(scope: PlanScope, expectedRevision: number, snapshot: NativePlanSnapshot, signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    if (snapshot.scope.sessionId !== scope.sessionId || snapshot.scope.workspace !== scope.workspace) {
      throw new PlanOperationError('invalid-scope', 'Plan snapshot scope does not match its storage key');
    }
    const candidate = parseStoredPlan(snapshot, scope);
    ensurePrivateDirectory(this.directory);
    const file = this.#file(scope);
    const lock = `${file}.lock`;
    await acquirePlanLock(lock, signal);
    try {
      const currentRevision = this.#read(scope)?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw new PlanOperationError('plan-conflict', `Expected plan revision ${expectedRevision}, current ${currentRevision}`);
      }
      abortIfNeeded(signal);
      const temporary = path.join(this.directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
      const output = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(output, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
        fs.fsyncSync(output);
      } finally { fs.closeSync(output); }
      try {
        abortIfNeeded(signal);
        fs.renameSync(temporary, file);
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      hardenPrivateFile(file);
      syncPlanDirectory(this.directory);
    } finally {
      try { fs.unlinkSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

async function acquirePlanLock(lock: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < PLAN_LOCK_ATTEMPTS; attempt += 1) {
    abortIfNeeded(signal);
    try {
      const descriptor = fs.openSync(lock, 'wx', 0o600);
      let initialized = false;
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
        fs.fsyncSync(descriptor);
        initialized = true;
      } finally {
        fs.closeSync(descriptor);
        if (!initialized) try { fs.unlinkSync(lock); } catch { /* preserve initialization failure */ }
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = fs.lstatSync(lock);
        if (Date.now() - stat.mtimeMs > PLAN_LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw inspectionError;
      }
      if (attempt + 1 < PLAN_LOCK_ATTEMPTS) await new Promise<void>((resolve) => setTimeout(resolve, PLAN_LOCK_RETRY_MS));
    }
  }
  throw new PlanOperationError('plan-conflict', 'Plan is being modified; retry the operation');
}

function syncPlanDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EACCES', 'EINVAL', 'EPERM'].includes(code ?? '')) throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Keeps runtime plan policy synchronized with the canonical file on every admission check. */
export class FileBackedRuntimePlanState implements RuntimePlanStateProvider, RuntimePlanStateUpdater {
  readonly #fallback = new LiveRuntimePlanState();

  constructor(readonly store: FilePlanStore, readonly scope: PlanScope) {}

  snapshot(): RuntimePlanPolicySnapshot {
    const current = this.store.loadCurrent(this.scope);
    return current === undefined
      ? this.#fallback.snapshot()
      : Object.freeze({ authority: 'runtime', revision: current.revision, active: current.phase === 'active' });
  }

  update(value: RuntimePlanPolicySnapshot): void { this.#fallback.update(value); }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PlanOperationError('invalid-input', `${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new PlanOperationError('invalid-input', `${label} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function dependencies(value: unknown, stepCount: number, self: number): readonly number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new PlanOperationError('invalid-dependencies', 'dependsOn must be an array of 1-based indices');
  const output = [...new Set(value.map((entry) => {
    if (!Number.isInteger(entry) || (entry as number) < 1 || (entry as number) > stepCount || entry === self) {
      throw new PlanOperationError('invalid-dependencies', `Invalid dependency index ${String(entry)} for step ${self}`);
    }
    return entry as number;
  }))].sort((a, b) => a - b);
  return output.length === 0 ? undefined : output;
}

function parseStep(value: unknown, index: number, count: number, revision: number): NativePlanStep {
  const input = typeof value === 'string' ? { text: value } : record(value, `step ${index}`);
  const activeForm = optionalText(input.activeForm, `step ${index}.activeForm`);
  const dependsOn = dependencies(input.dependsOn, count, index);
  const checkCommand = optionalText(input.checkCommand, `step ${index}.checkCommand`);
  return {
    id: `step:${revision}:${index}`,
    text: text(input.text, `step ${index}.text`),
    status: 'todo',
    ...(activeForm === undefined ? {} : { activeForm }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(checkCommand === undefined ? {} : { checkCommand }),
  };
}

function validateGraph(steps: readonly NativePlanStep[]): void {
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (index: number): void => {
    if (visiting.has(index)) throw new PlanOperationError('invalid-dependencies', 'Plan dependencies contain a cycle');
    if (visited.has(index)) return;
    visiting.add(index);
    for (const dependency of steps[index - 1]?.dependsOn ?? []) visit(dependency);
    visiting.delete(index);
    visited.add(index);
  };
  for (let index = 1; index <= steps.length; index += 1) visit(index);
}

function parseSteps(value: unknown, revision: number): readonly NativePlanStep[] {
  if (!Array.isArray(value) || value.length === 0) throw new PlanOperationError('invalid-input', 'steps must be a non-empty array');
  const steps = value.map((step, index) => parseStep(step, index + 1, value.length, revision));
  validateGraph(steps);
  return steps;
}

function requestedIndex(value: unknown, action: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new PlanOperationError('invalid-index', `${action} index must be a positive integer`);
  return value as number;
}

function existingIndex(value: unknown, action: string, steps: readonly NativePlanStep[]): number | undefined {
  const index = requestedIndex(value, action);
  if (index !== undefined && index > steps.length) throw new PlanOperationError('invalid-index', `${action} index ${index} exceeds ${steps.length} steps`);
  return index;
}

function receipt(value: unknown, expectedCommand: string): PlanVerificationReceipt {
  const input = record(value, 'receipt');
  const unexpected = Object.keys(input).filter((key) => !['command', 'status', 'message'].includes(key));
  if (unexpected.length > 0) throw new PlanOperationError('invalid-receipt', `receipt has unsupported field ${unexpected[0]}`);
  const command = text(input.command, 'receipt.command');
  const message = text(input.message, 'receipt.message');
  if (input.status !== 'SUCCESS' && input.status !== 'FAILED') throw new PlanOperationError('invalid-receipt', 'receipt.status must be SUCCESS or FAILED');
  if (command !== expectedCommand) throw new PlanOperationError('invalid-receipt', `receipt.command must match ${expectedCommand}`);
  return { command, status: input.status, message };
}

function questions(value: unknown): readonly { readonly prompt: string }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) throw new PlanOperationError('invalid-input', 'clarify requires 1-3 questions');
  return value.map((question, index) => ({ prompt: text(record(question, `question ${index + 1}`).prompt, `question ${index + 1}.prompt`) }));
}

function revisionPrecondition(value: unknown, current: number, action: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PlanOperationError('invalid-revision', `${action} expectedRevision must be a non-negative safe integer`);
  }
  if (value !== current) {
    throw new PlanOperationError('stale-revision', `${action} expected revision ${String(value)} but current revision is ${current}`);
  }
  return value as number;
}

function stableStepId(value: unknown, label = 'stepId'): string {
  const id = text(value, label);
  if (id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(id)) {
    throw new PlanOperationError('invalid-step-id', `${label} must be a stable plan step ID`);
  }
  return id;
}

function stableStepIds(value: unknown, label: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new PlanOperationError('invalid-step-id', `${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array of stable step IDs`);
  }
  const ids = value.map((entry, index) => stableStepId(entry, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new PlanOperationError('invalid-step-id', `${label} cannot contain duplicates`);
  return ids;
}

function stepPosition(steps: readonly NativePlanStep[], stepId: string): number {
  const position = steps.findIndex((step) => step.id === stepId);
  if (position < 0) throw new PlanOperationError('invalid-target', `Plan step ${stepId} was not found`);
  return position;
}

function dependencyIds(step: NativePlanStep, steps: readonly NativePlanStep[]): readonly string[] {
  return (step.dependsOn ?? []).map((dependency) => steps[dependency - 1]!.id);
}

function affectedStepIds(steps: readonly NativePlanStep[], rootId: string): readonly string[] {
  const affected = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (affected.has(step.id)) continue;
      if (dependencyIds(step, steps).some((dependency) => affected.has(dependency))) {
        affected.add(step.id);
        changed = true;
      }
    }
  }
  return steps.flatMap((step) => affected.has(step.id) ? [step.id] : []);
}

function invalidateAffected(
  steps: readonly NativePlanStep[],
  invalidatedStepIds: readonly string[],
): readonly NativePlanStep[] {
  const invalidated = new Set(invalidatedStepIds);
  const owned = steps.find((step) => invalidated.has(step.id) && step.workerId !== undefined);
  if (owned !== undefined) {
    throw new PlanOperationError('worker-owned-step', `Release worker ${owned.workerId} before changing plan step ${owned.id}`);
  }
  return steps.map((step) => {
    if (!invalidated.has(step.id)) return step;
    const { receipt: _receipt, ...withoutReceipt } = step;
    return { ...withoutReceipt, status: 'todo' as const };
  });
}

function editPlanStep(
  steps: readonly NativePlanStep[],
  intent: Extract<NativePlanReviewIntent, { type: 'edit' }>,
): { readonly steps: readonly NativePlanStep[]; readonly diff: NativePlanReviewDiff } {
  const position = stepPosition(steps, intent.stepId);
  const before = steps[position]!;
  let after: NativePlanStep = before;
  if (intent.text !== undefined) after = { ...after, text: text(intent.text, 'text') };
  if (Object.hasOwn(intent, 'activeForm')) {
    const { activeForm: _activeForm, ...base } = after;
    after = intent.activeForm === null ? base : { ...base, activeForm: text(intent.activeForm, 'activeForm') };
  }
  if (Object.hasOwn(intent, 'checkCommand')) {
    const { checkCommand: _checkCommand, ...base } = after;
    after = intent.checkCommand === null ? base : { ...base, checkCommand: text(intent.checkCommand, 'checkCommand') };
  }
  if (after === before || JSON.stringify(after) === JSON.stringify(before)) {
    throw new PlanOperationError('invalid-input', 'edit requires at least one changed typed field');
  }
  const invalidatedStepIds = affectedStepIds(steps, intent.stepId);
  const changed = steps.map((step, index) => index === position ? after : step);
  const invalidated = invalidateAffected(changed, invalidatedStepIds);
  const view = (step: NativePlanStep): Pick<NativePlanStep, 'text' | 'activeForm' | 'checkCommand' | 'status'> => ({
    text: step.text,
    status: step.status,
    ...(step.activeForm === undefined ? {} : { activeForm: step.activeForm }),
    ...(step.checkCommand === undefined ? {} : { checkCommand: step.checkCommand }),
  });
  return {
    steps: invalidated,
    diff: {
      type: 'step-edited',
      stepId: intent.stepId,
      before: view(before),
      after: view(invalidated[position]!),
      invalidatedStepIds,
    },
  };
}

function reorderPlanSteps(
  steps: readonly NativePlanStep[],
  intent: Extract<NativePlanReviewIntent, { type: 'reorder' }>,
): { readonly steps: readonly NativePlanStep[]; readonly diff: NativePlanReviewDiff } {
  const beforeStepIds = steps.map((step) => step.id);
  if (intent.stepIds.length !== steps.length || intent.stepIds.some((id) => !beforeStepIds.includes(id))) {
    throw new PlanOperationError('invalid-step-order', 'reorder stepIds must be an exact permutation of the current stable step IDs');
  }
  if (intent.stepIds.every((id, index) => beforeStepIds[index] === id)) {
    throw new PlanOperationError('invalid-step-order', 'reorder must change the current step order');
  }
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  const dependencyIdsByStep = new Map(steps.map((step) => [step.id, dependencyIds(step, steps)] as const));
  const nextIndex = new Map(intent.stepIds.map((id, index) => [id, index + 1] as const));
  const reordered = intent.stepIds.map((id) => {
    const step = byId.get(id)!;
    const mapped = dependencyIdsByStep.get(id)!.map((dependency) => nextIndex.get(dependency)!);
    const { dependsOn: _dependsOn, ...base } = step;
    return mapped.length === 0 ? base : { ...base, dependsOn: mapped };
  });
  validateGraph(reordered);
  return {
    steps: reordered,
    diff: { type: 'steps-reordered', beforeStepIds, afterStepIds: intent.stepIds },
  };
}

function changePlanDependencies(
  steps: readonly NativePlanStep[],
  intent: Extract<NativePlanReviewIntent, { type: 'dependency' }>,
): { readonly steps: readonly NativePlanStep[]; readonly diff: NativePlanReviewDiff } {
  const position = stepPosition(steps, intent.stepId);
  if (intent.dependsOnStepIds.includes(intent.stepId)) {
    throw new PlanOperationError('invalid-dependencies', `Plan step ${intent.stepId} cannot depend on itself`);
  }
  const indexById = new Map(steps.map((step, index) => [step.id, index + 1] as const));
  const unknown = intent.dependsOnStepIds.find((id) => !indexById.has(id));
  if (unknown !== undefined) throw new PlanOperationError('invalid-dependencies', `Unknown dependency step ${unknown}`);
  const beforeStepIds = dependencyIds(steps[position]!, steps);
  const { dependsOn: _dependsOn, ...base } = steps[position]!;
  const indexes = intent.dependsOnStepIds.map((id) => indexById.get(id)!);
  const updated = steps.map((step, index) => index === position
    ? indexes.length === 0 ? base : { ...base, dependsOn: indexes }
    : step);
  validateGraph(updated);
  const invalidatedStepIds = affectedStepIds(updated, intent.stepId);
  return {
    steps: invalidateAffected(updated, invalidatedStepIds),
    diff: {
      type: 'dependencies-changed',
      stepId: intent.stepId,
      beforeStepIds,
      afterStepIds: intent.dependsOnStepIds,
      invalidatedStepIds,
    },
  };
}

function reopenPlanStep(
  steps: readonly NativePlanStep[],
  intent: Extract<NativePlanReviewIntent, { type: 'reopen' }>,
): { readonly steps: readonly NativePlanStep[]; readonly diff: NativePlanReviewDiff } {
  const position = stepPosition(steps, intent.stepId);
  const beforeStatus = steps[position]!.status;
  if (beforeStatus !== 'done') throw new PlanOperationError('invalid-target', `Plan step ${intent.stepId} is not complete`);
  const invalidatedStepIds = affectedStepIds(steps, intent.stepId);
  return {
    steps: invalidateAffected(steps, invalidatedStepIds),
    diff: { type: 'step-reopened', stepId: intent.stepId, beforeStatus, afterStatus: 'todo', invalidatedStepIds },
  };
}

function parseReviewIntent(value: unknown, index: number): NativePlanReviewIntent {
  const input = record(value, `intent ${index}`);
  if (input.type === 'edit') {
    assertClosed(input, ['type', 'stepId', 'text', 'activeForm', 'checkCommand'], `intent ${index}`);
    const activeForm = input.activeForm === null ? null : optionalText(input.activeForm, `intent ${index}.activeForm`);
    const checkCommand = input.checkCommand === null ? null : optionalText(input.checkCommand, `intent ${index}.checkCommand`);
    return {
      type: 'edit',
      stepId: stableStepId(input.stepId, `intent ${index}.stepId`),
      ...(input.text === undefined ? {} : { text: text(input.text, `intent ${index}.text`) }),
      ...(input.activeForm === undefined ? {} : { activeForm }),
      ...(input.checkCommand === undefined ? {} : { checkCommand }),
    };
  }
  if (input.type === 'reorder') {
    assertClosed(input, ['type', 'stepIds'], `intent ${index}`);
    return { type: 'reorder', stepIds: stableStepIds(input.stepIds, `intent ${index}.stepIds`) };
  }
  if (input.type === 'dependency') {
    assertClosed(input, ['type', 'stepId', 'dependsOnStepIds'], `intent ${index}`);
    return {
      type: 'dependency',
      stepId: stableStepId(input.stepId, `intent ${index}.stepId`),
      dependsOnStepIds: stableStepIds(input.dependsOnStepIds, `intent ${index}.dependsOnStepIds`, true),
    };
  }
  if (input.type === 'reopen') {
    assertClosed(input, ['type', 'stepId'], `intent ${index}`);
    return { type: 'reopen', stepId: stableStepId(input.stepId, `intent ${index}.stepId`) };
  }
  throw new PlanOperationError('invalid-input', `Unsupported review intent type: ${String(input.type)}`);
}

function reviewIntents(value: unknown): readonly NativePlanReviewIntent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new PlanOperationError('invalid-input', 'review requires 1-32 typed intents');
  }
  return value.map((intent, index) => parseReviewIntent(intent, index + 1));
}

function applyReviewIntent(
  steps: readonly NativePlanStep[],
  intent: NativePlanReviewIntent,
): { readonly steps: readonly NativePlanStep[]; readonly diff: NativePlanReviewDiff } {
  switch (intent.type) {
    case 'edit': return editPlanStep(steps, intent);
    case 'reorder': return reorderPlanSteps(steps, intent);
    case 'dependency': return changePlanDependencies(steps, intent);
    case 'reopen': return reopenPlanStep(steps, intent);
  }
}

function result(ok: boolean, content: Record<string, unknown>, category?: string): ToolResult {
  return { ok, content: freeze(content), detailsVersion: 1, ...(category === undefined ? {} : { category }) };
}

function actionLabel(action: NativePlanAction, index?: number): string {
  switch (action) {
    case 'set': return 'Setting plan';
    case 'propose': return 'Proposing plan';
    case 'clarify': return 'Clarifying plan';
    case 'add': return 'Adding plan step';
    case 'start': return `Starting step ${index ?? ''}`.trim();
    case 'complete': return `Completing step ${index ?? ''}`.trim();
    case 'remove': return `Removing step ${index ?? ''}`.trim();
    case 'clear': return 'Clearing plan';
    case 'show': return 'Reading plan';
    case 'edit': return 'Editing plan step';
    case 'reorder': return 'Reordering plan steps';
    case 'dependency': return 'Changing plan dependencies';
    case 'reopen': return 'Reopening plan step';
    case 'approve': return 'Approving plan revision';
    case 'reject': return 'Rejecting plan revision';
    case 'change-request': return 'Requesting plan changes';
    case 'review': return 'Reviewing plan changes';
  }
}

function finishedLabel(action: NativePlanAction): string {
  return action === 'set' ? 'Plan set' : action === 'show' ? 'Plan loaded' : `Plan ${action} complete`;
}

async function executePlan(
  execution: ToolExecutionInput,
  store: PlanStore,
  interact?: NativePlanInteraction,
  verify?: NativePlanVerifier,
  onSnapshot?: RuntimePlanSnapshotSink,
  planState?: RuntimePlanStateUpdater,
): Promise<ToolResult> {
  const params = record(execution.input, 'plan input');
  const action = params.action;
  if (
    action !== 'set' && action !== 'propose' && action !== 'clarify' && action !== 'add' &&
    action !== 'start' && action !== 'complete' && action !== 'remove' && action !== 'clear' && action !== 'show' &&
    action !== 'edit' && action !== 'reorder' && action !== 'dependency' && action !== 'reopen' &&
    action !== 'approve' && action !== 'reject' && action !== 'change-request' && action !== 'review'
  ) {
    throw new PlanOperationError('invalid-input', `Unsupported plan action: ${String(action)}`);
  }
  const scope: PlanScope = { sessionId: String(execution.context.sessionId), workspace: execution.context.cwd };
  const index = requestedIndex(params.index, action);
  await execution.update({ version: 1, kind: 'status', message: actionLabel(action, index) });
  abortIfNeeded(execution.signal);
  const stored = await store.load(scope, execution.signal);
  let current = stored ?? emptyPlan(scope);
  const hasCurrentPlan = stored !== undefined;
  const hasWorkerOwnership = current.steps.some((step) => step.workerId !== undefined);

  const publish = (snapshot: NativePlanSnapshot): void => {
    planState?.update({
      authority: 'runtime',
      revision: snapshot.revision,
      active: snapshot.phase === 'active',
    });
    if (onSnapshot === undefined) return;
    try { onSnapshot(projectRuntimePlanSnapshot(snapshot)); }
    catch {
      // Presentation observers are not part of the durable plan transaction.
    }
  };

  const commit = async (next: Omit<NativePlanSnapshot, 'revision'>): Promise<NativePlanSnapshot> => {
    abortIfNeeded(execution.signal);
    const snapshot = immutable({ ...next, revision: current.revision + 1 });
    await store.save(scope, current.revision, snapshot, execution.signal);
    current = snapshot;
    publish(snapshot);
    return snapshot;
  };
  const success = async (status: string, plan = current, extra: Record<string, unknown> = {}): Promise<ToolResult> => {
    await execution.update({ version: 1, kind: 'details', value: plan });
    await execution.update({ version: 1, kind: 'status', message: finishedLabel(action) });
    return result(true, { status, action, plan, ...extra });
  };

  if (action === 'show') {
    if (hasCurrentPlan) publish(current);
    return success('shown');
  }
  if (
    action === 'edit' || action === 'reorder' || action === 'dependency' || action === 'reopen' ||
    action === 'approve' || action === 'reject' || action === 'change-request' || action === 'review'
  ) {
    revisionPrecondition(params.expectedRevision, current.revision, action);
  }
  if (hasWorkerOwnership && (action === 'clear' || action === 'set' || action === 'propose')) {
    throw new PlanOperationError('worker-owned-step', 'Release the active worker-owned plan step before replacing the plan');
  }
  if (action === 'clear') {
    const plan = await commit({ version: 1, scope, phase: 'empty', steps: [], decisions: [] });
    return success('cleared', plan);
  }
  if (action === 'set') {
    const steps = parseSteps(params.steps, current.revision + 1);
    const plan = await commit({ version: 1, scope, phase: 'active', steps, decisions: [] });
    return success('set', plan);
  }
  if (action === 'propose') {
    const steps = params.steps === undefined ? current.steps : parseSteps(params.steps, current.revision + 1);
    if (steps.length === 0) throw new PlanOperationError('invalid-input', 'propose requires steps or an existing draft');
    const draft = await commit({ version: 1, scope, phase: 'draft', steps, decisions: current.decisions });
    if (interact === undefined) return result(false, { status: 'interaction-required', action, plan: draft }, 'interaction-required');
    const outcome = await interact({ action, scope, plan: draft }, execution.signal);
    abortIfNeeded(execution.signal);
    if (outcome.status === 'approved') {
      const approved = await commit({ ...draft, phase: 'approved' });
      return success('approved', approved);
    }
    const status = outcome.status === 'answered' ? 'invalid-interaction-outcome' : outcome.status;
    return result(status !== 'invalid-interaction-outcome', { status, action, plan: draft, outcome }, status === 'invalid-interaction-outcome' ? 'invalid-interaction-outcome' : undefined);
  }
  if (action === 'clarify') {
    const prompts = questions(params.questions);
    if (current.phase !== 'draft') current = await commit({ ...current, phase: 'draft' });
    if (interact === undefined) return result(false, { status: 'interaction-required', action, plan: current, questions: prompts }, 'interaction-required');
    const outcome = await interact({ action, scope, plan: current, questions: prompts }, execution.signal);
    abortIfNeeded(execution.signal);
    if (outcome.status !== 'answered' || outcome.answers.length !== prompts.length || outcome.answers.some((answer) => typeof answer !== 'string' || !answer.trim())) {
      return result(false, { status: outcome.status, action, plan: current, outcome }, 'invalid-interaction-outcome');
    }
    const decisions = [...current.decisions, ...prompts.map((question, position) => ({ question: question.prompt, answer: outcome.answers[position]!.trim() }))];
    const plan = await commit({ ...current, phase: 'draft', decisions });
    return success('clarified', plan);
  }

  if (action === 'review') {
    if (current.steps.length === 0) throw new PlanOperationError('invalid-input', 'review requires an existing plan');
    let proposedSteps = current.steps;
    const diff: NativePlanReviewDiff[] = [];
    for (const intent of reviewIntents(params.intents)) {
      const applied = applyReviewIntent(proposedSteps, intent);
      proposedSteps = applied.steps;
      diff.push(applied.diff);
    }
    const proposed = immutable({ ...current, steps: proposedSteps });
    await execution.update({ version: 1, kind: 'details', value: { expectedRevision: current.revision, diff, proposed } });
    await execution.update({ version: 1, kind: 'status', message: finishedLabel(action) });
    return result(true, {
      status: 'reviewed',
      action,
      expectedRevision: current.revision,
      diff,
      proposed,
    });
  }

  if (action === 'approve') {
    if (current.phase !== 'draft') throw new PlanOperationError('invalid-transition', `approve requires a draft plan, not ${current.phase}`);
    const plan = await commit({ ...current, phase: 'approved' });
    return success('approved', plan);
  }

  if (action === 'reject' || action === 'change-request') {
    if (current.phase !== 'draft' && current.phase !== 'approved') {
      throw new PlanOperationError('invalid-transition', `${action} requires a draft or approved plan, not ${current.phase}`);
    }
    const feedback = action === 'change-request'
      ? text(params.feedback, 'feedback')
      : optionalText(params.feedback, 'feedback');
    const decisions = feedback === undefined
      ? current.decisions
      : [...current.decisions, {
          question: action === 'reject' ? 'Plan review rejection' : 'Plan review change request',
          answer: feedback,
        }];
    const plan = await commit({ ...current, phase: 'draft', decisions });
    return success(action === 'reject' ? 'rejected' : 'changes-requested', plan, feedback === undefined ? {} : { feedback });
  }

  if (action === 'edit') {
    const rawIntent: Record<string, unknown> = {
      type: 'edit',
      stepId: stableStepId(params.stepId),
      ...(params.text === undefined ? {} : { text: text(params.text, 'text') }),
      ...(params.activeForm === undefined ? {} : {
        activeForm: params.activeForm === null ? null : text(params.activeForm, 'activeForm'),
      }),
      ...(params.checkCommand === undefined ? {} : {
        checkCommand: params.checkCommand === null ? null : text(params.checkCommand, 'checkCommand'),
      }),
    };
    const intent = parseReviewIntent(rawIntent, 1) as Extract<NativePlanReviewIntent, { type: 'edit' }>;
    const applied = editPlanStep(current.steps, intent);
    const plan = await commit({
      ...current,
      phase: current.phase === 'complete' ? 'active' : current.phase,
      steps: applied.steps,
    });
    return success('edited', plan, {
      stepId: intent.stepId,
      invalidatedStepIds: applied.diff.type === 'step-edited' ? applied.diff.invalidatedStepIds : [],
      diff: applied.diff,
    });
  }

  if (action === 'reorder') {
    const intent: Extract<NativePlanReviewIntent, { type: 'reorder' }> = {
      type: 'reorder',
      stepIds: stableStepIds(params.stepIds, 'stepIds'),
    };
    const applied = reorderPlanSteps(current.steps, intent);
    const plan = await commit({ ...current, steps: applied.steps });
    return success('reordered', plan, { diff: applied.diff });
  }

  if (action === 'dependency') {
    const intent: Extract<NativePlanReviewIntent, { type: 'dependency' }> = {
      type: 'dependency',
      stepId: stableStepId(params.stepId),
      dependsOnStepIds: stableStepIds(params.dependsOnStepIds, 'dependsOnStepIds', true),
    };
    const applied = changePlanDependencies(current.steps, intent);
    const plan = await commit({
      ...current,
      phase: current.phase === 'complete' ? 'active' : current.phase,
      steps: applied.steps,
    });
    return success('dependencies-changed', plan, {
      stepId: intent.stepId,
      invalidatedStepIds: applied.diff.type === 'dependencies-changed' ? applied.diff.invalidatedStepIds : [],
      diff: applied.diff,
    });
  }

  if (action === 'reopen') {
    const intent: Extract<NativePlanReviewIntent, { type: 'reopen' }> = {
      type: 'reopen',
      stepId: stableStepId(params.stepId),
    };
    const applied = reopenPlanStep(current.steps, intent);
    const plan = await commit({ ...current, phase: 'active', steps: applied.steps });
    return success('reopened', plan, {
      stepId: intent.stepId,
      invalidatedStepIds: applied.diff.type === 'step-reopened' ? applied.diff.invalidatedStepIds : [],
      diff: applied.diff,
    });
  }

  if (current.phase === 'draft') throw new PlanOperationError('approval-required', 'Draft plan requires explicit approval before execution');
  if (action === 'add') {
    const step = parseStep({ text: params.text, activeForm: params.activeForm, dependsOn: params.dependsOn, checkCommand: params.checkCommand }, current.steps.length + 1, current.steps.length + 1, current.revision + 1);
    const steps = [...current.steps, step];
    validateGraph(steps);
    const plan = await commit({ ...current, phase: current.phase === 'complete' || current.phase === 'empty' ? 'active' : current.phase, steps });
    return success('added', plan);
  }

  const targetIndex = existingIndex(params.index, action, current.steps);
  if (action === 'start') {
    const active = current.steps.flatMap((step, position) => step.status === 'doing' ? [position + 1] : []);
    const runnable = current.steps.flatMap((step, position) => step.status === 'todo' && (step.dependsOn ?? []).every((dependency) => current.steps[dependency - 1]?.status === 'done') ? [position + 1] : []);
    const selected = targetIndex ?? (runnable.length === 1 ? runnable[0] : undefined);
    if (selected === undefined) throw new PlanOperationError('explicit-index-required', 'start requires an explicit index when zero or multiple steps are runnable');
    const target = current.steps[selected - 1]!;
    if (target.status === 'done') throw new PlanOperationError('invalid-target', `Step ${selected} is already complete`);
    if (target.status === 'doing') return success('already-started', current, { index: selected });
    if (active.length >= 4) throw new PlanOperationError('active-step-limit', 'At most four plan steps may be active concurrently');
    if (!(target.dependsOn ?? []).every((dependency) => current.steps[dependency - 1]?.status === 'done')) throw new PlanOperationError('blocked-step', `Step ${selected} is blocked by dependencies`);
    const steps = current.steps.map((step, position) => position === selected - 1 ? { ...step, status: 'doing' as const } : step);
    const plan = await commit({ ...current, phase: 'active', steps });
    return success('started', plan, { index: selected });
  }
  if (action === 'complete') {
    const active = current.steps.flatMap((step, position) => step.status === 'doing' ? [position + 1] : []);
    const selected = targetIndex ?? (active.length === 1 ? active[0] : undefined);
    if (selected === undefined) throw new PlanOperationError('explicit-index-required', 'complete requires an explicit index unless exactly one step is active');
    const target = current.steps[selected - 1]!;
    if (target.status !== 'doing') throw new PlanOperationError('not-active', `Step ${selected} is not active`);
    if (target.workerId !== undefined) throw new PlanOperationError('worker-owned-step', `Step ${selected} remains owned by worker ${target.workerId}`);
    let observedReceipt: PlanVerificationReceipt | undefined;
    if (target.checkCommand !== undefined) {
      if (params.receipt !== undefined) throw new PlanOperationError('invalid-receipt', 'Caller-supplied verification receipts are not authoritative');
      if (verify === undefined) throw new PlanOperationError('verification-required', `Step ${selected} requires a configured host verifier`);
      observedReceipt = receipt(await verify(freeze({ scope, command: target.checkCommand, step: target, plan: current }), execution.signal), target.checkCommand);
      abortIfNeeded(execution.signal);
      if (observedReceipt.status === 'FAILED') {
        const steps = current.steps.map((step, position) => position === selected - 1 ? { ...step, receipt: observedReceipt } : step);
        const plan = await commit({ ...current, steps });
        return result(false, { status: 'verification-failed', action, index: selected, plan }, 'verification-failed');
      }
    } else if (params.receipt !== undefined) {
      throw new PlanOperationError('invalid-receipt', 'receipt is only valid for a step with checkCommand');
    }
    const steps = current.steps.map((step, position) => position === selected - 1
      ? { ...step, status: 'done' as const, ...(observedReceipt === undefined ? {} : { receipt: observedReceipt }) }
      : step);
    const plan = await commit({ ...current, phase: steps.every((step) => step.status === 'done') ? 'complete' : 'active', steps });
    return success('completed', plan, { index: selected });
  }

  const selected = targetIndex;
  if (selected === undefined) throw new PlanOperationError('explicit-index-required', 'remove requires an explicit index');
  if (current.steps[selected - 1]!.status === 'doing') throw new PlanOperationError('invalid-target', 'Cannot remove the active step');
  if (current.steps.some((step, position) => position !== selected - 1 && step.dependsOn?.includes(selected))) {
    throw new PlanOperationError('dependency-in-use', `Step ${selected} is required by another step`);
  }
  const steps = current.steps
    .filter((_step, position) => position !== selected - 1)
    .map((step) => ({ ...step, ...(step.dependsOn === undefined ? {} : { dependsOn: step.dependsOn.map((dependency) => dependency > selected ? dependency - 1 : dependency) }) }));
  const plan = await commit({ ...current, phase: steps.length === 0 ? 'empty' : steps.every((step) => step.status === 'done') ? 'complete' : current.phase, steps });
  return success('removed', plan, { index: selected });
}

export function registerNativePlanTool(registry: ToolRegistry, options: NativePlanOptions = {}): void {
  const store = options.store ?? new InMemoryPlanStore();
  registry.register({
    name: 'plan',
    label: 'Plan',
    description: 'Create and track a session/workspace-scoped execution plan. Proposed plans require explicit interaction approval before execution.',
    schemaVersion: 1,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: [
          'set', 'propose', 'clarify', 'add', 'start', 'complete', 'remove', 'clear', 'show',
          'edit', 'reorder', 'dependency', 'reopen', 'approve', 'reject', 'change-request', 'review',
        ] },
        steps: { type: 'array' },
        text: { type: 'string' },
        activeForm: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        dependsOn: { type: 'array', items: { type: 'number' } },
        checkCommand: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        index: { type: 'number' },
        receipt: { type: 'object' },
        questions: { type: 'array' },
        expectedRevision: { type: 'integer', minimum: 0 },
        stepId: { type: 'string' },
        stepIds: { type: 'array', items: { type: 'string' } },
        dependsOnStepIds: { type: 'array', items: { type: 'string' } },
        feedback: { type: 'string' },
        intents: { type: 'array' },
      },
      additionalProperties: false,
    },
    outputSchema: {},
    outputVersion: 1,
    policy: { effects: createEffectSet('read', 'write'), trust: 'workspace', approval: 'on-request', plan: 'allowed' },
    async execute(execution) {
      try {
        return await executePlan(execution, store, options.interact, options.verify, options.onSnapshot, options.planState);
      } catch (error) {
        const category = error instanceof PlanOperationError ? error.category : execution.signal.aborted ? 'cancelled' : 'plan-error';
        const message = error instanceof Error ? error.message : 'Plan operation failed';
        return result(false, { status: category, action: typeof (execution.input as { action?: unknown })?.action === 'string' ? (execution.input as { action: string }).action : 'unknown', error: message }, category);
      }
    },
  }, 'native-plan');
}
