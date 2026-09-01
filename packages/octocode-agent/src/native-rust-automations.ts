import {
  RuntimeFailure,
  assertAutomationDefinition,
  assertAutomationOutcome,
  type AutomationClaim,
  type AutomationDefinition,
  type AutomationOutcome,
  type AutomationRun,
  type AutomationState,
  type AutomationStorePort,
} from "@octocodeai/agent-core";

import {
  NativeRustCoreError,
  type NativeRustAutomationCancelInput,
  type NativeRustAutomationClaimInput,
  type NativeRustAutomationDefinitionInput,
  type NativeRustAutomationHeartbeatInput,
  type NativeRustAutomationListInput,
  type NativeRustAutomationSettleInput,
  type NativeRustCoreObject,
} from "./native-rust-core.js";

export interface RustAutomationClient {
  automationPut(
    input: NativeRustAutomationDefinitionInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  automationList(
    input: NativeRustAutomationListInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  automationCancel(
    input: NativeRustAutomationCancelInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  automationClaim(
    input: NativeRustAutomationClaimInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  automationHeartbeat(
    input: NativeRustAutomationHeartbeatInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  automationComplete(
    input: NativeRustAutomationSettleInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  automationFail(
    input: NativeRustAutomationSettleInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  automationUncertain(
    input: NativeRustAutomationSettleInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_LEASE_MS = 86_400_000;
const MAX_LIST_LIMIT = 100;
const DEFINITION_KEYS = [
  "schemaVersion",
  "id",
  "revision",
  "state",
  "schedule",
  "misfirePolicy",
  "retryPolicy",
  "action",
  "createdAt",
  "updatedAt",
] as const;
const CLAIM_KEYS = [
  "schemaVersion",
  "runId",
  "automationId",
  "scheduledFor",
  "attempt",
  "state",
  "ownerId",
  "leaseExpiresAt",
  "fencingToken",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.includes("\0")
  ) {
    throw new RuntimeFailure("validation", `Invalid automation ${field}`);
  }
  return value;
}

function integer(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    throw new RuntimeFailure("validation", `Invalid automation ${field}`);
  return value as number;
}

function definition(
  value: unknown,
  source: "input" | "durable",
): AutomationDefinition {
  try {
    const record = isObject(value) ? value : undefined;
    if (record === undefined || !hasOnlyKeys(record, DEFINITION_KEYS))
      throw new TypeError("definition shape");
    const validated = assertAutomationDefinition(value);
    identifier(validated.id, "id");
    integer(validated.revision, "revision");
    integer(validated.createdAt, "createdAt");
    integer(validated.updatedAt, "updatedAt");
    integer(
      validated.retryPolicy.maxAttempts,
      "retryPolicy.maxAttempts",
      1,
      100,
    );
    integer(
      validated.retryPolicy.backoffMs,
      "retryPolicy.backoffMs",
      0,
      MAX_LEASE_MS,
    );
    integer(validated.action.version, "action.version", 1);
    identifier(validated.action.name, "action.name");
    if (validated.schedule.kind === "once")
      integer(validated.schedule.at, "schedule.at");
    if (validated.schedule.kind === "interval") {
      integer(validated.schedule.everyMs, "schedule.everyMs", 1);
      integer(validated.schedule.anchorAt, "schedule.anchorAt");
    }
    if (validated.schedule.kind === "cron") {
      identifier(validated.schedule.expression, "schedule.expression");
      identifier(validated.schedule.timeZone, "schedule.timeZone");
    }
    return validated;
  } catch (error) {
    if (source === "input" && error instanceof RuntimeFailure) throw error;
    if (source === "input")
      throw new RuntimeFailure(
        "validation",
        "Automation definition is invalid",
      );
    throw new RuntimeFailure(
      "persistence",
      "Rust automation definition is malformed",
      "unsafe",
      true,
      "sensitive",
    );
  }
}

function claim(value: unknown, source: "input" | "durable"): AutomationClaim {
  const fail = (): never => {
    if (source === "input")
      throw new RuntimeFailure("validation", "Automation claim is invalid");
    throw new RuntimeFailure(
      "persistence",
      "Rust automation claim is malformed",
      "unsafe",
      true,
      "sensitive",
    );
  };
  try {
    if (!isObject(value) || !hasOnlyKeys(value, CLAIM_KEYS)) return fail();
    if (value["schemaVersion"] !== 1 || value["state"] !== "claimed")
      return fail();
    return {
      schemaVersion: 1,
      runId: identifier(value["runId"], "claim.runId"),
      automationId: identifier(value["automationId"], "claim.automationId"),
      scheduledFor: integer(value["scheduledFor"], "claim.scheduledFor"),
      attempt: integer(value["attempt"], "claim.attempt", 1),
      state: "claimed",
      ownerId: identifier(value["ownerId"], "claim.ownerId"),
      leaseExpiresAt: integer(value["leaseExpiresAt"], "claim.leaseExpiresAt"),
      fencingToken: integer(value["fencingToken"], "claim.fencingToken", 1),
    };
  } catch (error) {
    if (source === "input" && error instanceof RuntimeFailure) throw error;
    return fail();
  }
}

function outcome<T extends AutomationOutcome["state"]>(
  value: unknown,
  expected: T,
  source: "input" | "durable",
): Extract<AutomationOutcome, { readonly state: T }> {
  try {
    const validated = assertAutomationOutcome(value);
    if (validated.state !== expected) throw new TypeError("outcome state");
    integer(validated.completedAt, "outcome.completedAt");
    return validated as Extract<AutomationOutcome, { readonly state: T }>;
  } catch (error) {
    if (source === "input" && error instanceof RuntimeFailure) throw error;
    if (source === "input")
      throw new RuntimeFailure("validation", "Automation outcome is invalid");
    throw new RuntimeFailure(
      "persistence",
      "Rust automation outcome is malformed",
      "unsafe",
      true,
      "sensitive",
    );
  }
}

function run<T extends AutomationOutcome["state"]>(
  value: unknown,
  expected: T,
  owner: AutomationClaim,
): AutomationRun {
  if (!isObject(value))
    throw new RuntimeFailure(
      "persistence",
      "Rust automation run is malformed",
      "unsafe",
      true,
      "sensitive",
    );
  const expectedKeys = [
    "schemaVersion",
    "runId",
    "automationId",
    "scheduledFor",
    "attempt",
    "state",
    "outcome",
  ];
  if (
    !hasOnlyKeys(value, expectedKeys) ||
    value["schemaVersion"] !== 1 ||
    value["runId"] !== owner.runId ||
    value["automationId"] !== owner.automationId ||
    value["scheduledFor"] !== owner.scheduledFor ||
    value["attempt"] !== owner.attempt ||
    value["state"] !== expected
  ) {
    throw new RuntimeFailure(
      "persistence",
      "Rust automation run is malformed",
      "unsafe",
      true,
      "sensitive",
    );
  }
  return {
    schemaVersion: 1,
    runId: owner.runId,
    automationId: owner.automationId,
    scheduledFor: owner.scheduledFor,
    attempt: owner.attempt,
    state: expected,
    outcome: outcome(value["outcome"], expected, "durable"),
  } as AutomationRun;
}

function failure(error: unknown): RuntimeFailure {
  if (error instanceof RuntimeFailure) return error;
  if (error instanceof NativeRustCoreError) {
    if (error.category === "cancelled")
      return new RuntimeFailure(
        "cancelled",
        "Rust automation operation was cancelled",
        "safe",
        true,
        "sensitive",
      );
    if (
      error.category === "validation" ||
      (error.category === "remote" && error.code === "INVALID_REQUEST")
    )
      return new RuntimeFailure(
        "validation",
        "Rust automation request is invalid",
        "unsafe",
        true,
        "sensitive",
      );
    if (
      error.category === "remote" &&
      ["CONFLICT", "NOT_FOUND"].includes(error.code ?? "")
    )
      return new RuntimeFailure(
        "conflict",
        "Rust automation ownership conflict",
        "unsafe",
        true,
        "sensitive",
      );
    if (
      error.category === "protocol" ||
      (error.category === "remote" && error.code === "CORRUPTION")
    )
      return new RuntimeFailure(
        "persistence",
        "Rust automation data is malformed",
        "unsafe",
        true,
        "sensitive",
      );
  }
  return new RuntimeFailure(
    "persistence",
    "Rust automation operation failed",
    "safe",
    true,
    "sensitive",
  );
}

function jsonObject(value: unknown): NativeRustCoreObject {
  return value as NativeRustCoreObject;
}

/** Durable automation store backed by the Rust actor; it owns no timers or executors. */
export class NativeRustAutomationStore implements AutomationStorePort {
  constructor(
    readonly client: RustAutomationClient,
    readonly signal?: AbortSignal,
  ) {}

  #active(): void {
    if (this.signal?.aborted)
      throw new RuntimeFailure(
        "cancelled",
        "Rust automation operation was cancelled",
        "safe",
        true,
        "sensitive",
      );
  }

  async put(value: AutomationDefinition): Promise<AutomationDefinition> {
    const input = definition(value, "input");
    this.#active();
    try {
      const stored = definition(
        await this.client.automationPut(
          jsonObject(input) as NativeRustAutomationDefinitionInput,
          this.signal,
        ),
        "durable",
      );
      if (stored.id !== input.id || stored.revision !== input.revision)
        throw new RuntimeFailure(
          "persistence",
          "Rust automation definition is inconsistent",
          "unsafe",
          true,
          "sensitive",
        );
      return stored;
    } catch (error) {
      throw failure(error);
    }
  }

  async list(filter?: {
    readonly states?: readonly AutomationState[];
  }): Promise<readonly AutomationDefinition[]> {
    const states = filter?.states;
    if (
      states !== undefined &&
      (states.length > 3 ||
        states.some(
          (state) => !["active", "paused", "cancelled"].includes(state),
        ))
    )
      throw new RuntimeFailure(
        "validation",
        "Automation state filter is invalid",
      );
    this.#active();
    const input: NativeRustAutomationListInput = {
      limit: MAX_LIST_LIMIT,
      states: states ?? ["active", "paused", "cancelled"],
    };
    try {
      const values = await this.client.automationList(input, this.signal);
      if (!Array.isArray(values) || values.length > MAX_LIST_LIMIT)
        throw new RuntimeFailure(
          "persistence",
          "Rust automation list is malformed",
          "unsafe",
          true,
          "sensitive",
        );
      return values.map((value) => definition(value, "durable"));
    } catch (error) {
      throw failure(error);
    }
  }

  async cancel(
    id: string,
    expectedRevision: number,
    cancelledAt: number,
  ): Promise<AutomationDefinition> {
    const input: NativeRustAutomationCancelInput = {
      id: identifier(id, "id"),
      expectedRevision: integer(expectedRevision, "expectedRevision"),
      cancelledAt: integer(cancelledAt, "cancelledAt"),
    };
    this.#active();
    try {
      const stored = definition(
        await this.client.automationCancel(input, this.signal),
        "durable",
      );
      if (
        stored.id !== input.id ||
        stored.revision !== input.expectedRevision + 1 ||
        stored.state !== "cancelled" ||
        stored.updatedAt !== input.cancelledAt
      )
        throw new RuntimeFailure(
          "persistence",
          "Rust automation cancellation is inconsistent",
          "unsafe",
          true,
          "sensitive",
        );
      return stored;
    } catch (error) {
      throw failure(error);
    }
  }

  async claim(
    request: Parameters<AutomationStorePort["claim"]>[0],
  ): Promise<readonly AutomationClaim[]> {
    const ownerId = identifier(request.ownerId, "ownerId");
    const now = integer(request.now, "now");
    const leaseMs = integer(request.leaseMs, "leaseMs", 1, MAX_LEASE_MS);
    const limit = integer(request.limit, "limit", 1, MAX_LIST_LIMIT);
    if (request.candidates.length < 1 || request.candidates.length > limit)
      throw new RuntimeFailure(
        "validation",
        "Automation candidates must be non-empty and bounded by limit",
      );
    integer(now + leaseMs, "lease deadline");
    const candidates = request.candidates.map((candidate) => ({
      automationId: identifier(
        candidate.automationId,
        "candidate.automationId",
      ),
      scheduledFor: integer(candidate.scheduledAt, "candidate.scheduledAt"),
    }));
    const input: NativeRustAutomationClaimInput = {
      ownerId,
      now,
      leaseMs,
      limit,
      candidates,
    };
    this.#active();
    try {
      const values = await this.client.automationClaim(input, this.signal);
      if (!Array.isArray(values) || values.length > limit)
        throw new RuntimeFailure(
          "persistence",
          "Rust automation claims are malformed",
          "unsafe",
          true,
          "sensitive",
        );
      return values.map((value) => {
        const parsed = claim(value, "durable");
        if (
          parsed.ownerId !== ownerId ||
          parsed.leaseExpiresAt !== now + leaseMs
        )
          throw new RuntimeFailure(
            "persistence",
            "Rust automation claim ownership is inconsistent",
            "unsafe",
            true,
            "sensitive",
          );
        return parsed;
      });
    } catch (error) {
      throw failure(error);
    }
  }

  async heartbeat(
    value: AutomationClaim,
    now: number,
    leaseMs: number,
  ): Promise<AutomationClaim> {
    const owned = claim(value, "input");
    const checkedNow = integer(now, "now");
    const checkedLease = integer(leaseMs, "leaseMs", 1, MAX_LEASE_MS);
    integer(checkedNow + checkedLease, "lease deadline");
    const input: NativeRustAutomationHeartbeatInput = {
      runId: owned.runId,
      ownerId: owned.ownerId,
      fencingToken: owned.fencingToken,
      now: checkedNow,
      leaseMs: checkedLease,
    };
    this.#active();
    try {
      const refreshed = claim(
        await this.client.automationHeartbeat(input, this.signal),
        "durable",
      );
      if (
        refreshed.runId !== owned.runId ||
        refreshed.ownerId !== owned.ownerId ||
        refreshed.fencingToken !== owned.fencingToken ||
        refreshed.leaseExpiresAt !== checkedNow + checkedLease
      )
        throw new RuntimeFailure(
          "persistence",
          "Rust automation heartbeat is inconsistent",
          "unsafe",
          true,
          "sensitive",
        );
      return refreshed;
    } catch (error) {
      throw failure(error);
    }
  }

  async #settle<T extends AutomationOutcome["state"]>(
    method: "automationComplete" | "automationFail" | "automationUncertain",
    value: AutomationClaim,
    result: Extract<AutomationOutcome, { readonly state: T }>,
    expected: T,
  ): Promise<AutomationRun> {
    const owned = claim(value, "input");
    const checked = outcome(result, expected, "input");
    const input: NativeRustAutomationSettleInput = {
      runId: owned.runId,
      ownerId: owned.ownerId,
      fencingToken: owned.fencingToken,
      outcome: checked as unknown as NativeRustCoreObject,
    };
    this.#active();
    try {
      return run(
        await this.client[method](input, this.signal),
        expected,
        owned,
      );
    } catch (error) {
      throw failure(error);
    }
  }

  complete(
    value: AutomationClaim,
    result: Extract<AutomationOutcome, { readonly state: "succeeded" }>,
  ): Promise<AutomationRun> {
    return this.#settle("automationComplete", value, result, "succeeded");
  }

  fail(
    value: AutomationClaim,
    result: Extract<AutomationOutcome, { readonly state: "failed" }>,
  ): Promise<AutomationRun> {
    return this.#settle("automationFail", value, result, "failed");
  }

  uncertain(
    value: AutomationClaim,
    result: Extract<AutomationOutcome, { readonly state: "uncertain" }>,
  ): Promise<AutomationRun> {
    return this.#settle("automationUncertain", value, result, "uncertain");
  }
}
