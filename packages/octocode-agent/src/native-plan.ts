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

const PLAN_LOCK_ATTEMPTS = 100;
const PLAN_LOCK_RETRY_MS = 5;
const PLAN_LOCK_STALE_MS = 30_000;

export type NativePlanAction = 'set' | 'propose' | 'clarify' | 'add' | 'start' | 'complete' | 'remove' | 'clear' | 'show';
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
  }[];
}

export type RuntimePlanSnapshotSink = (snapshot: RuntimePlanSnapshot) => void;

/** Durable implementations must check the signal immediately before committing. */
export interface PlanStore {
  load(scope: PlanScope, signal?: AbortSignal): Promise<NativePlanSnapshot | undefined>;
  save(scope: PlanScope, expectedRevision: number, snapshot: NativePlanSnapshot, signal?: AbortSignal): Promise<void>;
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
    assertClosed(step, ['id', 'text', 'status', 'activeForm', 'dependsOn', 'checkCommand', 'receipt'], `step ${position + 1}`);
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
    return {
      id: storedText(step.id, `step ${position + 1}.id`),
      text: storedText(step.text, `step ${position + 1}.text`),
      status: step.status,
      ...(step.activeForm === undefined ? {} : { activeForm: storedText(step.activeForm, `step ${position + 1}.activeForm`) }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
      ...(checkCommand === undefined ? {} : { checkCommand }),
      ...(parsedReceipt === undefined ? {} : { receipt: parsedReceipt }),
    };
  });
  if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new PlanOperationError('invalid-plan', 'Stored plan step IDs must be unique');
  try { validateGraph(steps); } catch { throw new PlanOperationError('invalid-plan', 'Stored plan dependency graph is invalid'); }
  for (const [position, step] of steps.entries()) {
    if ((step.dependsOn ?? []).some((dependency) => steps[dependency - 1]?.status !== 'done') && step.status !== 'todo') {
      throw new PlanOperationError('invalid-plan', `step ${position + 1} ran before its dependencies completed`);
    }
  }
  if (steps.filter((step) => step.status === 'doing').length > 1) throw new PlanOperationError('invalid-plan', 'Stored plan has multiple active steps');
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
  if (action !== 'set' && action !== 'propose' && action !== 'clarify' && action !== 'add' && action !== 'start' && action !== 'complete' && action !== 'remove' && action !== 'clear' && action !== 'show') {
    throw new PlanOperationError('invalid-input', `Unsupported plan action: ${String(action)}`);
  }
  const scope: PlanScope = { sessionId: String(execution.context.sessionId), workspace: execution.context.cwd };
  const index = requestedIndex(params.index, action);
  await execution.update({ version: 1, kind: 'status', message: actionLabel(action, index) });
  abortIfNeeded(execution.signal);
  const stored = await store.load(scope, execution.signal);
  let current = stored ?? emptyPlan(scope);
  const hasCurrentPlan = stored !== undefined;

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
    const active = current.steps.findIndex((step) => step.status === 'doing') + 1;
    const runnable = current.steps.flatMap((step, position) => step.status === 'todo' && (step.dependsOn ?? []).every((dependency) => current.steps[dependency - 1]?.status === 'done') ? [position + 1] : []);
    const selected = targetIndex ?? (runnable.length === 1 ? runnable[0] : undefined);
    if (selected === undefined) throw new PlanOperationError('explicit-index-required', 'start requires an explicit index when zero or multiple steps are runnable');
    if (active > 0 && active !== selected) throw new PlanOperationError('active-step-exists', `Step ${active} is already active`);
    const target = current.steps[selected - 1]!;
    if (target.status === 'done') throw new PlanOperationError('invalid-target', `Step ${selected} is already complete`);
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
        action: { type: 'string', enum: ['set', 'propose', 'clarify', 'add', 'start', 'complete', 'remove', 'clear', 'show'] },
        steps: { type: 'array' },
        text: { type: 'string' },
        activeForm: { type: 'string' },
        dependsOn: { type: 'array', items: { type: 'number' } },
        checkCommand: { type: 'string' },
        index: { type: 'number' },
        receipt: { type: 'object' },
        questions: { type: 'array' },
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
