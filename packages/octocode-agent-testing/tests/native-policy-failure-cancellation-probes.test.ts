import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { CANONICAL_HOST_SCENARIOS } from "../src/host-conformance.js";
import {
  createNativeCancellationProbe,
  createNativePolicyDenialProbe,
  createNativeToolFailureProbe,
} from "./support/native-policy-failure-cancellation-probes.js";

describe("native production policy conformance probe", () => {
  test("proves plan, trust, approval, and real peer-lock denials before effects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-native-policy-probe-"));
    const ambientDbPath = process.env.OCTOCODE_AGENT_DB_PATH;
    try {
      const scenario = CANONICAL_HOST_SCENARIOS.find(
        ({ id }) => id === "policy-denial-matrix",
      )!;
      const receipt = await createNativePolicyDenialProbe(root)({
        scenario,
        signal: new AbortController().signal,
      });

      expect(receipt.source).toBe("native-production-composition");
      expect(receipt.events).toEqual([
        {
          kind: "policy.denied",
          data: { boundary: "plan", blocked: true, callId: "probe-policy-1" },
        },
        {
          kind: "policy.denied",
          data: { boundary: "trust", blocked: true, callId: "probe-policy-2" },
        },
        {
          kind: "policy.denied",
          data: {
            boundary: "approval",
            blocked: true,
            callId: "probe-policy-3",
          },
        },
        {
          kind: "policy.denied",
          data: {
            boundary: "peer-lock",
            blocked: true,
            callId: "probe-policy-4",
          },
        },
      ]);
      expect(receipt.effects).toEqual([]);
      expect(process.env.OCTOCODE_AGENT_DB_PATH).toBe(ambientDbPath);
      expect(receipt.observations).toEqual([
        {
          kind: "native.policy-proof",
          data: {
            executorCalls: 0,
            idle: true,
            categories: expect.arrayContaining([
              "plan-policy",
              "trust",
              "approval",
              "peer-lock",
            ]),
          },
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels model, tool, compaction, and pre-submit work without leaks", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "octocode-native-cancellation-probe-"),
    );
    try {
      const scenario = CANONICAL_HOST_SCENARIOS.find(
        ({ id }) => id === "cancellation-boundaries",
      )!;
      const receipt = await createNativeCancellationProbe(root)({
        scenario,
        signal: new AbortController().signal,
      });

      expect(receipt.source).toBe("native-production-composition");
      expect(receipt.effects).toEqual([]);
      expect(receipt.events).toEqual([
        { kind: "cancellation.model-stream", data: { idle: true } },
        { kind: "cancellation.tool-work", data: { idle: true } },
        {
          kind: "compaction.cancelled",
          data: {
            reason: "manual",
            aborted: true,
            willRetry: false,
            persisted: false,
          },
        },
        {
          kind: "cancellation.before-submit",
          data: {
            enforced: true,
            sdkCallAvoided: true,
            boundary: "production-probe-adapter",
          },
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies schema, executor, and real result-persistence failures", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "octocode-native-tool-failure-probe-"),
    );
    try {
      const scenario = CANONICAL_HOST_SCENARIOS.find(
        ({ id }) => id === "tool-failure-matrix",
      )!;
      const receipt = await createNativeToolFailureProbe(root)({
        scenario,
        signal: new AbortController().signal,
      });

      expect(receipt.source).toBe("native-production-composition");
      expect(receipt.effects).toEqual([]);
      expect(receipt.events).toEqual([
        {
          kind: "tool.failure",
          data: { boundary: "before-execution", classified: true },
        },
        {
          kind: "tool.failure",
          data: { boundary: "during-execution", classified: true },
        },
        {
          kind: "tool.failure",
          data: {
            boundary: "result-persistence",
            classified: true,
            persisted: false,
            surfacedToPrompt: false,
          },
        },
      ]);
      expect(receipt.observations).toEqual([
        {
          kind: "native.tool-failure-proof",
          data: {
            beforeExecutorCalls: 0,
            duringExecutorCalls: 1,
            persistenceExecutorCalls: 1,
            toolResultCommitAttempted: true,
            persistedToolResult: false,
            promptRejected: false,
          },
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
