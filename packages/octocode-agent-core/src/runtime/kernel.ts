import { RuntimeFailure } from '../contracts/errors.js';
import { eventId, toolCallId, turnId, type SessionId, type TurnId } from '../contracts/identity.js';
import type {
  AgentRuntime,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeCompactionPort,
  MonitoringSnapshotV1,
  NativeMonitoringContributionV1,
  NativeMonitoringPort,
  RuntimePlanPolicySnapshot,
  RuntimePlanStateProvider,
  RuntimePlanStateUpdater,
  RuntimeSnapshot,
} from '../contracts/runtime.js';
import type { RuntimeEvent, RuntimeEventOf, RuntimeEventPayload, RuntimeMode, RuntimeOutputFormat, ToolCancelledPayload, TrustSnapshot } from '../contracts/events.js';
import type { ModelMessage, ModelPort, ModelRequest, ModelResponse } from '../contracts/ports.js';
import { createEffectSet, type EffectSet, type ToolDefinition, type ToolExecutionUpdate, type ToolPolicyMetadata } from '../contracts/tools.js';
import type { LifecycleDispatchResult } from '../events/bus.js';
import { ToolRegistry } from './registries.js';
import { PolicyChain } from './policy.js';
import { jsonSchemaError } from '../schemas/json-schema.js';
import { InMemoryEffectLedger, type EffectAdmissionReceipt, type EffectLedgerPort } from './effect-ledger.js';

interface ToolGateRequest { readonly callId: string; readonly name: string; readonly input: unknown; readonly policy: ToolPolicyMetadata; readonly lockTargets: readonly string[]; readonly mode: RuntimeMode; readonly trust: TrustSnapshot; readonly signal: AbortSignal; }
type ToolGateResult = { readonly allowed: true; readonly effects: EffectSet; readonly policy: EffectAdmissionReceipt['policy'] }
  | { readonly allowed: false; readonly category: 'validation' | 'trust' | 'approval' | 'plan-policy' | 'peer-lock' | 'policy' | 'cancelled'; readonly reason: string };
interface QueuedInput { readonly kind: 'follow-up' | 'steer'; readonly text: string; }
export interface RuntimeKernelOptions { readonly sessionId: SessionId; readonly model: ModelPort; readonly compaction?: RuntimeCompactionPort; readonly compactionInputTokenThreshold?: number; readonly effectLedger?: EffectLedgerPort; readonly initialModel?: NonNullable<RuntimeSnapshot['model']>; readonly validateModel?: (model: NonNullable<RuntimeSnapshot['model']>) => string | undefined; readonly validateThinking?: (level: string) => string | undefined; readonly initialMessages?: readonly ModelMessage[]; readonly initialContextEventIds?: readonly string[]; readonly tools?: ToolRegistry; readonly policy?: PolicyChain; readonly maxIterations?: number; readonly maxToolCalls?: number; readonly maxProviderAttempts?: number; readonly providerRetryDelayMs?: number; readonly maxQueuedInputs?: number; readonly maxToolResultBytes?: number; readonly maxToolResultBytesPerTurn?: number; readonly turnTimeoutMs?: number; readonly cwd?: string; readonly mode?: RuntimeMode; readonly outputFormat?: RuntimeOutputFormat; readonly trust?: TrustSnapshot; /** Legacy construction-time fallback. Prefer planState for live policy. */ readonly planActive?: boolean; readonly planState?: RuntimePlanStateProvider; readonly approve?: (request: ToolGateRequest) => Promise<boolean>; readonly checkPeerLocks?: (targets: readonly string[], request: ToolGateRequest) => Promise<boolean>; readonly emit?: (event: RuntimeEvent) => Promise<LifecycleDispatchResult<unknown> | void>; readonly monitoring?: NativeMonitoringPort; readonly now?: () => number; readonly createTurnId?: (sequence: number) => TurnId; }

const defaultTrust: TrustSnapshot = { workspace: 'unknown', managedOnly: false };
const DEFAULT_PLAN_POLICY_SNAPSHOT: RuntimePlanPolicySnapshot = Object.freeze({ authority: 'runtime', revision: 0, active: false });
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_TOOL_RESULT_BYTES_PER_TURN = 4 * 1024 * 1024;
const TURN_DEADLINE_EXCEEDED = Symbol('turn-deadline-exceeded');
const DEFAULT_RUNTIME_CWD = '';
const DEFAULT_RUNTIME_NOW = Date.now;
interface MutableAggregate { count: number; sum: number; min: number | null; max: number | null; }
const emptyAggregate = (): MutableAggregate => ({ count: 0, sum: 0, min: null, max: null });
function observeAggregate(aggregate: MutableAggregate, value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value)) return;
  const normalized = Math.max(0, value);
  aggregate.count += 1;
  aggregate.sum += normalized;
  aggregate.min = aggregate.min === null ? normalized : Math.min(aggregate.min, normalized);
  aggregate.max = aggregate.max === null ? normalized : Math.max(aggregate.max, normalized);
}
const isCounter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function nativeMonitoringContribution(value: NativeMonitoringContributionV1 | undefined): NativeMonitoringContributionV1 | undefined {
  if (value === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const cache = value.cache;
  if (cache === undefined || (
    !isCounter(cache.hits) || !isCounter(cache.misses) || !isCounter(cache.loads)
    || !isCounter(cache.loadFailures) || !isCounter(cache.expirations) || !isCounter(cache.evictions)
    || !isCounter(cache.entries) || !isCounter(cache.maxEntries) || cache.maxEntries === 0
    || cache.entries > cache.maxEntries || !isCounter(cache.ttlMs) || cache.ttlMs === 0
  )) return undefined;
  return { cache: structuredClone(cache) };
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isModelToolCall = (value: unknown): boolean => isRecord(value)
  && typeof value['id'] === 'string'
  && typeof value['name'] === 'string'
  && 'input' in value;
const isModelMessage = (value: unknown): value is ModelMessage => {
  if (!isRecord(value) || typeof value['content'] !== 'string') return false;
  if (value['role'] === 'system' || value['role'] === 'user') return value['toolCallId'] === undefined && value['toolCalls'] === undefined;
  if (value['role'] === 'assistant') return value['toolCallId'] === undefined
    && (value['toolCalls'] === undefined || (Array.isArray(value['toolCalls']) && value['toolCalls'].every(isModelToolCall)));
  return value['role'] === 'tool' && typeof value['toolCallId'] === 'string' && value['toolCalls'] === undefined;
};

function normalizePlanPolicySnapshot(value: RuntimePlanPolicySnapshot): RuntimePlanPolicySnapshot {
  if (value?.authority !== 'runtime') throw new RuntimeFailure('validation', 'Plan policy state requires runtime authority');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new RuntimeFailure('validation', 'Plan policy revision must be a non-negative integer');
  if (typeof value.active !== 'boolean') throw new RuntimeFailure('validation', 'Plan policy active state must be boolean');
  return Object.freeze({ authority: 'runtime', revision: value.revision, active: value.active });
}

export class LiveRuntimePlanState implements RuntimePlanStateProvider, RuntimePlanStateUpdater {
  #current = DEFAULT_PLAN_POLICY_SNAPSHOT;

  snapshot(): RuntimePlanPolicySnapshot { return this.#current; }

  update(value: RuntimePlanPolicySnapshot): void {
    const next = normalizePlanPolicySnapshot(value);
    if (next.revision < this.#current.revision) throw new RuntimeFailure('conflict', 'Plan policy revision is stale');
    if (next.revision === this.#current.revision) {
      if (next.active !== this.#current.active) throw new RuntimeFailure('conflict', 'Plan policy state cannot change at the same revision');
      return;
    }
    this.#current = next;
  }
}
function cancelledToolPayload(callId: ToolCancelledPayload['callId'], name: string, message: string): ToolCancelledPayload {
  const error = new RuntimeFailure('cancelled', message).toJSON();
  return { callId, name, outcome: 'cancelled', category: 'cancelled', message, error };
}
async function awaitAbortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<{ kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'aborted' }> {
  if (signal.aborted) return { kind: 'aborted' };
  let onAbort!: () => void;
  const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
    onAbort = () => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const completed = Promise.resolve().then(operation).then(
    (value): { kind: 'value'; value: T } => ({ kind: 'value', value }),
    (error): { kind: 'error'; error: unknown } => ({ kind: 'error', error }),
  );
  try { return await Promise.race([completed, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
function updateError(update: ToolExecutionUpdate): string | undefined {
  if (!isRecord(update) || update.version !== 1) return 'Tool update must use version 1';
  if (update.kind !== 'progress' && update.kind !== 'status' && update.kind !== 'details') return 'Tool update kind is invalid';
  if (update.message !== undefined && typeof update.message !== 'string') return 'Tool update message must be a string';
  return undefined;
}
function resultError(result: unknown, definition: ToolDefinition): string | undefined {
  if (!isRecord(result) || typeof result.ok !== 'boolean' || !Number.isInteger(result.detailsVersion)) return 'Tool result envelope is invalid';
  if (result.detailsVersion !== definition.outputVersion) return `Tool result version must be ${definition.outputVersion}`;
  if (result.category !== undefined && typeof result.category !== 'string') return 'Tool result category must be a string';
  return jsonSchemaError(result.content, definition.outputSchema, '$.content');
}
function serializeToolResult(result: unknown, maxBytes: number): { readonly content: string; readonly bytes: number } {
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new TypeError('result serialized to undefined');
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > maxBytes) throw new RuntimeFailure('tool-execution', `Tool result exceeds ${maxBytes} bytes`);
    return { content: serialized, bytes };
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    throw new RuntimeFailure('tool-execution', 'Tool result is not JSON-serializable');
  }
}
export class RuntimeKernel implements AgentRuntime {
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  readonly #options: RuntimeKernelOptions;
  readonly #modelTools: ModelRequest['tools'];
  readonly #contextEventIds: Set<string>;
  readonly #effectLedger: EffectLedgerPort;
  readonly #cwd: string;
  readonly #now: () => number;
  readonly #queuedInputs: QueuedInput[] = [];
  readonly #pendingSteers: QueuedInput[] = [];
  readonly #providerDurationMs = emptyAggregate();
  readonly #providerTtftMs = emptyAggregate();
  readonly #providerErrors: Record<string, number> = {};
  #history: ModelMessage[];
  #compaction: AbortController | null = null;
  #state: RuntimeSnapshot['state'] = 'created'; #active: AbortController | null = null; #activeProviderAttempt: AbortController | null = null; #activeTurn: Promise<void> | null = null; #activeTurnId: ReturnType<typeof turnId> | null = null; #queueDrain: Promise<void> | null = null; #stopping: Promise<void> | null = null; #revision = 0; #model: RuntimeSnapshot['model'] = null; #thinking: string | null = null; #usage: RuntimeSnapshot['usage'] = { inputTokens: 0, outputTokens: 0 }; #lastCompactedInputTokens = 0; #sequence = 0;
  #providerRequests = 0; #providerResponses = 0; #providerFailures = 0; #providerRetries = 0; #providerCancellations = 0;
  constructor(options: RuntimeKernelOptions) {
    this.#options = options;
    this.#cwd = options.cwd ?? DEFAULT_RUNTIME_CWD;
    this.#now = options.now ?? DEFAULT_RUNTIME_NOW;
    this.#history = structuredClone([...(options.initialMessages ?? [])]);
    this.#contextEventIds = new Set(options.initialContextEventIds ?? []);
    this.#effectLedger = options.effectLedger ?? new InMemoryEffectLedger(this.#now);
    if (options.compactionInputTokenThreshold !== undefined && (!Number.isSafeInteger(options.compactionInputTokenThreshold) || options.compactionInputTokenThreshold <= 0)) {
      throw new RuntimeFailure('validation', 'Compaction input-token threshold must be a positive integer');
    }
    const tools = options.tools?.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    this.#modelTools = tools === undefined ? undefined : structuredClone(tools);
    this.#model = options.initialModel ?? null;
  }
  async start(): Promise<void> { if (this.#state !== 'created') return; this.#state = 'starting'; await this.#emit('runtime.ready', 'notification', {}); if (this.#state === 'starting') { this.#state = 'ready'; this.#revision += 1; } }
  async submit(input: string): Promise<void> {
    if (this.#state !== 'created' && this.#state !== 'ready') throw new RuntimeFailure('internal-invariant', `Runtime cannot submit while ${this.#state}`);
    const controller = new AbortController();
    const configuredTimeout = this.#options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TURN_TIMEOUT_MS;
    const deadline = setTimeout(() => controller.abort(TURN_DEADLINE_EXCEEDED), timeoutMs);
    this.#active = controller;
    const turn = this.#startAndSubmit(input, controller);
    this.#activeTurn = turn;
    try { await turn; }
    finally { clearTimeout(deadline); if (this.#activeTurn === turn) this.#activeTurn = null; if (this.#active === controller) this.#active = null; this.#scheduleQueueDrain(); }
  }
  async #startAndSubmit(input: string, controller: AbortController): Promise<void> {
    if (this.#state === 'created') await this.start();
    if (controller.signal.aborted && (this.#state === 'stopping' || this.#state === 'stopped')) return;
    if (this.#state !== 'ready') throw new RuntimeFailure('internal-invariant', `Runtime cannot submit while ${this.#state}`);
    await this.#submitTurn(input, controller);
  }
  async #submitTurn(input: string, controller: AbortController): Promise<void> {
    this.#state = 'running'; this.#revision += 1; const id = this.#options.createTurnId?.(this.#sequence + 1) ?? turnId(`turn:${this.#sequence + 1}`); this.#activeTurnId = id;
    let stop: string = 'error';
    let agentStarted = false;
    const abortStop = (): 'cancelled' | 'timeout' => controller.signal.reason === TURN_DEADLINE_EXCEEDED ? 'timeout' : 'cancelled';
    try {
      const lifecycle = await this.#emit('input.received', 'before', { text: input });
      if (!isRecord(lifecycle.payload) || typeof lifecycle.payload['text'] !== 'string') throw new RuntimeFailure('validation', 'input.received lifecycle payload requires text');
      const effectiveInput = lifecycle.payload['text'];
      await this.#emit('turn.started', 'notification', { turnId: id });
      if (lifecycle.decision.kind === 'deny') {
        stop = 'deny';
        await this.#emit('input.rejected', 'after', { text: effectiveInput, reason: lifecycle.decision.reason });
      } else if (lifecycle.decision.kind === 'stop') {
        stop = 'stop';
        await this.#emit('input.handled', 'after', { text: effectiveInput, reason: lifecycle.decision.reason });
      } else if (controller.signal.aborted) stop = abortStop();
      else {
        if (effectiveInput !== input) await this.#emit('input.transformed', 'after', { original: input, text: effectiveInput });
        await this.#emit('agent.started', 'notification', { turnId: id });
        agentStarted = true;
        stop = await this.#runModelToolLoop(effectiveInput, id, controller.signal);
        if (!controller.signal.aborted) await this.#maybeAutoCompact();
        if (stop === 'cancelled') stop = abortStop();
      }
    }
    catch (error) { if (!controller.signal.aborted) { this.#state = 'failed'; await this.#emit('runtime.failed', 'notification', { message: error instanceof Error ? error.message : 'Model failed' }); throw error; } stop = abortStop(); }
    finally {
      if (this.#state === 'running') this.#state = 'ready';
      this.#revision += 1;
      try {
        if (agentStarted) await this.#emit('agent.ended', 'after', { turnId: id, stop });
      } finally {
        try { await this.#emit('turn.ended', 'after', { turnId: id, stop }); }
        finally { this.#activeTurnId = null; }
      }
    }
  }
  async cancel(reason = 'cancelled'): Promise<void> { this.#active?.abort(reason); }
  async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    try {
      switch (command.type) {
        case 'input.submit': await this.submit(command.text); return { ok: true };
        case 'input.follow-up': return await this.#enqueueInput({ kind: 'follow-up', text: command.text });
        case 'input.steer': {
          if (this.#state !== 'running' || this.#active === null) return { ok: false, error: new RuntimeFailure('conflict', 'input.steer requires an active turn').toJSON() };
          const queued = await this.#enqueueSteer(command.text);
          if (queued.ok) this.#activeProviderAttempt?.abort('steered');
          return queued;
        }
        case 'input.cancel': await this.cancel(command.reason); return { ok: true };
        case 'context.append': {
          const eventId = command.eventId.trim();
          const text = command.text.trim();
          if (!eventId || !text) return { ok: false, error: new RuntimeFailure('validation', 'External context requires a non-empty eventId and text').toJSON() };
          if (Buffer.byteLength(text, 'utf8') > 16_384) return { ok: false, error: new RuntimeFailure('validation', 'External context exceeds 16384 bytes').toJSON() };
          if (this.#contextEventIds.has(eventId)) return { ok: true, data: { duplicate: true } };
          this.#contextEventIds.add(eventId);
          this.#history.push({ role: 'system', content: text });
          this.#revision += 1;
          try {
            await this.#emit('context.appended', 'after', { eventId, text, provenance: command.provenance });
          } catch (error) {
            this.#contextEventIds.delete(eventId);
            this.#history.pop();
            this.#revision -= 1;
            throw error;
          }
          return { ok: true, data: { duplicate: false } };
        }
        case 'model.select': {
          if (this.#state === 'running') return { ok: false, error: new RuntimeFailure('conflict', 'Cannot change model during an active turn').toJSON() };
          if (!command.providerId.trim() || !command.modelId.trim()) return { ok: false, error: new RuntimeFailure('validation', 'Model provider and id must be non-empty').toJSON() };
          const next = { providerId: command.providerId, modelId: command.modelId };
          const unsupported = this.#options.validateModel?.(next);
          if (unsupported) return { ok: false, error: new RuntimeFailure('unsupported-capability', unsupported).toJSON() };
          this.#model = next; this.#revision += 1; await this.#emit('model.selected', 'notification', this.#model); return { ok: true };
        }
        case 'model.thinking': {
          if (this.#state === 'running') return { ok: false, error: new RuntimeFailure('conflict', 'Cannot change thinking level during an active turn').toJSON() };
          const unsupported = this.#options.validateThinking?.(command.level);
          if (unsupported) return { ok: false, error: new RuntimeFailure('unsupported-capability', unsupported).toJSON() };
          this.#thinking = command.level; this.#revision += 1; await this.#emit('model.thinking-level-selected', 'notification', { level: command.level }); return { ok: true };
        }
        case 'context.compact': {
          if (this.#options.compaction === undefined) return { ok: false, error: new RuntimeFailure('unsupported-capability', 'Context compaction requires a composed service').toJSON() };
          if (this.#state === 'running' || this.#compaction !== null) return { ok: false, error: new RuntimeFailure('conflict', 'Context compaction requires an idle runtime').toJSON() };
          return await this.#compact(command.reason);
        }
        case 'context.cancel-compaction': {
          if (this.#compaction === null) return { ok: false, error: new RuntimeFailure('conflict', 'No compaction is active').toJSON() };
          this.#compaction.abort('Compaction cancelled');
          await this.#options.compaction?.cancel?.('Compaction cancelled');
          return { ok: true };
        }
        case 'context.usage': case 'runtime.snapshot': return { ok: true, data: this.snapshot() };
        case 'monitoring.snapshot': return { ok: true, data: this.monitoringSnapshot() };
        case 'tools.list': return { ok: true, data: this.#options.tools?.list().map(({ name, label, description, policy }) => ({ name, label, description, policy: { effects: createEffectSet(...policy.effects), trust: policy.trust, approval: policy.approval, plan: policy.plan } })) ?? [] };
        case 'runtime.stop': await this.stop(); return { ok: true };
        default: return { ok: false, error: new RuntimeFailure('unsupported-capability', `Command ${command.type} requires a composed service`).toJSON() };
      }
    } catch (error) {
      const failure = error instanceof RuntimeFailure ? error : new RuntimeFailure('internal-invariant', error instanceof Error ? error.message : 'Runtime command failed');
      return { ok: false, error: failure.toJSON() };
    }
  }
  async #compact(reason: 'manual' | 'threshold' | 'overflow'): Promise<RuntimeCommandResult> {
    const compaction = this.#options.compaction;
    if (compaction === undefined) return { ok: false, error: new RuntimeFailure('unsupported-capability', 'Context compaction requires a composed service').toJSON() };
    const controller = new AbortController();
    this.#compaction = controller;
    await this.#emit('context.compaction-started', 'notification', { reason });
    try {
      const compacted = await compaction.compact({ reason, messages: structuredClone(this.#history), signal: controller.signal });
      if (controller.signal.aborted) throw new RuntimeFailure('cancelled', 'Compaction cancelled');
      this.#history = structuredClone([...compacted.messages]);
      this.#lastCompactedInputTokens = this.#usage.inputTokens;
      this.#revision += 1;
      await this.#emit('context.compacted', 'after', { reason, summary: compacted.summary });
      return { ok: true, data: { summary: compacted.summary } };
    } catch (error) {
      const failure = error instanceof RuntimeFailure ? error : new RuntimeFailure('compaction', error instanceof Error ? error.message : 'Compaction failed');
      await this.#emit('context.compaction-failed', 'after', { reason, category: failure.category, message: failure.message });
      throw failure;
    } finally { this.#compaction = null; }
  }
  async #maybeAutoCompact(): Promise<void> {
    const threshold = this.#options.compactionInputTokenThreshold;
    if (this.#options.compaction === undefined || threshold === undefined || this.#compaction !== null) return;
    if (this.#usage.inputTokens - this.#lastCompactedInputTokens < threshold) return;
    try { await this.#compact('threshold'); }
    catch {
      this.#lastCompactedInputTokens = this.#usage.inputTokens;
      // Automatic compaction is maintenance at a turn safe point. Its typed
      // failure event is observable, but a completed user turn remains valid.
      // Treat the failed attempt as the next threshold baseline so an unavailable
      // summarizer cannot create a retry storm on every subsequent turn.
    }
  }
  snapshot(): RuntimeSnapshot { return { schemaVersion: 1, state: this.#state, sessionId: this.#options.sessionId, activeTurn: this.#active !== null, model: this.#model, thinkingLevel: this.#thinking, usage: this.#usage, revision: this.#revision }; }
  monitoringSnapshot(): MonitoringSnapshotV1 {
    const native = nativeMonitoringContribution(this.#options.monitoring?.snapshot());
    return {
      schemaVersion: 1,
      generatedAt: this.#now(),
      sessionId: this.#options.sessionId,
      model: this.#model,
      usage: { ...this.#usage },
      provider: {
        requests: this.#providerRequests,
        responses: this.#providerResponses,
        failures: this.#providerFailures,
        retries: this.#providerRetries,
        cancellations: this.#providerCancellations,
        durationMs: { ...this.#providerDurationMs },
        ttftMs: { ...this.#providerTtftMs },
        byErrorCategory: { ...this.#providerErrors },
      },
      ...(native === undefined ? {} : { native }),
    };
  }
  subscribe(listener: (event: RuntimeEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async stop(): Promise<void> {
    if (this.#state === 'stopped') return;
    if (this.#stopping !== null) return this.#stopping;
    this.#stopping = this.#stop();
    return this.#stopping;
  }
  async #stop(): Promise<void> { this.#state = 'stopping'; this.#active?.abort('runtime stopping'); this.#activeProviderAttempt?.abort('runtime stopping'); this.#compaction?.abort('runtime stopping'); await this.#options.compaction?.cancel?.('runtime stopping'); const queued = [...this.#pendingSteers.splice(0), ...this.#queuedInputs.splice(0)]; for (const input of queued) await this.#emit('input.rejected', 'after', { kind: input.kind, text: input.text, reason: 'runtime stopping' }); await this.#emit('runtime.stopping', 'notification', {}); await this.#activeTurn; await this.#queueDrain; this.#state = 'stopped'; this.#revision += 1; await this.#emit('runtime.stopped', 'notification', {}); }
  async #enqueueInput(input: QueuedInput, front = false): Promise<RuntimeCommandResult> {
    if (this.#state === 'stopping' || this.#state === 'stopped' || this.#state === 'failed') return { ok: false, error: new RuntimeFailure('conflict', `Cannot queue ${input.kind} while runtime is ${this.#state}`).toJSON() };
    const configured = this.#options.maxQueuedInputs ?? 16;
    const limit = Number.isInteger(configured) && configured > 0 ? configured : 16;
    if (this.#queuedInputs.length + this.#pendingSteers.length >= limit) { await this.#emit('input.rejected', 'after', { kind: input.kind, text: input.text, reason: 'input queue full', limit }); return { ok: false, error: new RuntimeFailure('conflict', `Input queue is full (${limit})`).toJSON() }; }
    if (front) this.#queuedInputs.unshift(input); else this.#queuedInputs.push(input);
    const position = front ? 1 : this.#queuedInputs.length;
    await this.#emit('input.queued', 'notification', { kind: input.kind, text: input.text, position });
    this.#scheduleQueueDrain();
    return { ok: true, data: { queued: true, kind: input.kind, position } };
  }
  async #enqueueSteer(text: string): Promise<RuntimeCommandResult> {
    const configured = this.#options.maxQueuedInputs ?? 16;
    const limit = Number.isInteger(configured) && configured > 0 ? configured : 16;
    if (this.#queuedInputs.length + this.#pendingSteers.length >= limit) {
      await this.#emit('input.rejected', 'after', { kind: 'steer', text, reason: 'input queue full', limit });
      return { ok: false, error: new RuntimeFailure('conflict', `Input queue is full (${limit})`).toJSON() };
    }
    this.#pendingSteers.push({ kind: 'steer', text });
    const position = this.#pendingSteers.length;
    await this.#emit('input.queued', 'notification', { kind: 'steer', text, position });
    return { ok: true, data: { queued: true, kind: 'steer', position } };
  }
  #scheduleQueueDrain(): void {
    if (this.#queueDrain !== null || this.#queuedInputs.length === 0 || (this.#state !== 'created' && this.#state !== 'ready')) return;
    const drain = this.#drainQueue();
    this.#queueDrain = drain;
    void drain.finally(() => { if (this.#queueDrain === drain) this.#queueDrain = null; this.#scheduleQueueDrain(); });
  }
  async #drainQueue(): Promise<void> {
    while (this.#queuedInputs.length > 0 && (this.#state === 'created' || this.#state === 'ready')) {
      const next = this.#queuedInputs.shift()!;
      try { await this.submit(next.text); }
      catch {
        const rejected = this.#queuedInputs.splice(0);
        for (const input of rejected) {
          await this.#emit('input.rejected', 'after', {
            kind: input.kind,
            text: input.text,
            reason: 'earlier queued input failed',
          });
        }
        return;
      }
    }
  }
  async #emit<TType extends RuntimeEvent['type']>(type: TType, phase: RuntimeEvent['phase'], payload: RuntimeEventPayload<TType>): Promise<LifecycleDispatchResult<unknown>> {
    const event = { schemaVersion: 1, eventVersion: 1, id: eventId(`runtime:${++this.#sequence}`), type, phase, sessionId: this.#options.sessionId, ...(this.#activeTurnId === null ? {} : { turnId: this.#activeTurnId }), timestamp: this.#now(), cwd: this.#cwd, mode: this.#options.mode ?? 'headless', ...(this.#options.outputFormat === undefined ? {} : { outputFormat: this.#options.outputFormat }), ...(this.#model === null ? {} : { model: this.#model }), trust: this.#options.trust ?? defaultTrust, payload } as RuntimeEventOf<TType>;
    const result = await this.#options.emit?.(event) ?? {
      payload,
      decision: { kind: 'continue' as const },
      context: [],
      suppressed: false,
      receipts: [],
    };
    const effectiveEvent: RuntimeEvent = result.payload === event.payload ? event : { ...event, payload: result.payload } as RuntimeEvent;
    if (!result.suppressed) {
      for (const listener of this.#listeners) { try { listener(effectiveEvent); } catch { /* Presentation observers cannot change durable runtime outcomes. */ } }
    }
    return result;
  }
  async #gate(definition: ToolDefinition, call: { id: string; name: string; input: unknown }, callId: string, signal: AbortSignal): Promise<ToolGateResult> {
    if (signal.aborted) return { allowed: false, category: 'cancelled', reason: 'Tool call cancelled before policy evaluation' };
    const trust = this.#options.trust ?? defaultTrust;
    const inputFailure = jsonSchemaError(call.input, definition.inputSchema);
    if (inputFailure) return { allowed: false, category: 'validation', reason: inputFailure };
    let effects: EffectSet;
    try { effects = createEffectSet(...definition.policy.effects); }
    catch (error) { return { allowed: false, category: 'validation', reason: error instanceof Error ? error.message : 'Tool effects are invalid' }; }
    if (definition.policy.trust === 'workspace' && trust.workspace !== 'trusted') return { allowed: false, category: 'trust', reason: 'Tool requires a trusted workspace' };
    if (definition.policy.trust === 'managed' && (!trust.managedOnly || trust.workspace !== 'trusted')) return { allowed: false, category: 'trust', reason: 'Tool requires a trusted managed workspace' };
    let planState: RuntimePlanPolicySnapshot;
    try {
      planState = this.#options.planState === undefined
        ? Object.freeze({ ...DEFAULT_PLAN_POLICY_SNAPSHOT, active: this.#options.planActive === true })
        : normalizePlanPolicySnapshot(this.#options.planState.snapshot());
    } catch {
      if (definition.policy.plan !== 'allowed') return { allowed: false, category: 'plan-policy', reason: 'Authoritative plan state is unavailable' };
      planState = DEFAULT_PLAN_POLICY_SNAPSHOT;
    }
    if (definition.policy.plan === 'required' && !planState.active) return { allowed: false, category: 'plan-policy', reason: 'Tool requires an active plan' };
    if (definition.policy.plan === 'forbidden' && planState.active) return { allowed: false, category: 'plan-policy', reason: 'Tool is forbidden while a plan is active' };
    let lockTargets: readonly string[] = [];
    try { lockTargets = definition.policy.lockTarget?.(call.input) ?? []; }
    catch { return { allowed: false, category: 'validation', reason: 'Tool lock targets could not be derived' }; }
    const request: ToolGateRequest = { callId, name: call.name, input: call.input, policy: definition.policy, lockTargets, mode: this.#options.mode ?? 'headless', trust, signal };
    if (lockTargets.length > 0) {
      if (!this.#options.checkPeerLocks) return { allowed: false, category: 'peer-lock', reason: 'Tool requires peer-lock verification' };
      try { if (!await this.#options.checkPeerLocks(lockTargets, request)) return { allowed: false, category: 'peer-lock', reason: 'Tool conflicts with a peer lock' }; }
      catch { return { allowed: false, category: 'peer-lock', reason: 'Peer-lock verification failed' }; }
    }
    const policy = await (this.#options.policy ?? new PolicyChain()).evaluate({ operation: `tool:${call.name}`, trust, effects, metadata: { callId, tool: call.name, approval: definition.policy.approval, plan: definition.policy.plan, planActive: planState.active, planRevision: planState.revision, trustRequirement: definition.policy.trust, lockTargets, mode: request.mode, cwd: this.#cwd } });
    if (policy.effect === 'deny') return { allowed: false, category: policy.category, reason: policy.reason };
    if (definition.policy.approval !== 'never') {
      const permission = await this.#emit('permission.requested', 'permission', {
        callId, name: call.name, input: call.input, policy: definition.policy,
      });
      if (permission.decision.kind === 'deny' || permission.decision.kind === 'stop') {
        return { allowed: false, category: 'approval', reason: permission.decision.reason };
      }
      if (permission.decision.kind !== 'allow') {
        if (!this.#options.approve) return { allowed: false, category: 'approval', reason: 'Tool requires approval' };
        const approval = await awaitAbortable(() => this.#options.approve!(request), signal);
        if (approval.kind === 'aborted') return { allowed: false, category: 'cancelled', reason: 'Tool call cancelled while awaiting approval' };
        if (approval.kind === 'error') return { allowed: false, category: 'approval', reason: 'Tool approval failed' };
        if (!approval.value) return { allowed: false, category: 'approval', reason: 'Tool approval was denied' };
      }
    }
    return {
      allowed: true,
      effects,
      policy: {
        trust,
        approval: definition.policy.approval,
        approved: true,
        plan: planState,
        lockTargets: [...lockTargets],
        receipts: policy.receipts,
      },
    };
  }
  async #applyPendingSteers(messages: ModelMessage[]): Promise<'continue' | 'stop'> {
    const pending = this.#pendingSteers.splice(0);
    for (const steer of pending) {
      const lifecycle = await this.#emit('input.received', 'before', { kind: 'steer', text: steer.text });
      if (!isRecord(lifecycle.payload) || typeof lifecycle.payload['text'] !== 'string') {
        throw new RuntimeFailure('validation', 'input.received lifecycle payload requires text');
      }
      const effectiveInput = lifecycle.payload['text'];
      if (lifecycle.decision.kind === 'deny') {
        await this.#emit('input.rejected', 'after', { kind: 'steer', text: effectiveInput, reason: lifecycle.decision.reason });
        continue;
      }
      if (lifecycle.decision.kind === 'stop') {
        await this.#emit('input.handled', 'after', { kind: 'steer', text: effectiveInput, reason: lifecycle.decision.reason });
        return 'stop';
      }
      if (effectiveInput !== steer.text) await this.#emit('input.transformed', 'after', { kind: 'steer', original: steer.text, text: effectiveInput });
      messages.push({ role: 'user', content: effectiveInput });
    }
    return 'continue';
  }
  async #runModelToolLoop(input: string, activeTurnId: ReturnType<typeof turnId>, signal: AbortSignal): Promise<string> {
    const messages: Array<ModelRequest['messages'][number]> = [...structuredClone(this.#history), { role: 'user', content: input }]; const effects = new Set<string>(); const maxIterations = this.#options.maxIterations ?? 16;
    const configuredMaxToolCalls = this.#options.maxToolCalls ?? 64;
    const maxToolCalls = Number.isSafeInteger(configuredMaxToolCalls) && configuredMaxToolCalls > 0 ? configuredMaxToolCalls : 64;
    const configuredAggregateResultBytes = this.#options.maxToolResultBytesPerTurn ?? DEFAULT_MAX_TOOL_RESULT_BYTES_PER_TURN;
    const maxAggregateResultBytes = Number.isSafeInteger(configuredAggregateResultBytes) && configuredAggregateResultBytes > 0
      ? configuredAggregateResultBytes
      : DEFAULT_MAX_TOOL_RESULT_BYTES_PER_TURN;
    let toolCallCount = 0;
    let modelVisibleToolResultBytes = 0;
    modelLoop: for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (signal.aborted) { this.#history = messages; return 'cancelled'; }
      if (this.#pendingSteers.length > 0 && await this.#applyPendingSteers(messages) === 'stop') {
        this.#history = messages;
        return 'stop';
      }
      const contextLifecycle = await this.#emit('context.preparing', 'before', { iteration, messages: structuredClone(messages) });
      if (contextLifecycle.decision.kind === 'deny' || contextLifecycle.decision.kind === 'stop') {
        this.#history = messages;
        return contextLifecycle.decision.kind;
      }
      if (!isRecord(contextLifecycle.payload) || !Array.isArray(contextLifecycle.payload['messages']) || !contextLifecycle.payload['messages'].every(isModelMessage)) {
        throw new RuntimeFailure('validation', 'context.preparing lifecycle payload requires valid messages');
      }
      const preparedMessages: ModelMessage[] = [
        ...structuredClone(contextLifecycle.payload['messages']),
        ...contextLifecycle.context.map((content): ModelMessage => ({ role: 'system', content })),
      ];
      const request = structuredClone({
        messages: preparedMessages,
        ...(this.#model === null ? {} : { model: this.#model }),
        ...(this.#thinking === null ? {} : { thinkingLevel: this.#thinking }),
        ...(this.#modelTools === undefined || this.#modelTools.length === 0 ? {} : { tools: this.#modelTools, toolChoice: 'auto' as const }),
      }) as ModelRequest;
      const configuredAttempts = this.#options.maxProviderAttempts ?? 3;
      const maxProviderAttempts = Number.isSafeInteger(configuredAttempts) && configuredAttempts > 0 ? configuredAttempts : 3;
      let result!: ModelResponse;
      let calls: { id: string; name: string; input: unknown }[] = [];
      let text: string[] = [];
      let messageId = '';
      let requestId = '';
      let requestStartedAt = 0;
      let firstDeltaAt: number | undefined;
      let successfulAttempt = 0;
      for (let providerAttempt = 1; providerAttempt <= maxProviderAttempts; providerAttempt += 1) {
        calls = [];
        text = [];
        messageId = `${activeTurnId}:message:${iteration + 1}:attempt:${providerAttempt}`;
        requestId = `${activeTurnId}:provider:${iteration + 1}:attempt:${providerAttempt}`;
        requestStartedAt = this.#now();
        firstDeltaAt = undefined;
        this.#providerRequests += 1;
        await this.#emit('provider.request-started', 'notification', { requestId, iteration, attempt: providerAttempt, maxAttempts: maxProviderAttempts });
        await this.#emit('message.started', 'notification', { requestId, messageId, role: 'assistant', iteration, attempt: providerAttempt });
        const attemptController = new AbortController();
        const abortAttempt = (): void => attemptController.abort(signal.reason);
        if (signal.aborted) abortAttempt();
        else signal.addEventListener('abort', abortAttempt, { once: true });
        this.#activeProviderAttempt = attemptController;
        let attempt;
        try {
          attempt = await awaitAbortable(
             () => this.#options.model.run(request, { signal: attemptController.signal, emit: async (delta) => { if (attemptController.signal.aborted) return; firstDeltaAt ??= this.#now(); if (delta.type === 'tool-call') calls.push({ id: delta.id, name: delta.name, input: delta.input }); else if (delta.type === 'text') text.push(delta.text); if (!attemptController.signal.aborted) await this.#emit('message.delta', 'notification', { ...delta, requestId, messageId, ...(delta.type === 'thinking' ? { segment: 'thinking' } : {}) }); } }),
            attemptController.signal,
          );
        } finally {
          signal.removeEventListener('abort', abortAttempt);
          if (this.#activeProviderAttempt === attemptController) this.#activeProviderAttempt = null;
        }
        if (attempt.kind === 'aborted') {
          const durationMs = Math.max(0, this.#now() - requestStartedAt);
          this.#providerCancellations += 1;
          observeAggregate(this.#providerDurationMs, durationMs);
          await this.#emit('message.ended', 'after', { requestId, messageId, status: 'cancelled' });
          if (!signal.aborted && this.#pendingSteers.length > 0) continue modelLoop;
          this.#history = messages;
          return 'cancelled';
        }
        if (attempt.kind === 'value') { result = attempt.value; successfulAttempt = providerAttempt; break; }
        const error = attempt.error;
        const retryable = error instanceof RuntimeFailure && error.retry === 'safe' && effects.size === 0 && providerAttempt < maxProviderAttempts;
        const configuredDelay = (error instanceof RuntimeFailure ? error.retryAfterMs : undefined) ?? this.#options.providerRetryDelayMs ?? 0;
        const delayMs = Number.isFinite(configuredDelay) ? Math.max(0, Math.min(configuredDelay, 30_000)) : 0;
        const durationMs = Math.max(0, this.#now() - requestStartedAt);
        const category = error instanceof RuntimeFailure ? error.category : 'provider';
        this.#providerFailures += 1;
        if (retryable) this.#providerRetries += 1;
        this.#providerErrors[category] = (this.#providerErrors[category] ?? 0) + 1;
        observeAggregate(this.#providerDurationMs, durationMs);
        await this.#emit('message.ended', 'after', { requestId, messageId, status: 'error', retrying: retryable });
        await this.#emit('provider.failed', 'after', { requestId, iteration, attempt: providerAttempt, maxAttempts: maxProviderAttempts, retrying: retryable, category, durationMs, delayMs, message: error instanceof Error ? error.message : 'Model provider failed' });
        if (!retryable) throw error;
        if (delayMs > 0) {
          const delayed = await awaitAbortable(() => new Promise<void>((resolve) => setTimeout(resolve, delayMs)), signal);
          if (delayed.kind === 'aborted') { this.#history = messages; return 'cancelled'; }
        }
      }
      const cachedInputTokens = result.usage.cachedInputTokens === undefined && this.#usage.cachedInputTokens === undefined
        ? undefined
        : (this.#usage.cachedInputTokens ?? 0) + (result.usage.cachedInputTokens ?? 0);
      const cacheWriteInputTokens = result.usage.cacheWriteInputTokens === undefined && this.#usage.cacheWriteInputTokens === undefined
        ? undefined
        : (this.#usage.cacheWriteInputTokens ?? 0) + (result.usage.cacheWriteInputTokens ?? 0);
      this.#usage = {
        inputTokens: this.#usage.inputTokens + result.usage.inputTokens,
        outputTokens: this.#usage.outputTokens + result.usage.outputTokens,
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
      };
      this.#revision += 1;
      const durationMs = Math.max(0, this.#now() - requestStartedAt);
      const ttftMs = firstDeltaAt === undefined ? undefined : Math.max(0, firstDeltaAt - requestStartedAt);
      this.#providerResponses += 1;
      observeAggregate(this.#providerDurationMs, durationMs);
      observeAggregate(this.#providerTtftMs, ttftMs);
      await this.#emit('provider.response-received', 'after', { requestId, iteration, attempt: successfulAttempt, maxAttempts: maxProviderAttempts, durationMs, ...(ttftMs === undefined ? {} : { ttftMs }), stop: result.stop, usage: result.usage });
      await this.#emit('context.usage-changed', 'notification', this.#usage);
      if (signal.aborted) { await this.#emit('message.ended', 'after', { requestId, messageId, status: 'cancelled' }); this.#history = messages; return 'cancelled'; }
      if (result.stop === 'error') {
        const failure = new RuntimeFailure('provider', 'Model provider returned an error stop', 'unknown');
        this.#providerFailures += 1;
        this.#providerErrors[failure.category] = (this.#providerErrors[failure.category] ?? 0) + 1;
        await this.#emit('message.ended', 'after', { requestId, messageId, status: 'error' });
        await this.#emit('provider.failed', 'after', { requestId, iteration, attempt: successfulAttempt, maxAttempts: maxProviderAttempts, retrying: false, category: failure.category, durationMs, delayMs: 0, message: failure.message });
        throw failure;
      }
      if ((result.stop === 'tool') !== (calls.length > 0)) {
        const failure = new RuntimeFailure(
          'adapter-translation',
          result.stop === 'tool'
            ? 'Model returned a tool stop without tool calls'
            : 'Model returned tool calls without a tool stop',
        );
        this.#providerFailures += 1;
        this.#providerErrors[failure.category] = (this.#providerErrors[failure.category] ?? 0) + 1;
        await this.#emit('message.ended', 'after', { requestId, messageId, status: 'error' });
        await this.#emit('provider.failed', 'after', { requestId, iteration, attempt: successfulAttempt, maxAttempts: maxProviderAttempts, retrying: false, category: failure.category, durationMs, delayMs: 0, message: failure.message });
        throw failure;
      }
      if (toolCallCount + calls.length > maxToolCalls) {
        const failure = new RuntimeFailure('model', `Model tool-call budget exceeded ${maxToolCalls}`);
        this.#providerFailures += 1;
        this.#providerErrors[failure.category] = (this.#providerErrors[failure.category] ?? 0) + 1;
        await this.#emit('message.ended', 'after', { requestId, messageId, status: 'error' });
        await this.#emit('provider.failed', 'after', { requestId, iteration, attempt: successfulAttempt, maxAttempts: maxProviderAttempts, retrying: false, category: failure.category, durationMs, delayMs: 0, message: failure.message });
        throw failure;
      }
      toolCallCount += calls.length;
      if (text.length > 0 || calls.length > 0) messages.push({ role: 'assistant', content: text.join(''), ...(calls.length === 0 ? {} : { toolCalls: structuredClone(calls) }) });
      await this.#emit('message.ended', 'after', { requestId, messageId, status: 'complete' });
      if (result.stop !== 'tool' || calls.length === 0) {
        if (this.#pendingSteers.length > 0) continue modelLoop;
        this.#history = messages;
        return result.stop;
      }
      const preparedCalls: Array<{
        call: { id: string; name: string; input: unknown };
        callId: ReturnType<typeof toolCallId>;
        lifecycle: LifecycleDispatchResult<unknown>;
      }> = [];
      const lifecycleContext: string[] = [];
      for (const [index, call] of calls.entries()) {
        const callId = toolCallId(call.id || `${activeTurnId}:${iteration}:${index}:${call.name}`); if (effects.has(callId)) throw new RuntimeFailure('internal-invariant', `Duplicate effect: ${callId}`); effects.add(callId);
        const lifecycle = await this.#emit('tool.requested', 'permission', { callId, name: call.name, input: call.input });
        if (typeof lifecycle.payload !== 'object' || lifecycle.payload === null || Array.isArray(lifecycle.payload)) throw new RuntimeFailure('validation', 'tool.requested lifecycle payload must be an object');
        const rewritten = lifecycle.payload as Record<string, unknown>;
        if (typeof rewritten['name'] !== 'string' || !rewritten['name'].trim()) throw new RuntimeFailure('validation', 'tool.requested lifecycle payload requires a non-empty name');
        if (!('input' in rewritten)) throw new RuntimeFailure('validation', 'tool.requested lifecycle payload requires input');
        call.name = rewritten['name'];
        call.input = rewritten['input'];
        try {
          const historyInput = structuredClone(call.input);
          const assistant = messages.at(-1);
          if (assistant?.role === 'assistant' && assistant.toolCalls !== undefined) {
            messages[messages.length - 1] = {
              ...assistant,
              toolCalls: assistant.toolCalls.map((historyCall, historyIndex) => historyIndex === index
                ? { ...historyCall, name: call.name, input: historyInput }
                : historyCall),
            };
          }
        } catch { /* Non-cloneable final input is rejected by admission without contaminating history. */ }
        lifecycleContext.push(...lifecycle.context);
        preparedCalls.push({ call, callId, lifecycle });
      }
      for (const { call, callId, lifecycle } of preparedCalls) {
        if (lifecycle.decision.kind === 'deny' || lifecycle.decision.kind === 'stop') {
          const content = { error: lifecycle.decision.reason, category: 'policy' };
          await this.#emit('tool.blocked', 'after', { callId, name: call.name, ...content });
          await this.#emit('tool.ended', 'after', { callId, name: call.name, outcome: 'blocked', ...content });
          messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify(content) });
          continue;
        }
        if (signal.aborted) { const payload = cancelledToolPayload(callId, call.name, 'Tool call cancelled before execution'); await this.#emit('tool.ended', 'after', payload); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify({ error: payload.error }) }); continue; }
        const definition = this.#options.tools?.get(call.name);
        if (definition === undefined) { const content = { error: `Unknown tool: ${call.name}`, category: 'unsupported-capability' }; await this.#emit('tool.blocked', 'after', { callId, name: call.name, ...content }); await this.#emit('tool.ended', 'after', { callId, name: call.name, outcome: 'blocked', ...content }); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify(content) }); continue; }
        const gate = await this.#gate(definition, call, callId, signal);
        if (!gate.allowed && gate.category === 'cancelled') { const payload = cancelledToolPayload(callId, call.name, gate.reason); await this.#emit('tool.ended', 'after', payload); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify({ error: payload.error }) }); continue; }
        if (!gate.allowed) { const content = { error: gate.reason, category: gate.category }; await this.#emit('tool.blocked', 'after', { callId, name: call.name, ...content }); await this.#emit('tool.ended', 'after', { callId, name: call.name, outcome: 'blocked', ...content }); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify(content) }); continue; }
        if (signal.aborted) { const payload = cancelledToolPayload(callId, call.name, 'Tool call cancelled before execution'); await this.#emit('tool.ended', 'after', payload); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify({ error: payload.error }) }); continue; }
        const effectKey = `${this.#options.sessionId}:${activeTurnId}:${callId}`;
        let receiptInput: unknown;
        try { receiptInput = structuredClone(call.input); }
        catch {
          const content = { error: 'Tool input cannot be bound to an admission receipt', category: 'validation' };
          await this.#emit('tool.blocked', 'after', { callId, name: call.name, ...content });
          await this.#emit('tool.ended', 'after', { callId, name: call.name, outcome: 'blocked', ...content });
          messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify(content) });
          continue;
        }
        const admissionReceipt: EffectAdmissionReceipt = {
          schemaVersion: 1,
          operation: `tool:${call.name}`,
          input: receiptInput,
          effects: gate.effects,
          policy: gate.policy,
        };
        let admission;
        try { admission = await this.#effectLedger.begin(effectKey, admissionReceipt); }
        catch (error) {
          if (!(error instanceof RuntimeFailure) || error.category !== 'validation') throw error;
          const content = { error: error.message, category: 'validation' };
          await this.#emit('tool.blocked', 'after', { callId, name: call.name, ...content });
          await this.#emit('tool.ended', 'after', { callId, name: call.name, outcome: 'blocked', ...content });
          messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify(content) });
          continue;
        }
        if (admission !== 'acquired') {
          const content = { error: `Effect ${callId} already has ledger state ${admission}`, category: 'conflict' };
          await this.#emit('tool.blocked', 'after', { callId, name: call.name, ...content });
          await this.#emit('tool.ended', 'after', { callId, name: call.name, outcome: 'blocked', ...content });
          messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify(content) });
          continue;
        }
        await this.#emit('tool.started', 'notification', { callId, name: call.name });
        let effectSettled = false;
        try {
           const execution = await awaitAbortable(() => definition.execute({
             input: call.input,
             callId,
              context: { sessionId: this.#options.sessionId, turnId: activeTurnId, cwd: this.#cwd, mode: this.#options.mode ?? 'headless', ...(this.#options.outputFormat === undefined ? {} : { outputFormat: this.#options.outputFormat }), trust: this.#options.trust ?? defaultTrust, signal },
             signal,
             update: async (update) => {
               if (signal.aborted) return;
               const invalid = updateError(update);
               if (invalid) throw new RuntimeFailure('validation', invalid);
               if (!signal.aborted) await this.#emit('tool.updated', 'notification', { callId, name: call.name, update });
             },
           }), signal);
           if (execution.kind === 'aborted') { await this.#effectLedger.settle(effectKey, 'uncertain'); const payload = cancelledToolPayload(callId, call.name, 'Tool call cancelled during execution'); await this.#emit('tool.ended', 'after', payload); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify({ error: payload.error }) }); continue; }
           if (execution.kind === 'error') throw execution.error;
           const toolResult = execution.value;
            if (signal.aborted) { await this.#effectLedger.settle(effectKey, 'uncertain'); const payload = cancelledToolPayload(callId, call.name, 'Tool call cancelled during execution'); await this.#emit('tool.ended', 'after', payload); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify({ error: payload.error }) }); continue; }
          const invalid = resultError(toolResult, definition);
          if (invalid) throw new RuntimeFailure('validation', invalid);
          const configuredMaxResultBytes = this.#options.maxToolResultBytes ?? 1024 * 1024;
          const maxResultBytes = Number.isSafeInteger(configuredMaxResultBytes) && configuredMaxResultBytes > 0
            ? configuredMaxResultBytes
            : 1024 * 1024;
            const serialized = serializeToolResult(toolResult, maxResultBytes);
            if (modelVisibleToolResultBytes + serialized.bytes > maxAggregateResultBytes) {
              throw new RuntimeFailure('tool-execution', `Aggregate tool-result budget exceeds ${maxAggregateResultBytes} bytes`);
            }
            modelVisibleToolResultBytes += serialized.bytes;
            await this.#effectLedger.settle(effectKey, toolResult.ok ? 'committed' : 'failed');
            effectSettled = true;
          await this.#emit('tool.ended', 'after', {
            callId,
            name: call.name,
            outcome: toolResult.ok ? 'success' : 'error',
            ...(toolResult.ok ? {} : { category: toolResult.category ?? 'tool-execution' }),
            result: toolResult,
          });
           messages.push({ role: 'tool', toolCallId: callId, content: serialized.content });
        }
        catch (error) { const failure = signal.aborted ? new RuntimeFailure('cancelled', 'Tool call cancelled during execution') : error instanceof RuntimeFailure ? error : new RuntimeFailure('tool-execution', error instanceof Error ? error.message : 'Tool failed'); if (!effectSettled) await this.#effectLedger.settle(effectKey, failure.category === 'cancelled' ? 'uncertain' : 'failed'); if (failure.category === 'cancelled') { const payload = cancelledToolPayload(callId, call.name, failure.message); await this.#emit('tool.ended', 'after', payload); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify({ error: payload.error }) }); } else { await this.#emit('tool.ended', 'after', { callId, name: call.name, outcome: 'error', category: failure.category, message: failure.message, error: failure.toJSON() }); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify({ error: failure.toJSON() }) }); } }
      }
      for (const context of lifecycleContext) messages.push({ role: 'system', content: context });
      if (signal.aborted) { this.#history = messages; return 'cancelled'; }
    }
    throw new RuntimeFailure('internal-invariant', `Model/tool loop exceeded ${maxIterations} iterations`);
  }
}
export const createRuntimeKernel = (options: RuntimeKernelOptions): AgentRuntime => new RuntimeKernel(options);
