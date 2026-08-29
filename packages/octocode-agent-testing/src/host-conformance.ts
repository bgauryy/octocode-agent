import { createHash } from "node:crypto";

export interface HostTraceEvent {
  sequence?: number;
  timestamp?: number;
  kind: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface NormalizedHostTraceEvent {
  sequence: number;
  kind: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface NormalizationOptions {
  workspaceRoots?: readonly string[];
  volatileKeys?: readonly string[];
  pathKeys?: readonly string[];
  identityKeys?: readonly string[];
}

export type CanonicalScenarioId =
  | "lifecycle-clean-start-stop"
  | "deterministic-model-turn"
  | "streaming-tool-flow"
  | "policy-denial-matrix"
  | "tool-failure-matrix"
  | "cancellation-boundaries"
  | "steer-and-follow-up"
  | "session-lifecycle"
  | "compaction-matrix"
  | "ui-semantics"
  | "transport-corpus"
  | "persistence-restart"
  | "codex-hook-lifecycle"
  | "plugin-lifecycle";

export interface HostConformanceScenario<TInput = unknown> {
  id: string;
  title?: string;
  requirements?: readonly string[];
  input: TInput;
}

export interface CanonicalHostConformanceScenario extends HostConformanceScenario<
  Readonly<Record<string, unknown>>
> {
  id: CanonicalScenarioId;
  title: string;
  requirements: readonly string[];
}

function scenario(
  id: CanonicalScenarioId,
  title: string,
  requirements: readonly string[],
  input: Readonly<Record<string, unknown>>,
): CanonicalHostConformanceScenario {
  return Object.freeze({
    id,
    title,
    requirements: Object.freeze([...requirements]),
    input: Object.freeze({ ...input }),
  });
}

/** The canonical shared matrix from TEST_PLAN.md §Shared host-conformance scenarios. */
export const CANONICAL_HOST_SCENARIOS: readonly CanonicalHostConformanceScenario[] =
  Object.freeze([
    scenario(
      "lifecycle-clean-start-stop",
      "Start, register, and stop cleanly",
      ["lifecycle", "registries"],
      { register: ["tools", "commands", "hooks"] },
    ),
    scenario(
      "deterministic-model-turn",
      "Submit one deterministic prompt",
      ["runtime", "model"],
      { prompt: "deterministic prompt", capture: "complete-turn" },
    ),
    scenario(
      "streaming-tool-flow",
      "Stream model and tool content",
      ["streaming", "tools"],
      {
        deltas: [
          "text",
          "thinking",
          "tool-arguments",
          "tool-update",
          "tool-result",
        ],
      },
    ),
    scenario(
      "policy-denial-matrix",
      "Deny mutations before effects",
      ["policy", "security"],
      { denials: ["plan", "trust", "approval", "peer-lock"] },
    ),
    scenario(
      "tool-failure-matrix",
      "Classify tool failures",
      ["tools", "persistence"],
      {
        boundaries: [
          "before-execution",
          "during-execution",
          "result-persistence",
        ],
      },
    ),
    scenario(
      "cancellation-boundaries",
      "Cancel owned work",
      ["cancellation", "leaks"],
      {
        boundaries: [
          "before-submit",
          "model-stream",
          "tool-work",
          "compaction",
        ],
      },
    ),
    scenario(
      "steer-and-follow-up",
      "Queue steering and follow-up input",
      ["input", "streaming"],
      { inputs: ["steer", "follow-up"] },
    ),
    scenario("session-lifecycle", "Exercise session lifecycle", ["sessions"], {
      operations: [
        "start",
        "name",
        "resume",
        "fork",
        "tree",
        "rewind",
        "export",
        "stop",
      ],
    }),
    scenario(
      "compaction-matrix",
      "Exercise compaction terminal states",
      ["compaction"],
      { reasons: ["manual", "threshold", "overflow", "retry", "failed-retry"] },
    ),
    scenario(
      "ui-semantics",
      "Exercise semantic UI requests",
      ["ui", "headless"],
      { adapters: ["interactive", "headless"] },
    ),
    scenario(
      "transport-corpus",
      "Run transport corpora",
      ["print", "json", "rpc"],
      { transports: ["print", "json", "rpc"] },
    ),
    scenario(
      "persistence-restart",
      "Restart after persistence faults",
      ["sessions", "fault-injection"],
      { assertion: "deterministic-projection" },
    ),
    scenario(
      "codex-hook-lifecycle",
      "Dispatch reviewed Codex hooks",
      ["hooks", "trust"],
      { compare: ["decision", "context", "rewrite"] },
    ),
    scenario(
      "plugin-lifecycle",
      "Exercise transactional plugin lifecycle",
      ["plugins", "leaks"],
      {
        operations: [
          "activate",
          "use",
          "disable",
          "unload",
          "update",
          "resume",
        ],
      },
    ),
  ]);

export interface RecordedEffect {
  id: string;
  kind: string;
  effectful: boolean;
  data?: unknown;
}

export type ExecutionMode = "pure" | "shadow" | "live";

export interface HostExecutionContext {
  signal: AbortSignal;
  emit(kind: string, data?: unknown): void;
  effect(effect: RecordedEffect): void;
}

export interface HostExecutionReceipt {
  events?: readonly HostTraceEvent[];
  effects?: readonly RecordedEffect[];
}

export interface HostConformanceAdapter {
  name: string;
  /** Distinguishes runner fixtures from evidence captured at a production composition root. */
  evidence: "synthetic" | "production";
  supports?(scenario: HostConformanceScenario): HostScenarioSupport;
  execute(
    scenario: HostConformanceScenario,
    context: HostExecutionContext,
  ): Promise<void | readonly HostTraceEvent[] | HostExecutionReceipt>;
}

export type HostScenarioSupport =
  { supported: true } | { supported: false; reason: string };

export type CanonicalScenarioHandler = (
  scenario: CanonicalHostConformanceScenario,
  context: HostExecutionContext,
) => void | Promise<void>;

export type CanonicalScenarioHandlers = Record<
  CanonicalScenarioId,
  CanonicalScenarioHandler
>;

/** Adapt a Pi or native structural surface without importing either production package. */
export function createCanonicalHostAdapter(
  name: string,
  handlers: CanonicalScenarioHandlers,
): HostConformanceAdapter {
  return {
    name,
    evidence: "synthetic",
    async execute(value, context) {
      const canonical = CANONICAL_HOST_SCENARIOS.find(
        ({ id }) => id === value.id,
      );
      if (!canonical)
        throw new Error(`Unknown canonical host scenario: ${value.id}`);
      const handler = handlers[canonical.id];
      if (!handler)
        throw new Error(
          `Missing canonical handler for ${canonical.id} on ${name}`,
        );
      await handler(canonical, context);
    },
  };
}

export interface TraceDivergence {
  index: number;
  path: string;
  baseline: unknown;
  candidate: unknown;
}

export interface ValueComparison {
  matched: boolean;
  baselineHash: string;
  candidateHash: string;
  firstDivergence: TraceDivergence | null;
}

export type TraceComparison = ValueComparison;

export interface ScenarioConformanceResult {
  scenarioId: string;
  matched: boolean;
  status: "matched" | "diverged" | "unsupported";
  unsupported?: { baseline?: string; candidate?: string };
  trace: TraceComparison;
  effects: ValueComparison;
}

export interface HostConformanceReport {
  baselineHost: string;
  candidateHost: string;
  evidence: {
    baseline: HostConformanceAdapter["evidence"];
    candidate: HostConformanceAdapter["evidence"];
  };
  summary: {
    total: number;
    matched: number;
    diverged: number;
    unsupported: number;
  };
  matched: boolean;
  results: ScenarioConformanceResult[];
}

const DEFAULT_VOLATILE_KEYS = new Set([
  "timestamp",
  "time",
  "startedAt",
  "finishedAt",
]);
const DEFAULT_PATH_KEYS = new Set([
  "cwd",
  "path",
  "file",
  "sessionFile",
  "workspace",
]);
const DEFAULT_IDENTITY_KEYS = new Set([
  "sessionId",
  "parentId",
  "turnId",
  "requestId",
  "callId",
  "toolCallId",
  "effectId",
  "eventId",
  "traceId",
  "spanId",
]);
const ANSI_PATTERN =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

interface NormalizationState {
  readonly identities: Map<string, string>;
  nextIdentity: number;
}

function normalizeString(value: string, roots: readonly string[]): string {
  let normalized = value.replace(ANSI_PATTERN, "");
  for (const root of [...roots].sort(
    (left, right) => right.length - left.length,
  )) {
    if (!root) continue;
    const rootPattern = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalized = normalized.replace(
      new RegExp(`${rootPattern}(?=$|[/\\\\])`, "g"),
      "<workspace>",
    );
  }
  return normalized;
}

function normalizeIdentity(value: string, state: NormalizationState): string {
  const existing = state.identities.get(value);
  if (existing) return existing;
  const normalized = `<id:${++state.nextIdentity}>`;
  state.identities.set(value, normalized);
  return normalized;
}

function normalizeValue(
  value: unknown,
  options: NormalizationOptions,
  state: NormalizationState,
  seen = new WeakSet<object>(),
): unknown {
  const roots = options.workspaceRoots ?? [];
  if (typeof value === "string") return normalizeString(value, roots);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  if (value instanceof Error) {
    const metadata: Record<string, unknown> = {};
    if ("cause" in value && value.cause !== undefined)
      metadata.cause = value.cause;
    for (const key of Object.keys(value).sort()) {
      if (
        key !== "cause" &&
        key !== "message" &&
        key !== "name" &&
        key !== "stack"
      ) {
        metadata[key] = (value as unknown as Record<string, unknown>)[key];
      }
    }
    return {
      name: value.name,
      message: normalizeString(value.message, roots),
      ...(normalizeValue(metadata, options, state, seen) as Record<
        string,
        unknown
      >),
    };
  }
  if (value instanceof Date) return "<timestamp>";
  if (Array.isArray(value))
    return value.map((item) => normalizeValue(item, options, state, seen));
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, item]) => [
        normalizeValue(key, options, state, seen),
        normalizeValue(item, options, state, seen),
      ])
      .sort(([left], [right]) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  }
  if (value instanceof Set) {
    return [...value]
      .map((item) => normalizeValue(item, options, state, seen))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  }

  const volatileKeys = new Set([
    ...DEFAULT_VOLATILE_KEYS,
    ...(options.volatileKeys ?? []),
  ]);
  const pathKeys = new Set([...DEFAULT_PATH_KEYS, ...(options.pathKeys ?? [])]);
  const identityKeys = new Set([
    ...DEFAULT_IDENTITY_KEYS,
    ...(options.identityKeys ?? []),
  ]);
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (volatileKeys.has(key)) continue;
    const item = (value as Record<string, unknown>)[key];
    normalized[key] =
      identityKeys.has(key) && typeof item === "string"
        ? normalizeIdentity(item, state)
        : pathKeys.has(key) && typeof item === "string"
          ? normalizeString(item, roots)
          : normalizeValue(item, options, state, seen);
  }
  return normalized;
}

export function normalizeHostTrace(
  events: readonly HostTraceEvent[],
  options: NormalizationOptions = {},
): NormalizedHostTraceEvent[] {
  const state: NormalizationState = { identities: new Map(), nextIdentity: 0 };
  return events.map((event, index) => {
    const {
      kind,
      data,
      sequence: _sequence,
      timestamp: _timestamp,
      ...envelope
    } = event;
    const normalizedEnvelope = normalizeValue(
      envelope,
      options,
      state,
    ) as Record<string, unknown>;
    return {
      sequence: index + 1,
      kind,
      ...normalizedEnvelope,
      ...(data === undefined
        ? {}
        : { data: normalizeValue(data, options, state) }),
    };
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function hashNormalizedTrace(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function firstDifference(
  baseline: unknown,
  candidate: unknown,
  path = "$",
): Omit<TraceDivergence, "index"> | null {
  if (Object.is(baseline, candidate)) return null;
  if (
    typeof baseline !== typeof candidate ||
    baseline === null ||
    candidate === null
  )
    return { path, baseline, candidate };
  if (typeof baseline !== "object") return { path, baseline, candidate };
  const baselineArray = Array.isArray(baseline);
  if (baselineArray !== Array.isArray(candidate))
    return { path, baseline, candidate };
  const left = baseline as Record<string, unknown> | unknown[];
  const right = candidate as Record<string, unknown> | unknown[];
  const keys = Array.from(
    new Set([...Object.keys(left), ...Object.keys(right)]),
  ).sort();
  for (const key of keys) {
    const nested = firstDifference(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      baselineArray ? `${path}[${key}]` : `${path}.${key}`,
    );
    if (nested) return nested;
  }
  return null;
}

function compareValues(baseline: unknown, candidate: unknown): ValueComparison {
  const difference = firstDifference(baseline, candidate);
  const eventIndex = difference
    ? Number(/^\$\[(\d+)\]/.exec(difference.path)?.[1] ?? 0)
    : -1;
  return {
    matched: difference === null,
    baselineHash: hashNormalizedTrace(baseline),
    candidateHash: hashNormalizedTrace(candidate),
    firstDivergence: difference ? { index: eventIndex, ...difference } : null,
  };
}

export function compareHostTraces(
  baseline: readonly NormalizedHostTraceEvent[],
  candidate: readonly NormalizedHostTraceEvent[],
): TraceComparison {
  return compareValues(baseline, candidate);
}

export class EffectLedger {
  readonly effects: RecordedEffect[] = [];
  private readonly ids = new Set<string>();

  constructor(private readonly mode: ExecutionMode) {}

  record(effect: RecordedEffect): void {
    if (this.ids.has(effect.id))
      throw new Error(`Duplicate effect id: ${effect.id}`);
    if (this.mode === "pure" && effect.effectful) {
      throw new Error(
        `Pure execution cannot perform effectful ${effect.kind} operation`,
      );
    }
    if (this.mode === "shadow" && effect.effectful) {
      throw new Error(
        `Shadow execution cannot perform effectful ${effect.kind} operation`,
      );
    }
    this.ids.add(effect.id);
    this.effects.push({ ...effect });
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason ?? new Error("Host conformance run aborted");
}

async function executeAdapter(
  adapter: HostConformanceAdapter,
  scenarioValue: HostConformanceScenario,
  ledger: EffectLedger,
  signal: AbortSignal,
): Promise<HostTraceEvent[]> {
  throwIfAborted(signal);
  const events: HostTraceEvent[] = [];
  const context: HostExecutionContext = {
    signal,
    emit: (kind, data) =>
      events.push({ kind, ...(data === undefined ? {} : { data }) }),
    effect: (effect) => ledger.record(effect),
  };
  const receipt = await adapter.execute(scenarioValue, context);
  throwIfAborted(signal);
  if (Array.isArray(receipt)) events.push(...receipt);
  else if (receipt && typeof receipt === "object") {
    const structured = receipt as HostExecutionReceipt;
    events.push(...(structured.events ?? []));
    for (const effect of structured.effects ?? []) ledger.record(effect);
  }
  return events;
}

export async function runHostConformance(options: {
  baseline: HostConformanceAdapter;
  candidate: HostConformanceAdapter;
  scenarios: readonly HostConformanceScenario[];
  baselineMode?: ExecutionMode;
  candidateMode?: ExecutionMode;
  normalization?: NormalizationOptions;
  signal?: AbortSignal;
}): Promise<HostConformanceReport> {
  const signal = options.signal ?? new AbortController().signal;
  const baselineLedger = new EffectLedger(options.baselineMode ?? "live");
  const candidateLedger = new EffectLedger(options.candidateMode ?? "live");
  const results: ScenarioConformanceResult[] = [];

  for (const current of options.scenarios) {
    const baselineSupport = options.baseline.supports?.(current) ?? {
      supported: true as const,
    };
    const candidateSupport = options.candidate.supports?.(current) ?? {
      supported: true as const,
    };
    if (!baselineSupport.supported || !candidateSupport.supported) {
      const unsupported = {
        ...(!baselineSupport.supported
          ? { baseline: baselineSupport.reason }
          : {}),
        ...(!candidateSupport.supported
          ? { candidate: candidateSupport.reason }
          : {}),
      };
      results.push({
        scenarioId: current.id,
        matched: false,
        status: "unsupported",
        unsupported,
        trace: compareValues(
          baselineSupport.supported
            ? { supported: true }
            : { supported: false, reason: baselineSupport.reason },
          candidateSupport.supported
            ? { supported: true }
            : { supported: false, reason: candidateSupport.reason },
        ),
        effects: compareValues([], []),
      });
      continue;
    }
    const baselineStart = baselineLedger.effects.length;
    const candidateStart = candidateLedger.effects.length;
    const scenarioController = new AbortController();
    const forwardAbort = (): void => scenarioController.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    const executeOwned = async (
      adapter: HostConformanceAdapter,
      ledger: EffectLedger,
    ): Promise<HostTraceEvent[]> => {
      try {
        return await executeAdapter(
          adapter,
          current,
          ledger,
          scenarioController.signal,
        );
      } catch (error) {
        if (!scenarioController.signal.aborted) scenarioController.abort(error);
        throw error;
      }
    };
    let baselineEvents: HostTraceEvent[];
    let candidateEvents: HostTraceEvent[];
    try {
      [baselineEvents, candidateEvents] = await Promise.all([
        executeOwned(options.baseline, baselineLedger),
        executeOwned(options.candidate, candidateLedger),
      ]);
    } finally {
      signal.removeEventListener("abort", forwardAbort);
    }
    const baselineEffects = baselineLedger.effects.slice(baselineStart);
    const candidateEffects = candidateLedger.effects.slice(candidateStart);
    const baselineExternalIds = new Set(
      baselineEffects.filter(({ effectful }) => effectful).map(({ id }) => id),
    );
    const duplicatedExternal = candidateEffects.find(
      ({ id, effectful }) => effectful && baselineExternalIds.has(id),
    );
    if (duplicatedExternal) {
      throw new Error(
        `Duplicate external effect ${duplicatedExternal.id} executed by ${options.baseline.name} and ${options.candidate.name}`,
      );
    }
    const trace = compareHostTraces(
      normalizeHostTrace(baselineEvents, options.normalization),
      normalizeHostTrace(candidateEvents, options.normalization),
    );
    const effects = compareValues(
      normalizeValue(baselineEffects, options.normalization ?? {}, {
        identities: new Map(),
        nextIdentity: 0,
      }),
      normalizeValue(candidateEffects, options.normalization ?? {}, {
        identities: new Map(),
        nextIdentity: 0,
      }),
    );
    const matched = trace.matched && effects.matched;
    results.push({
      scenarioId: current.id,
      matched,
      status: matched ? "matched" : "diverged",
      trace,
      effects,
    });
  }
  return {
    baselineHost: options.baseline.name,
    candidateHost: options.candidate.name,
    evidence: {
      baseline: options.baseline.evidence,
      candidate: options.candidate.evidence,
    },
    summary: {
      total: results.length,
      matched: results.filter(({ status }) => status === "matched").length,
      diverged: results.filter(({ status }) => status === "diverged").length,
      unsupported: results.filter(({ status }) => status === "unsupported")
        .length,
    },
    matched: results.every((result) => result.matched),
    results,
  };
}

export function runCanonicalHostConformance(options: {
  baseline: HostConformanceAdapter;
  candidate: HostConformanceAdapter;
  baselineMode?: ExecutionMode;
  candidateMode?: ExecutionMode;
  normalization?: NormalizationOptions;
  signal?: AbortSignal;
}): Promise<HostConformanceReport> {
  return runHostConformance({
    ...options,
    scenarios: CANONICAL_HOST_SCENARIOS,
  });
}
