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
} from "../src/production-host-adapters.js";

const roots: string[] = [];

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

describe("production host conformance evidence", () => {
  test("asserts the supported Pi 0.84.2 contract from the production compatibility boundary", async () => {
    expect(APPROVED_PI_HOST_VERSION).toBe("0.84.2");
    const incompatible = createOctocodePiExtension({ hostVersion: "0.84.3" });
    await expect(
      incompatible(createPiFlowHarness().pi as never),
    ).rejects.toBeInstanceOf(PiHostCompatibilityError);
  });

  test("runs a bounded lifecycle scenario through both production composition roots", async () => {
    const lifecycle = CANONICAL_HOST_SCENARIOS[0]!;
    const report = await runCanonicalHostConformance({
      baseline: productionPiAdapter(),
      candidate: productionNativeAdapter(),
    });

    expect(report.evidence).toEqual({
      baseline: "production",
      candidate: "production",
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
    expect(lifecycleResult.trace.firstDivergence?.path).toContain("$[1].data");
    expect(lifecycleResult.effects.matched).toBe(false);
    expect(lifecycleResult.trace.baselineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleResult.trace.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleResult.effects.baselineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycleResult.effects.candidateHash).toMatch(/^[a-f0-9]{64}$/);

    const uiResult = report.results.find(
      ({ scenarioId }) => scenarioId === "ui-semantics",
    )!;
    expect(uiResult.status).toBe("unsupported");
    expect(uiResult.unsupported).toMatchObject({
      baseline: expect.stringMatching(/has not implemented ui-semantics/),
      candidate: expect.stringMatching(/has not implemented ui-semantics/),
    });

    const unsupported = report.results.filter(
      ({ status }) => status === "unsupported",
    );
    expect(unsupported).toHaveLength(13);
    expect(
      unsupported.every(
        (result) =>
          result.matched === false &&
          result.unsupported?.baseline !== undefined &&
          result.unsupported?.candidate !== undefined,
      ),
    ).toBe(true);
    expect(report.matched).toBe(false);
  }, 30_000);
});
