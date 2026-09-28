import { describe, expect, it, vi } from "vitest";
import { CANONICAL_HOST_SCENARIOS } from "../src/host-conformance.js";
import { createProductionNativeHostAdapter } from "../src/production-host-adapters.js";

const scenario = (id: string) =>
  CANONICAL_HOST_SCENARIOS.find((value) => value.id === id)!;

const executionContext = () => ({
  signal: new AbortController().signal,
  emit: vi.fn(),
  effect: vi.fn(),
});

describe("production host adapter receipts", () => {
  it("projects native lifecycle registries from runtime events and command names", async () => {
    const lifecycle = vi.fn(async () => ({
      events: [
        { type: "runtime-ready" },
        {
          type: "presentation-changed",
          property: "widget",
          value: { id: "native-command-output", items: ["read"] },
        },
        { type: "runtime-stopping" },
      ],
      commandNames: ["zeta", "alpha"],
    }));
    const adapter = createProductionNativeHostAdapter({
      captureLifecycle: lifecycle,
    });
    const context = executionContext();

    expect(adapter.evidence).toBe("production");
    expect(adapter.hostKind).toBe("native");
    await adapter.execute(scenario("lifecycle-clean-start-stop"), context);
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(context.emit.mock.calls.map(([kind]) => kind)).toEqual([
      "host.started",
      "registry.snapshot",
      "host.stopped",
    ]);
  });

  it("advertises only scenarios backed by an explicit real-host receipt", async () => {
    const nativeProbe = vi.fn(async () => ({
      source: "native-production-composition" as const,
      events: [{ kind: "model.turn", data: { text: "native" } }],
      effects: [],
    }));
    const native = createProductionNativeHostAdapter({
      scenarioProbes: { "deterministic-model-turn": nativeProbe },
    });

    expect(native.supports?.(scenario("deterministic-model-turn"))).toEqual({
      supported: true,
    });
    expect(native.supports?.(scenario("streaming-tool-flow"))).toMatchObject({
      supported: false,
    });
    const context = executionContext();
    await native.execute(scenario("deterministic-model-turn"), context);
    expect(nativeProbe).toHaveBeenCalledOnce();
    expect(context.emit.mock.calls).toContainEqual([
      "model.turn",
      { text: "native" },
    ]);
  });

  it("fails closed when a production probe reports the wrong composition root", async () => {
    const adapter = createProductionNativeHostAdapter({
      scenarioProbes: {
        "deterministic-model-turn": async () => ({
          source: "foreign-host" as never,
          events: [{ kind: "model.turn" }],
          effects: [],
        }),
      },
    });

    await expect(
      adapter.execute(scenario("deterministic-model-turn"), executionContext()),
    ).rejects.toThrow("native-production-composition or built-native");
  });

  it("returns non-comparable observations separately from emitted parity events", async () => {
    const adapter = createProductionNativeHostAdapter({
      scenarioProbes: {
        "persistence-restart": async () => ({
          source: "native-production-composition",
          events: [
            {
              kind: "persistence.restarted",
              data: { deterministicProjection: true },
            },
          ],
          effects: [],
          observations: [
            {
              kind: "persistence.durable-entry-count",
              data: { count: 20 },
            },
          ],
        }),
      },
    });
    const context = executionContext();

    const result = await adapter.execute(
      scenario("persistence-restart"),
      context,
    );

    expect(context.emit.mock.calls).toEqual([
      ["persistence.restarted", { deterministicProjection: true }],
    ]);
    expect(result).toEqual({
      observations: [
        {
          kind: "production.probe-source",
          data: { source: "native-production-composition" },
        },
        {
          kind: "persistence.durable-entry-count",
          data: { count: 20 },
        },
      ],
    });
  });

  it("rejects unsupported direct execution", async () => {
    const unsupportedNative = createProductionNativeHostAdapter({});

    await expect(
      unsupportedNative.execute(
        scenario("streaming-tool-flow"),
        executionContext(),
      ),
    ).rejects.toThrow(/Unsupported native scenario/u);
  });

  it("rejects malformed native lifecycle events without projecting fake tools or hooks", async () => {
    const adapter = createProductionNativeHostAdapter({
      captureLifecycle: async () => ({
        events: [null, "text", [], { type: 9 }, { type: "unrelated" }],
        commandNames: ["zeta", "alpha"],
      }),
    });
    const context = executionContext();

    await expect(
      adapter.execute(scenario("lifecycle-clean-start-stop"), context),
    ).rejects.toThrow(/did not register every canonical registry: commands/u);
    expect(context.emit).not.toHaveBeenCalled();
  });
});
