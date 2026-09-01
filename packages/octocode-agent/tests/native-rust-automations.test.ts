import {
  RuntimeFailure,
  type AutomationClaim,
  type AutomationDefinition,
  type AutomationOutcome,
} from "@octocodeai/agent-core";
import { describe, expect, it, vi } from "vitest";

import { NativeRustAutomationStore } from "../src/native-rust-automations.js";
import {
  NativeRustCoreError,
  type NativeRustAutomationCancelInput,
  type NativeRustAutomationClaimInput,
  type NativeRustAutomationDefinitionInput,
  type NativeRustAutomationHeartbeatInput,
  type NativeRustAutomationListInput,
  type NativeRustAutomationSettleInput,
} from "../src/native-rust-core.js";

const DEFINITION: AutomationDefinition = {
  schemaVersion: 1,
  id: "awareness-status",
  revision: 0,
  state: "active",
  schedule: { kind: "interval", everyMs: 30_000, anchorAt: 1_000 },
  misfirePolicy: "run-once",
  retryPolicy: { maxAttempts: 3, backoffMs: 5_000 },
  action: {
    name: "awareness.status",
    version: 1,
    payload: { workspace: "/workspace" },
  },
  createdAt: 1_000,
  updatedAt: 1_000,
};

const CLAIM: AutomationClaim = {
  schemaVersion: 1,
  runId: "run-1",
  automationId: DEFINITION.id,
  scheduledFor: 30_000,
  attempt: 1,
  state: "claimed",
  ownerId: "native-agent",
  leaseExpiresAt: 61_000,
  fencingToken: 41,
};

interface FakeAutomationClient {
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

function fakeClient(): FakeAutomationClient {
  const terminal = (
    input: NativeRustAutomationSettleInput,
    state: "succeeded" | "failed" | "uncertain",
  ) => ({
    schemaVersion: 1,
    runId: CLAIM.runId,
    automationId: CLAIM.automationId,
    scheduledFor: CLAIM.scheduledFor,
    attempt: CLAIM.attempt,
    state,
    outcome: input.outcome,
  });
  return {
    automationPut: vi.fn(async (input) => input),
    automationList: vi.fn(async () => [DEFINITION]),
    automationCancel: vi.fn(async () => ({
      ...DEFINITION,
      revision: 1,
      state: "cancelled",
      updatedAt: 2_000,
    })),
    automationClaim: vi.fn(async () => [CLAIM]),
    automationHeartbeat: vi.fn(async (input) => ({
      ...CLAIM,
      leaseExpiresAt: input.now + input.leaseMs,
    })),
    automationComplete: vi.fn(async (input) => terminal(input, "succeeded")),
    automationFail: vi.fn(async (input) => terminal(input, "failed")),
    automationUncertain: vi.fn(async (input) => terminal(input, "uncertain")),
  };
}

describe("NativeRustAutomationStore", () => {
  it("projects canonical definitions and translates scheduledAt candidates to the Rust wire", async () => {
    const client = fakeClient();
    const store = new NativeRustAutomationStore(client);

    await expect(store.put(DEFINITION)).resolves.toEqual(DEFINITION);
    await expect(store.list({ states: ["active"] })).resolves.toEqual([
      DEFINITION,
    ]);
    await expect(
      store.claim({
        ownerId: "native-agent",
        now: 1_000,
        leaseMs: 60_000,
        limit: 1,
        candidates: [
          { automationId: DEFINITION.id, scheduledAt: CLAIM.scheduledFor },
        ],
      }),
    ).resolves.toEqual([CLAIM]);

    expect(client.automationPut).toHaveBeenCalledWith(DEFINITION, undefined);
    expect(client.automationList).toHaveBeenCalledWith(
      { limit: 100, states: ["active"] },
      undefined,
    );
    expect(client.automationClaim).toHaveBeenCalledWith(
      {
        ownerId: "native-agent",
        now: 1_000,
        leaseMs: 60_000,
        limit: 1,
        candidates: [
          { automationId: DEFINITION.id, scheduledFor: CLAIM.scheduledFor },
        ],
      },
      undefined,
    );
  });

  it("uses revision CAS for cancellation and owner plus numeric fencing for every lease mutation", async () => {
    const client = fakeClient();
    const store = new NativeRustAutomationStore(client);
    const succeeded: Extract<AutomationOutcome, { state: "succeeded" }> = {
      state: "succeeded",
      completedAt: 2_000,
      result: { ok: true },
    };
    const failed: Extract<AutomationOutcome, { state: "failed" }> = {
      state: "failed",
      completedAt: 2_001,
      error: { code: "temporary", message: "try later", retryable: true },
    };
    const uncertain: Extract<AutomationOutcome, { state: "uncertain" }> = {
      state: "uncertain",
      completedAt: 2_002,
      reason: "transport lost",
    };

    await store.cancel(DEFINITION.id, 0, 2_000);
    await store.heartbeat(CLAIM, 1_001, 60_000);
    await store.complete(CLAIM, succeeded);
    await store.fail(CLAIM, failed);
    await store.uncertain(CLAIM, uncertain);

    expect(client.automationCancel).toHaveBeenCalledWith(
      { id: DEFINITION.id, expectedRevision: 0, cancelledAt: 2_000 },
      undefined,
    );
    const ownership = {
      runId: CLAIM.runId,
      ownerId: CLAIM.ownerId,
      fencingToken: CLAIM.fencingToken,
    };
    expect(client.automationHeartbeat).toHaveBeenCalledWith(
      { ...ownership, now: 1_001, leaseMs: 60_000 },
      undefined,
    );
    expect(client.automationComplete).toHaveBeenCalledWith(
      { ...ownership, outcome: succeeded },
      undefined,
    );
    expect(client.automationFail).toHaveBeenCalledWith(
      { ...ownership, outcome: failed },
      undefined,
    );
    expect(client.automationUncertain).toHaveBeenCalledWith(
      { ...ownership, outcome: uncertain },
      undefined,
    );
  });

  it("rejects invalid and unbounded inputs before crossing the process boundary", async () => {
    const client = fakeClient();
    const store = new NativeRustAutomationStore(client);

    await expect(
      store.claim({
        ownerId: "native-agent",
        now: 0,
        leaseMs: 1,
        limit: 1,
        candidates: [],
      }),
    ).rejects.toMatchObject({ category: "validation" });
    await expect(
      store.claim({
        ownerId: "native-agent",
        now: 0,
        leaseMs: 86_400_001,
        limit: 1,
        candidates: [{ automationId: DEFINITION.id, scheduledAt: 0 }],
      }),
    ).rejects.toMatchObject({ category: "validation" });
    await expect(store.cancel(DEFINITION.id, -1, 2_000)).rejects.toMatchObject({
      category: "validation",
    });
    expect(client.automationClaim).not.toHaveBeenCalled();
    expect(client.automationCancel).not.toHaveBeenCalled();
  });

  it("fails closed on malformed durable definitions, claims, and outcomes", async () => {
    const malformedDefinition = fakeClient();
    malformedDefinition.automationList = vi.fn(async () => [
      { ...DEFINITION, retryPolicy: undefined },
    ]) as FakeAutomationClient["automationList"];
    await expect(
      new NativeRustAutomationStore(malformedDefinition).list(),
    ).rejects.toMatchObject({
      category: "persistence",
      retry: "unsafe",
    });

    const malformedClaim = fakeClient();
    malformedClaim.automationClaim = vi.fn(async () => [
      { ...CLAIM, fencingToken: "41" },
    ]) as FakeAutomationClient["automationClaim"];
    await expect(
      new NativeRustAutomationStore(malformedClaim).claim({
        ownerId: "native-agent",
        now: 1_000,
        leaseMs: 60_000,
        limit: 1,
        candidates: [{ automationId: DEFINITION.id, scheduledAt: 30_000 }],
      }),
    ).rejects.toMatchObject({ category: "persistence", retry: "unsafe" });

    const malformedOutcome = fakeClient();
    malformedOutcome.automationComplete = vi.fn(async () => ({
      ...CLAIM,
      state: "succeeded",
      outcome: { state: "failed", completedAt: 2_000 },
    }));
    await expect(
      new NativeRustAutomationStore(malformedOutcome).complete(CLAIM, {
        state: "succeeded",
        completedAt: 2_000,
      }),
    ).rejects.toMatchObject({ category: "persistence", retry: "unsafe" });
  });

  it("maps stale remote ownership and cancellation without leaking remote details", async () => {
    const stale = fakeClient();
    stale.automationCancel = vi.fn(async () => {
      throw new NativeRustCoreError(
        "remote",
        "secret sqlite path /private/core.sqlite3",
        "CONFLICT",
      );
    });
    const conflict = await new NativeRustAutomationStore(stale)
      .cancel(DEFINITION.id, 0, 2_000)
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(RuntimeFailure);
    expect(conflict).toMatchObject({ category: "conflict", retry: "unsafe" });
    expect((conflict as Error).message).not.toMatch(/secret|private|sqlite/u);

    const cancelled = fakeClient();
    cancelled.automationPut = vi.fn(async () => {
      throw new NativeRustCoreError("cancelled", "cancelled");
    });
    await expect(
      new NativeRustAutomationStore(cancelled).put(DEFINITION),
    ).rejects.toMatchObject({ category: "cancelled", retry: "safe" });
  });

  it("passes an adapter abort signal through every Rust request", async () => {
    const client = fakeClient();
    const controller = new AbortController();
    const store = new NativeRustAutomationStore(client, controller.signal);
    controller.abort();

    await expect(store.put(DEFINITION)).rejects.toMatchObject({
      category: "cancelled",
    });
    expect(client.automationPut).not.toHaveBeenCalled();
  });
});
