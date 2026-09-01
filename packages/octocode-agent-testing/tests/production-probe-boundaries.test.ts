import { describe, expect, it } from "vitest";

import {
  CANONICAL_HOST_SCENARIOS,
  type CanonicalHostConformanceScenario,
} from "../src/host-conformance.js";
import type { ProductionScenarioProbe } from "../src/production-host-adapters.js";
import { createNativeCodexHookProbe } from "./support/native-codex-hook-probe.js";
import { createNativeCompactionProbe } from "./support/native-compaction-probe.js";
import { createNativePluginLifecycleProbe } from "./support/native-plugin-lifecycle-probe.js";
import {
  createNativeCancellationProbe,
  createNativePolicyDenialProbe,
  createNativeToolFailureProbe,
} from "./support/native-policy-failure-cancellation-probes.js";
import {
  createNativePersistenceRestartProbe,
  createNativeSessionLifecycleProbe,
} from "./support/native-session-persistence-probes.js";
import { createNativeSteerFollowUpProbe } from "./support/native-steer-followup-probe.js";
import { createNativeUiSemanticsProbe } from "./support/native-ui-semantics-probe.js";

const wrongScenario = CANONICAL_HOST_SCENARIOS[0]!;

function scenario(
  id: CanonicalHostConformanceScenario["id"],
): CanonicalHostConformanceScenario {
  return CANONICAL_HOST_SCENARIOS.find((candidate) => candidate.id === id)!;
}

function invoke(
  probe: ProductionScenarioProbe,
  selected: CanonicalHostConformanceScenario,
  signal = new AbortController().signal,
) {
  return probe({ scenario: selected, signal });
}

describe("production probe input boundaries", () => {
  it.each([
    ["Codex hook", createNativeCodexHookProbe()],
    ["compaction", createNativeCompactionProbe("/unused")],
    ["plugin", createNativePluginLifecycleProbe("/unused")],
    ["policy", createNativePolicyDenialProbe("/unused")],
    ["cancellation", createNativeCancellationProbe("/unused")],
    ["tool failure", createNativeToolFailureProbe("/unused")],
    ["session", createNativeSessionLifecycleProbe("/unused")],
    ["persistence", createNativePersistenceRestartProbe("/unused")],
    ["steer", createNativeSteerFollowUpProbe("/unused")],
  ] as const)("rejects a mismatched %s scenario before side effects", async (_name, probe) => {
    await expect(invoke(probe, wrongScenario)).rejects.toThrow(/unexpected/i);
  });

  it.each([
    ["Codex hook", createNativeCodexHookProbe(), "codex-hook-lifecycle"],
    ["plugin", createNativePluginLifecycleProbe("/unused"), "plugin-lifecycle"],
    ["session", createNativeSessionLifecycleProbe("/unused"), "session-lifecycle"],
    ["persistence", createNativePersistenceRestartProbe("/unused"), "persistence-restart"],
    ["steer", createNativeSteerFollowUpProbe("/unused"), "steer-and-follow-up"],
    ["UI", createNativeUiSemanticsProbe("/unused"), "ui-semantics"],
  ] as const)("honors a pre-aborted %s probe", async (_name, probe, id) => {
    const abort = new AbortController();
    abort.abort(new Error("boundary cancelled"));

    await expect(invoke(probe, scenario(id), abort.signal)).rejects.toThrow(
      "boundary cancelled",
    );
  });
});
