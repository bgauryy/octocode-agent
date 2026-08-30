import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeSnapshot,
} from "@octocodeai/agent-core";
import {
  APPROVED_PI_HOST_VERSION,
  createOctocodePiExtension,
  PiHostCompatibilityError,
} from "@octocodeai/pi-extension";
import {
  launchNativeAgent,
  type NativeLaunchDependencies,
} from "../../octocode-agent/src/native-launcher.js";
import { NATIVE_SLASH_COMMANDS } from "../../octocode-agent/src/native-command-catalog.js";
import {
  CANONICAL_HOST_SCENARIOS,
  runCanonicalHostConformance,
} from "../src/host-conformance.js";
import { createPiFlowHarness } from "../src/index.js";
import {
  createProductionNativeHostAdapter,
  createProductionPiHostAdapter,
  type ProductionScenarioUnsupportedReasons,
} from "../src/production-host-adapters.js";

const roots: string[] = [];

const piUnsupported: ProductionScenarioUnsupportedReasons = {
  "deterministic-model-turn": "Pi production harness activates the extension but has no real model-loop driver",
  "streaming-tool-flow": "Pi production harness has no provider-to-tool streaming driver",
  "policy-denial-matrix": "Pi production harness does not exercise all plan, trust, approval, and peer-lock denials",
  "tool-failure-matrix": "Pi production harness has no real before/during/persistence failure injector",
  "cancellation-boundaries": "Pi production harness has no owned live model, tool, or compaction work to cancel",
  "steer-and-follow-up": "Pi production harness has no in-flight production agent loop for steering",
  "session-lifecycle": "Pi production harness cannot exercise native rewind/export semantics",
  "compaction-matrix": "Pi production harness has no real threshold, overflow, and failed-retry compaction driver",
  "ui-semantics": "Pi production harness does not execute both interactive and headless UI adapters",
  "transport-corpus": "Pi production harness is structural and does not launch print, JSON, and RPC stdio transports",
  "persistence-restart": "Pi production harness durable map is not the production filesystem session store",
  "codex-hook-lifecycle": "Pi production harness has no reviewed Codex hook fixture spanning decision, context, and rewrite",
  "plugin-lifecycle": "Pi production activation has no transactional plugin install-disable-update-resume driver",
};

const nativeUnsupported: ProductionScenarioUnsupportedReasons = {
  "deterministic-model-turn": "Native production adapter injects a lifecycle runtime and does not execute a loopback model turn",
  "streaming-tool-flow": "Native production adapter has no captured provider and tool streaming fixture",
  "policy-denial-matrix": "Native production adapter does not drive plan, trust, approval, and peer-lock denials",
  "tool-failure-matrix": "Native production adapter has no real before/during/persistence failure injector",
  "cancellation-boundaries": "Native production adapter has no owned live model, tool, or compaction work to cancel",
  "steer-and-follow-up": "Native production adapter has no active turn on which to prove steer and follow-up ordering",
  "session-lifecycle": "Native slash surface has no complete name, resume, fork, tree, rewind, and export corpus",
  "compaction-matrix": "Native production adapter injects a runtime without a real compaction summarizer",
  "ui-semantics": "Native production adapter captures interactive presentation but not the headless UI adapter",
  "transport-corpus": "Native production adapter launches only the interactive composition, not print, JSON, and RPC corpora",
  "persistence-restart": "Native production adapter injects a runtime and bypasses the filesystem session store",
  "codex-hook-lifecycle": "Native production adapter has no reviewed hook fixture spanning decision, context, and rewrite",
  "plugin-lifecycle": "Native production adapter has no transactional plugin fixture across disable, update, and resume",
};

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function productionPiAdapter() {
  const cwd = temporaryRoot("octocode-pi-conformance-");
  return createProductionPiHostAdapter({
    hostVersion: APPROVED_PI_HOST_VERSION,
    createHarness: () =>
      createPiFlowHarness({ cwd, sessionId: "production-conformance" }),
    activate: createOctocodePiExtension({
      hostVersion: APPROVED_PI_HOST_VERSION,
    }) as (pi: unknown) => Promise<void>,
    unsupportedReasons: piUnsupported,
  });
}

function productionNativeAdapter() {
  const root = temporaryRoot("octocode-native-conformance-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    OCTOCODE_HOME: root,
    OCTOCODE_NATIVE_WORKER: "1",
    OCTOCODE_MODEL_API_KEY: "conformance-test-key",
    OCTOCODE_MODEL_ENDPOINT: "http://127.0.0.1:1/v1",
  };
  return createProductionNativeHostAdapter<NativeLaunchDependencies>({
    launch: launchNativeAgent,
    commandNames: NATIVE_SLASH_COMMANDS.map(({ name }) => name),
    unsupportedReasons: nativeUnsupported,
    createDependencies: (events) => {
      const input = new PassThrough();
      input.end("/tools\n/exit\n");
      const listeners = new Set<(event: RuntimeEvent) => void>();
      const emitLifecycle = (
        type: "runtime.ready" | "runtime.stopping",
      ): void => {
        const event = {
          type,
          payload: {},
          trust: { workspace: "trusted", managedOnly: false },
        } as RuntimeEvent;
        for (const listener of listeners) listener(event);
      };
      const runtime: AgentRuntime = {
        start: async () => {
          emitLifecycle("runtime.ready");
        },
        submit: async () => undefined,
        cancel: async () => undefined,
        execute: async () => ({ ok: true, data: {} }),
        snapshot: () => ({ state: "ready" }) as RuntimeSnapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        stop: async () => {
          emitLifecycle("runtime.stopping");
        },
      };
      return {
        cwd: root,
        env,
        stdin: input,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        createRuntime: async () => runtime,
        createTerminal: () => ({
          inputOwnership: "external",
          start: async () => undefined,
          accept: (event) => {
            events.push(event);
          },
          stop: async () => undefined,
          snapshot: () => ({
            ready: true,
            working: "idle",
            turns: [],
            messages: [],
            tools: [],
            statuses: {},
            notifications: [],
            widgets: {},
            interactionHandler: "required",
          }),
          acceptInput: () => false,
        }),
      };
    },
  });
}

describe("production composition with synthetic conformance drivers", () => {
  test("asserts the supported Pi 0.84.2 contract from the production compatibility boundary", async () => {
    expect(APPROVED_PI_HOST_VERSION).toBe("0.84.2");
    const incompatible = createOctocodePiExtension({ hostVersion: "0.84.3" });
    await expect(
      incompatible(createPiFlowHarness().pi as never),
    ).rejects.toBeInstanceOf(PiHostCompatibilityError);
  });

  test("labels the bounded lifecycle evidence without overstating driver strength", async () => {
    const lifecycle = CANONICAL_HOST_SCENARIOS[0]!;
    const report = await runCanonicalHostConformance({
      baseline: productionPiAdapter(),
      candidate: productionNativeAdapter(),
    });

    expect(report.baselineHost).toContain("production-composition/synthetic-driver");
    expect(report.candidateHost).toContain("production-composition/synthetic-driver");
    expect(report.evidence).toEqual({
      baseline: "synthetic",
      candidate: "synthetic",
    });
    expect(report.summary).toEqual({
      total: 14,
      matched: 0,
      diverged: 1,
      unsupported: 13,
    });
    expect(report.results).toHaveLength(14);
    const lifecycleResult = report.results.find(
      ({ scenarioId }) => scenarioId === lifecycle.id,
    )!;
    expect(lifecycleResult.status).toBe("diverged");
    expect(lifecycleResult.trace.firstDivergence?.index).toBe(1);
    expect(lifecycleResult.trace.firstDivergence).toMatchObject({
      index: 1,
      path: "$[1].data.identity.composition",
      baseline: "@octocodeai/pi-extension",
      candidate: "octocode-agent/native-launcher",
    });
    expect(lifecycleResult.effects.matched).toBe(false);
    expect(lifecycleResult.effects.firstDivergence).toMatchObject({
      index: 0,
      path: "$[0].data.identity.composition",
      baseline: "@octocodeai/pi-extension",
      candidate: "octocode-agent/native-launcher",
    });
    expect(lifecycleResult.trace.baselineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleResult.trace.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleResult.effects.baselineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleResult.effects.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect({
      traceBaseline: lifecycleResult.trace.baselineHash,
      traceCandidate: lifecycleResult.trace.candidateHash,
      effectsBaseline: lifecycleResult.effects.baselineHash,
      effectsCandidate: lifecycleResult.effects.candidateHash,
    }).toEqual({
      traceBaseline: "2f71ad745d74a1b83cb3e41da48aa705e8e5639e347db0ccdd38037342df9079",
      traceCandidate: "05d6a2a5a7cdac3ce9c6f4c61a6ca9d0ec028e92e6d69c262a7708c1817da0a0",
      effectsBaseline: "934ab6c0304783606a8bd88bad6086892dc0a63fe07718b7577a6a83a81fd732",
      effectsCandidate: "5fce6a955cc977bcef52aa5ca5439414bba969c65af07b40f39e363c969d176b",
    });

    const uiResult = report.results.find(
      ({ scenarioId }) => scenarioId === "ui-semantics",
    )!;
    expect(uiResult.status).toBe("unsupported");
    expect(uiResult.unsupported).toMatchObject({
      baseline: piUnsupported["ui-semantics"],
      candidate: nativeUnsupported["ui-semantics"],
    });

    const unsupported = report.results.filter(
      ({ status }) => status === "unsupported",
    );
    expect(unsupported).toHaveLength(13);
    expect(
      unsupported.every(
        (result) =>
          result.matched === false &&
          result.unsupported?.baseline === piUnsupported[result.scenarioId as keyof typeof piUnsupported] &&
          result.unsupported?.candidate === nativeUnsupported[result.scenarioId as keyof typeof nativeUnsupported],
      ),
    ).toBe(true);
    expect(report.matched).toBe(false);
  }, 30_000);
});
