import { describe, expect, test } from "vitest";
import {
  CANONICAL_HOST_SCENARIOS,
  EffectLedger,
  compareHostTraces,
  createCanonicalHostAdapter,
  normalizeHostTrace,
  runCanonicalHostConformance,
  runHostConformance,
  type CanonicalScenarioHandlers,
  type HostConformanceAdapter,
} from "../src/host-conformance.js";

function canonicalHandlers(suffix = ""): CanonicalScenarioHandlers {
  return Object.fromEntries(
    CANONICAL_HOST_SCENARIOS.map((scenario) => [
      scenario.id,
      (_scenario, context) => {
        context.emit("scenario.started", {
          scenario: scenario.id,
          cwd: suffix ? "/native/workspace" : "/reference/workspace",
          timestamp: suffix ? 99 : 10,
        });
        context.effect({
          id: `${scenario.id}:effect`,
          kind: "projection",
          effectful: false,
        });
        context.emit("scenario.finished", {
          scenario: scenario.id,
          outcome: `ok${suffix}`,
        });
      },
    ]),
  ) as CanonicalScenarioHandlers;
}

describe("canonical host scenario matrix", () => {
  test("freezes the RFC 14-scenario inventory with distinct ids", () => {
    expect(CANONICAL_HOST_SCENARIOS).toHaveLength(14);
    expect(new Set(CANONICAL_HOST_SCENARIOS.map(({ id }) => id)).size).toBe(14);
    expect(CANONICAL_HOST_SCENARIOS.map(({ id }) => id)).toEqual([
      "lifecycle-clean-start-stop",
      "deterministic-model-turn",
      "streaming-tool-flow",
      "policy-denial-matrix",
      "tool-failure-matrix",
      "cancellation-boundaries",
      "steer-and-follow-up",
      "session-lifecycle",
      "compaction-matrix",
      "ui-semantics",
      "transport-corpus",
      "persistence-restart",
      "codex-hook-lifecycle",
      "plugin-lifecycle",
    ]);
    for (const scenario of CANONICAL_HOST_SCENARIOS) {
      expect(scenario.requirements.length).toBeGreaterThan(0);
      expect(scenario.input).toBeTypeOf("object");
    }
    expect(
      CANONICAL_HOST_SCENARIOS.find(
        ({ id }) => id === "codex-hook-lifecycle",
      )?.applicability,
    ).toEqual({
      kind: "host-specific",
      host: "native",
      reason: "reviewed Codex hook dispatch is a native host integration",
    });
  });

  test("covers a typed host-specific scenario once without fabricating peer evidence", async () => {
    const nativeOnly = CANONICAL_HOST_SCENARIOS.filter(
      ({ id }) => id === "codex-hook-lifecycle",
    );
    const reference: HostConformanceAdapter = {
      name: "reference",
      hostKind: "generic",
      evidence: "production",
      supports: () => ({ supported: false, reason: "typed native-only scope" }),
      async execute() {
        throw new Error("reference must not execute a native-only scenario");
      },
    };
    const native: HostConformanceAdapter = {
      name: "native",
      hostKind: "native",
      evidence: "production",
      supports: () => ({ supported: true }),
      async execute(_scenario, context) {
        context.emit("hook.covered", { decision: true });
        context.effect({
          id: "hook:observed",
          kind: "hook.execution",
          effectful: false,
        });
        return {
          observations: [{ kind: "hook.receipt", data: { reviewed: true } }],
        };
      },
    };

    const report = await runHostConformance({
      baseline: reference,
      candidate: native,
      scenarios: nativeOnly,
    });

    expect(report.matched).toBe(true);
    expect(report.summary).toEqual({
      total: 1,
      matched: 0,
      covered: 1,
      diverged: 0,
      unsupported: 0,
    });
    expect(report.results[0]).toMatchObject({
      scenarioId: "codex-hook-lifecycle",
      matched: true,
      status: "covered",
      comparison: {
        performed: false,
        reason: "host-specific scenario",
      },
      coverage: {
        host: "native",
        role: "candidate",
        trace: [{ sequence: 1, kind: "hook.covered", data: { decision: true } }],
        effects: [
          { id: "hook:observed", kind: "hook.execution", effectful: false },
        ],
        observations: [{ kind: "hook.receipt", data: { reviewed: true } }],
      },
    });
    expect(report.results[0]?.trace).toMatchObject({ matched: true });
    expect(report.results[0]?.effects).toMatchObject({ matched: true });
  });

  test.each([
    ["missing", "generic", "generic", "No native adapter"],
    ["ambiguous", "native", "native", "Multiple native adapters"],
  ] as const)(
    "marks a %s host-specific adapter selection unsupported",
    async (_case, baselineKind, candidateKind, reason) => {
      const adapter = (name: string, hostKind: "generic" | "native"): HostConformanceAdapter => ({
        name,
        hostKind,
        evidence: "production",
        async execute() {
          throw new Error("unsupported selection must not execute");
        },
      });
      const report = await runHostConformance({
        baseline: adapter("baseline", baselineKind),
        candidate: adapter("candidate", candidateKind),
        scenarios: CANONICAL_HOST_SCENARIOS.filter(
          ({ id }) => id === "codex-hook-lifecycle",
        ),
      });

      expect(report.matched).toBe(false);
      expect(report.results[0]).toMatchObject({
        status: "unsupported",
        unsupported: { candidate: expect.stringContaining(reason) },
      });
    },
  );

  test("marks a selected but unsupported host-specific adapter explicitly", async () => {
    const adapter = (
      name: string,
      hostKind: "generic" | "native",
      supported: boolean,
    ): HostConformanceAdapter => ({
      name,
      hostKind,
      evidence: "production",
      supports: () => supported
        ? { supported: true }
        : { supported: false, reason: "fixture unavailable" },
      async execute() {
        throw new Error("unsupported adapter must not execute");
      },
    });
    const report = await runHostConformance({
      baseline: adapter("reference", "generic", true),
      candidate: adapter("native", "native", false),
      scenarios: CANONICAL_HOST_SCENARIOS.filter(
        ({ id }) => id === "codex-hook-lifecycle",
      ),
    });

    expect(report.matched).toBe(false);
    expect(report.results[0]).toMatchObject({
      status: "unsupported",
      unsupported: { candidate: "fixture unavailable" },
    });
  });

  test("self-tests the runner with synthetic handlers without claiming production parity", async () => {
    const report = await runCanonicalHostConformance({
      baseline: createCanonicalHostAdapter("reference", canonicalHandlers()),
      candidate: createCanonicalHostAdapter("native", canonicalHandlers()),
      normalization: { workspaceRoots: ["/reference/workspace", "/native/workspace"] },
    });

    expect(report.matched).toBe(true);
    expect(report.evidence).toEqual({
      baseline: "synthetic",
      candidate: "synthetic",
    });
    expect(report.results).toHaveLength(14);
    expect(
      report.results.every(
        (result) => result.trace.matched && result.effects.matched,
      ),
    ).toBe(true);
    expect(
      report.results.every(
        (result) => result.trace.baselineHash === result.trace.candidateHash,
      ),
    ).toBe(true);
  });

  test("fails closed when a canonical adapter omits a scenario handler", async () => {
    const handlers = canonicalHandlers() as Partial<CanonicalScenarioHandlers>;
    delete handlers["plugin-lifecycle"];
    const adapter = createCanonicalHostAdapter(
      "incomplete",
      handlers as CanonicalScenarioHandlers,
    );
    await expect(
      adapter.execute(CANONICAL_HOST_SCENARIOS.at(-1)!, {
        emit: () => undefined,
        effect: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/missing canonical handler.*plugin-lifecycle/i);
  });

  test("rejects scenario ids outside the canonical inventory", async () => {
    const adapter = createCanonicalHostAdapter("reference", canonicalHandlers());
    await expect(
      adapter.execute(
        { id: "invented", input: {} },
        {
          emit: () => undefined,
          effect: () => undefined,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(/unknown canonical host scenario/i);
  });
});

describe("trace normalization and comparison", () => {
  test("normalizes volatile fields, paths, ANSI, errors, maps, and sets deterministically", () => {
    const first = normalizeHostTrace(
      [
        {
          sequence: 9,
          timestamp: 10,
          kind: "ready",
          data: {
            cwd: "/one",
            text: "\u001b[31mok\u001b[0m",
            nested: { sessionId: "a", value: 1 },
            error: new Error("boom"),
            map: new Map([
              ["b", 2],
              ["a", 1],
            ]),
            set: new Set(["b", "a"]),
          },
        },
      ],
      { workspaceRoots: ["/one"] },
    );
    const second = normalizeHostTrace(
      [
        {
          sequence: 1,
          timestamp: 99,
          kind: "ready",
          data: {
            cwd: "/two",
            text: "ok",
            nested: { sessionId: "b", value: 1 },
            error: new Error("boom"),
            map: new Map([
              ["a", 1],
              ["b", 2],
            ]),
            set: new Set(["a", "b"]),
          },
        },
      ],
      { workspaceRoots: ["/two"] },
    );

    expect(first).toEqual(second);
    expect(compareHostTraces(first, second)).toMatchObject({
      matched: true,
      firstDivergence: null,
    });
  });

  test("bijectively normalizes generated ids while preserving equality and ancestry", () => {
    const baseline = normalizeHostTrace([
      {
        kind: "session.started",
        data: { sessionId: "reference-session", requestId: "reference-request" },
      },
      {
        kind: "session.child",
        data: {
          sessionId: "reference-child",
          parentId: "reference-session",
          requestId: "reference-request",
        },
      },
    ]);
    const equivalent = normalizeHostTrace([
      {
        kind: "session.started",
        data: { sessionId: "native-session", requestId: "native-request" },
      },
      {
        kind: "session.child",
        data: {
          sessionId: "native-child",
          parentId: "native-session",
          requestId: "native-request",
        },
      },
    ]);
    const brokenAncestry = normalizeHostTrace([
      {
        kind: "session.started",
        data: { sessionId: "native-session", requestId: "native-request" },
      },
      {
        kind: "session.child",
        data: {
          sessionId: "native-child",
          parentId: "unrelated-session",
          requestId: "other-request",
        },
      },
    ]);

    expect(compareHostTraces(baseline, equivalent).matched).toBe(true);
    expect(compareHostTraces(baseline, brokenAncestry)).toMatchObject({
      matched: false,
      firstDivergence: { path: "$[1].data.parentId" },
    });
  });

  test("preserves canonical identity relationships carried by event envelopes", () => {
    const baseline = normalizeHostTrace([
      {
        kind: "turn.started",
        sessionId: "reference-session",
        requestId: "reference-request",
      },
      {
        kind: "turn.finished",
        sessionId: "reference-session",
        requestId: "reference-request",
      },
    ]);
    const mismatched = normalizeHostTrace([
      {
        kind: "turn.started",
        sessionId: "native-session",
        requestId: "native-request",
      },
      {
        kind: "turn.finished",
        sessionId: "other-session",
        requestId: "other-request",
      },
    ]);

    expect(compareHostTraces(baseline, mismatched)).toMatchObject({
      matched: false,
      firstDivergence: { path: "$[1].requestId" },
    });
  });

  test("does not normalize stable semantic ids as generated identities", () => {
    const baseline = normalizeHostTrace([
      {
        kind: "ui.widget",
        data: { id: "tool-output", requestId: "reference-request" },
      },
    ]);
    const candidate = normalizeHostTrace([
      {
        kind: "ui.widget",
        data: { id: "settings-panel", requestId: "native-request" },
      },
    ]);

    expect(compareHostTraces(baseline, candidate)).toMatchObject({
      matched: false,
      firstDivergence: {
        path: "$[0].data.id",
        baseline: "tool-output",
        candidate: "settings-panel",
      },
    });
  });

  test("normalizes logical roots without erasing containment-relevant path suffixes", () => {
    const baseline = normalizeHostTrace(
      [{ kind: "file.selected", data: { path: "/reference/workspace/src/a.ts" } }],
      { workspaceRoots: ["/reference/workspace"] },
    );
    const equivalent = normalizeHostTrace(
      [{ kind: "file.selected", data: { path: "/native/workspace/src/a.ts" } }],
      { workspaceRoots: ["/native/workspace"] },
    );
    const escaped = normalizeHostTrace(
      [
        {
          kind: "file.selected",
          data: { path: "/native/workspace/../secret.txt" },
        },
      ],
      { workspaceRoots: ["/native/workspace"] },
    );

    expect(compareHostTraces(baseline, equivalent).matched).toBe(true);
    expect(compareHostTraces(baseline, escaped)).toMatchObject({
      matched: false,
      firstDivergence: { path: "$[0].data.path" },
    });
  });

  test("does not treat a shared path prefix as workspace containment", () => {
    const baseline = normalizeHostTrace(
      [{ kind: "file.selected", data: { path: "/work/project/src/a.ts" } }],
      { workspaceRoots: ["/work/project"] },
    );
    const outside = normalizeHostTrace(
      [
        {
          kind: "file.selected",
          data: { path: "/work/project-copy/src/a.ts" },
        },
      ],
      { workspaceRoots: ["/work/project"] },
    );

    expect(compareHostTraces(baseline, outside)).toMatchObject({
      matched: false,
      firstDivergence: { path: "$[0].data.path" },
    });
    expect((outside[0]?.data as { path: string }).path).toBe(
      "/work/project-copy/src/a.ts",
    );
  });

  test("preserves structured error category and cause", () => {
    const baselineError = Object.assign(
      new Error("tool failed", { cause: new Error("upstream timeout") }),
      { code: "ETIMEDOUT" },
    );
    const candidateError = Object.assign(
      new Error("tool failed", { cause: new Error("permission denied") }),
      { code: "EACCES" },
    );
    const baseline = normalizeHostTrace([
      { kind: "tool.failed", data: { error: baselineError } },
    ]);
    const candidate = normalizeHostTrace([
      { kind: "tool.failed", data: { error: candidateError } },
    ]);

    expect(compareHostTraces(baseline, candidate)).toMatchObject({
      matched: false,
      firstDivergence: { path: "$[0].data.error.cause.message" },
    });
    expect(baseline[0]?.data).toMatchObject({
      error: {
        name: "Error",
        message: "tool failed",
        code: "ETIMEDOUT",
        cause: { message: "upstream timeout" },
      },
    });
  });

  test("reports stable hashes and the first semantic divergence", async () => {
    const adapter = (
      name: string,
      outcome: string,
    ): HostConformanceAdapter => ({
      name,
      evidence: "synthetic",
      async execute(_scenario, context) {
        context.emit("turn.started", { requestId: `${name}-request` });
        context.emit("turn.finished", { outcome });
      },
    });
    const report = await runHostConformance({
      baseline: adapter("reference", "ok"),
      candidate: adapter("native", "different"),
      scenarios: [CANONICAL_HOST_SCENARIOS[1]!],
    });

    expect(report.matched).toBe(false);
    expect(report.results[0]?.trace.firstDivergence).toMatchObject({
      index: 1,
      path: "$[1].data.outcome",
      baseline: "ok",
      candidate: "different",
    });
    expect(report.results[0]?.trace.baselineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.results[0]?.trace.candidateHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("effect ledger", () => {
  test("rejects duplicate effect ids and effectful shadow operations", () => {
    const live = new EffectLedger("live");
    live.record({ id: "effect-1", kind: "tool", effectful: true });
    expect(() =>
      live.record({ id: "effect-1", kind: "tool", effectful: true }),
    ).toThrow(/duplicate effect/i);
    const shadow = new EffectLedger("shadow");
    expect(() =>
      shadow.record({ id: "effect-2", kind: "model", effectful: true }),
    ).toThrow(/shadow/i);
    expect(() =>
      shadow.record({ id: "pure-1", kind: "projection", effectful: false }),
    ).not.toThrow();
  });

  test("rejects external effects in pure execution mode", () => {
    const pure = new EffectLedger("pure");
    expect(() =>
      pure.record({ id: "effect-1", kind: "process", effectful: true }),
    ).toThrow(/pure/i);
    expect(() =>
      pure.record({ id: "projection-1", kind: "projection", effectful: false }),
    ).not.toThrow();
  });

  test("compares effect ledgers independently from traces", async () => {
    const adapter = (name: string, kind: string): HostConformanceAdapter => ({
      name,
      evidence: "synthetic",
      async execute(_scenario, context) {
        context.emit("same");
        context.effect({ id: "effect-1", kind, effectful: false });
      },
    });
    const report = await runHostConformance({
      baseline: adapter("reference", "projection"),
      candidate: adapter("native", "different"),
      scenarios: [CANONICAL_HOST_SCENARIOS[0]!],
    });
    expect(report.results[0]?.trace.matched).toBe(true);
    expect(report.results[0]?.effects.matched).toBe(false);
    expect(report.results[0]?.effects.firstDivergence?.path).toBe("$[0].kind");
  });

  test("rejects duplicate external effects across hosts", async () => {
    const adapter = (name: string): HostConformanceAdapter => ({
      name,
      evidence: "synthetic",
      async execute(_scenario, context) {
        context.effect({ id: "shared-effect", kind: "write", effectful: true });
      },
    });

    await expect(
      runHostConformance({
        baseline: adapter("reference"),
        candidate: adapter("native"),
        scenarios: [CANONICAL_HOST_SCENARIOS[0]!],
      }),
    ).rejects.toThrow(/duplicate external effect.*shared-effect.*reference.*native/i);
  });

  test("aborts before invoking adapters when the signal is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop now"));
    const adapter = createCanonicalHostAdapter("reference", canonicalHandlers());
    await expect(
      runHostConformance({
        baseline: adapter,
        candidate: adapter,
        scenarios: [CANONICAL_HOST_SCENARIOS[0]!],
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop now");
  });

  test("aborts the sibling production run when one adapter fails", async () => {
    let candidateSignal: AbortSignal | undefined;
    const baseline: HostConformanceAdapter = {
      name: "reference",
      evidence: "production",
      async execute() {
        throw new Error("baseline failed");
      },
    };
    const candidate: HostConformanceAdapter = {
      name: "native",
      evidence: "production",
      async execute(_scenario, context) {
        candidateSignal = context.signal;
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      },
    };

    await expect(
      runHostConformance({
        baseline,
        candidate,
        scenarios: [CANONICAL_HOST_SCENARIOS[0]!],
      }),
    ).rejects.toThrow("baseline failed");
    expect(candidateSignal?.aborted).toBe(true);
  });

  test("accepts legacy event arrays and structured adapter receipts", async () => {
    const baseline: HostConformanceAdapter = {
      name: "reference",
      evidence: "synthetic",
      async execute() {
        return [{ kind: "same", data: { cwd: "/reference" } }];
      },
    };
    const candidate: HostConformanceAdapter = {
      name: "native",
      evidence: "synthetic",
      async execute() {
        return {
          events: [{ kind: "same", data: { cwd: "/native" } }],
          effects: [{ id: "pure", kind: "projection", effectful: false }],
        };
      },
    };
    const report = await runHostConformance({
      baseline: {
        ...baseline,
        async execute(scenario, context) {
          context.effect({ id: "pure", kind: "projection", effectful: false });
          return baseline.execute(scenario, context);
        },
      },
      candidate,
      scenarios: [CANONICAL_HOST_SCENARIOS[0]!],
      normalization: { workspaceRoots: ["/reference", "/native"] },
    });
    expect(report.matched).toBe(true);
  });

  test("preserves host observations without treating them as parity evidence", async () => {
    const persistence = CANONICAL_HOST_SCENARIOS.find(
      ({ id }) => id === "persistence-restart",
    )!;
    const adapter = (
      name: string,
      durableEntryCount: number,
    ): HostConformanceAdapter => ({
      name,
      evidence: "production",
      async execute() {
        return {
          events: [
            {
              kind: "persistence.restarted",
              data: {
                deterministicProjection: true,
              },
            },
          ],
          observations: [
            {
              kind: "persistence.durable-entry-count",
              data: { count: durableEntryCount, recoveredCustomEntry: true },
            },
          ],
        };
      },
    });

    const report = await runHostConformance({
      baseline: adapter("reference", 8),
      candidate: adapter("native", 20),
      scenarios: [persistence],
    });

    expect(report.matched).toBe(true);
    expect(report.results[0]).toMatchObject({
      status: "matched",
      trace: { matched: true },
      observations: {
        baseline: [
          {
            kind: "persistence.durable-entry-count",
            data: { count: 8, recoveredCustomEntry: true },
          },
        ],
        candidate: [
          {
            kind: "persistence.durable-entry-count",
            data: { count: 20, recoveredCustomEntry: true },
          },
        ],
      },
    });
    expect(report.results[0]?.trace.baselineHash).toBe(
      report.results[0]?.trace.candidateHash,
    );
    expect(report.results[0]?.observations.baselineHash).not.toBe(
      report.results[0]?.observations.candidateHash,
    );
  });

  test("rejects malformed or unbounded host observations", async () => {
    const persistence = CANONICAL_HOST_SCENARIOS.find(
      ({ id }) => id === "persistence-restart",
    )!;
    const baseline: HostConformanceAdapter = {
      name: "baseline",
      evidence: "production",
      async execute() {
        return { events: [{ kind: "persistence.restarted" }] };
      },
    };
    const candidate = (
      observations: readonly { kind: string; data?: unknown }[],
    ): HostConformanceAdapter => ({
      name: "candidate",
      evidence: "production",
      async execute() {
        return {
          events: [{ kind: "persistence.restarted" }],
          observations,
        };
      },
    });

    await expect(
      runHostConformance({
        baseline,
        candidate: candidate([{ kind: "Not valid" }]),
        scenarios: [persistence],
      }),
    ).rejects.toThrow("kind is malformed");
    await expect(
      runHostConformance({
        baseline,
        candidate: candidate(
          Array.from({ length: 257 }, () => ({ kind: "evidence.item" })),
        ),
        scenarios: [persistence],
      }),
    ).rejects.toThrow("count exceeds");
  });

  test("reports unsupported production scenarios as failed coverage rather than skipped success", async () => {
    const production = (
      name: string,
      supported: boolean,
    ): HostConformanceAdapter => ({
      name,
      evidence: "production",
      supports: () =>
        supported
          ? { supported: true }
          : {
              supported: false,
              reason: `${name} has no production scenario adapter`,
            },
      async execute(_scenario, context) {
        context.emit("host.started");
      },
    });
    const report = await runHostConformance({
      baseline: production("reference", true),
      candidate: production("native", false),
      scenarios: [CANONICAL_HOST_SCENARIOS[1]!],
    });

    expect(report.matched).toBe(false);
    expect(report.summary).toEqual({
      total: 1,
      matched: 0,
      covered: 0,
      diverged: 0,
      unsupported: 1,
    });
    expect(report.evidence).toEqual({
      baseline: "production",
      candidate: "production",
    });
    expect(report.results[0]).toMatchObject({
      matched: false,
      status: "unsupported",
      unsupported: { candidate: "native has no production scenario adapter" },
    });
  });
});
