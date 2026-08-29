import { describe, expect, it, vi } from "vitest";
import { CANONICAL_HOST_SCENARIOS } from "../src/host-conformance.js";
import {
  createProductionNativeHostAdapter,
  createProductionPiHostAdapter,
} from "../src/production-host-adapters.js";

const scenario = (id: string) =>
  CANONICAL_HOST_SCENARIOS.find((value) => value.id === id)!;

describe("production host adapter scenario drivers", () => {
  it("advertises only scenarios backed by an explicit production driver", async () => {
    const piDriver = vi.fn(async ({ context }) => {
      context.emit("model.turn", { text: "pi" });
    });
    const nativeDriver = vi.fn(async ({ context }) => {
      context.emit("model.turn", { text: "native" });
    });
    const harness = {
      pi: {},
      tools: new Map(),
      commands: new Map(),
      handlers: new Map(),
      emit: async () => undefined,
    };
    const pi = createProductionPiHostAdapter({
      hostVersion: "0.84.2",
      createHarness: () => harness,
      activate: async () => undefined,
      scenarioDrivers: { "deterministic-model-turn": piDriver },
    });
    const native = createProductionNativeHostAdapter({
      launch: async () => 0,
      createDependencies: () => ({}),
      commandNames: [],
      scenarioDrivers: { "deterministic-model-turn": nativeDriver },
    });

    expect(pi.supports?.(scenario("deterministic-model-turn"))).toEqual({
      supported: true,
    });
    expect(native.supports?.(scenario("deterministic-model-turn"))).toEqual({
      supported: true,
    });
    expect(pi.supports?.(scenario("streaming-tool-flow"))).toMatchObject({
      supported: false,
    });
    expect(native.supports?.(scenario("streaming-tool-flow"))).toMatchObject({
      supported: false,
    });
    const context = {
      signal: new AbortController().signal,
      emit: vi.fn(),
      effect: vi.fn(),
    };
    await pi.execute(scenario("deterministic-model-turn"), context);
    await native.execute(scenario("deterministic-model-turn"), context);
    expect(piDriver).toHaveBeenCalledOnce();
    expect(nativeDriver).toHaveBeenCalledOnce();
  });
});
