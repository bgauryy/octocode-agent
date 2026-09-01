import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { CANONICAL_HOST_SCENARIOS } from "../src/host-conformance.js";
import { createNativeSteerFollowUpProbe } from "./support/native-steer-followup-probe.js";

describe("native production steer and follow-up conformance probe", () => {
  test("queues both controls during a live turn and delivers them in provider order", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "octocode-native-steer-followup-probe-"),
    );
    try {
      const scenario = CANONICAL_HOST_SCENARIOS.find(
        ({ id }) => id === "steer-and-follow-up",
      )!;
      const receipt = await createNativeSteerFollowUpProbe(root)({
        scenario,
        signal: new AbortController().signal,
      });

      expect(receipt.source).toBe("native-production-composition");
      expect(receipt.effects).toEqual([]);
      expect(receipt.events).toEqual([
        { kind: "turn.started" },
        { kind: "stream.text", data: { delta: "first" } },
        { kind: "stream.text", data: { delta: "steered" } },
        { kind: "stream.text", data: { delta: "followed" } },
        { kind: "turn.completed" },
        {
          kind: "control.queued",
          data: { steering: 1, followUp: 1 },
        },
        {
          kind: "control.delivered",
          data: {
            providerTurns: 3,
            inputs: [
              ["initial"],
              ["initial", "steer-message"],
              ["initial", "steer-message", "follow-up-message"],
            ],
          },
        },
      ]);
      expect(receipt.observations).toEqual([
        {
          kind: "native.control-proof",
          data: {
            composition: "createDefaultNativeRuntime",
            queuedKinds: ["steer", "follow-up"],
            lastUserInputs: ["initial", "steer-message", "follow-up-message"],
            ready: true,
          },
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
