import { RuntimeFailure } from "../contracts/errors.js";
import {
  assertModelToolResultV1,
  type ModelToolResultV1,
} from "../contracts/artifacts.js";
import {
  assertContextProjectionReceipt,
  contextSha256,
  type ContextProjectionReceiptV1,
} from "../contracts/context-artifacts.js";
import {
  eventId,
  toolCallId,
  turnId,
  type SessionId,
  type TurnId,
} from "../contracts/identity.js";
import type {
  AgentRuntime,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeCompactionPort,
  RuntimeContextTokenMeterPort,
  MonitoringSnapshotV1,
  NativeMonitoringContributionV1,
  NativeMonitoringPort,
  RuntimePlanPolicySnapshot,
  RuntimePlanStateProvider,
  RuntimePlanStateUpdater,
  RuntimeSnapshot,
} from "../contracts/runtime.js";
import type { ModelDefinition } from "../contracts/models.js";
import type {
  RuntimeEvent,
  RuntimeEventOf,
  RuntimeEventPayload,
  RuntimeMode,
  RuntimeOutputFormat,
  SessionForkReceiptV1,
  SessionStartedReceiptV1,
  ToolCancelledPayload,
  TrustSnapshot,
} from "../contracts/events.js";
import {
  isInputModelContextOverflow,
  type ModelMessage,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from "../contracts/ports.js";
import {
  assertRuntimeUserInputV1,
  runtimeUserInputAttachments,
  runtimeUserInputFromText,
  runtimeUserInputText,
  runtimeUserInputWithText,
  type RuntimeUserInputV1,
} from "../contracts/user-input.js";
import {
  createEffectSet,
  type EffectSet,
  type ToolDefinition,
  type ToolExecutionUpdate,
  type ToolAdmissionContextV1,
  type ToolConcurrencyLane,
  type WorkerAuthorityRootV1,
  type ToolPolicyMetadata,
  type ToolPolicyResolution,
  type ToolEffect,
  type ToolResult,
} from "../contracts/tools.js";
import type { LifecycleDispatchResult } from "../events/bus.js";
import {
  assertCheckpointEventPayloadV1,
  assertCheckpointEventV1,
  type CheckpointEventIngressPort,
  type CheckpointEventV1,
} from "../events/checkpoints.js";
import type { SemanticContextRuntimeOptions } from "../contracts/semantic-context.js";
import type {
  PermissionMode,
  ResolvedToolRisk,
} from "../contracts/permissions.js";
import { ToolRegistry } from "./registries.js";
import { PolicyChain } from "./policy.js";
import { jsonSchemaError } from "../schemas/json-schema.js";
import {
  InMemoryEffectLedger,
  createEffectAdmissionReceipt,
  type EffectAdmissionReceipt,
  type EffectLedgerPort,
} from "./effect-ledger.js";
import {
  insertSemanticContextBeforeCurrentUser,
  renderSemanticContext,
  semanticContextTokenBudget,
} from "./semantic-context.js";
import { resolvePermissionDecision } from "./permissions.js";

interface ToolGateRequest {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
  readonly policy: ToolPolicyResolution & Pick<ToolPolicyMetadata, "plan">;
  readonly lockTargets: readonly string[];
  readonly mode: RuntimeMode;
  readonly trust: TrustSnapshot;
  readonly signal: AbortSignal;
}
type ToolGateResult =
  | {
      readonly allowed: true;
      readonly effects: EffectSet;
      readonly policy: EffectAdmissionReceipt["policy"];
      readonly policyRevision: number;
    }
  | {
      readonly allowed: false;
      readonly category:
        | "validation"
        | "trust"
        | "approval"
        | "plan-policy"
        | "peer-lock"
        | "policy"
        | "cancelled";
      readonly reason: string;
    };
type ToolExecutionOutcome =
  | { kind: "value"; value: ToolResult }
  | { kind: "error"; error: unknown }
  | { kind: "aborted" }
  | { kind: "cancelled-before-start" };
interface RequestedToolCall {
  readonly call: { id: string; name: string; input: unknown };
  readonly callId: ReturnType<typeof toolCallId>;
  readonly lifecycle: LifecycleDispatchResult<unknown>;
}
interface QueuedInput {
  readonly kind: "follow-up" | "steer";
  readonly input: RuntimeUserInputV1;
}
export interface RuntimeKernelOptions {
  readonly sessionId: SessionId;
  readonly model: ModelPort;
  readonly compaction?: RuntimeCompactionPort;
  readonly compactionInputTokenThreshold?: number;
  readonly stablePrefixMessageCount?: number;
  readonly modelLimits?: ModelDefinition["limits"];
  readonly contextTokenMeter?: RuntimeContextTokenMeterPort;
  readonly compactionSafetyMarginTokens?: number;
  readonly compactionSoftLimitRatio?: number;
  readonly effectLedger?: EffectLedgerPort;
  readonly initialModel?: NonNullable<RuntimeSnapshot["model"]>;
  readonly validateModel?: (
    model: NonNullable<RuntimeSnapshot["model"]>,
  ) => string | undefined;
  readonly validateThinking?: (level: string) => string | undefined;
  readonly initialMessages?: readonly ModelMessage[];
  readonly initialContextEventIds?: readonly string[];
  readonly initialContextProjectionReceipt?: ContextProjectionReceiptV1;
  /** Runtime-authoritative, already-sanitized receipt emitted once when this kernel becomes active. */
  readonly initialSessionReceipt?: SessionStartedReceiptV1 | SessionForkReceiptV1;
  readonly tools?: ToolRegistry;
  readonly policy?: PolicyChain;
  readonly maxIterations?: number;
  readonly maxToolCalls?: number;
  readonly maxProviderAttempts?: number;
  readonly providerRetryDelayMs?: number;
  readonly maxQueuedInputs?: number;
  readonly maxToolResultBytes?: number;
  readonly maxToolResultBytesPerTurn?: number;
  readonly turnTimeoutMs?: number;
  readonly cwd?: string;
  readonly mode?: RuntimeMode;
  readonly outputFormat?: RuntimeOutputFormat;
  readonly trust?: TrustSnapshot;
  readonly permissionMode?: PermissionMode;
  /** Host-owned root used only to mint worker authority after tool effect admission. */
  readonly workerAuthorityRoot?: WorkerAuthorityRootV1;
  /** Legacy construction-time fallback. Prefer planState for live policy. */ readonly planActive?: boolean;
  readonly planState?: RuntimePlanStateProvider;
  readonly approve?: (request: ToolGateRequest) => Promise<boolean>;
  readonly checkPeerLocks?: (
    targets: readonly string[],
    request: ToolGateRequest,
  ) => Promise<boolean>;
  readonly emit?: (
    event: RuntimeEvent,
  ) => Promise<LifecycleDispatchResult<unknown> | void>;
  /** Grants the host a narrow ingress that can publish only validated checkpoint receipts. */
  readonly registerCheckpointEventIngress?: (ingress: CheckpointEventIngressPort) => void;
  readonly monitoring?: NativeMonitoringPort;
  readonly semanticContext?: SemanticContextRuntimeOptions;
  readonly now?: () => number;
  readonly createTurnId?: (sequence: number) => TurnId;
}

const defaultTrust: TrustSnapshot = {
  workspace: "unknown",
  managedOnly: false,
};
const DEFAULT_PLAN_POLICY_SNAPSHOT: RuntimePlanPolicySnapshot = Object.freeze({
  authority: "runtime",
  revision: 0,
  active: false,
});
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_TOOL_RESULT_BYTES_PER_TURN = 4 * 1024 * 1024;
const DEFAULT_COMPACTION_SOFT_LIMIT_RATIO = 0.9;
const DEFAULT_CONTEXT_SAFETY_RATIO = 0.05;
const TURN_DEADLINE_EXCEEDED = Symbol("turn-deadline-exceeded");
const DEFAULT_RUNTIME_CWD = "";
const DEFAULT_RUNTIME_NOW = Date.now;
const MAX_PARALLEL_TOOL_CALLS = 4;
const UTF8_ENCODER = new TextEncoder();
const utf8Bytes = (value: string): number =>
  UTF8_ENCODER.encode(value).byteLength;
const modelMessagesSize = (messages: readonly ModelMessage[]): number =>
  utf8Bytes(JSON.stringify(messages));
const sameModelMessages = (
  left: readonly ModelMessage[],
  right: readonly ModelMessage[],
): boolean => JSON.stringify(left) === JSON.stringify(right);

const TOOL_TRUST_REQUIREMENTS = new Set(["none", "workspace", "managed"]);
const TOOL_APPROVAL_REQUIREMENTS = new Set(["never", "on-request", "always"]);
const TOOL_PLAN_REQUIREMENTS = new Set(["allowed", "forbidden", "required"]);

function resolveToolPolicy(
  policy: ToolPolicyMetadata,
  input: unknown,
): ToolPolicyResolution & Pick<ToolPolicyMetadata, "plan"> {
  const capabilityCeiling = createEffectSet(...policy.effects);
  const candidate = policy.resolve === undefined ? policy : policy.resolve(input);
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
    throw new RuntimeFailure("validation", "Tool policy resolver returned an invalid policy");
  if (!Array.isArray(candidate.effects))
    throw new RuntimeFailure("validation", "Tool policy resolver did not return effects");
  const effects = createEffectSet(...(candidate.effects as readonly ToolEffect[]));
  if (
    effects.some(
      (effect) => effect !== "read" && !capabilityCeiling.includes(effect),
    )
  )
    throw new RuntimeFailure(
      "validation",
      "Tool policy resolver exceeded its registered capability ceiling",
    );
  if (!TOOL_TRUST_REQUIREMENTS.has(candidate.trust))
    throw new RuntimeFailure("validation", "Tool policy resolver returned an invalid trust requirement");
  if (!TOOL_APPROVAL_REQUIREMENTS.has(candidate.approval))
    throw new RuntimeFailure("validation", "Tool policy resolver returned an invalid approval requirement");
  if (!TOOL_PLAN_REQUIREMENTS.has(policy.plan))
    throw new RuntimeFailure("validation", "Tool policy has an invalid plan requirement");
  return Object.freeze({ effects, trust: candidate.trust, approval: candidate.approval, plan: policy.plan });
}

class PermitPool {
  readonly #waiters: Array<() => void> = [];
  #available: number;

  constructor(maximum: number) {
    this.#available = maximum;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#available === 0)
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    else this.#available -= 1;
    try {
      return await operation();
    } finally {
      const next = this.#waiters.shift();
      if (next === undefined) this.#available += 1;
      else next();
    }
  }
}

function concurrencyLane(
  definition: ToolDefinition,
  input: unknown,
): ToolConcurrencyLane | undefined {
  const lane = definition.policy.concurrency?.(input);
  if (lane === undefined) return undefined;
  if (
    typeof lane.lane !== "string" ||
    !lane.lane.trim() ||
    lane.lane.length > 256
  )
    throw new RuntimeFailure(
      "validation",
      "Tool concurrency lane must be a non-empty bounded string",
    );
  if (
    !Number.isSafeInteger(lane.maxActive) ||
    lane.maxActive < 1 ||
    lane.maxActive > MAX_PARALLEL_TOOL_CALLS
  )
    throw new RuntimeFailure(
      "validation",
      `Tool concurrency maxActive must be between 1 and ${MAX_PARALLEL_TOOL_CALLS}`,
    );
  return Object.freeze({ lane: lane.lane, maxActive: lane.maxActive });
}
interface MutableAggregate {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
}
const emptyAggregate = (): MutableAggregate => ({
  count: 0,
  sum: 0,
  min: null,
  max: null,
});
function observeAggregate(
  aggregate: MutableAggregate,
  value: number | undefined,
): void {
  if (value === undefined || !Number.isFinite(value)) return;
  const normalized = Math.max(0, value);
  aggregate.count += 1;
  aggregate.sum += normalized;
  aggregate.min =
    aggregate.min === null ? normalized : Math.min(aggregate.min, normalized);
  aggregate.max =
    aggregate.max === null ? normalized : Math.max(aggregate.max, normalized);
}
const isCounter = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function nativeMonitoringContribution(
  value: NativeMonitoringContributionV1 | undefined,
): NativeMonitoringContributionV1 | undefined {
  if (
    value === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  )
    return undefined;
  const cache = value.cache;
  if (
    cache === undefined ||
    !isCounter(cache.hits) ||
    !isCounter(cache.misses) ||
    !isCounter(cache.loads) ||
    !isCounter(cache.loadFailures) ||
    !isCounter(cache.expirations) ||
    !isCounter(cache.evictions) ||
    !isCounter(cache.entries) ||
    !isCounter(cache.maxEntries) ||
    cache.maxEntries === 0 ||
    cache.entries > cache.maxEntries ||
    !isCounter(cache.ttlMs) ||
    cache.ttlMs === 0
  )
    return undefined;
  return { cache: structuredClone(cache) };
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const modelToolResult = (value: unknown): ModelToolResultV1 | undefined => {
  if (!isRecord(value) || value["schemaVersion"] !== 1 || !Array.isArray(value["parts"]))
    return undefined;
  return assertModelToolResultV1(value);
};
const isModelToolCall = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["name"] === "string" &&
  "input" in value;
const isModelMessage = (value: unknown): value is ModelMessage => {
  if (!isRecord(value) || typeof value["content"] !== "string") return false;
  if (value["role"] === "system")
    return (
      value["toolCallId"] === undefined && value["toolCalls"] === undefined && value["userInput"] === undefined && value["result"] === undefined
    );
  if (value["role"] === "user") {
    if (value["toolCallId"] !== undefined || value["toolCalls"] !== undefined || value["result"] !== undefined) return false;
    if (value["userInput"] === undefined) return true;
    try {
      return runtimeUserInputText(assertRuntimeUserInputV1(value["userInput"])) === value["content"];
    } catch { return false; }
  }
  if (value["role"] === "assistant")
    return (
      value["toolCallId"] === undefined &&
      value["result"] === undefined &&
      (value["toolCalls"] === undefined ||
        (Array.isArray(value["toolCalls"]) &&
          value["toolCalls"].every(isModelToolCall)))
    );
  if (value["role"] !== "tool" || typeof value["toolCallId"] !== "string" || value["toolCalls"] !== undefined)
    return false;
  if (value["result"] === undefined) return true;
  try { return modelToolResult(value["result"]) !== undefined; }
  catch { return false; }
};

const sameRuntimeUserInput = (
  left: RuntimeUserInputV1,
  right: RuntimeUserInputV1,
): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * Lifecycle hooks historically rewrote model messages as role/content pairs.
 * Preserve the canonical input attached by the runtime when such a rewrite
 * targets the same message slot, updating only its text parts. An explicitly
 * replaced userInput still has to be valid and agree with content.
 */
const normalizeContextLifecycleMessages = (
  value: unknown,
  source: readonly ModelMessage[],
): ModelMessage[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const normalized: ModelMessage[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!isRecord(candidate) || typeof candidate["content"] !== "string")
      return undefined;
    const original = source[index];
    if (
      candidate["role"] === "user" &&
      original?.role === "user" &&
      original.userInput !== undefined
    ) {
      if (candidate["userInput"] === undefined) {
        const restored = {
          ...candidate,
          userInput: runtimeUserInputWithText(
            original.userInput,
            candidate["content"],
          ),
        };
        if (!isModelMessage(restored)) return undefined;
        normalized.push(restored);
        continue;
      }
      let rewrittenInput: RuntimeUserInputV1;
      try {
        rewrittenInput = assertRuntimeUserInputV1(candidate["userInput"]);
      } catch {
        return undefined;
      }
      if (
        runtimeUserInputText(rewrittenInput) !== candidate["content"] &&
        sameRuntimeUserInput(rewrittenInput, original.userInput)
      ) {
        const restored = {
          ...candidate,
          userInput: runtimeUserInputWithText(
            original.userInput,
            candidate["content"],
          ),
        };
        if (!isModelMessage(restored)) return undefined;
        normalized.push(restored);
        continue;
      }
    }
    if (!isModelMessage(candidate)) return undefined;
    normalized.push(candidate);
  }
  return normalized;
};

function normalizePlanPolicySnapshot(
  value: RuntimePlanPolicySnapshot,
): RuntimePlanPolicySnapshot {
  if (value?.authority !== "runtime")
    throw new RuntimeFailure(
      "validation",
      "Plan policy state requires runtime authority",
    );
  if (!Number.isSafeInteger(value.revision) || value.revision < 0)
    throw new RuntimeFailure(
      "validation",
      "Plan policy revision must be a non-negative integer",
    );
  if (typeof value.active !== "boolean")
    throw new RuntimeFailure(
      "validation",
      "Plan policy active state must be boolean",
    );
  return Object.freeze({
    authority: "runtime",
    revision: value.revision,
    active: value.active,
  });
}

export class LiveRuntimePlanState
  implements RuntimePlanStateProvider, RuntimePlanStateUpdater
{
  #current = DEFAULT_PLAN_POLICY_SNAPSHOT;

  snapshot(): RuntimePlanPolicySnapshot {
    return this.#current;
  }

  update(value: RuntimePlanPolicySnapshot): void {
    const next = normalizePlanPolicySnapshot(value);
    if (next.revision < this.#current.revision)
      throw new RuntimeFailure("conflict", "Plan policy revision is stale");
    if (next.revision === this.#current.revision) {
      if (next.active !== this.#current.active)
        throw new RuntimeFailure(
          "conflict",
          "Plan policy state cannot change at the same revision",
        );
      return;
    }
    this.#current = next;
  }
}
function cancelledToolPayload(
  callId: ToolCancelledPayload["callId"],
  name: string,
  message: string,
): ToolCancelledPayload {
  const error = new RuntimeFailure("cancelled", message).toJSON();
  return {
    callId,
    name,
    outcome: "cancelled",
    category: "cancelled",
    message,
    error,
  };
}
async function awaitAbortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "aborted" }
> {
  if (signal.aborted) return { kind: "aborted" };
  let onAbort!: () => void;
  const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const completed = Promise.resolve()
    .then(operation)
    .then(
      (value): { kind: "value"; value: T } => ({ kind: "value", value }),
      (error): { kind: "error"; error: unknown } => ({ kind: "error", error }),
    );
  try {
    return await Promise.race([completed, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
function updateError(update: ToolExecutionUpdate): string | undefined {
  if (!isRecord(update) || update.version !== 1)
    return "Tool update must use version 1";
  if (
    update.kind !== "progress" &&
    update.kind !== "status" &&
    update.kind !== "details"
  )
    return "Tool update kind is invalid";
  if (update.message !== undefined && typeof update.message !== "string")
    return "Tool update message must be a string";
  return undefined;
}
function resultError(
  result: unknown,
  definition: ToolDefinition,
): string | undefined {
  if (
    !isRecord(result) ||
    typeof result.ok !== "boolean" ||
    !Number.isInteger(result.detailsVersion)
  )
    return "Tool result envelope is invalid";
  if (result.detailsVersion !== definition.outputVersion)
    return `Tool result version must be ${definition.outputVersion}`;
  if (result.category !== undefined && typeof result.category !== "string")
    return "Tool result category must be a string";
  return jsonSchemaError(result.content, definition.outputSchema, "$.content");
}
function serializeToolResult(
  result: unknown,
  maxBytes: number,
): { readonly content: string; readonly bytes: number } {
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined)
      throw new TypeError("result serialized to undefined");
    const bytes = utf8Bytes(serialized);
    if (bytes > maxBytes)
      throw new RuntimeFailure(
        "tool-execution",
        `Tool result exceeds ${maxBytes} bytes`,
      );
    return { content: serialized, bytes };
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    throw new RuntimeFailure(
      "tool-execution",
      "Tool result is not JSON-serializable",
    );
  }
}
const PEER_CONTEXT_HEADER =
  "[provenance:peer-attributed-data; authority:untrusted-user-data]";
function modelVisiblePeerContext(text: string): string {
  return `${PEER_CONTEXT_HEADER}\n${text}`;
}
function effectFailureSettlement(
  failure: RuntimeFailure,
): "failed" | "uncertain" {
  return failure.category === "cancelled" || failure.retry !== "safe"
    ? "uncertain"
    : "failed";
}
export class RuntimeKernel implements AgentRuntime {
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  readonly #options: RuntimeKernelOptions;
  readonly #modelTools: ModelRequest["tools"];
  readonly #contextEventIds: Set<string>;
  readonly #effectLedger: EffectLedgerPort;
  readonly #cwd: string;
  readonly #now: () => number;
  readonly #queuedInputs: QueuedInput[] = [];
  readonly #pendingSteers: QueuedInput[] = [];
  readonly #externalOperations = new Set<string>();
  readonly #providerDurationMs = emptyAggregate();
  readonly #providerTtftMs = emptyAggregate();
  readonly #providerErrors: Record<string, number> = {};
  readonly #stablePrefix: readonly ModelMessage[];
  #history: ModelMessage[];
  #compaction: AbortController | null = null;
  #state: RuntimeSnapshot["state"] = "created";
  #active: AbortController | null = null;
  #activeProviderAttempt: AbortController | null = null;
  #activeTurn: Promise<void> | null = null;
  #activeTurnId: ReturnType<typeof turnId> | null = null;
  #queueDrain: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  #revision = 0;
  #model: RuntimeSnapshot["model"] = null;
  #thinking: string | null = null;
  #usage: RuntimeSnapshot["usage"] = { inputTokens: 0, outputTokens: 0 };
  #latestProviderInputTokens = 0;
  #automaticCompactionBackoffUntil = 0;
  #sequence = 0;
  #providerRequests = 0;
  #providerResponses = 0;
  #providerFailures = 0;
  #providerRetries = 0;
  #providerCancellations = 0;
  readonly #initialContextProjectionReceipt?: ContextProjectionReceiptV1;
  readonly #workerAuthorityRoot?: WorkerAuthorityRootV1;
  #initialContextProjectionReceiptEmitted = false;
  constructor(options: RuntimeKernelOptions) {
    if (options.workerAuthorityRoot !== undefined) {
      const authority = options.workerAuthorityRoot;
      if (
        typeof authority.rootAgentId !== "string" ||
        authority.rootAgentId.trim().length === 0 ||
        authority.rootAgentId.includes("\0") ||
        typeof authority.workspaceId !== "string" ||
        authority.workspaceId.trim().length === 0 ||
        authority.workspaceId.includes("\0") ||
        !Number.isSafeInteger(authority.workspaceGeneration) ||
        authority.workspaceGeneration < 0 ||
        !Number.isSafeInteger(authority.ownershipGeneration) ||
        authority.ownershipGeneration < 0
      ) {
        throw new RuntimeFailure("validation", "Worker authority root is invalid");
      }
      this.#workerAuthorityRoot = Object.freeze({ ...authority });
    }
    this.#options = options;
    this.#cwd = options.cwd ?? DEFAULT_RUNTIME_CWD;
    this.#now = options.now ?? DEFAULT_RUNTIME_NOW;
    this.#history = structuredClone([...(options.initialMessages ?? [])]);
    const stablePrefixMessageCount = options.stablePrefixMessageCount ?? 0;
    if (
      !Number.isSafeInteger(stablePrefixMessageCount) ||
      stablePrefixMessageCount < 0 ||
      stablePrefixMessageCount > this.#history.length
    ) {
      throw new RuntimeFailure(
        "validation",
        "Stable prefix message count must select an initial-message prefix",
      );
    }
    this.#stablePrefix = Object.freeze(
      structuredClone(this.#history.slice(0, stablePrefixMessageCount)),
    );
    this.#contextEventIds = new Set(options.initialContextEventIds ?? []);
    if (options.initialContextProjectionReceipt !== undefined) {
      const receipt = assertContextProjectionReceipt(
        options.initialContextProjectionReceipt,
      );
      if (receipt.phase !== "initial")
        throw new RuntimeFailure(
          "validation",
          "Initial context projection receipt must use the initial phase",
        );
      this.#initialContextProjectionReceipt = receipt;
    }
    this.#effectLedger =
      options.effectLedger ?? new InMemoryEffectLedger(this.#now);
    if (
      options.compactionInputTokenThreshold !== undefined &&
      (!Number.isSafeInteger(options.compactionInputTokenThreshold) ||
        options.compactionInputTokenThreshold <= 0)
    ) {
      throw new RuntimeFailure(
        "validation",
        "Compaction input-token threshold must be a positive integer",
      );
    }
    if (
      options.compactionSafetyMarginTokens !== undefined &&
      (!Number.isSafeInteger(options.compactionSafetyMarginTokens) ||
        options.compactionSafetyMarginTokens < 0)
    ) {
      throw new RuntimeFailure(
        "validation",
        "Compaction safety margin must be a non-negative integer",
      );
    }
    if (
      options.compactionSoftLimitRatio !== undefined &&
      (!Number.isFinite(options.compactionSoftLimitRatio) ||
        options.compactionSoftLimitRatio <= 0 ||
        options.compactionSoftLimitRatio > 1)
    ) {
      throw new RuntimeFailure(
        "validation",
        "Compaction soft-limit ratio must be greater than zero and at most one",
      );
    }
    for (const [name, value] of Object.entries(options.modelLimits ?? {})) {
      if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new RuntimeFailure(
          "validation",
          `Model ${name} limit must be a positive integer or null`,
        );
      }
    }
    if (
      options.maxIterations !== undefined &&
      (!Number.isSafeInteger(options.maxIterations) ||
        options.maxIterations <= 0)
    ) {
      throw new RuntimeFailure(
        "validation",
        "Model/tool loop iteration limit must be a positive integer",
      );
    }
    const tools = options.tools
      ?.list()
      .map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
    this.#modelTools = tools === undefined ? undefined : structuredClone(tools);
    this.#model = options.initialModel ?? null;
    options.registerCheckpointEventIngress?.(Object.freeze({
      emit: async (event: CheckpointEventV1) => this.#ingestCheckpointEvent(event),
    }));
  }
  async start(): Promise<void> {
    if (this.#state !== "created") return;
    this.#state = "starting";
    await this.#emit("runtime.ready", "notification", {});
    if (this.#options.initialSessionReceipt !== undefined) {
      const receipt = this.#options.initialSessionReceipt;
      if (receipt.transition === "fork")
        await this.#emit("session.forked", "notification", receipt);
      else await this.#emit("session.started", "notification", receipt);
    }
    if (
      this.#initialContextProjectionReceipt !== undefined &&
      !this.#initialContextProjectionReceiptEmitted
    ) {
      this.#initialContextProjectionReceiptEmitted = true;
      await this.#emit(
        "context.artifacts-projected",
        "notification",
        this.#initialContextProjectionReceipt,
      );
    }
    if (this.#state === "starting") {
      this.#state = "ready";
      this.#revision += 1;
    }
  }
  async submit(input: string | RuntimeUserInputV1): Promise<void> {
    if (this.#state !== "created" && this.#state !== "ready")
      throw new RuntimeFailure(
        "internal-invariant",
        `Runtime cannot submit while ${this.#state}`,
      );
    const controller = new AbortController();
    const configuredTimeout =
      this.#options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const timeoutMs =
      Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_TURN_TIMEOUT_MS;
    const deadline = setTimeout(
      () => controller.abort(TURN_DEADLINE_EXCEEDED),
      timeoutMs,
    );
    this.#active = controller;
    const normalizedInput = typeof input === "string" ? runtimeUserInputFromText(input) : assertRuntimeUserInputV1(input);
    const turn = this.#startAndSubmit(normalizedInput, controller);
    this.#activeTurn = turn;
    try {
      await turn;
    } finally {
      clearTimeout(deadline);
      if (this.#activeTurn === turn) this.#activeTurn = null;
      if (this.#active === controller) this.#active = null;
      this.#scheduleQueueDrain();
    }
  }
  async #startAndSubmit(
    input: RuntimeUserInputV1,
    controller: AbortController,
  ): Promise<void> {
    if (this.#state === "created") await this.start();
    if (
      controller.signal.aborted &&
      (this.#state === "stopping" || this.#state === "stopped")
    )
      return;
    if (this.#state !== "ready")
      throw new RuntimeFailure(
        "internal-invariant",
        `Runtime cannot submit while ${this.#state}`,
      );
    await this.#submitTurn(input, controller);
  }
  async #submitTurn(input: RuntimeUserInputV1, controller: AbortController): Promise<void> {
    this.#state = "running";
    this.#revision += 1;
    const id =
      this.#options.createTurnId?.(this.#sequence + 1) ??
      turnId(`turn:${this.#sequence + 1}`);
    this.#activeTurnId = id;
    let stop: string = "error";
    let agentStarted = false;
    const abortStop = (): "cancelled" | "timeout" =>
      controller.signal.reason === TURN_DEADLINE_EXCEEDED
        ? "timeout"
        : "cancelled";
    try {
      const lifecycle = await this.#emit("input.received", "before", {
        text: runtimeUserInputText(input),
        attachments: runtimeUserInputAttachments(input),
      });
      if (
        !isRecord(lifecycle.payload) ||
        typeof lifecycle.payload["text"] !== "string"
      )
        throw new RuntimeFailure(
          "validation",
          "input.received lifecycle payload requires text",
        );
      const effectiveInput = runtimeUserInputWithText(input, lifecycle.payload["text"]);
      const effectiveText = runtimeUserInputText(effectiveInput);
      await this.#emit("turn.started", "notification", { turnId: id });
      if (lifecycle.decision.kind === "deny") {
        stop = "deny";
        await this.#emit("input.rejected", "after", {
          text: effectiveText,
          attachments: runtimeUserInputAttachments(effectiveInput),
          reason: lifecycle.decision.reason,
        });
      } else if (lifecycle.decision.kind === "stop") {
        stop = "stop";
        await this.#emit("input.handled", "after", {
           text: effectiveText,
          reason: lifecycle.decision.reason,
        });
      } else if (controller.signal.aborted) stop = abortStop();
      else {
        if (effectiveText !== runtimeUserInputText(input))
          await this.#emit("input.transformed", "after", {
            original: runtimeUserInputText(input),
            text: effectiveText,
          });
        await this.#emit("agent.started", "notification", { turnId: id });
        agentStarted = true;
        stop = await this.#runModelToolLoop(
          effectiveInput,
          id,
          controller.signal,
          lifecycle.context,
        );
        if (!controller.signal.aborted) await this.#maybeAutoCompact();
        if (stop === "cancelled") stop = abortStop();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.#state = "failed";
        await this.#emit("runtime.failed", "notification", {
          message: error instanceof Error ? error.message : "Model failed",
        });
        throw error;
      }
      stop = abortStop();
    } finally {
      if (this.#state === "running") this.#state = "ready";
      this.#revision += 1;
      try {
        if (agentStarted)
          await this.#emit("agent.ended", "after", { turnId: id, stop });
      } finally {
        try {
          await this.#emit("turn.ended", "after", { turnId: id, stop });
        } finally {
          this.#activeTurnId = null;
        }
      }
    }
  }
  async cancel(reason = "cancelled"): Promise<void> {
    this.#active?.abort(reason);
  }
  async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    try {
      switch (command.type) {
        case "input.submit":
          await this.submit(command.input ?? command.text);
          return { ok: true };
        case "input.follow-up":
          return await this.#enqueueInput({
            kind: "follow-up",
            input: command.input ?? runtimeUserInputFromText(command.text),
          });
        case "input.steer": {
          if (this.#state !== "running" || this.#active === null)
            return {
              ok: false,
              error: new RuntimeFailure(
                "conflict",
                "input.steer requires an active turn",
              ).toJSON(),
            };
          const queued = await this.#enqueueSteer(command.input ?? runtimeUserInputFromText(command.text));
          if (queued.ok) this.#activeProviderAttempt?.abort("steered");
          return queued;
        }
        case "input.cancel":
          await this.cancel(command.reason);
          return { ok: true };
        case "context.append": {
          const eventId = command.eventId.trim();
          const text = command.text.trim();
          if (!eventId || !text)
            return {
              ok: false,
              error: new RuntimeFailure(
                "validation",
                "External context requires a non-empty eventId and text",
              ).toJSON(),
            };
          const modelText = modelVisiblePeerContext(text);
          if (utf8Bytes(modelText) > 16_384)
            return {
              ok: false,
              error: new RuntimeFailure(
                "validation",
                "External context exceeds 16384 bytes",
              ).toJSON(),
            };
          if (this.#contextEventIds.has(eventId))
            return { ok: true, data: { duplicate: true } };
          this.#contextEventIds.add(eventId);
          this.#history.push({ role: "user", content: modelText });
          this.#revision += 1;
          try {
            await this.#emit("context.appended", "after", {
              eventId,
              text: modelText,
              provenance: command.provenance,
            });
          } catch (error) {
            this.#contextEventIds.delete(eventId);
            this.#history.pop();
            this.#revision -= 1;
            throw error;
          }
          return { ok: true, data: { duplicate: false } };
        }
        case "model.select": {
          if (this.#state === "running")
            return {
              ok: false,
              error: new RuntimeFailure(
                "conflict",
                "Cannot change model during an active turn",
              ).toJSON(),
            };
          if (!command.providerId.trim() || !command.modelId.trim())
            return {
              ok: false,
              error: new RuntimeFailure(
                "validation",
                "Model provider and id must be non-empty",
              ).toJSON(),
            };
          const next = {
            providerId: command.providerId,
            modelId: command.modelId,
          };
          const unsupported = this.#options.validateModel?.(next);
          if (unsupported)
            return {
              ok: false,
              error: new RuntimeFailure(
                "unsupported-capability",
                unsupported,
              ).toJSON(),
            };
          this.#model = next;
          this.#revision += 1;
          await this.#emit("model.selected", "notification", this.#model);
          return { ok: true };
        }
        case "model.thinking": {
          if (this.#state === "running")
            return {
              ok: false,
              error: new RuntimeFailure(
                "conflict",
                "Cannot change thinking level during an active turn",
              ).toJSON(),
            };
          const unsupported = this.#options.validateThinking?.(command.level);
          if (unsupported)
            return {
              ok: false,
              error: new RuntimeFailure(
                "unsupported-capability",
                unsupported,
              ).toJSON(),
            };
          this.#thinking = command.level;
          this.#revision += 1;
          await this.#emit("model.thinking-level-selected", "notification", {
            level: command.level,
          });
          return { ok: true };
        }
        case "context.compact": {
          if (this.#options.compaction === undefined)
            return {
              ok: false,
              error: new RuntimeFailure(
                "unsupported-capability",
                "Context compaction requires a composed service",
              ).toJSON(),
            };
          if (this.#state === "running" || this.#compaction !== null)
            return {
              ok: false,
              error: new RuntimeFailure(
                "conflict",
                "Context compaction requires an idle runtime",
              ).toJSON(),
            };
          return await this.#compact(command.reason);
        }
        case "context.cancel-compaction": {
          if (this.#compaction === null)
            return {
              ok: false,
              error: new RuntimeFailure(
                "conflict",
                "No compaction is active",
              ).toJSON(),
            };
          this.#compaction.abort("Compaction cancelled");
          await this.#options.compaction?.cancel?.("Compaction cancelled");
          return { ok: true };
        }
        case "context.usage":
        case "runtime.snapshot":
          return { ok: true, data: this.snapshot() };
        case "monitoring.snapshot":
          return { ok: true, data: this.monitoringSnapshot() };
        case "tool.execute":
          return await this.#executeRuntimeTool(command);
        case "tools.list":
          return {
            ok: true,
            data:
              this.#options.tools
                ?.list()
                .map(({ name, label, description, policy }) => ({
                  name,
                  label,
                  description,
                  policy: {
                    effects: createEffectSet(...policy.effects),
                    trust: policy.trust,
                    approval: policy.approval,
                    plan: policy.plan,
                  },
                })) ?? [],
          };
        case "runtime.stop":
          await this.stop();
          return { ok: true };
        default:
          return {
            ok: false,
            error: new RuntimeFailure(
              "unsupported-capability",
              `Command ${command.type} requires a composed service`,
            ).toJSON(),
          };
      }
    } catch (error) {
      const failure =
        error instanceof RuntimeFailure
          ? error
          : new RuntimeFailure(
              "internal-invariant",
              error instanceof Error ? error.message : "Runtime command failed",
            );
      return { ok: false, error: failure.toJSON() };
    }
  }
  async #compact(
    reason: "manual" | "threshold" | "overflow",
  ): Promise<RuntimeCommandResult> {
    const compacted = await this.#compactMessages(reason, this.#history);
    return { ok: true, data: { summary: compacted.summary } };
  }
  async #compactMessages(
    reason: "manual" | "threshold" | "overflow",
    sourceMessages: readonly ModelMessage[],
  ): Promise<{ readonly summary: string; readonly messages: readonly ModelMessage[] }> {
    const compaction = this.#options.compaction;
    if (compaction === undefined)
      throw new RuntimeFailure(
        "unsupported-capability",
        "Context compaction requires a composed service",
      );
    const controller = new AbortController();
    this.#compaction = controller;
    const preCompact = await this.#emit("context.compaction-started", "notification", { reason });
    try {
      if (preCompact.decision.kind === "stop" || preCompact.decision.kind === "deny") {
        throw new RuntimeFailure("compaction", preCompact.decision.reason, "safe");
      }
      const compacted = await compaction.compact({
        reason,
        messages: structuredClone([...sourceMessages]),
        stablePrefix: structuredClone([...this.#stablePrefix]),
        context: Object.freeze([...preCompact.context]),
        signal: controller.signal,
      });
      if (controller.signal.aborted)
        throw new RuntimeFailure("cancelled", "Compaction cancelled");
      const contextProjectionReceipt =
        compacted.contextProjectionReceipt === undefined
          ? undefined
          : assertContextProjectionReceipt(compacted.contextProjectionReceipt);
      if (
        contextProjectionReceipt !== undefined &&
        contextProjectionReceipt.phase !== "compaction"
      )
        throw new RuntimeFailure(
          "validation",
          "Compaction context projection receipt must use the compaction phase",
        );
      const compactedPrefix = compacted.messages.slice(0, this.#stablePrefix.length);
      if (!sameModelMessages(compactedPrefix, this.#stablePrefix))
        throw new RuntimeFailure(
          "compaction",
          "Compaction changed the stable prompt prefix",
          "safe",
        );
      this.#history = structuredClone([...compacted.messages]);
      this.#latestProviderInputTokens = 0;
      this.#automaticCompactionBackoffUntil = 0;
      this.#revision += 1;
      if (contextProjectionReceipt !== undefined)
        await this.#emit(
          "context.artifacts-projected",
          "after",
          contextProjectionReceipt,
        );
      await this.#emit("context.compacted", "after", {
        reason,
        summary: compacted.summary,
      });
      return {
        summary: compacted.summary,
        messages: structuredClone([...compacted.messages]),
      };
    } catch (error) {
      const failure =
        error instanceof RuntimeFailure
          ? error
          : new RuntimeFailure(
              "compaction",
              error instanceof Error ? error.message : "Compaction failed",
            );
      await this.#emit("context.compaction-failed", "after", {
        reason,
        category: failure.category,
        message: failure.message,
      });
      throw failure;
    } finally {
      this.#compaction = null;
    }
  }
  #preflightBudget(): {
    readonly triggerTokens: number;
    readonly hardLimitTokens?: number;
  } | null {
    const absoluteThreshold = this.#options.compactionInputTokenThreshold;
    const contextLimit = this.#options.modelLimits?.context;
    if (contextLimit === null || contextLimit === undefined) {
      return absoluteThreshold === undefined
        ? null
        : { triggerTokens: absoluteThreshold };
    }
    const outputReserve = this.#options.modelLimits?.output ?? 0;
    const safetyMargin =
      this.#options.compactionSafetyMarginTokens ??
      Math.ceil(contextLimit * DEFAULT_CONTEXT_SAFETY_RATIO);
    const hardLimitTokens = Math.max(
      1,
      contextLimit - outputReserve - safetyMargin,
    );
    const softLimitTokens = Math.max(
      1,
      Math.floor(
        hardLimitTokens *
          (this.#options.compactionSoftLimitRatio ??
            DEFAULT_COMPACTION_SOFT_LIMIT_RATIO),
      ),
    );
    return {
      triggerTokens:
        absoluteThreshold === undefined
          ? softLimitTokens
          : Math.min(absoluteThreshold, softLimitTokens),
      hardLimitTokens,
    };
  }
  async #measureContextTokens(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<number | null> {
    const meter = this.#options.contextTokenMeter;
    if (meter === undefined) return null;
    const measured = await awaitAbortable(
      () => Promise.resolve(meter.measure(request, { signal })),
      signal,
    );
    if (measured.kind === "aborted") return null;
    if (measured.kind === "error") throw measured.error;
    if (!Number.isSafeInteger(measured.value) || measured.value < 0)
      throw new RuntimeFailure(
        "adapter-translation",
        "Context token meter returned an invalid token count",
      );
    return measured.value;
  }
  async #maybeAutoCompact(): Promise<void> {
    const threshold = this.#options.compactionInputTokenThreshold;
    if (
      this.#options.compaction === undefined ||
      threshold === undefined ||
      this.#compaction !== null
    )
      return;
    if (
      this.#latestProviderInputTokens <
      Math.max(threshold, this.#automaticCompactionBackoffUntil)
    )
      return;
    try {
      await this.#compact("threshold");
    } catch {
      this.#automaticCompactionBackoffUntil = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#latestProviderInputTokens + threshold,
      );
      // Automatic compaction is maintenance at a turn safe point. Its typed
      // failure event is observable, but a completed user turn remains valid.
      // Require another threshold of context growth before retrying so an
      // unavailable summarizer cannot create a retry storm on every turn.
    }
  }
  snapshot(): RuntimeSnapshot {
    return {
      schemaVersion: 1,
      state: this.#state,
      sessionId: this.#options.sessionId,
      activeTurn: this.#active !== null,
      model: this.#model,
      thinkingLevel: this.#thinking,
      usage: this.#usage,
      revision: this.#revision,
    };
  }
  monitoringSnapshot(): MonitoringSnapshotV1 {
    const native = nativeMonitoringContribution(
      this.#options.monitoring?.snapshot(),
    );
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
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#stopping !== null) return this.#stopping;
    this.#stopping = this.#stop();
    return this.#stopping;
  }
  async #stop(): Promise<void> {
    this.#state = "stopping";
    this.#active?.abort("runtime stopping");
    this.#activeProviderAttempt?.abort("runtime stopping");
    this.#compaction?.abort("runtime stopping");
    await this.#options.compaction?.cancel?.("runtime stopping");
    const queued = [
      ...this.#pendingSteers.splice(0),
      ...this.#queuedInputs.splice(0),
    ];
    for (const input of queued)
      await this.#emit("input.rejected", "after", {
        kind: input.kind,
        text: runtimeUserInputText(input.input),
        attachments: runtimeUserInputAttachments(input.input),
        reason: "runtime stopping",
      });
    await this.#emit("runtime.stopping", "notification", {});
    await this.#activeTurn;
    await this.#queueDrain;
    this.#state = "stopped";
    this.#revision += 1;
    await this.#emit("runtime.stopped", "notification", {});
  }
  async #enqueueInput(
    input: QueuedInput,
    front = false,
  ): Promise<RuntimeCommandResult> {
    if (
      this.#state === "stopping" ||
      this.#state === "stopped" ||
      this.#state === "failed"
    )
      return {
        ok: false,
        error: new RuntimeFailure(
          "conflict",
          `Cannot queue ${input.kind} while runtime is ${this.#state}`,
        ).toJSON(),
      };
    const configured = this.#options.maxQueuedInputs ?? 16;
    const limit =
      Number.isInteger(configured) && configured > 0 ? configured : 16;
    if (this.#queuedInputs.length + this.#pendingSteers.length >= limit) {
      await this.#emit("input.rejected", "after", {
        kind: input.kind,
        text: runtimeUserInputText(input.input),
        attachments: runtimeUserInputAttachments(input.input),
        reason: "input queue full",
        limit,
      });
      return {
        ok: false,
        error: new RuntimeFailure(
          "conflict",
          `Input queue is full (${limit})`,
        ).toJSON(),
      };
    }
    if (front) this.#queuedInputs.unshift(input);
    else this.#queuedInputs.push(input);
    const position = front ? 1 : this.#queuedInputs.length;
    await this.#emit("input.queued", "notification", {
      kind: input.kind,
      text: runtimeUserInputText(input.input),
      attachments: runtimeUserInputAttachments(input.input),
      position,
    });
    this.#scheduleQueueDrain();
    return { ok: true, data: { queued: true, kind: input.kind, position } };
  }
  async #enqueueSteer(input: RuntimeUserInputV1): Promise<RuntimeCommandResult> {
    const configured = this.#options.maxQueuedInputs ?? 16;
    const limit =
      Number.isInteger(configured) && configured > 0 ? configured : 16;
    if (this.#queuedInputs.length + this.#pendingSteers.length >= limit) {
      await this.#emit("input.rejected", "after", {
        kind: "steer",
        text: runtimeUserInputText(input),
        attachments: runtimeUserInputAttachments(input),
        reason: "input queue full",
        limit,
      });
      return {
        ok: false,
        error: new RuntimeFailure(
          "conflict",
          `Input queue is full (${limit})`,
        ).toJSON(),
      };
    }
    this.#pendingSteers.push({ kind: "steer", input });
    const position = this.#pendingSteers.length;
    await this.#emit("input.queued", "notification", {
      kind: "steer",
      text: runtimeUserInputText(input),
      attachments: runtimeUserInputAttachments(input),
      position,
    });
    return { ok: true, data: { queued: true, kind: "steer", position } };
  }
  #scheduleQueueDrain(): void {
    if (
      this.#queueDrain !== null ||
      this.#queuedInputs.length === 0 ||
      (this.#state !== "created" && this.#state !== "ready")
    )
      return;
    const drain = this.#drainQueue();
    this.#queueDrain = drain;
    void drain.finally(() => {
      if (this.#queueDrain === drain) this.#queueDrain = null;
      this.#scheduleQueueDrain();
    });
  }
  async #drainQueue(): Promise<void> {
    while (
      this.#queuedInputs.length > 0 &&
      (this.#state === "created" || this.#state === "ready")
    ) {
      const next = this.#queuedInputs.shift()!;
      try {
        await this.submit(next.input);
      } catch {
        const rejected = this.#queuedInputs.splice(0);
        for (const input of rejected) {
          await this.#emit("input.rejected", "after", {
            kind: input.kind,
            text: runtimeUserInputText(input.input),
            attachments: runtimeUserInputAttachments(input.input),
            reason: "earlier queued input failed",
          });
        }
        return;
      }
    }
  }
  async #emit<TType extends RuntimeEvent["type"]>(
    type: TType,
    phase: RuntimeEvent["phase"],
    payload: RuntimeEventPayload<TType>,
    validateRewritten?: (payload: unknown) => void,
  ): Promise<LifecycleDispatchResult<unknown>> {
    const event = {
      schemaVersion: 1,
      eventVersion: 1,
      id: eventId(`runtime:${++this.#sequence}`),
      type,
      phase,
      sessionId: this.#options.sessionId,
      ...(this.#activeTurnId === null ? {} : { turnId: this.#activeTurnId }),
      timestamp: this.#now(),
      cwd: this.#cwd,
      mode: this.#options.mode ?? "headless",
      ...(this.#options.outputFormat === undefined
        ? {}
        : { outputFormat: this.#options.outputFormat }),
      ...(this.#model === null ? {} : { model: this.#model }),
      trust: this.#options.trust ?? defaultTrust,
      payload,
    } as RuntimeEventOf<TType>;
    const result = (await this.#options.emit?.(event)) ?? {
      payload,
      decision: { kind: "continue" as const },
      context: [],
      suppressed: false,
      receipts: [],
    };
    validateRewritten?.(result.payload);
    const effectiveEvent: RuntimeEvent =
      result.payload === event.payload
        ? event
        : ({ ...event, payload: result.payload } as RuntimeEvent);
    if (!result.suppressed) {
      for (const listener of this.#listeners) {
        try {
          listener(effectiveEvent);
        } catch {
          /* Presentation observers cannot change durable runtime outcomes. */
        }
      }
    }
    return result;
  }

  async #ingestCheckpointEvent(value: CheckpointEventV1): Promise<void> {
    const event = assertCheckpointEventV1(value);
    if (this.#state !== "ready" && this.#state !== "running")
      throw new RuntimeFailure("validation", "Checkpoint event ingress is not active");
    switch (event.type) {
      case "checkpoint.prepared":
        await this.#emit(event.type, "notification", {
          schemaVersion: event.schemaVersion,
          transition: event.transition,
        }, (payload) => { assertCheckpointEventPayloadV1(event.type, payload); });
        return;
      case "checkpoint.recovered":
        await this.#emit(event.type, "notification", {
          schemaVersion: event.schemaVersion,
          recovery: event.recovery,
        }, (payload) => { assertCheckpointEventPayloadV1(event.type, payload); });
        return;
      case "rewind.prepared":
        await this.#emit(event.type, "notification", {
          schemaVersion: event.schemaVersion,
          transition: event.transition,
        }, (payload) => { assertCheckpointEventPayloadV1(event.type, payload); });
        return;
      case "rewind.completed":
        await this.#emit(event.type, "notification", {
          schemaVersion: event.schemaVersion,
          recovery: event.recovery,
        }, (payload) => { assertCheckpointEventPayloadV1(event.type, payload); });
    }
  }
  async #gate(
    definition: ToolDefinition,
    call: { id: string; name: string; input: unknown },
    callId: string,
    signal: AbortSignal,
  ): Promise<ToolGateResult> {
    if (signal.aborted)
      return {
        allowed: false,
        category: "cancelled",
        reason: "Tool call cancelled before policy evaluation",
      };
    const trust = this.#options.trust ?? defaultTrust;
    const inputFailure = jsonSchemaError(call.input, definition.inputSchema);
    if (inputFailure)
      return { allowed: false, category: "validation", reason: inputFailure };
    let resolvedPolicy: ToolPolicyResolution & Pick<ToolPolicyMetadata, "plan">;
    try {
      resolvedPolicy = resolveToolPolicy(definition.policy, call.input);
    } catch (error) {
      return {
        allowed: false,
        category: "validation",
        reason:
          error instanceof Error ? error.message : "Tool policy could not be resolved",
      };
    }
    if (
      resolvedPolicy.trust === "workspace" &&
      trust.workspace !== "trusted"
    )
      return {
        allowed: false,
        category: "trust",
        reason: "Tool requires a trusted workspace",
      };
    if (
      resolvedPolicy.trust === "managed" &&
      (!trust.managedOnly || trust.workspace !== "trusted")
    )
      return {
        allowed: false,
        category: "trust",
        reason: "Tool requires a trusted managed workspace",
      };
    let planState: RuntimePlanPolicySnapshot;
    try {
      planState =
        this.#options.planState === undefined
          ? Object.freeze({
              ...DEFAULT_PLAN_POLICY_SNAPSHOT,
              active: this.#options.planActive === true,
            })
          : normalizePlanPolicySnapshot(this.#options.planState.snapshot());
    } catch {
      if (resolvedPolicy.plan !== "allowed")
        return {
          allowed: false,
          category: "plan-policy",
          reason: "Authoritative plan state is unavailable",
        };
      planState = DEFAULT_PLAN_POLICY_SNAPSHOT;
    }
    if (resolvedPolicy.plan === "required" && !planState.active)
      return {
        allowed: false,
        category: "plan-policy",
        reason: "Tool requires an active plan",
      };
    if (resolvedPolicy.plan === "forbidden" && planState.active)
      return {
        allowed: false,
        category: "plan-policy",
        reason: "Tool is forbidden while a plan is active",
      };
    let lockTargets: readonly string[] = [];
    try {
      lockTargets = definition.policy.lockTarget?.(call.input) ?? [];
    } catch {
      return {
        allowed: false,
        category: "validation",
        reason: "Tool lock targets could not be derived",
      };
    }
    const request: ToolGateRequest = {
      callId,
      name: call.name,
      input: call.input,
      policy: resolvedPolicy,
      lockTargets,
      mode: this.#options.mode ?? "headless",
      trust,
      signal,
    };
    if (lockTargets.length > 0) {
      if (!this.#options.checkPeerLocks)
        return {
          allowed: false,
          category: "peer-lock",
          reason: "Tool requires peer-lock verification",
        };
      try {
        if (!(await this.#options.checkPeerLocks(lockTargets, request)))
          return {
            allowed: false,
            category: "peer-lock",
            reason: "Tool conflicts with a peer lock",
          };
      } catch {
        return {
          allowed: false,
          category: "peer-lock",
          reason: "Peer-lock verification failed",
        };
      }
    }
    const policyChain = this.#options.policy ?? new PolicyChain();
    const policy = await policyChain.evaluate({
      operation: `tool:${call.name}`,
      trust,
      effects: resolvedPolicy.effects,
      metadata: {
        callId,
        tool: call.name,
        approval: resolvedPolicy.approval,
        plan: resolvedPolicy.plan,
        planActive: planState.active,
        planRevision: planState.revision,
        trustRequirement: resolvedPolicy.trust,
        lockTargets,
        mode: request.mode,
        cwd: this.#cwd,
      },
    });
    if (policy.effect === "deny")
      return {
        allowed: false,
        category: policy.category,
        reason: policy.reason,
      };
    const permissionMode = this.#options.permissionMode ?? "default";
    const elevatedEffects = resolvedPolicy.effects.some(
      (effect) => effect !== "read",
    );
    const risk: ResolvedToolRisk = Object.freeze({
      schemaVersion: 1,
      effects: resolvedPolicy.effects,
      trust: resolvedPolicy.trust,
      approval:
        resolvedPolicy.approval === "never"
          ? "auto"
          : resolvedPolicy.approval === "on-request"
            ? "prompt"
            : "mandatory",
      scope: resolvedPolicy.effects.includes("network")
        ? "external"
        : resolvedPolicy.effects.includes("process")
          ? "host"
          : elevatedEffects
            ? "workspace"
            : "closed",
      data: "workspace",
      openWorld:
        resolvedPolicy.effects.includes("network") ||
        resolvedPolicy.effects.includes("process"),
      externalCommunication: resolvedPolicy.effects.includes("network"),
      destructive: resolvedPolicy.effects.includes("destructive"),
      reversible: !resolvedPolicy.effects.includes("destructive"),
      idempotent: resolvedPolicy.effects.every((effect) => effect === "read"),
    });
    const permissionDecision = resolvePermissionDecision({
      schemaVersion: 1,
      mode: permissionMode,
      risk,
      reviewer: {
        availability:
          this.#options.approve !== undefined || this.#options.emit !== undefined
            ? "available"
            : "unavailable",
      },
      guards: {
        trust:
          permissionMode === "allow-all" && trust.workspace !== "trusted"
            ? "failed"
            : "satisfied",
        managed: "satisfied",
        capability: "satisfied",
        sandbox: "satisfied",
        plan: "satisfied",
        lock: "satisfied",
      },
    });
    if (permissionDecision.outcome === "deny")
      return {
        allowed: false,
        category: "approval",
        reason: permissionDecision.reason,
      };
    if (permissionDecision.outcome === "prompt") {
      const permission = await this.#emit(
        "permission.requested",
        "permission",
        {
          callId,
          name: call.name,
          input: call.input,
          policy: { ...resolvedPolicy, permission: permissionDecision },
        },
      );
      if (
        permission.decision.kind === "deny" ||
        permission.decision.kind === "stop"
      ) {
        return {
          allowed: false,
          category: "approval",
          reason: permission.decision.reason,
        };
      }
      if (permission.decision.kind !== "allow") {
        if (!this.#options.approve)
          return {
            allowed: false,
            category: "approval",
            reason: "Tool requires approval",
          };
        const approval = await awaitAbortable(
          () => this.#options.approve!(request),
          signal,
        );
        if (approval.kind === "aborted")
          return {
            allowed: false,
            category: "cancelled",
            reason: "Tool call cancelled while awaiting approval",
          };
        if (approval.kind === "error")
          return {
            allowed: false,
            category: "approval",
            reason: "Tool approval failed",
          };
        if (!approval.value)
          return {
            allowed: false,
            category: "approval",
            reason: "Tool approval was denied",
          };
      }
    }
    return {
      allowed: true,
      effects: resolvedPolicy.effects,
      policy: {
        trust,
        approval: resolvedPolicy.approval,
        approved: true,
        permission: permissionDecision,
        plan: planState,
        lockTargets: [...lockTargets],
        receipts: policy.receipts,
      },
      policyRevision: policyChain.revision,
    };
  }
  async #requestToolCall(
    source: { id: string; name: string; input: unknown },
    callId: ReturnType<typeof toolCallId>,
    origin?: "runtime",
  ): Promise<RequestedToolCall> {
    const call = { ...source };
    const lifecycle = await this.#emit("tool.requested", "permission", {
      callId,
      name: call.name,
      input: call.input,
      ...(origin === undefined ? {} : { origin }),
    });
    if (typeof lifecycle.payload !== "object" || lifecycle.payload === null || Array.isArray(lifecycle.payload))
      throw new RuntimeFailure("validation", "tool.requested lifecycle payload must be an object");
    const rewritten = lifecycle.payload as Record<string, unknown>;
    if (typeof rewritten["name"] !== "string" || !rewritten["name"].trim())
      throw new RuntimeFailure("validation", "tool.requested lifecycle payload requires a non-empty name");
    if (!("input" in rewritten))
      throw new RuntimeFailure("validation", "tool.requested lifecycle payload requires input");
    call.name = rewritten["name"];
    call.input = rewritten["input"];
    return { call, callId, lifecycle };
  }
  async #finalizeBlockedToolCall(
    callId: ReturnType<typeof toolCallId>,
    name: string,
    content: { readonly error: string; readonly category: string },
    onContext?: (context: readonly string[]) => void,
  ): Promise<Extract<ModelMessage, { role: "tool" }>> {
    await this.#emit("tool.blocked", "after", { callId, name, ...content });
    const lifecycle = await this.#emit("tool.ended", "after", { callId, name, outcome: "blocked", ...content });
    onContext?.(lifecycle.context);
    return { role: "tool", toolCallId: callId, content: JSON.stringify(content) };
  }
  async #admitToolEffect(
    definition: ToolDefinition,
    call: { id: string; name: string; input: unknown },
    callId: ReturnType<typeof toolCallId>,
    effectKey: string,
    signal: AbortSignal,
  ): Promise<{
    readonly lane: ToolConcurrencyLane | undefined;
    readonly admission: ToolAdmissionContextV1;
  }> {
    const gate = await this.#gate(definition, call, callId, signal);
    if (!gate.allowed)
      throw new RuntimeFailure(gate.category === "policy" ? "approval" : gate.category, gate.reason);
    const lane = concurrencyLane(definition, call.input);
    let receiptInput: unknown;
    try {
      receiptInput = structuredClone(call.input);
    } catch {
      throw new RuntimeFailure("validation", "Tool input cannot be bound to an admission receipt");
    }
    const configuredReceiptTtl = this.#options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const receiptTtl = Number.isSafeInteger(configuredReceiptTtl) && configuredReceiptTtl > 0
      ? configuredReceiptTtl
      : DEFAULT_TURN_TIMEOUT_MS;
    const receipt = createEffectAdmissionReceipt({
      schemaVersion: 1,
      operation: `tool:${call.name}`,
      input: receiptInput,
      effects: gate.effects,
      policy: gate.policy,
    }, {
      expiresAt: this.#now() + receiptTtl,
      policyRevision: gate.policyRevision,
    });
    let admission = await this.#effectLedger.begin(effectKey, receipt);
    if (admission === "started") {
      await this.#effectLedger.settle(effectKey, "uncertain");
      admission = "uncertain";
    }
    if (admission !== "acquired")
      throw new RuntimeFailure("conflict", `Effect ${callId} already has ledger state ${admission}`);
    if (receipt.digest === undefined)
      throw new RuntimeFailure("internal-invariant", "Effect admission receipt is missing its digest");
    const trust = gate.policy.trust;
    const workerAuthorityRoot = this.#workerAuthorityRoot;
    return {
      lane,
      admission: Object.freeze({
        schemaVersion: 1,
        effectAdmissionId: effectKey,
        receiptDigest: receipt.digest,
        trustRevision: contextSha256(
          JSON.stringify({ managedOnly: trust.managedOnly, workspace: trust.workspace }),
        ),
        permissionMode: this.#options.permissionMode ?? "default",
        policyRevision: gate.policyRevision,
        planRevision: gate.policy.plan.revision,
        ...(workerAuthorityRoot === undefined
          ? {}
          : { workerAuthorityRoot: Object.freeze({ ...workerAuthorityRoot }) }),
      }),
    };
  }
  async #invokeTool(
    definition: ToolDefinition,
    call: { id: string; name: string; input: unknown },
    callId: ReturnType<typeof toolCallId>,
    signal: AbortSignal,
    activeTurnId?: TurnId,
    admission?: ToolAdmissionContextV1,
  ): Promise<ToolExecutionOutcome> {
    if (signal.aborted) return { kind: "cancelled-before-start" };
    try {
      await this.#emit("tool.started", "notification", { callId, name: call.name });
    } catch (error) {
      return {
        kind: "error",
        error: new RuntimeFailure(
          error instanceof RuntimeFailure ? error.category : "tool-execution",
          error instanceof Error ? error.message : "Tool failed to start",
          "safe",
        ),
      };
    }
    return await awaitAbortable(
      () => definition.execute({
        input: call.input,
        callId,
        context: {
          sessionId: this.#options.sessionId,
          ...(activeTurnId === undefined ? {} : { turnId: activeTurnId }),
          cwd: this.#cwd,
          mode: this.#options.mode ?? "headless",
          ...(this.#options.outputFormat === undefined ? {} : { outputFormat: this.#options.outputFormat }),
          trust: this.#options.trust ?? defaultTrust,
          ...(admission === undefined ? {} : { admission }),
          signal,
        },
        signal,
        update: async (update) => {
          if (signal.aborted) return;
          const invalid = updateError(update);
          if (invalid) throw new RuntimeFailure("validation", invalid);
          if (!signal.aborted)
            await this.#emit("tool.updated", "notification", { callId, name: call.name, update });
        },
      }),
      signal,
    );
  }
  async #executeRuntimeTool(command: Extract<RuntimeCommand, { type: "tool.execute" }>): Promise<RuntimeCommandResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(command.operationId) || !command.name.trim())
      return { ok: false, error: new RuntimeFailure("validation", "Runtime tool execution requires bounded stable operation and tool identifiers").toJSON() };
    const signal = command.signal ?? new AbortController().signal;
    const callId = toolCallId(`external:${command.operationId}`);
    const effectKey = `${this.#options.sessionId}:external:${command.operationId}`;
    if (this.#externalOperations.has(command.operationId))
      return { ok: false, error: new RuntimeFailure("conflict", `Duplicate external operation: ${command.operationId}`).toJSON() };
    this.#externalOperations.add(command.operationId);
    let admitted = false;
    let settled = false;
    let requested: RequestedToolCall | undefined;
    try {
      requested = await this.#requestToolCall({ id: callId, name: command.name, input: command.input }, callId, "runtime");
      if (requested.lifecycle.decision.kind === "deny" || requested.lifecycle.decision.kind === "stop")
        throw new RuntimeFailure("approval", requested.lifecycle.decision.reason);
      if (signal.aborted) throw new RuntimeFailure("cancelled", "Tool call cancelled before execution");
      const definition = this.#options.tools?.get(requested.call.name);
      if (definition === undefined)
        throw new RuntimeFailure("unsupported-capability", `Unknown tool: ${requested.call.name}`);
      const { admission } = await this.#admitToolEffect(definition, requested.call, callId, effectKey, signal);
      admitted = true;
      const execution = await this.#invokeTool(definition, requested.call, callId, signal, undefined, admission);
      if (execution.kind === "cancelled-before-start" || execution.kind === "aborted" || signal.aborted)
        throw new RuntimeFailure("cancelled", "Tool call cancelled during execution");
      if (execution.kind === "error") throw execution.error;
      const result = execution.value;
      const invalid = resultError(result, definition);
      if (invalid) throw new RuntimeFailure("validation", invalid);
      const maxBytes = this.#options.maxToolResultBytes ?? 1024 * 1024;
      const serialized = serializeToolResult(result, Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 1024 * 1024);
      const sanitized = JSON.parse(serialized.content) as ToolResult;
      await this.#effectLedger.settle(effectKey, result.ok ? "committed" : "failed");
      settled = true;
      await this.#emit("tool.ended", "after", {
        callId, name: requested.call.name, outcome: result.ok ? "success" : "error",
        ...(result.ok ? {} : { category: result.category ?? "tool-execution" }), result: sanitized,
      });
      return { ok: true, data: sanitized };
    } catch (error) {
      const failure = signal.aborted
        ? new RuntimeFailure("cancelled", "Tool call cancelled during execution")
        : error instanceof RuntimeFailure
          ? error
          : new RuntimeFailure("tool-execution", error instanceof Error ? error.message : "Tool failed");
      if (admitted && !settled)
        await this.#effectLedger
          .settle(effectKey, effectFailureSettlement(failure))
          .catch(() => undefined);
      const name = requested?.call.name ?? command.name;
      if (!admitted)
        await this.#finalizeBlockedToolCall(callId, name, { error: failure.message, category: failure.category });
      else
        await this.#emit("tool.ended", "after", {
          callId, name, outcome: failure.category === "cancelled" ? "cancelled" : "error",
          category: failure.category, message: failure.message, error: failure.toJSON(),
        });
      return { ok: false, error: failure.toJSON() };
    }
  }
  async #applyPendingSteers(
    messages: ModelMessage[],
  ): Promise<"continue" | "stop"> {
    const pending = this.#pendingSteers.splice(0);
    for (const steer of pending) {
      const lifecycle = await this.#emit("input.received", "before", {
        kind: "steer",
        text: runtimeUserInputText(steer.input),
        attachments: runtimeUserInputAttachments(steer.input),
      });
      if (
        !isRecord(lifecycle.payload) ||
        typeof lifecycle.payload["text"] !== "string"
      ) {
        throw new RuntimeFailure(
          "validation",
          "input.received lifecycle payload requires text",
        );
      }
      const effectiveInput = runtimeUserInputWithText(steer.input, lifecycle.payload["text"]);
      const effectiveText = runtimeUserInputText(effectiveInput);
      if (lifecycle.decision.kind === "deny") {
        await this.#emit("input.rejected", "after", {
          kind: "steer",
          text: effectiveText,
          attachments: runtimeUserInputAttachments(effectiveInput),
          reason: lifecycle.decision.reason,
        });
        continue;
      }
      if (lifecycle.decision.kind === "stop") {
        await this.#emit("input.handled", "after", {
          kind: "steer",
          text: effectiveText,
          reason: lifecycle.decision.reason,
        });
        return "stop";
      }
      if (effectiveText !== runtimeUserInputText(steer.input))
        await this.#emit("input.transformed", "after", {
          kind: "steer",
          original: runtimeUserInputText(steer.input),
          text: effectiveText,
        });
      for (const context of lifecycle.context)
        messages.push({ role: "user", content: context });
      messages.push({ role: "user", content: effectiveText, userInput: effectiveInput });
    }
    return "continue";
  }
  async #runModelToolLoop(
    input: RuntimeUserInputV1,
    activeTurnId: ReturnType<typeof turnId>,
    signal: AbortSignal,
    initialLifecycleContext: readonly string[] = [],
  ): Promise<string> {
    let messages: Array<ModelRequest["messages"][number]> = [
      ...structuredClone(this.#history),
      ...initialLifecycleContext.map((content) => ({ role: "user" as const, content })),
      { role: "user", content: runtimeUserInputText(input), userInput: input },
    ];
    const effects = new Set<string>();
      const preflightCompactedIterations = new Set<number>();
      const preflightProgressByIteration = new Map<number, {
        readonly hardLimitTokens?: number;
      }>();
    let overflowCompactionAttempted = false;
    const maxIterations = this.#options.maxIterations ?? 16;
    const configuredMaxToolCalls = this.#options.maxToolCalls ?? 64;
    const maxToolCalls =
      Number.isSafeInteger(configuredMaxToolCalls) && configuredMaxToolCalls > 0
        ? configuredMaxToolCalls
        : 64;
    const configuredAggregateResultBytes =
      this.#options.maxToolResultBytesPerTurn ??
      DEFAULT_MAX_TOOL_RESULT_BYTES_PER_TURN;
    const maxAggregateResultBytes =
      Number.isSafeInteger(configuredAggregateResultBytes) &&
      configuredAggregateResultBytes > 0
        ? configuredAggregateResultBytes
        : DEFAULT_MAX_TOOL_RESULT_BYTES_PER_TURN;
    let toolCallCount = 0;
    let modelVisibleToolResultBytes = 0;
    modelLoop: for (
      let iteration = 0;
      iteration < maxIterations;
      iteration += 1
    ) {
      if (signal.aborted) {
        this.#history = messages;
        return "cancelled";
      }
      if (
        this.#pendingSteers.length > 0 &&
        (await this.#applyPendingSteers(messages)) === "stop"
      ) {
        this.#history = messages;
        return "stop";
      }
      let currentUserMessageIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") {
          currentUserMessageIndex = index;
          break;
        }
      }
      const contextLifecycle = await this.#emit("context.preparing", "before", {
        iteration,
        messages: structuredClone(messages),
      });
      if (
        contextLifecycle.decision.kind === "deny" ||
        contextLifecycle.decision.kind === "stop"
      ) {
        this.#history = messages;
        return contextLifecycle.decision.kind;
      }
      const lifecycleMessages = isRecord(contextLifecycle.payload)
        ? normalizeContextLifecycleMessages(
            contextLifecycle.payload["messages"],
            messages,
          )
        : undefined;
      if (lifecycleMessages === undefined) {
        throw new RuntimeFailure(
          "validation",
          "context.preparing lifecycle payload requires valid messages",
        );
      }
      let preparedMessages: ModelMessage[] = [
        ...structuredClone(lifecycleMessages),
        ...contextLifecycle.context.map((content): ModelMessage => ({
          role: "user",
          content,
        })),
      ];
      const semanticContext = this.#options.semanticContext;
      if (semanticContext !== undefined && this.#cwd.length > 0) {
        let semanticMaxTokens: number | undefined;
        try {
          semanticMaxTokens = semanticContextTokenBudget(semanticContext.maxTokens);
        } catch {
          // Invalid enrichment configuration must not poison an otherwise valid
          // model turn or silently expand the caller's requested ceiling.
          semanticMaxTokens = undefined;
        }
        if (semanticMaxTokens !== undefined) {
          const semanticAttempt = await awaitAbortable(
            () => semanticContext.provider.prepare({
              schemaVersion: 1,
              sessionId: this.#options.sessionId,
              turnId: activeTurnId,
              workspaceRoot: this.#cwd,
              query: runtimeUserInputText(input),
              iteration,
              budget: { maxTokens: semanticMaxTokens },
              trust: this.#options.trust ?? defaultTrust,
              ...(this.#model === null ? {} : { model: this.#model }),
              signal,
            }),
            signal,
          );
          if (semanticAttempt.kind === "aborted") {
            this.#history = messages;
            return "cancelled";
          }
          if (semanticAttempt.kind === "value") {
            try {
              const rendered = renderSemanticContext(semanticAttempt.value, {
                workspaceRoot: this.#cwd,
                maxTokens: semanticMaxTokens,
                ...(this.#model === null ? {} : { model: this.#model }),
                tokenMeter: semanticContext.tokenMeter,
              });
              preparedMessages = [...insertSemanticContextBeforeCurrentUser(
                preparedMessages,
                currentUserMessageIndex,
                rendered.text,
              )] as ModelMessage[];
            } catch {
              // Semantic context is optional enrichment. Malformed or stale host
              // evidence fails closed at the projection boundary, while the turn
              // continues without that untrusted data.
            }
          }
        }
      }
      if (
        !sameModelMessages(
          preparedMessages.slice(0, this.#stablePrefix.length),
          this.#stablePrefix,
        )
      )
        throw new RuntimeFailure(
          "internal-invariant",
          "Context preparation changed the stable prompt prefix",
        );
      const request = structuredClone({
        messages: preparedMessages,
        ...(this.#model === null ? {} : { model: this.#model }),
        ...(this.#thinking === null ? {} : { thinkingLevel: this.#thinking }),
        ...(this.#stablePrefix.length === 0
          ? {}
          : {
              cache: {
                stablePrefixMessageCount: this.#stablePrefix.length,
              },
            }),
        ...(this.#modelTools === undefined || this.#modelTools.length === 0
          ? {}
          : { tools: this.#modelTools, toolChoice: "auto" as const }),
      }) as ModelRequest;
      const budget = this.#preflightBudget();
      const measuredInputTokens =
        budget === null
          ? null
          : await this.#measureContextTokens(request, signal);
      if (signal.aborted) {
        this.#history = messages;
        return "cancelled";
      }
      const preflightProgress = preflightProgressByIteration.get(iteration);
      if (
        measuredInputTokens !== null &&
        preflightProgress !== undefined
      ) {
        if (
          preflightProgress.hardLimitTokens !== undefined &&
          measuredInputTokens >= preflightProgress.hardLimitTokens
        )
          throw new RuntimeFailure(
            "model",
            "Compacted context still exceeds the model input budget",
          );
        // A soft threshold is advisory. Tool schemas, stable prompt material, and
        // rehydrated context can dominate the request even when mutable history
        // cannot shrink. One bounded compaction attempt is enough; below the hard
        // model limit, admit the request instead of looping or failing the turn.
        preflightProgressByIteration.delete(iteration);
      }
      if (
        budget !== null &&
        measuredInputTokens !== null &&
        measuredInputTokens >= budget.triggerTokens &&
        this.#options.compaction !== undefined &&
        !preflightCompactedIterations.has(iteration)
      ) {
        preflightCompactedIterations.add(iteration);
        preflightProgressByIteration.set(iteration, {
          ...(budget.hardLimitTokens === undefined
            ? {}
            : { hardLimitTokens: budget.hardLimitTokens }),
        });
        const compacted = await this.#compactMessages("threshold", messages);
        messages = structuredClone([...compacted.messages]);
        iteration -= 1;
        continue modelLoop;
      }
      const configuredAttempts = this.#options.maxProviderAttempts ?? 3;
      const maxProviderAttempts =
        Number.isSafeInteger(configuredAttempts) && configuredAttempts > 0
          ? configuredAttempts
          : 3;
      let result!: ModelResponse;
      let calls: { id: string; name: string; input: unknown }[] = [];
      let text: string[] = [];
      let messageId = "";
      let requestId = "";
      let requestStartedAt = 0;
      let firstDeltaAt: number | undefined;
      let successfulAttempt = 0;
      for (
        let providerAttempt = 1;
        providerAttempt <= maxProviderAttempts;
        providerAttempt += 1
      ) {
        calls = [];
        text = [];
        messageId = `${activeTurnId}:message:${iteration + 1}:attempt:${providerAttempt}`;
        requestId = `${activeTurnId}:provider:${iteration + 1}:attempt:${providerAttempt}`;
        requestStartedAt = this.#now();
        firstDeltaAt = undefined;
        this.#providerRequests += 1;
        await this.#emit("provider.request-started", "notification", {
          requestId,
          iteration,
          attempt: providerAttempt,
          maxAttempts: maxProviderAttempts,
        });
        await this.#emit("message.started", "notification", {
          requestId,
          messageId,
          role: "assistant",
          iteration,
          attempt: providerAttempt,
        });
        const attemptController = new AbortController();
        const abortAttempt = (): void => attemptController.abort(signal.reason);
        if (signal.aborted) abortAttempt();
        else signal.addEventListener("abort", abortAttempt, { once: true });
        this.#activeProviderAttempt = attemptController;
        let attempt;
        try {
          attempt = await awaitAbortable(
            () =>
              this.#options.model.run(request, {
                signal: attemptController.signal,
                emit: async (delta) => {
                  if (attemptController.signal.aborted) return;
                  firstDeltaAt ??= this.#now();
                  if (delta.type === "tool-call")
                    calls.push({
                      id: delta.id,
                      name: delta.name,
                      input: delta.input,
                    });
                  else if (delta.type === "text") text.push(delta.text);
                  if (!attemptController.signal.aborted)
                    await this.#emit("message.delta", "notification", {
                      ...delta,
                      requestId,
                      messageId,
                      ...(delta.type === "thinking"
                        ? { segment: "thinking" }
                        : {}),
                    });
                },
              }),
            attemptController.signal,
          );
        } finally {
          signal.removeEventListener("abort", abortAttempt);
          if (this.#activeProviderAttempt === attemptController)
            this.#activeProviderAttempt = null;
        }
        if (attempt.kind === "aborted") {
          const durationMs = Math.max(0, this.#now() - requestStartedAt);
          this.#providerCancellations += 1;
          observeAggregate(this.#providerDurationMs, durationMs);
          await this.#emit("message.ended", "after", {
            requestId,
            messageId,
            status: "cancelled",
          });
          if (!signal.aborted && this.#pendingSteers.length > 0)
            continue modelLoop;
          this.#history = messages;
          return "cancelled";
        }
        if (attempt.kind === "value") {
          result = attempt.value;
          successfulAttempt = providerAttempt;
          break;
        }
        const error = attempt.error;
        const overflowRecoverable =
          isInputModelContextOverflow(error) &&
          firstDeltaAt === undefined &&
          !overflowCompactionAttempted &&
          this.#options.compaction !== undefined;
        const retryable =
          overflowRecoverable ||
          (error instanceof RuntimeFailure &&
            error.retry === "safe" &&
            effects.size === 0 &&
            providerAttempt < maxProviderAttempts);
        const configuredDelay =
          (error instanceof RuntimeFailure ? error.retryAfterMs : undefined) ??
          this.#options.providerRetryDelayMs ??
          0;
        const delayMs = Number.isFinite(configuredDelay)
          ? Math.max(0, Math.min(configuredDelay, 30_000))
          : 0;
        const durationMs = Math.max(0, this.#now() - requestStartedAt);
        const category =
          error instanceof RuntimeFailure ? error.category : "provider";
        this.#providerFailures += 1;
        if (retryable) this.#providerRetries += 1;
        this.#providerErrors[category] =
          (this.#providerErrors[category] ?? 0) + 1;
        observeAggregate(this.#providerDurationMs, durationMs);
        await this.#emit("message.ended", "after", {
          requestId,
          messageId,
          status: "error",
          retrying: retryable,
        });
        await this.#emit("provider.failed", "after", {
          requestId,
          iteration,
          attempt: providerAttempt,
          maxAttempts: maxProviderAttempts,
          retrying: retryable,
          category,
          durationMs,
          delayMs,
          message:
            error instanceof Error ? error.message : "Model provider failed",
        });
        if (overflowRecoverable) {
          overflowCompactionAttempted = true;
          const beforeSize = modelMessagesSize(messages);
          const compacted = await this.#compactMessages("overflow", messages);
          if (modelMessagesSize(compacted.messages) >= beforeSize)
            throw new RuntimeFailure(
              "compaction",
              "Context compaction made no input-size progress",
              "safe",
            );
          messages = structuredClone([...compacted.messages]);
          iteration -= 1;
          continue modelLoop;
        }
        if (!retryable) throw error;
        if (delayMs > 0) {
          const delayed = await awaitAbortable(
            () => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
            signal,
          );
          if (delayed.kind === "aborted") {
            this.#history = messages;
            return "cancelled";
          }
        }
      }
      const cachedInputTokens =
        result.usage.cachedInputTokens === undefined &&
        this.#usage.cachedInputTokens === undefined
          ? undefined
          : (this.#usage.cachedInputTokens ?? 0) +
            (result.usage.cachedInputTokens ?? 0);
      const cacheWriteInputTokens =
        result.usage.cacheWriteInputTokens === undefined &&
        this.#usage.cacheWriteInputTokens === undefined
          ? undefined
          : (this.#usage.cacheWriteInputTokens ?? 0) +
            (result.usage.cacheWriteInputTokens ?? 0);
      this.#usage = {
        inputTokens: this.#usage.inputTokens + result.usage.inputTokens,
        outputTokens: this.#usage.outputTokens + result.usage.outputTokens,
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(cacheWriteInputTokens === undefined
          ? {}
          : { cacheWriteInputTokens }),
      };
      this.#latestProviderInputTokens = result.usage.inputTokens;
      this.#revision += 1;
      const durationMs = Math.max(0, this.#now() - requestStartedAt);
      const ttftMs =
        firstDeltaAt === undefined
          ? undefined
          : Math.max(0, firstDeltaAt - requestStartedAt);
      this.#providerResponses += 1;
      observeAggregate(this.#providerDurationMs, durationMs);
      observeAggregate(this.#providerTtftMs, ttftMs);
      await this.#emit("provider.response-received", "after", {
        requestId,
        iteration,
        attempt: successfulAttempt,
        maxAttempts: maxProviderAttempts,
        durationMs,
        ...(ttftMs === undefined ? {} : { ttftMs }),
        stop: result.stop,
        usage: result.usage,
      });
      await this.#emit("context.usage-changed", "notification", {
        ...this.#usage,
        currentContextTokens: this.#latestProviderInputTokens + result.usage.outputTokens,
      });
      if (signal.aborted) {
        await this.#emit("message.ended", "after", {
          requestId,
          messageId,
          status: "cancelled",
        });
        this.#history = messages;
        return "cancelled";
      }
      if (result.stop === "error") {
        const failure = new RuntimeFailure(
          "provider",
          "Model provider returned an error stop",
          "unknown",
        );
        this.#providerFailures += 1;
        this.#providerErrors[failure.category] =
          (this.#providerErrors[failure.category] ?? 0) + 1;
        await this.#emit("message.ended", "after", {
          requestId,
          messageId,
          status: "error",
        });
        await this.#emit("provider.failed", "after", {
          requestId,
          iteration,
          attempt: successfulAttempt,
          maxAttempts: maxProviderAttempts,
          retrying: false,
          category: failure.category,
          durationMs,
          delayMs: 0,
          message: failure.message,
        });
        throw failure;
      }
      if ((result.stop === "tool") !== calls.length > 0) {
        const failure = new RuntimeFailure(
          "adapter-translation",
          result.stop === "tool"
            ? "Model returned a tool stop without tool calls"
            : "Model returned tool calls without a tool stop",
        );
        this.#providerFailures += 1;
        this.#providerErrors[failure.category] =
          (this.#providerErrors[failure.category] ?? 0) + 1;
        await this.#emit("message.ended", "after", {
          requestId,
          messageId,
          status: "error",
        });
        await this.#emit("provider.failed", "after", {
          requestId,
          iteration,
          attempt: successfulAttempt,
          maxAttempts: maxProviderAttempts,
          retrying: false,
          category: failure.category,
          durationMs,
          delayMs: 0,
          message: failure.message,
        });
        throw failure;
      }
      if (toolCallCount + calls.length > maxToolCalls) {
        const failure = new RuntimeFailure(
          "model",
          `Model tool-call budget exceeded ${maxToolCalls}`,
        );
        this.#providerFailures += 1;
        this.#providerErrors[failure.category] =
          (this.#providerErrors[failure.category] ?? 0) + 1;
        await this.#emit("message.ended", "after", {
          requestId,
          messageId,
          status: "error",
        });
        await this.#emit("provider.failed", "after", {
          requestId,
          iteration,
          attempt: successfulAttempt,
          maxAttempts: maxProviderAttempts,
          retrying: false,
          category: failure.category,
          durationMs,
          delayMs: 0,
          message: failure.message,
        });
        throw failure;
      }
      toolCallCount += calls.length;
      if (text.length > 0 || calls.length > 0)
        messages.push({
          role: "assistant",
          content: text.join(""),
          ...(calls.length === 0 ? {} : { toolCalls: structuredClone(calls) }),
        });
      await this.#emit("message.ended", "after", {
        requestId,
        messageId,
        status: "complete",
      });
      if (result.stop !== "tool" || calls.length === 0) {
        if (this.#pendingSteers.length > 0) continue modelLoop;
        this.#history = messages;
        return result.stop;
      }
      const preparedCalls: Array<{
        index: number;
        call: { id: string; name: string; input: unknown };
        callId: ReturnType<typeof toolCallId>;
        lifecycle: LifecycleDispatchResult<unknown>;
      }> = [];
      const lifecycleContext: string[] = [];
      for (const [index, call] of calls.entries()) {
        const callId = toolCallId(
          call.id || `${activeTurnId}:${iteration}:${index}:${call.name}`,
        );
        if (effects.has(callId))
          throw new RuntimeFailure(
            "internal-invariant",
            `Duplicate effect: ${callId}`,
          );
        effects.add(callId);
        const requested = await this.#requestToolCall(call, callId);
        call.name = requested.call.name;
        call.input = requested.call.input;
        try {
          const historyInput = structuredClone(call.input);
          const assistant = messages.at(-1);
          if (
            assistant?.role === "assistant" &&
            assistant.toolCalls !== undefined
          ) {
            messages[messages.length - 1] = {
              ...assistant,
              toolCalls: assistant.toolCalls.map((historyCall, historyIndex) =>
                historyIndex === index
                  ? { ...historyCall, name: call.name, input: historyInput }
                  : historyCall,
              ),
            };
          }
        } catch {
          /* Non-cloneable final input is rejected by admission without contaminating history. */
        }
        lifecycleContext.push(...requested.lifecycle.context);
        preparedCalls.push({ index, call, callId, lifecycle: requested.lifecycle });
      }
      type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
      type AdmittedCall = (typeof preparedCalls)[number] & {
        definition: ToolDefinition;
        effectKey: string;
        lane: ToolConcurrencyLane | undefined;
        admission: ToolAdmissionContextV1;
      };
      const toolMessages: Array<ToolMessage | undefined> = new Array(
        preparedCalls.length,
      );
      const admittedCalls: AdmittedCall[] = [];
      const cancellationMessage = async (
        callId: ReturnType<typeof toolCallId>,
        name: string,
        reason: string,
      ): Promise<ToolMessage> => {
        const payload = cancelledToolPayload(callId, name, reason);
        const lifecycle = await this.#emit("tool.ended", "after", payload);
        lifecycleContext.push(...lifecycle.context);
        return {
          role: "tool",
          toolCallId: callId,
          content: JSON.stringify({ error: payload.error }),
        };
      };
      try {
        for (const prepared of preparedCalls) {
          const { index, call, callId, lifecycle } = prepared;
          if (
            lifecycle.decision.kind === "deny" ||
            lifecycle.decision.kind === "stop"
          ) {
            toolMessages[index] = await this.#finalizeBlockedToolCall(
              callId,
              call.name,
              {
                error: lifecycle.decision.reason,
                category: "policy",
              },
              (context) => lifecycleContext.push(...context),
            );
            continue;
          }
          if (signal.aborted) {
            toolMessages[index] = await cancellationMessage(
              callId,
              call.name,
              "Tool call cancelled before execution",
            );
            continue;
          }
          const definition = this.#options.tools?.get(call.name);
          if (definition === undefined) {
            toolMessages[index] = await this.#finalizeBlockedToolCall(
              callId,
              call.name,
              {
                error: `Unknown tool: ${call.name}`,
                category: "unsupported-capability",
              },
              (context) => lifecycleContext.push(...context),
            );
            continue;
          }
          const effectKey = `${this.#options.sessionId}:${activeTurnId}:${callId}`;
          try {
            const admitted = await this.#admitToolEffect(definition, call, callId, effectKey, signal);
            admittedCalls.push({ ...prepared, definition, effectKey, ...admitted });
          } catch (error) {
            const failure = error instanceof RuntimeFailure
              ? error
              : new RuntimeFailure("internal-invariant", "Tool admission failed");
            toolMessages[index] = failure.category === "cancelled"
              ? await cancellationMessage(callId, call.name, failure.message)
              : await this.#finalizeBlockedToolCall(
                  callId,
                  call.name,
                  { error: failure.message, category: failure.category },
                  (context) => lifecycleContext.push(...context),
                );
          }
        }
      } catch (error) {
        await Promise.all(
          admittedCalls.map(({ effectKey }) =>
            this.#effectLedger
              .settle(effectKey, "cancelled")
              .catch(() => undefined),
          ),
        );
        throw error;
      }

      const executeAdmitted = async ({
        call,
        callId,
        definition,
        admission,
      }: AdmittedCall): Promise<ToolExecutionOutcome> => {
        return await this.#invokeTool(definition, call, callId, signal, activeTurnId, admission);
      };
      const executionOutcomes = new Map<number, ToolExecutionOutcome>();
      let parallelBatch: AdmittedCall[] = [];
      const flushParallelBatch = async (): Promise<void> => {
        if (parallelBatch.length === 0) return;
        const batch = parallelBatch;
        parallelBatch = [];
        const laneLimits = new Map<string, number>();
        for (const item of batch) {
          const lane = item.lane!;
          laneLimits.set(
            lane.lane,
            Math.min(
              laneLimits.get(lane.lane) ?? lane.maxActive,
              lane.maxActive,
            ),
          );
        }
        const lanes = new Map(
          [...laneLimits].map(([key, limit]) => [key, new PermitPool(limit)]),
        );
        const global = new PermitPool(MAX_PARALLEL_TOOL_CALLS);
        const outcomes = await Promise.all(
          batch.map((item) =>
            lanes
              .get(item.lane!.lane)!
              .run(() => global.run(() => executeAdmitted(item))),
          ),
        );
        for (const [offset, outcome] of outcomes.entries())
          executionOutcomes.set(batch[offset]!.index, outcome);
      };
      for (const admitted of admittedCalls) {
        if (admitted.lane !== undefined) {
          parallelBatch.push(admitted);
          continue;
        }
        await flushParallelBatch();
        executionOutcomes.set(admitted.index, await executeAdmitted(admitted));
      }
      await flushParallelBatch();

      for (const {
        index,
        call,
        callId,
        definition,
        effectKey,
      } of admittedCalls) {
        const execution = executionOutcomes.get(index);
        if (execution === undefined)
          throw new RuntimeFailure(
            "internal-invariant",
            `Missing tool execution outcome: ${callId}`,
          );
        let effectSettled = false;
        try {
          if (execution.kind === "cancelled-before-start") {
            await this.#effectLedger.settle(effectKey, "cancelled");
            effectSettled = true;
            toolMessages[index] = await cancellationMessage(
              callId,
              call.name,
              "Tool call cancelled before execution",
            );
            continue;
          }
          if (execution.kind === "aborted")
            throw new RuntimeFailure(
              "cancelled",
              "Tool call cancelled during execution",
            );
          if (execution.kind === "error") throw execution.error;
          const toolResult = execution.value;
          if (signal.aborted)
            throw new RuntimeFailure(
              "cancelled",
              "Tool call cancelled during execution",
            );
          const invalid = resultError(toolResult, definition);
          if (invalid) throw new RuntimeFailure("validation", invalid);
          const configuredMaxResultBytes =
            this.#options.maxToolResultBytes ?? 1024 * 1024;
          const maxResultBytes =
            Number.isSafeInteger(configuredMaxResultBytes) &&
            configuredMaxResultBytes > 0
              ? configuredMaxResultBytes
              : 1024 * 1024;
          const serialized = serializeToolResult(toolResult, maxResultBytes);
          const structuredResult = modelToolResult(toolResult.content);
          if (
            modelVisibleToolResultBytes + serialized.bytes >
            maxAggregateResultBytes
          )
            throw new RuntimeFailure(
              "tool-execution",
              `Aggregate tool-result budget exceeds ${maxAggregateResultBytes} bytes`,
            );
          modelVisibleToolResultBytes += serialized.bytes;
          await this.#effectLedger.settle(
            effectKey,
            toolResult.ok ? "committed" : "failed",
          );
          effectSettled = true;
          const lifecycle = await this.#emit("tool.ended", "after", {
            callId,
            name: call.name,
            outcome: toolResult.ok ? "success" : "error",
            ...(toolResult.ok
              ? {}
              : { category: toolResult.category ?? "tool-execution" }),
            result: toolResult,
          });
          lifecycleContext.push(...lifecycle.context);
          toolMessages[index] = {
            role: "tool",
            toolCallId: callId,
            content: serialized.content,
            ...(structuredResult === undefined ? {} : { result: structuredResult }),
          };
        } catch (error) {
          const failure = signal.aborted
            ? new RuntimeFailure(
                "cancelled",
                "Tool call cancelled during execution",
              )
            : error instanceof RuntimeFailure
              ? error
              : new RuntimeFailure(
                  "tool-execution",
                  error instanceof Error ? error.message : "Tool failed",
                );
          if (!effectSettled)
            await this.#effectLedger.settle(
              effectKey,
              effectFailureSettlement(failure),
            );
          if (failure.category === "cancelled")
            toolMessages[index] = await cancellationMessage(
              callId,
              call.name,
              failure.message,
            );
          else {
            const lifecycle = await this.#emit("tool.ended", "after", {
              callId,
              name: call.name,
              outcome: "error",
              category: failure.category,
              message: failure.message,
              error: failure.toJSON(),
            });
            lifecycleContext.push(...lifecycle.context);
            toolMessages[index] = {
              role: "tool",
              toolCallId: callId,
              content: JSON.stringify({ error: failure.toJSON() }),
            };
          }
        }
      }
      for (const [index, message] of toolMessages.entries()) {
        if (message === undefined)
          throw new RuntimeFailure(
            "internal-invariant",
            `Missing tool result message at index ${index}`,
          );
        messages.push(message);
      }
      for (const context of lifecycleContext)
        messages.push({ role: "user", content: context });
      if (signal.aborted) {
        this.#history = messages;
        return "cancelled";
      }
    }
    throw new RuntimeFailure(
      "internal-invariant",
      `Model/tool loop exceeded ${maxIterations} iterations`,
    );
  }
}
export const createRuntimeKernel = (
  options: RuntimeKernelOptions,
): AgentRuntime => new RuntimeKernel(options);
