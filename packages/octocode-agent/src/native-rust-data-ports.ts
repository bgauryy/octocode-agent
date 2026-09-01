import {
  assertEffectAdmissionReceipt,
  RuntimeFailure,
  projectSession,
  revision,
  type EffectAdmissionReceipt,
  type EffectAdmissionResult,
  type EffectLedgerPort,
  type EffectLedgerRecord,
  type EffectLedgerState,
  type Revision,
  type SessionEvent,
  type SessionId,
  type SessionLoadResult,
  type SessionStore,
} from "@octocodeai/agent-core";

import {
  NativeRustCoreError,
  type NativeRustCoreClient,
  type NativeRustCoreJson,
  type NativeRustCoreObject,
  type NativeRustSessionIndexInput,
} from "./native-rust-core.js";

type RustSessionClient = Pick<
  NativeRustCoreClient,
  "sessionAppend" | "sessionLoad"
>;
type RustSessionIndexClient = Pick<NativeRustCoreClient, "sessionList">;
type RustEffectClient = Pick<
  NativeRustCoreClient,
  "effectBegin" | "effectGet" | "effectSettle"
>;

const MAX_SAFE_REVISION = BigInt(Number.MAX_SAFE_INTEGER);
const EFFECT_STATES = new Set<EffectLedgerState>([
  "started",
  "committed",
  "failed",
  "cancelled",
  "uncertain",
]);
const TERMINAL_EFFECT_STATES = new Set<Exclude<EffectLedgerState, "started">>([
  "committed",
  "failed",
  "cancelled",
  "uncertain",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedRevision(
  value: unknown,
  failure: "validation" | "session-corruption",
): Revision {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RuntimeFailure(
      failure,
      failure === "validation"
        ? "Session revision is invalid"
        : "Rust session revision is malformed",
      "unsafe",
      true,
      "sensitive",
    );
  }
  const numeric = BigInt(value);
  if (numeric > MAX_SAFE_REVISION) {
    throw new RuntimeFailure(
      failure,
      failure === "validation"
        ? "Session revision exceeds the runtime range"
        : "Rust session revision exceeds the runtime range",
      "unsafe",
      true,
      "sensitive",
    );
  }
  return revision(value);
}

function sessionFailure(error: unknown): RuntimeFailure {
  if (error instanceof RuntimeFailure) return error;
  if (error instanceof NativeRustCoreError) {
    if (error.category === "remote" && error.code === "CONFLICT") {
      return new RuntimeFailure(
        "session-conflict",
        "Rust session revision conflict",
        "safe",
        true,
        "sensitive",
      );
    }
    if (
      error.category === "protocol" ||
      (error.category === "remote" &&
        ["CORRUPTION", "SESSION_CORRUPTION"].includes(error.code ?? ""))
    ) {
      return new RuntimeFailure(
        "session-corruption",
        "Rust session data is malformed",
        "unsafe",
        true,
        "sensitive",
      );
    }
    return new RuntimeFailure(
      "persistence",
      "Rust session operation failed",
      "safe",
      true,
      "sensitive",
    );
  }
  return new RuntimeFailure(
    "persistence",
    "Rust session operation failed",
    "safe",
    true,
    "sensitive",
  );
}

function effectFailure(
  error: unknown,
  operation: "begin" | "get" | "settle",
): RuntimeFailure {
  if (error instanceof RuntimeFailure) return error;
  if (error instanceof NativeRustCoreError) {
    if (error.category === "remote" && error.code === "CONFLICT") {
      return new RuntimeFailure(
        "conflict",
        "Rust effect is already terminal with a different state",
        "unsafe",
        true,
        "sensitive",
      );
    }
    if (
      error.category === "remote" &&
      error.code === "NOT_FOUND" &&
      operation === "settle"
    ) {
      return new RuntimeFailure(
        "internal-invariant",
        "Rust effect was not admitted",
        "unsafe",
        true,
        "sensitive",
      );
    }
    if (error.category === "remote" && error.code === "INVALID_REQUEST") {
      return new RuntimeFailure(
        "validation",
        "Rust effect request is invalid",
        "unsafe",
        true,
        "sensitive",
      );
    }
    if (
      error.category === "protocol" ||
      (error.category === "remote" &&
        ["CORRUPTION", "EFFECT_CORRUPTION"].includes(error.code ?? ""))
    ) {
      return new RuntimeFailure(
        "persistence",
        "Rust effect data is malformed",
        "unsafe",
        true,
        "sensitive",
      );
    }
  }
  return new RuntimeFailure(
    "persistence",
    "Rust effect operation failed",
    "safe",
    true,
    "sensitive",
  );
}

function jsonEvents(
  events: readonly SessionEvent[],
): readonly NativeRustCoreJson[] {
  return events as unknown as readonly NativeRustCoreJson[];
}

function sessionIndex(
  events: readonly SessionEvent[],
): NativeRustSessionIndexInput | null {
  if (events.length === 0) return null;
  let cwd: string | undefined;
  let parentSessionId: string | undefined;
  let updatedAt = 0;
  for (const item of events) {
    updatedAt = Math.max(updatedAt, item.timestamp);
    if (item.event.type !== "custom.appended") continue;
    if (
      item.event.kind === "session.cwd" &&
      typeof item.event.value === "string"
    )
      cwd = item.event.value;
    if (
      item.event.kind === "session.parent" &&
      typeof item.event.value === "string" &&
      item.event.value.trim()
    ) {
      parentSessionId = item.event.value;
    }
  }
  return {
    updatedAt,
    cwd: cwd ?? null,
    parentSessionId: parentSessionId ?? null,
  };
}

function validateEffectJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new RuntimeFailure(
        "validation",
        "Effect admission receipt requires finite numbers",
      );
    return;
  }
  if (typeof value !== "object")
    throw new RuntimeFailure(
      "validation",
      "Effect admission receipt must be JSON-compatible",
    );
  if (seen.has(value))
    throw new RuntimeFailure(
      "validation",
      "Effect admission receipt must be acyclic",
    );
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const child of value) validateEffectJson(child, seen);
    } else {
      for (const child of Object.values(value)) validateEffectJson(child, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function validateAppend(
  id: SessionId,
  expectedRevision: Revision,
  events: readonly SessionEvent[],
): Revision {
  const current = checkedRevision(expectedRevision, "validation");
  const nextValue = BigInt(current) + BigInt(events.length);
  if (nextValue > MAX_SAFE_REVISION)
    throw new RuntimeFailure(
      "validation",
      "Session revision exceeds the runtime range",
    );
  const next = revision(String(nextValue));
  const firstSequence = Number(current) + 1;
  for (const [index, event] of events.entries()) {
    const sequence = firstSequence + index;
    if (
      event.sessionId !== id ||
      event.sequence !== sequence ||
      event.revision !== String(sequence)
    ) {
      throw new RuntimeFailure(
        "session-corruption",
        "Appended session events do not match the expected revision",
        "unsafe",
        true,
        "sensitive",
      );
    }
  }
  projectSession(id, events, {
    allowGaps: current !== revision("0"),
    revision: next,
  });
  return next;
}

/** SessionStore whose atomic compare-and-append and durable event log are owned by the Rust actor. */
export class NativeRustSessionStore implements SessionStore {
  constructor(readonly client: RustSessionClient) {}

  async append(
    id: SessionId,
    expectedRevision: Revision,
    events: readonly SessionEvent[],
  ): Promise<Revision> {
    const expectedNext = validateAppend(id, expectedRevision, events);
    const index = sessionIndex(events);
    try {
      const result = await this.client.sessionAppend({
        sessionId: String(id),
        expectedRevision: String(expectedRevision),
        events: jsonEvents(events),
        index,
      });
      if (!isObject(result))
        throw new RuntimeFailure(
          "session-corruption",
          "Rust session append result is malformed",
          "unsafe",
          true,
          "sensitive",
        );
      const committed = checkedRevision(
        result["revision"],
        "session-corruption",
      );
      if (committed !== expectedNext)
        throw new RuntimeFailure(
          "session-corruption",
          "Rust session append returned an unexpected revision",
          "unsafe",
          true,
          "sensitive",
        );
      return committed;
    } catch (error) {
      throw sessionFailure(error);
    }
  }

  async load(id: SessionId): Promise<SessionLoadResult> {
    try {
      const result = await this.client.sessionLoad({ sessionId: String(id) });
      if (result === null)
        return { events: [], projection: projectSession(id, []) };
      if (
        !isObject(result) ||
        result["sessionId"] !== id ||
        !Array.isArray(result["events"])
      ) {
        throw new RuntimeFailure(
          "session-corruption",
          "Rust session record is malformed",
          "unsafe",
          true,
          "sensitive",
        );
      }
      const durableRevision = checkedRevision(
        result["revision"],
        "session-corruption",
      );
      if (BigInt(durableRevision) !== BigInt(result["events"].length)) {
        throw new RuntimeFailure(
          "session-corruption",
          "Rust session revision does not match its event log",
          "unsafe",
          true,
          "sensitive",
        );
      }
      const events = result["events"] as readonly SessionEvent[];
      const projection = projectSession(id, events, {
        revision: durableRevision,
      });
      if (projection.revision !== durableRevision) {
        throw new RuntimeFailure(
          "session-corruption",
          "Rust session projection revision is inconsistent",
          "unsafe",
          true,
          "sensitive",
        );
      }
      return { events, projection };
    } catch (error) {
      throw sessionFailure(error);
    }
  }
}

export interface NativeRustSessionIndexEntry {
  readonly sessionId: SessionId;
  readonly revision: Revision;
  readonly cwd: string;
  readonly parentSessionId?: SessionId;
  readonly updatedAt: number;
}

/** Transactional discovery/navigation over the same Rust database that owns session events. */
export class NativeRustSessionIndex {
  constructor(
    readonly client: RustSessionIndexClient,
    readonly limit = 1_000,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RuntimeFailure(
        "validation",
        "Rust session index limit must be between 1 and 1000",
      );
    }
  }

  async list(cwd: string): Promise<readonly NativeRustSessionIndexEntry[]> {
    try {
      const values = await this.client.sessionList({ cwd, limit: this.limit });
      return values.map((value): NativeRustSessionIndexEntry => {
        if (
          !isObject(value) ||
          typeof value["sessionId"] !== "string" ||
          value["sessionId"].length === 0 ||
          value["cwd"] !== cwd ||
          typeof value["revision"] !== "string" ||
          typeof value["updatedAt"] !== "number" ||
          !Number.isSafeInteger(value["updatedAt"]) ||
          value["updatedAt"] < 0 ||
          (value["parentSessionId"] !== null &&
            value["parentSessionId"] !== undefined &&
            typeof value["parentSessionId"] !== "string")
        ) {
          throw new RuntimeFailure(
            "session-corruption",
            "Rust session index record is malformed",
            "unsafe",
            true,
            "sensitive",
          );
        }
        const durableRevision = checkedRevision(
          value["revision"],
          "session-corruption",
        );
        if (durableRevision === revision("0")) {
          throw new RuntimeFailure(
            "session-corruption",
            "Rust session index contains an empty session",
            "unsafe",
            true,
            "sensitive",
          );
        }
        return {
          sessionId: value["sessionId"] as SessionId,
          revision: durableRevision,
          cwd,
          ...(typeof value["parentSessionId"] === "string"
            ? { parentSessionId: value["parentSessionId"] as SessionId }
            : {}),
          updatedAt: value["updatedAt"],
        };
      });
    } catch (error) {
      throw sessionFailure(error);
    }
  }

  async resolve(
    current: SessionId,
    direction: "parent" | "child" | "previous" | "next",
    cwd: string,
  ): Promise<SessionId | null> {
    const available = await this.list(cwd);
    const index = available.findIndex(({ sessionId: id }) => id === current);
    if (index < 0) return null;
    if (direction === "parent") {
      const parent = available[index]?.parentSessionId;
      return parent !== undefined &&
        available.some(({ sessionId: id }) => id === parent)
        ? parent
        : null;
    }
    if (direction === "child")
      return (
        available.find(({ parentSessionId }) => parentSessionId === current)
          ?.sessionId ?? null
      );
    return (
      (direction === "previous" ? available[index + 1] : available[index - 1])
        ?.sessionId ?? null
    );
  }
}

function parseEffectRecord(
  value: unknown,
  expectedKey: string,
): EffectLedgerRecord | undefined {
  if (value === null || value === undefined) return undefined;
  if (
    !isObject(value) ||
    value["key"] !== expectedKey ||
    typeof value["state"] !== "string" ||
    !EFFECT_STATES.has(value["state"] as EffectLedgerState) ||
    typeof value["updatedAt"] !== "number" ||
    !Number.isFinite(value["updatedAt"])
  ) {
    throw new RuntimeFailure(
      "persistence",
      "Rust effect record is malformed",
      "unsafe",
      true,
      "sensitive",
    );
  }
  try {
    assertEffectAdmissionReceipt(value["receipt"]);
  } catch {
    throw new RuntimeFailure(
      "persistence",
      "Rust effect record is malformed",
      "unsafe",
      true,
      "sensitive",
    );
  }
  return value as unknown as EffectLedgerRecord;
}

/** Effect ledger whose admission and terminal transitions are atomic in the Rust actor. */
export class NativeRustEffectLedger implements EffectLedgerPort {
  constructor(
    readonly client: RustEffectClient,
    readonly sessionId: SessionId,
    readonly now: () => number = Date.now,
  ) {}

  async begin(
    key: string,
    receipt: EffectAdmissionReceipt,
  ): Promise<EffectAdmissionResult> {
    assertEffectAdmissionReceipt(receipt);
    validateEffectJson(receipt);
    try {
      const existing = parseEffectRecord(
        await this.client.effectGet({ sessionId: String(this.sessionId), key }),
        key,
      );
      if (existing === undefined && receipt.expiresAt !== undefined) {
        const now = this.now();
        if (!Number.isSafeInteger(now) || now < 0) {
          throw new RuntimeFailure(
            "internal-invariant",
            "Effect ledger clock is invalid",
          );
        }
        if (receipt.expiresAt <= now) {
          throw new RuntimeFailure(
            "conflict",
            `Effect ${key} admission receipt expired`,
          );
        }
      }
      const result = await this.client.effectBegin({
        sessionId: String(this.sessionId),
        key,
        receipt: receipt as unknown as NativeRustCoreObject,
      });
      if (
        typeof result !== "string" ||
        ![
          "acquired",
          "started",
          "committed",
          "failed",
          "cancelled",
          "uncertain",
          "mismatch",
        ].includes(result)
      ) {
        throw new RuntimeFailure(
          "persistence",
          "Rust effect admission result is malformed",
          "unsafe",
          true,
          "sensitive",
        );
      }
      return result as EffectAdmissionResult;
    } catch (error) {
      throw effectFailure(error, "begin");
    }
  }

  async settle(
    key: string,
    state: Exclude<EffectLedgerState, "started">,
  ): Promise<void> {
    if (!TERMINAL_EFFECT_STATES.has(state))
      throw new RuntimeFailure(
        "validation",
        "Effect terminal state is invalid",
      );
    try {
      const result = await this.client.effectSettle({
        sessionId: String(this.sessionId),
        key,
        state,
      });
      if (result !== state)
        throw new RuntimeFailure(
          "persistence",
          "Rust effect settlement result is malformed",
          "unsafe",
          true,
          "sensitive",
        );
    } catch (error) {
      throw effectFailure(error, "settle");
    }
  }

  async get(key: string): Promise<EffectLedgerRecord | undefined> {
    try {
      return parseEffectRecord(
        await this.client.effectGet({ sessionId: String(this.sessionId), key }),
        key,
      );
    } catch (error) {
      throw effectFailure(error, "get");
    }
  }
}
