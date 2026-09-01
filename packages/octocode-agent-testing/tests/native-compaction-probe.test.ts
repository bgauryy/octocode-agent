import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { CANONICAL_HOST_SCENARIOS } from "../src/host-conformance.js";
import { createNativeCompactionProbe } from "./support/native-compaction-probe.js";

describe("native production compaction conformance probe", () => {
  test("proves the five canonical states and retains native context evidence", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "octocode-native-compaction-probe-"),
    );
    try {
      const scenario = CANONICAL_HOST_SCENARIOS.find(
        ({ id }) => id === "compaction-matrix",
      )!;
      const receipt = await createNativeCompactionProbe(root)({
        scenario,
        signal: new AbortController().signal,
      });

      expect(receipt.source).toBe("native-production-composition");
      expect(receipt.effects).toEqual([]);
      expect(receipt.events).toEqual([
        { kind: "compaction.started", data: { reason: "manual" } },
        {
          kind: "compaction.completed",
          data: {
            reason: "manual",
            aborted: false,
            willRetry: false,
            persisted: true,
          },
        },
        { kind: "compaction.started", data: { reason: "threshold" } },
        {
          kind: "compaction.completed",
          data: {
            reason: "threshold",
            aborted: false,
            willRetry: false,
            persisted: true,
          },
        },
        { kind: "compaction.started", data: { reason: "overflow" } },
        {
          kind: "compaction.completed",
          data: {
            reason: "overflow",
            aborted: false,
            willRetry: false,
            persisted: true,
          },
        },
        { kind: "compaction.started", data: { reason: "overflow" } },
        {
          kind: "compaction.completed",
          data: {
            reason: "overflow",
            aborted: false,
            willRetry: true,
            persisted: true,
          },
        },
        { kind: "compaction.started", data: { reason: "overflow" } },
        {
          kind: "compaction.completed",
          data: {
            reason: "overflow",
            aborted: false,
            willRetry: true,
            persisted: true,
          },
        },
        {
          kind: "compaction.failed-retry",
          data: {
            reason: "overflow",
            aborted: false,
            willRetry: false,
            persisted: false,
            error:
              "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
          },
        },
      ]);
      expect(receipt.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "native.compaction-context-proof",
            data: expect.objectContaining({
              promptDigestBefore: expect.stringMatching(/^[a-f0-9]{64}$/u),
              promptDigestAfter: expect.stringMatching(/^[a-f0-9]{64}$/u),
              stablePrefixMessageCount: 1,
              activePlanRehydrated: true,
              droppedArtifacts: 0,
              cacheReadTokens: expect.any(Number),
              cacheWriteTokens: expect.any(Number),
            }),
          }),
          {
            kind: "native.compaction-preflight-proof",
            data: {
              providerCalls: 1,
              summarizerCalls: 1,
              compactedBeforeProvider: true,
              requestBytes: 300_010,
            },
          },
          {
            kind: "native.compaction-overflow-retry-proof",
            data: { providerCalls: 2, summarizerCalls: 1, retryBounded: true },
          },
          expect.objectContaining({
            kind: "native.compaction-failed-retry-proof",
            data: expect.objectContaining({
              providerCalls: 2,
              summarizerCalls: 1,
              retryBounded: true,
              providerError: "Context overflow after compaction retry",
              terminalState: "failed",
              terminalSignals: 2,
              lifecycle: expect.arrayContaining([
                "context.compaction-started",
                "context.compacted",
              ]),
            }),
          }),
        ]),
      );
      const context = receipt.observations?.find(
        ({ kind }) => kind === "native.compaction-context-proof",
      )?.data as { promptDigestBefore?: string; promptDigestAfter?: string };
      expect(context.promptDigestBefore).toBe(context.promptDigestAfter);
      expect(JSON.stringify(receipt)).not.toContain("Keep the active plan");
      expect(JSON.stringify(receipt)).not.toContain("production repeated overflow");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
