import { describe, expect, test } from "vitest";
import { createNativeCodexHookProbe } from "./support/native-codex-hook-probe.js";

describe("native Codex hook production probe", () => {
  test("covers reviewed decisions, context, rewrites, redaction, failure, and timeout", async () => {
    const receipt = await createNativeCodexHookProbe()({
      scenario: {
        id: "codex-hook-lifecycle",
        title: "Dispatch reviewed Codex hooks",
        requirements: ["hooks", "trust"],
        applicability: {
          kind: "host-specific",
          host: "native",
          reason: "reviewed Codex hook dispatch is a native host integration",
        },
        input: { compare: ["decision", "context", "rewrite"] },
      },
      signal: new AbortController().signal,
    });

    expect(receipt.source).toBe("native-production-composition");
    expect(receipt.events).toEqual([
      { kind: "hook.decision", data: { permission: "allow" } },
      {
        kind: "hook.context",
        data: { bounded: true, escaped: true, untrusted: true },
      },
      { kind: "hook.rewrite", data: { prompt: true, toolInput: true } },
      { kind: "hook.redaction", data: { defaultExposure: "redacted" } },
      {
        kind: "hook.failure",
        data: { malformedRewriteRejected: true, timeoutRecorded: true },
      },
    ]);
    expect(receipt.effects).toEqual([
      {
        id: "codex-hook-lifecycle:dispatch",
        kind: "hook.execution",
        effectful: false,
        data: { reviewed: true },
      },
    ]);
    expect(receipt.observations).toEqual([
      {
        kind: "hook.dispatch-receipts",
        data: { executed: 5, failed: 2, skipped: 0 },
      },
    ]);
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE HOOK RESULT");
  });
});
