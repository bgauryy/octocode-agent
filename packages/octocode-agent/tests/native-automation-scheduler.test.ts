import {
  RuntimeFailure,
  type AutomationCandidate,
  type AutomationClaim,
  type AutomationDefinition,
  type AutomationOutcome,
  type AutomationRun,
  type AutomationState,
  type AutomationStorePort,
} from "@octocodeai/agent-core";
import { describe, expect, it, vi } from "vitest";

import {
  NativeAutomationScheduler,
  NativeAutomationUncertainError,
  expandNativeAutomationCandidates,
  type NativeAutomationSemanticExecutor,
} from "../src/native-automation-scheduler.js";

function definition(
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    schemaVersion: 1,
    id: "status",
    revision: 0,
    state: "active",
    schedule: { kind: "interval", everyMs: 10, anchorAt: 0 },
    misfirePolicy: "run-once",
    retryPolicy: { maxAttempts: 2, backoffMs: 0 },
    action: { name: "awareness.status", version: 1, payload: {} },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

class FakeAutomationStore implements AutomationStorePort {
  readonly definitions = new Map<string, AutomationDefinition>();
  readonly runs = new Map<string, AutomationRun>();
  readonly completed: AutomationRun[] = [];
  readonly failed: AutomationRun[] = [];
  readonly uncertainRuns: AutomationRun[] = [];
  heartbeatCount = 0;
  #fence = 0;

  constructor(...definitions: AutomationDefinition[]) {
    for (const item of definitions) this.definitions.set(item.id, item);
  }

  async put(value: AutomationDefinition): Promise<AutomationDefinition> {
    this.definitions.set(value.id, value);
    return value;
  }

  async list(filter?: {
    readonly states?: readonly AutomationState[];
  }): Promise<readonly AutomationDefinition[]> {
    return [...this.definitions.values()].filter(
      (item) =>
        filter?.states === undefined || filter.states.includes(item.state),
    );
  }

  async cancel(
    id: string,
    expectedRevision: number,
    cancelledAt: number,
  ): Promise<AutomationDefinition> {
    const current = this.definitions.get(id);
    if (current === undefined || current.revision !== expectedRevision)
      throw new RuntimeFailure("conflict", "stale");
    const cancelled: AutomationDefinition = {
      ...current,
      revision: current.revision + 1,
      state: "cancelled",
      updatedAt: cancelledAt,
    };
    this.definitions.set(id, cancelled);
    return cancelled;
  }

  async claim(request: {
    readonly ownerId: string;
    readonly now: number;
    readonly leaseMs: number;
    readonly limit: number;
    readonly candidates: readonly AutomationCandidate[];
  }): Promise<readonly AutomationClaim[]> {
    const claims: AutomationClaim[] = [];
    for (const candidate of request.candidates) {
      if (claims.length >= request.limit) break;
      const key = `${candidate.automationId}:${candidate.scheduledAt}`;
      if (this.runs.has(key)) continue;
      const claim: AutomationClaim = {
        schemaVersion: 1,
        runId: `run-${key}`,
        automationId: candidate.automationId,
        scheduledFor: candidate.scheduledAt,
        attempt: 1,
        state: "claimed",
        ownerId: request.ownerId,
        leaseExpiresAt: request.now + request.leaseMs,
        fencingToken: ++this.#fence,
      };
      this.runs.set(key, claim);
      claims.push(claim);
    }
    return claims;
  }

  async heartbeat(
    claim: AutomationClaim,
    now: number,
    leaseMs: number,
  ): Promise<AutomationClaim> {
    this.heartbeatCount += 1;
    return { ...claim, leaseExpiresAt: now + leaseMs };
  }

  async complete(
    claim: AutomationClaim,
    outcome: Extract<AutomationOutcome, { readonly state: "succeeded" }>,
  ): Promise<AutomationRun> {
    const run = { ...terminal(claim), state: "succeeded", outcome } as const;
    this.completed.push(run);
    return run;
  }

  async fail(
    claim: AutomationClaim,
    outcome: Extract<AutomationOutcome, { readonly state: "failed" }>,
  ): Promise<AutomationRun> {
    const run = { ...terminal(claim), state: "failed", outcome } as const;
    this.failed.push(run);
    return run;
  }

  async uncertain(
    claim: AutomationClaim,
    outcome: Extract<AutomationOutcome, { readonly state: "uncertain" }>,
  ): Promise<AutomationRun> {
    const run = { ...terminal(claim), state: "uncertain", outcome } as const;
    this.uncertainRuns.push(run);
    return run;
  }
}

function terminal(claim: AutomationClaim) {
  return {
    schemaVersion: 1 as const,
    runId: claim.runId,
    automationId: claim.automationId,
    scheduledFor: claim.scheduledFor,
    attempt: claim.attempt,
  };
}

function executor(
  execute: NativeAutomationSemanticExecutor["execute"] = async () => ({
    ok: true,
  }),
): NativeAutomationSemanticExecutor {
  return { execute };
}

describe("native automation schedule expansion", () => {
  it("reconstructs deterministic restart candidates for once and run-once interval schedules", () => {
    expect(
      expandNativeAutomationCandidates(
        definition({
          id: "once",
          schedule: { kind: "once", at: 25 },
          misfirePolicy: "run-once",
        }),
        { after: 0, now: 50, restart: true, maxCatchUp: 3 },
      ),
    ).toEqual([{ automationId: "once", scheduledAt: 25 }]);
    expect(
      expandNativeAutomationCandidates(definition(), {
        after: 0,
        now: 50,
        restart: true,
        maxCatchUp: 3,
      }),
    ).toEqual([{ automationId: "status", scheduledAt: 50 }]);
  });

  it("bounds catch-up deterministically and skips downtime when configured", () => {
    expect(
      expandNativeAutomationCandidates(
        definition({ misfirePolicy: "catch-up" }),
        { after: 0, now: 50, restart: true, maxCatchUp: 3 },
      ),
    ).toEqual([
      { automationId: "status", scheduledAt: 30 },
      { automationId: "status", scheduledAt: 40 },
      { automationId: "status", scheduledAt: 50 },
    ]);
    expect(
      expandNativeAutomationCandidates(definition({ misfirePolicy: "skip" }), {
        after: 0,
        now: 50,
        restart: true,
        maxCatchUp: 3,
      }),
    ).toEqual([]);
  });

  it("rejects invalid cron expressions and IANA zones before candidate admission", () => {
    for (const schedule of [
      { kind: "cron", expression: "not cron", timeZone: "UTC" },
      { kind: "cron", expression: "0 * * * *", timeZone: "Mars/Olympus" },
    ] as const) {
      expect(() =>
        expandNativeAutomationCandidates(
          definition({ schedule }),
          { after: 0, now: 50, restart: true, maxCatchUp: 3 },
        ),
      ).toThrowError(expect.objectContaining({ category: "validation" }));
    }
  });

  it("enumerates deterministic timezone dates while skipping DST gaps and folding once", () => {
    const cron = definition({
      id: "dst",
      schedule: {
        kind: "cron",
        expression: "30 2 * * *",
        timeZone: "America/New_York",
      },
      misfirePolicy: "catch-up",
    });
    expect(
      expandNativeAutomationCandidates(cron, {
        after: Date.UTC(2024, 2, 9),
        now: Date.UTC(2024, 2, 12),
        restart: true,
        maxCatchUp: 10,
      }).map(({ scheduledAt }) => new Date(scheduledAt).toISOString()),
    ).toEqual([
      "2024-03-09T07:30:00.000Z",
      "2024-03-11T06:30:00.000Z",
    ]);

    const fold = definition({
      ...cron,
      id: "fold",
      schedule: {
        kind: "cron",
        expression: "30 1 * * *",
        timeZone: "America/New_York",
      },
    });
    expect(
      expandNativeAutomationCandidates(fold, {
        after: Date.UTC(2024, 10, 2),
        now: Date.UTC(2024, 10, 5),
        restart: true,
        maxCatchUp: 10,
      }).map(({ scheduledAt }) => new Date(scheduledAt).toISOString()),
    ).toEqual([
      "2024-11-02T05:30:00.000Z",
      "2024-11-03T05:30:00.000Z",
      "2024-11-04T06:30:00.000Z",
    ]);
  });

  it("uses exclusive current dates, deterministic next dates, and bounded cron catch-up", () => {
    const cron = definition({
      id: "hourly",
      schedule: { kind: "cron", expression: "0 * * * *", timeZone: "UTC" },
      misfirePolicy: "catch-up",
    });
    expect(
      expandNativeAutomationCandidates(cron, {
        after: Date.UTC(2025, 0, 1, 0),
        now: Date.UTC(2025, 0, 1, 5),
        restart: true,
        maxCatchUp: 2,
      }),
    ).toEqual([
      { automationId: "hourly", scheduledAt: Date.UTC(2025, 0, 1, 4) },
      { automationId: "hourly", scheduledAt: Date.UTC(2025, 0, 1, 5) },
    ]);
  });
});

describe("NativeAutomationScheduler", () => {
  it("lets two pollers race while the durable store admits exactly one claim", async () => {
    const store = new FakeAutomationStore(
      definition({ schedule: { kind: "once", at: 10 } }),
    );
    const execute = vi.fn(async () => ({ ok: true }));
    const options = {
      store,
      executors: new Map([["awareness.status@1", executor(execute)]]),
      now: () => 20,
      maxCatchUp: 10,
    } as const;
    const one = new NativeAutomationScheduler({ ...options, ownerId: "one" });
    const two = new NativeAutomationScheduler({ ...options, ownerId: "two" });

    await Promise.all([one.poll(), two.poll()]);

    expect(execute).toHaveBeenCalledOnce();
    expect(store.completed).toHaveLength(1);
  });

  it("settles semantic executor success, failure, and explicit uncertainty", async () => {
    const definitions = [
      definition({ id: "success", schedule: { kind: "once", at: 1 } }),
      definition({
        id: "failure",
        schedule: { kind: "once", at: 2 },
        action: { name: "failure", version: 1, payload: {} },
      }),
      definition({
        id: "uncertain",
        schedule: { kind: "once", at: 3 },
        action: { name: "uncertain", version: 1, payload: {} },
      }),
    ];
    const store = new FakeAutomationStore(...definitions);
    const scheduler = new NativeAutomationScheduler({
      store,
      ownerId: "one",
      executors: new Map([
        ["awareness.status@1", executor()],
        [
          "failure@1",
          executor(async () => {
            throw new Error("secret provider failure");
          }),
        ],
        [
          "uncertain@1",
          executor(async () => {
            throw new NativeAutomationUncertainError(
              "effect may have happened",
            );
          }),
        ],
      ]),
      now: () => 10,
      maxCatchUp: 10,
    });

    await scheduler.poll();

    expect(store.completed).toHaveLength(1);
    expect(store.failed).toHaveLength(1);
    expect(store.failed[0]?.outcome).toMatchObject({
      error: { code: "executor-failed", retryable: true },
    });
    expect(JSON.stringify(store.failed[0])).not.toContain("secret");
    expect(store.uncertainRuns).toHaveLength(1);
  });

  it("heartbeats long execution and seals session cancellation as uncertain", async () => {
    vi.useFakeTimers();
    try {
      let clock = 10;
      const store = new FakeAutomationStore(
        definition({ schedule: { kind: "once", at: 1 } }),
      );
      const scheduler = new NativeAutomationScheduler({
        store,
        ownerId: "one",
        executors: new Map([
          [
            "awareness.status@1",
            executor(
              ({ signal }) =>
                new Promise((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () =>
                      reject(
                        new NativeAutomationUncertainError("session stopped"),
                      ),
                    { once: true },
                  );
                }),
            ),
          ],
        ]),
        now: () => clock,
        leaseMs: 100,
        heartbeatMs: 25,
      });
      const polling = scheduler.poll();
      await vi.advanceTimersByTimeAsync(25);
      clock = 35;
      await vi.advanceTimersByTimeAsync(25);
      expect(store.heartbeatCount).toBeGreaterThan(0);

      await scheduler.stop("session stopped");
      await polling;

      expect(store.uncertainRuns).toHaveLength(1);
      expect(store.completed).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("provides explicit list, revision-CAS cancel, and run-now authority", async () => {
    let clock = 100;
    const stored = definition({ schedule: { kind: "once", at: 1_000 } });
    const store = new FakeAutomationStore(stored);
    const execute = vi.fn(async () => ({ manual: true }));
    const scheduler = new NativeAutomationScheduler({
      store,
      ownerId: "one",
      executors: new Map([["awareness.status@1", executor(execute)]]),
      now: () => clock,
    });

    await expect(scheduler.list()).resolves.toEqual([stored]);
    await scheduler.run("status");
    expect(execute).toHaveBeenCalledOnce();
    clock = 101;
    await expect(scheduler.cancel("status", 0)).resolves.toMatchObject({
      state: "cancelled",
      revision: 1,
      updatedAt: 101,
    });
  });
});
