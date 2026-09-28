import { describe, expect, it } from "vitest";
import {
  RELEASE_CLOSURE_GATES,
  evaluateReleaseClosure,
  type ReleaseClosureReceiptV1,
} from "../src/release-closure.js";

const candidate = {
  commit: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  clean: true,
} as const;

function receipts(
  status: ReleaseClosureReceiptV1["status"] = "PASS",
): ReleaseClosureReceiptV1[] {
  return RELEASE_CLOSURE_GATES.map((gate, index) => ({
    schemaVersion: 1,
    gate,
    candidateCommit: candidate.commit,
    artifactSha256: candidate.artifactSha256,
    status,
    producer: `producer-${index}`,
    reviewer: `reviewer-${index}`,
    command: `verify-${gate}`,
    exitCode: status === "PASS" ? 0 : 1,
    evidenceHash: String(index).padStart(64, "c"),
    signature: `signature-${index}`,
    observedAt: "2026-09-01T00:00:00.000Z",
  }));
}

const passingCanary = {
  startedAt: "2026-09-01T00:00:00.000Z",
  endedAt: "2026-09-02T00:00:00.000Z",
  minimumDurationMs: 86_400_000,
  cohortSize: 100,
  minimumCohortSize: 100,
  metrics: [
    { name: "task-success", direction: "minimum" as const, observed: 0.99, threshold: 0.98 },
    { name: "unsafe-effects", direction: "maximum" as const, observed: 0, threshold: 0 },
  ],
};

describe("release closure evaluator", () => {
  it("holds a dirty or incomplete candidate and names every missing gate", () => {
    const result = evaluateReleaseClosure({
      candidate: { ...candidate, clean: false },
      receipts: receipts().slice(0, 2),
      verifySignature: () => true,
    });

    expect(result.decision).toBe("HOLD");
    expect(result.blockers).toContain("candidate:dirty");
    expect(result.blockers.filter((value) => value.startsWith("missing:"))).toHaveLength(6);
  });

  it("accepts only one clean candidate with independent, signed receipts and a passing canary", () => {
    const result = evaluateReleaseClosure({
      candidate,
      receipts: receipts(),
      canary: passingCanary,
      verifySignature: () => true,
    });

    expect(result).toEqual({ decision: "GO", blockers: [], closedGates: 8, totalGates: 8 });
  });

  it("holds mismatched, self-reviewed, unsupported, or unverifiable evidence", () => {
    const values = receipts();
    values[0] = { ...values[0]!, candidateCommit: "d".repeat(40) };
    values[1] = { ...values[1]!, reviewer: values[1]!.producer };
    values[2] = { ...values[2]!, status: "UNSUPPORTED", exitCode: 1 };

    const result = evaluateReleaseClosure({
      candidate,
      receipts: values,
      canary: passingCanary,
      verifySignature: (receipt) => receipt.gate !== values[3]!.gate,
    });

    expect(result.decision).toBe("HOLD");
    expect(result.blockers).toEqual(expect.arrayContaining([
      `candidate-mismatch:${values[0]!.gate}`,
      `self-reviewed:${values[1]!.gate}`,
      `unsupported:${values[2]!.gate}`,
      `signature:${values[3]!.gate}`,
    ]));
  });

  it("orders rollback when an active canary violates an abort threshold", () => {
    const result = evaluateReleaseClosure({
      candidate,
      receipts: receipts(),
      canary: {
        ...passingCanary,
        metrics: [
          { name: "unsafe-effects", direction: "maximum", observed: 1, threshold: 0 },
        ],
      },
      verifySignature: () => true,
    });

    expect(result.decision).toBe("ROLLBACK");
    expect(result.blockers).toContain("canary-metric:unsafe-effects");
  });

  it("fails closed on duplicate or unknown receipts and invalid canary bounds", () => {
    const values = receipts();
    values.push(values[0]!);
    values.push({ ...values[1]!, gate: "invented" as never });

    const result = evaluateReleaseClosure({
      candidate,
      receipts: values,
      canary: {
        ...passingCanary,
        minimumDurationMs: 0,
        cohortSize: -1,
        minimumCohortSize: 0,
      },
      verifySignature: () => true,
    });

    expect(result.decision).toBe("HOLD");
    expect(result.blockers).toEqual(expect.arrayContaining([
      `duplicate:${values[0]!.gate}`,
      "unknown-gate:invented",
      "canary:duration",
      "canary:cohort",
    ]));
  });

  it("fails closed when signature verification throws", () => {
    const result = evaluateReleaseClosure({
      candidate,
      receipts: receipts(),
      canary: passingCanary,
      verifySignature: () => {
        throw new Error("verifier unavailable");
      },
    });

    expect(result.decision).toBe("HOLD");
    expect(result.blockers.filter((value) => value.startsWith("signature:"))).toHaveLength(8);
  });

  it("rejects malformed evidence and failed execution independently", () => {
    const values = receipts();
    values[0] = { ...values[0]!, evidenceHash: "not-a-digest" };
    values[1] = { ...values[1]!, status: "FAIL", exitCode: 0 };
    values[2] = { ...values[2]!, exitCode: 9 };

    const result = evaluateReleaseClosure({
      candidate,
      receipts: values,
      canary: passingCanary,
      verifySignature: () => true,
    });

    expect(result.decision).toBe("HOLD");
    expect(result.closedGates).toBe(5);
    expect(result.blockers).toEqual(expect.arrayContaining([
      `shape:${values[0]!.gate}`,
      `failed:${values[1]!.gate}`,
      `failed:${values[2]!.gate}`,
    ]));
  });

  it("holds absent, reversed, undersized, or metric-free canaries", () => {
    const absent = evaluateReleaseClosure({
      candidate,
      receipts: receipts(),
      verifySignature: () => true,
    });
    const invalid = evaluateReleaseClosure({
      candidate,
      receipts: receipts(),
      canary: {
        ...passingCanary,
        startedAt: "invalid",
        endedAt: "2025-01-01T00:00:00.000Z",
        cohortSize: 1,
        metrics: [],
      },
      verifySignature: () => true,
    });

    expect(absent.blockers).toContain("canary:missing");
    expect(invalid.decision).toBe("HOLD");
    expect(invalid.blockers).toEqual(expect.arrayContaining([
      "canary:duration",
      "canary:cohort",
      "canary:metrics-missing",
    ]));
  });

  it("rejects invalid candidate identifiers even when receipts are otherwise complete", () => {
    const result = evaluateReleaseClosure({
      candidate: { commit: "short", artifactSha256: "short", clean: true },
      receipts: receipts(),
      canary: passingCanary,
      verifySignature: () => true,
    });

    expect(result.decision).toBe("HOLD");
    expect(result.blockers).toEqual(expect.arrayContaining([
      "candidate:commit",
      "candidate:artifact",
    ]));
  });
});
