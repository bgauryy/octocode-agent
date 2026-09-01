import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CANONICAL_HOST_SCENARIOS,
  runHostConformance,
  type HostConformanceAdapter,
} from "../src/host-conformance.js";
import { createProductionNativeHostAdapter } from "../src/production-host-adapters.js";
import { createNativePluginLifecycleProbe } from "./support/native-plugin-lifecycle-probe.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("native production plugin lifecycle probe", () => {
  it("proves grants, leases, disable/unload, update/resume, and failure closure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-plugin-production-"));
    roots.push(root);
    const scenario = CANONICAL_HOST_SCENARIOS.find(({ id }) => id === "plugin-lifecycle")!;
    const receipt = await createNativePluginLifecycleProbe(root)({
      scenario,
      signal: new AbortController().signal,
    });

    expect(receipt.source).toBe("native-production-composition");
    expect(receipt.events).toEqual([{
      kind: "plugin.lifecycle",
      data: {
        activated: true,
        used: true,
        disabled: true,
        unloaded: true,
        updated: true,
        resumed: true,
      },
    }]);
    expect(receipt.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "plugin.capability-grant" }),
      expect.objectContaining({ kind: "plugin.activation-leases" }),
      expect.objectContaining({ kind: "plugin.reverse-unload" }),
      expect.objectContaining({ kind: "plugin.failure-closure" }),
      expect.objectContaining({ kind: "plugin.update-resume" }),
    ]));
  });

  it("records native-only production coverage without fabricating a Pi peer trace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-plugin-coverage-"));
    roots.push(root);
    const scenario = CANONICAL_HOST_SCENARIOS.find(({ id }) => id === "plugin-lifecycle")!;
    const pi: HostConformanceAdapter = {
      name: "pi-without-transactional-plugins",
      hostKind: "pi",
      evidence: "production",
      supports: () => ({ supported: false, reason: "Pi SDK is host-inapplicable" }),
      execute: async () => { throw new Error("Pi plugin lifecycle must not execute"); },
    };
    const native = createProductionNativeHostAdapter({
      scenarioProbes: { "plugin-lifecycle": createNativePluginLifecycleProbe(root) },
    });

    const report = await runHostConformance({ baseline: pi, candidate: native, scenarios: [scenario] });

    expect(report.summary).toEqual({ total: 1, matched: 0, covered: 1, diverged: 0, unsupported: 0 });
    expect(report.matched).toBe(true);
    expect(report.results[0]).toMatchObject({
      status: "covered",
      matched: true,
      comparison: { performed: false, reason: "host-specific scenario" },
      coverage: {
        host: "native",
        role: "candidate",
        trace: [expect.objectContaining({ kind: "plugin.lifecycle" })],
        observations: expect.arrayContaining([
          expect.objectContaining({ kind: "production.probe-source" }),
          expect.objectContaining({ kind: "plugin.failure-closure" }),
        ]),
      },
    });
    expect(report.results[0]?.trace).toMatchObject({ matched: true });
  });
});
