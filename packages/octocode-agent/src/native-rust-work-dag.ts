import { RuntimeFailure } from "@octocodeai/agent-core";
import { isDeepStrictEqual } from "node:util";

import {
  NativeRustCoreError,
  type NativeRustCoreJson,
  type NativeRustWorkClaim,
  type NativeRustWorkClaimInput,
  type NativeRustWorkGraph,
  type NativeRustWorkGraphItem,
  type NativeRustWorkGraphKey,
  type NativeRustWorkGraphResult,
  type NativeRustWorkGraphSummary,
  type NativeRustWorkHeartbeatInput,
  type NativeRustWorkPutGraphInput,
  type NativeRustWorkSettleInput,
  type NativeRustWorkSettlement,
} from "./native-rust-core.js";

export interface RustWorkDagClient {
  workPutGraph(
    input: NativeRustWorkPutGraphInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  workGetGraph(
    input: NativeRustWorkGraphKey,
    signal?: AbortSignal,
  ): Promise<unknown>;
  workClaim(
    input: NativeRustWorkClaimInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  workHeartbeat(
    input: NativeRustWorkHeartbeatInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  workComplete(
    input: NativeRustWorkSettleInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  workFail(
    input: NativeRustWorkSettleInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface NativeWorkDagDefinition {
  readonly graphId: string;
  readonly items: readonly {
    readonly itemId: string;
    readonly dependsOn: readonly string[];
  }[];
}

export interface NativeWorkDagClaimRequest {
  readonly graphId: string;
  readonly ownerId: string;
  readonly now: number;
  readonly leaseMs: number;
  readonly limit: number;
}

const MAX_IDENTIFIER_BYTES = 512;
const MAX_ITEMS = 1000;
const MAX_DEPENDENCIES_PER_ITEM = 1000;
const MAX_CLAIMS = 100;
const MAX_LEASE_MS = 86_400_000;
const MAX_GRAPH_REQUEST_BYTES = 512 * 1024;
const MAX_OUTCOME_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES ||
    /[\0\r\n]/u.test(value)
  )
    throw new RuntimeFailure("validation", `Invalid dependency-work ${field}`);
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
    throw new RuntimeFailure("validation", `Invalid dependency-work ${field}`);
  return value as number;
}

function durableFailure(message: string): RuntimeFailure {
  return new RuntimeFailure(
    "persistence",
    message,
    "unsafe",
    true,
    "sensitive",
  );
}

function identifierList(
  value: unknown,
  field: string,
  source: "input" | "durable",
): readonly string[] {
  try {
    if (!Array.isArray(value) || value.length > MAX_DEPENDENCIES_PER_ITEM)
      throw new TypeError("array");
    const parsed = value.map((candidate, index) =>
      identifier(candidate, `${field}[${index}]`),
    );
    if (new Set(parsed).size !== parsed.length)
      throw new TypeError("duplicates");
    return Object.freeze(parsed);
  } catch (error) {
    if (source === "input" && error instanceof RuntimeFailure) throw error;
    if (source === "input")
      throw new RuntimeFailure(
        "validation",
        `Invalid dependency-work ${field}`,
      );
    throw durableFailure("Rust dependency-work identifier list is malformed");
  }
}

function graphDefinition(
  value: NativeWorkDagDefinition,
): NativeRustWorkPutGraphInput {
  if (
    !isObject(value) ||
    !onlyKeys(value, ["graphId", "items"]) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > MAX_ITEMS
  )
    throw new RuntimeFailure("validation", "Dependency-work graph is invalid");
  const graphId = identifier(value.graphId, "graphId");
  const ids = new Set<string>();
  const items = value.items.map((candidate, index) => {
    if (!isObject(candidate) || !onlyKeys(candidate, ["itemId", "dependsOn"]))
      throw new RuntimeFailure(
        "validation",
        `Invalid dependency-work item ${index + 1}`,
      );
    const itemId = identifier(candidate.itemId, `items[${index}].itemId`);
    if (ids.has(itemId))
      throw new RuntimeFailure(
        "validation",
        "Dependency-work item IDs must be unique",
      );
    ids.add(itemId);
    return Object.freeze({
      itemId,
      dependsOn: identifierList(
        candidate.dependsOn,
        `items[${index}].dependsOn`,
        "input",
      ),
    });
  });
  const byId = new Map(items.map((item) => [item.itemId, item] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (itemId: string): void => {
    if (visiting.has(itemId))
      throw new RuntimeFailure(
        "validation",
        "Dependency-work graph contains a cycle",
      );
    if (visited.has(itemId)) return;
    visiting.add(itemId);
    for (const dependency of byId.get(itemId)?.dependsOn ?? []) {
      if (dependency === itemId || !byId.has(dependency))
        throw new RuntimeFailure(
          "validation",
          `Dependency-work item ${itemId} has an invalid dependency`,
        );
      visit(dependency);
    }
    visiting.delete(itemId);
    visited.add(itemId);
  };
  for (const item of items) visit(item.itemId);
  const result: NativeRustWorkPutGraphInput = Object.freeze({
    graphId,
    items: Object.freeze(items),
  });
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_GRAPH_REQUEST_BYTES
  )
    throw new RuntimeFailure(
      "validation",
      "Dependency-work graph exceeds the native request budget",
    );
  return result;
}

function graphSummary(
  value: unknown,
  expected: NativeRustWorkPutGraphInput,
): NativeRustWorkGraphSummary {
  if (
    !isObject(value) ||
    !onlyKeys(value, ["schemaVersion", "graphId", "itemCount"]) ||
    value.schemaVersion !== 1 ||
    value.graphId !== expected.graphId ||
    value.itemCount !== expected.items.length
  )
    throw durableFailure("Rust dependency-work graph summary is malformed");
  return Object.freeze({
    schemaVersion: 1,
    graphId: expected.graphId,
    itemCount: expected.items.length,
  });
}

function claim(
  value: unknown,
  expected: { readonly graphId: string; readonly ownerId: string },
  source: "input" | "durable",
): NativeRustWorkClaim {
  const fail = (): never => {
    if (source === "input")
      throw new RuntimeFailure(
        "validation",
        "Dependency-work claim is invalid",
      );
    throw durableFailure("Rust dependency-work claim is malformed");
  };
  try {
    if (
      !isObject(value) ||
      !onlyKeys(value, [
        "schemaVersion",
        "graphId",
        "itemId",
        "state",
        "ownerId",
        "leaseExpiresAt",
        "fencingToken",
      ]) ||
      value.schemaVersion !== 1 ||
      value.graphId !== expected.graphId ||
      value.state !== "claimed" ||
      value.ownerId !== expected.ownerId
    )
      return fail();
    return Object.freeze({
      schemaVersion: 1,
      graphId: expected.graphId,
      itemId: identifier(value.itemId, "claim.itemId"),
      state: "claimed",
      ownerId: expected.ownerId,
      leaseExpiresAt: integer(value.leaseExpiresAt, "claim.leaseExpiresAt"),
      fencingToken: integer(value.fencingToken, "claim.fencingToken", 1),
    });
  } catch (error) {
    if (source === "input" && error instanceof RuntimeFailure) throw error;
    return fail();
  }
}

function claims(
  value: unknown,
  expected: NativeRustWorkClaimInput,
): readonly NativeRustWorkClaim[] {
  if (!Array.isArray(value) || value.length > expected.limit)
    throw durableFailure("Rust dependency-work claims are malformed");
  const seen = new Set<string>();
  return Object.freeze(
    value.map((candidate) => {
      const parsed = claim(candidate, expected, "durable");
      if (seen.has(parsed.itemId))
        throw durableFailure("Rust dependency-work claims contain duplicates");
      seen.add(parsed.itemId);
      return parsed;
    }),
  );
}

function graphItem(value: unknown, ordinal: number): NativeRustWorkGraphItem {
  if (
    !isObject(value) ||
    !onlyKeys(value, [
      "itemId",
      "ordinal",
      "dependsOn",
      "state",
      "fencingToken",
      "ownerId",
      "leaseExpiresAt",
      "outcome",
      "blockedBy",
    ]) ||
    value.ordinal !== ordinal ||
    !["pending", "claimed", "succeeded", "failed", "blocked"].includes(
      String(value.state),
    )
  )
    throw durableFailure("Rust dependency-work graph item is malformed");
  const itemId = identifier(value.itemId, "item.itemId");
  const dependsOn = identifierList(
    value.dependsOn,
    "item.dependsOn",
    "durable",
  );
  const blockedBy = identifierList(
    value.blockedBy,
    "item.blockedBy",
    "durable",
  );
  const fencingToken = integer(value.fencingToken, "item.fencingToken");
  const claimed = value.state === "claimed";
  const ownerId =
    value.ownerId === null ? null : identifier(value.ownerId, "item.ownerId");
  const leaseExpiresAt =
    value.leaseExpiresAt === null
      ? null
      : integer(value.leaseExpiresAt, "item.leaseExpiresAt");
  if (
    (claimed &&
      (ownerId === null ||
        leaseExpiresAt === null ||
        fencingToken < 1 ||
        value.outcome !== null)) ||
    (!claimed && (ownerId !== null || leaseExpiresAt !== null)) ||
    (value.state === "pending" && value.outcome !== null) ||
    ((value.state === "succeeded" || value.state === "failed") &&
      fencingToken < 1) ||
    (value.state !== "blocked" && blockedBy.length > 0)
  )
    throw durableFailure("Rust dependency-work graph ownership is malformed");
  return Object.freeze({
    itemId,
    ordinal,
    dependsOn,
    state: value.state as NativeRustWorkGraphItem["state"],
    fencingToken,
    ownerId,
    leaseExpiresAt,
    outcome: value.outcome as NativeRustCoreJson,
    blockedBy,
  });
}

function graph(
  value: unknown,
  expectedGraphId: string,
): NativeRustWorkGraphResult {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !onlyKeys(value, ["schemaVersion", "graphId", "items"]) ||
    value.schemaVersion !== 1 ||
    value.graphId !== expectedGraphId ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > MAX_ITEMS
  )
    throw durableFailure("Rust dependency-work graph is malformed");
  let items: NativeRustWorkGraphItem[];
  try {
    items = value.items.map(graphItem);
  } catch {
    throw durableFailure("Rust dependency-work graph item is malformed");
  }
  const ids = new Set(items.map((item) => item.itemId));
  if (ids.size !== items.length)
    throw durableFailure("Rust dependency-work graph item IDs are duplicated");
  for (const item of items) {
    if (
      item.dependsOn.some(
        (dependency) => dependency === item.itemId || !ids.has(dependency),
      ) ||
      item.blockedBy.some((dependency) => !item.dependsOn.includes(dependency))
    )
      throw durableFailure(
        "Rust dependency-work graph dependencies are malformed",
      );
  }
  const byId = new Map(items.map((item) => [item.itemId, item] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (itemId: string): void => {
    if (visiting.has(itemId))
      throw durableFailure("Rust dependency-work graph contains a cycle");
    if (visited.has(itemId)) return;
    visiting.add(itemId);
    for (const dependency of byId.get(itemId)?.dependsOn ?? [])
      visit(dependency);
    visiting.delete(itemId);
    visited.add(itemId);
  };
  for (const item of items) visit(item.itemId);
  return Object.freeze({
    schemaVersion: 1,
    graphId: expectedGraphId,
    items: Object.freeze(items),
  }) satisfies NativeRustWorkGraph;
}

function jsonOutcome(value: unknown): NativeRustCoreJson {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): NativeRustCoreJson => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH)
      throw new RuntimeFailure(
        "validation",
        "Dependency-work outcome is too complex",
      );
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    )
      return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate))
      return candidate;
    if (Array.isArray(candidate))
      return Object.freeze(candidate.map((item) => visit(item, depth + 1)));
    if (isObject(candidate)) {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null)
        throw new RuntimeFailure(
          "validation",
          "Dependency-work outcome must be JSON",
        );
      return Object.freeze(
        Object.fromEntries(
          Object.entries(candidate).map(([key, item]) => [
            key,
            visit(item, depth + 1),
          ]),
        ),
      );
    }
    throw new RuntimeFailure(
      "validation",
      "Dependency-work outcome must be JSON",
    );
  };
  const parsed = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_OUTCOME_BYTES)
    throw new RuntimeFailure(
      "validation",
      "Dependency-work outcome is too large",
    );
  return parsed;
}

function settlement(
  value: unknown,
  expected: NativeRustWorkSettleInput,
  state: "succeeded" | "failed",
): NativeRustWorkSettlement {
  if (
    !isObject(value) ||
    !onlyKeys(value, [
      "schemaVersion",
      "graphId",
      "itemId",
      "state",
      "fencingToken",
      "outcome",
    ]) ||
    value.schemaVersion !== 1 ||
    value.graphId !== expected.graphId ||
    value.itemId !== expected.itemId ||
    value.state !== state ||
    value.fencingToken !== expected.fencingToken ||
    !isDeepStrictEqual(value.outcome, expected.outcome)
  )
    throw durableFailure("Rust dependency-work settlement is malformed");
  return Object.freeze({
    schemaVersion: 1,
    graphId: expected.graphId,
    itemId: expected.itemId,
    state,
    fencingToken: expected.fencingToken,
    outcome: expected.outcome,
  });
}

function failure(error: unknown): RuntimeFailure {
  if (error instanceof RuntimeFailure) return error;
  if (error instanceof NativeRustCoreError) {
    if (error.category === "cancelled")
      return new RuntimeFailure(
        "cancelled",
        "Rust dependency-work operation was cancelled",
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
        "Rust dependency-work request is invalid",
        "unsafe",
        true,
        "sensitive",
      );
    if (
      error.category === "remote" &&
      (error.code === "CONFLICT" || error.code === "NOT_FOUND")
    )
      return new RuntimeFailure(
        "conflict",
        "Rust dependency-work ownership conflict",
        "unsafe",
        true,
        "sensitive",
      );
    if (
      error.category === "protocol" ||
      (error.category === "remote" && error.code === "CORRUPTION")
    )
      return durableFailure("Rust dependency-work data is malformed");
  }
  return new RuntimeFailure(
    "persistence",
    "Rust dependency-work operation failed",
    "safe",
    true,
    "sensitive",
  );
}

/**
 * Strict TypeScript semantic adapter for the Rust dependency-work ledger.
 * It persists scheduling mechanics only; callers still enter worker execution
 * through the ordinary policy, capability, effect, and process boundaries.
 */
export class NativeRustWorkDagStore {
  constructor(
    readonly client: RustWorkDagClient,
    readonly signal?: AbortSignal,
  ) {}

  #active(): void {
    if (this.signal?.aborted)
      throw new RuntimeFailure(
        "cancelled",
        "Rust dependency-work operation was cancelled",
        "safe",
        true,
        "sensitive",
      );
  }

  async putGraph(
    value: NativeWorkDagDefinition,
  ): Promise<NativeRustWorkGraphSummary> {
    const input = graphDefinition(value);
    this.#active();
    try {
      return graphSummary(
        await this.client.workPutGraph(input, this.signal),
        input,
      );
    } catch (error) {
      throw failure(error);
    }
  }

  async getGraph(graphIdValue: string): Promise<NativeRustWorkGraphResult> {
    const graphId = identifier(graphIdValue, "graphId");
    this.#active();
    try {
      return graph(
        await this.client.workGetGraph({ graphId }, this.signal),
        graphId,
      );
    } catch (error) {
      throw failure(error);
    }
  }

  async claim(
    value: NativeWorkDagClaimRequest,
  ): Promise<readonly NativeRustWorkClaim[]> {
    if (
      !isObject(value) ||
      !onlyKeys(value, ["graphId", "ownerId", "now", "leaseMs", "limit"])
    )
      throw new RuntimeFailure(
        "validation",
        "Dependency-work claim request is invalid",
      );
    const input: NativeRustWorkClaimInput = {
      graphId: identifier(value.graphId, "graphId"),
      ownerId: identifier(value.ownerId, "ownerId"),
      now: integer(value.now, "now"),
      leaseMs: integer(value.leaseMs, "leaseMs", 1, MAX_LEASE_MS),
      limit: integer(value.limit, "limit", 1, MAX_CLAIMS),
    };
    if (!Number.isSafeInteger(input.now + input.leaseMs))
      throw new RuntimeFailure(
        "validation",
        "Dependency-work lease deadline overflows",
      );
    this.#active();
    try {
      return claims(await this.client.workClaim(input, this.signal), input);
    } catch (error) {
      throw failure(error);
    }
  }

  async heartbeat(
    ownership: NativeRustWorkClaim,
    nowValue: number,
    leaseMsValue: number,
  ): Promise<NativeRustWorkClaim> {
    const owned = claim(ownership, ownership, "input");
    const input: NativeRustWorkHeartbeatInput = {
      graphId: owned.graphId,
      itemId: owned.itemId,
      ownerId: owned.ownerId,
      fencingToken: owned.fencingToken,
      now: integer(nowValue, "now"),
      leaseMs: integer(leaseMsValue, "leaseMs", 1, MAX_LEASE_MS),
    };
    if (!Number.isSafeInteger(input.now + input.leaseMs))
      throw new RuntimeFailure(
        "validation",
        "Dependency-work lease deadline overflows",
      );
    this.#active();
    try {
      const renewed = claim(
        await this.client.workHeartbeat(input, this.signal),
        input,
        "durable",
      );
      if (
        renewed.itemId !== input.itemId ||
        renewed.fencingToken !== input.fencingToken ||
        renewed.leaseExpiresAt !== input.now + input.leaseMs
      )
        throw durableFailure("Rust dependency-work heartbeat is inconsistent");
      return renewed;
    } catch (error) {
      throw failure(error);
    }
  }

  complete(
    ownership: NativeRustWorkClaim,
    completedAt: number,
    outcome: unknown,
  ): Promise<NativeRustWorkSettlement> {
    return this.#settle("succeeded", ownership, completedAt, outcome);
  }

  fail(
    ownership: NativeRustWorkClaim,
    completedAt: number,
    outcome: unknown,
  ): Promise<NativeRustWorkSettlement> {
    return this.#settle("failed", ownership, completedAt, outcome);
  }

  async #settle(
    state: "succeeded" | "failed",
    ownership: NativeRustWorkClaim,
    completedAtValue: number,
    outcomeValue: unknown,
  ): Promise<NativeRustWorkSettlement> {
    const owned = claim(ownership, ownership, "input");
    const input: NativeRustWorkSettleInput = {
      graphId: owned.graphId,
      itemId: owned.itemId,
      ownerId: owned.ownerId,
      fencingToken: owned.fencingToken,
      completedAt: integer(completedAtValue, "completedAt"),
      outcome: jsonOutcome(outcomeValue),
    };
    this.#active();
    try {
      const result =
        state === "succeeded"
          ? await this.client.workComplete(input, this.signal)
          : await this.client.workFail(input, this.signal);
      return settlement(result, input, state);
    } catch (error) {
      throw failure(error);
    }
  }
}
