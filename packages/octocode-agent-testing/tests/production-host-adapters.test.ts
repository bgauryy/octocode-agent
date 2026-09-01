import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPROVED_PI_HOST_VERSION,
  captureProductionPiLifecycle,
} from "@octocodeai/pi-extension";
import { describe, expect, it, vi } from "vitest";
import { CANONICAL_HOST_SCENARIOS } from "../src/host-conformance.js";
import {
  createProductionNativeHostAdapter,
  createProductionPiHostAdapter,
} from "../src/production-host-adapters.js";

const scenario = (id: string) =>
  CANONICAL_HOST_SCENARIOS.find((value) => value.id === id)!;

describe("production host adapter receipts", () => {
  it("accepts lifecycle evidence only after the real Pi SDK observes start and shutdown", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "octocode-pi-sdk-lifecycle-"),
    );
    const lifecycle = vi.fn(() => captureProductionPiLifecycle(root));
    const adapter = createProductionPiHostAdapter({
      hostVersion: APPROVED_PI_HOST_VERSION,
      captureLifecycle: lifecycle,
    });
    const context = {
      signal: new AbortController().signal,
      emit: vi.fn(),
      effect: vi.fn(),
    };

    try {
      expect(adapter.evidence).toBe("production");
      await adapter.execute(scenario("lifecycle-clean-start-stop"), context);
      expect(lifecycle).toHaveBeenCalledOnce();
      expect(context.emit.mock.calls.map(([kind]) => kind)).toEqual([
        "host.started",
        "registry.snapshot",
        "host.stopped",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("advertises only scenarios backed by an explicit real-host receipt", async () => {
    const piProbe = vi.fn(async () => ({
      source: "installed-pi-sdk" as const,
      events: [{ kind: "model.turn", data: { text: "pi" } }],
      effects: [],
    }));
    const nativeProbe = vi.fn(async () => ({
      source: "native-production-composition" as const,
      events: [{ kind: "model.turn", data: { text: "native" } }],
      effects: [],
    }));
    const pi = createProductionPiHostAdapter({
      hostVersion: "0.84.2",
      scenarioProbes: { "deterministic-model-turn": piProbe },
    });
    const native = createProductionNativeHostAdapter({
      scenarioProbes: { "deterministic-model-turn": nativeProbe },
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
    expect(piProbe).toHaveBeenCalledOnce();
    expect(nativeProbe).toHaveBeenCalledOnce();
    expect(context.emit.mock.calls).toContainEqual([
      "model.turn",
      { text: "pi" },
    ]);
  });

  it("fails closed when a production probe reports the wrong composition root", async () => {
    const adapter = createProductionPiHostAdapter({
      hostVersion: "0.84.2",
      scenarioProbes: {
        "deterministic-model-turn": async () => ({
          source: "built-native",
          events: [{ kind: "model.turn" }],
          effects: [],
        }),
      },
    });

    await expect(
      adapter.execute(scenario("deterministic-model-turn"), {
        signal: new AbortController().signal,
        emit: vi.fn(),
        effect: vi.fn(),
      }),
    ).rejects.toThrow("installed-pi-sdk");
  });

  it("returns non-comparable observations separately from emitted parity events", async () => {
    const adapter = createProductionPiHostAdapter({
      hostVersion: "0.84.2",
      scenarioProbes: {
        "persistence-restart": async () => ({
          source: "installed-pi-sdk",
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
              data: { count: 8 },
            },
          ],
        }),
      },
    });
    const context = {
      signal: new AbortController().signal,
      emit: vi.fn(),
      effect: vi.fn(),
    };

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
          data: { source: "installed-pi-sdk" },
        },
        {
          kind: "persistence.durable-entry-count",
          data: { count: 8 },
        },
      ],
    });
  });

  it("rejects incomplete Pi lifecycle capture and unsupported direct execution", async () => {
    const context = {
      signal: new AbortController().signal,
      emit: vi.fn(),
      effect: vi.fn(),
    };
    const incomplete = createProductionPiHostAdapter({
      hostVersion: APPROVED_PI_HOST_VERSION,
      captureLifecycle: async () => ({
        started: true,
        stopped: false,
        registry: { tools: [], commands: [], hooks: [] },
      }),
    });
    const unsupportedPi = createProductionPiHostAdapter({
      hostVersion: APPROVED_PI_HOST_VERSION,
    });
    const unsupportedNative = createProductionNativeHostAdapter({});

    await expect(
      incomplete.execute(scenario("lifecycle-clean-start-stop"), context),
    ).rejects.toThrow(/both session_start and session_shutdown/u);
    await expect(
      unsupportedPi.execute(scenario("streaming-tool-flow"), context),
    ).rejects.toThrow(/Unsupported Pi scenario/u);
    await expect(
      unsupportedNative.execute(scenario("streaming-tool-flow"), context),
    ).rejects.toThrow(/Unsupported native scenario/u);
  });

  it("rejects malformed native lifecycle events without projecting fake tools or hooks", async () => {
    const adapter = createProductionNativeHostAdapter({
      captureLifecycle: async () => ({
        events: [null, "text", [], { type: 9 }, { type: "unrelated" }],
        commandNames: ["zeta", "alpha"],
      }),
    });
    const context = {
      signal: new AbortController().signal,
      emit: vi.fn(),
      effect: vi.fn(),
    };

    await expect(
      adapter.execute(scenario("lifecycle-clean-start-stop"), context),
    ).rejects.toThrow(/did not register every canonical registry: commands/u);
    expect(context.emit).not.toHaveBeenCalled();
  });
});
