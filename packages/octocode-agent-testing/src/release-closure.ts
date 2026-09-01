export const RELEASE_CLOSURE_GATES = Object.freeze([
  "local-implementation",
  "production-conformance",
  "session-context-integrity",
  "security-effect-safety",
  "providers-mcp",
  "workers-orchestration",
  "settings-terminal",
  "native-pi-isolation",
  "canary-observation",
] as const);

export type ReleaseClosureGate = (typeof RELEASE_CLOSURE_GATES)[number];
export type ReleaseDecision = "GO" | "HOLD" | "ROLLBACK";

export interface ReleaseClosureReceiptV1 {
  readonly schemaVersion: 1;
  readonly gate: ReleaseClosureGate;
  readonly candidateCommit: string;
  readonly artifactSha256: string;
  readonly status: "PASS" | "FAIL" | "UNSUPPORTED";
  readonly producer: string;
  readonly reviewer: string;
  readonly command: string;
  readonly exitCode: number;
  readonly evidenceHash: string;
  readonly signature: string;
  readonly observedAt: string;
}

export interface ReleaseCanaryMetricV1 {
  readonly name: string;
  readonly direction: "minimum" | "maximum";
  readonly observed: number;
  readonly threshold: number;
}

export interface ReleaseCanaryWindowV1 {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly minimumDurationMs: number;
  readonly cohortSize: number;
  readonly minimumCohortSize: number;
  readonly metrics: readonly ReleaseCanaryMetricV1[];
}

export interface ReleaseCandidateV1 {
  readonly commit: string;
  readonly artifactSha256: string;
  readonly clean: boolean;
}

export interface ReleaseClosureEvaluation {
  readonly decision: ReleaseDecision;
  readonly blockers: readonly string[];
  readonly closedGates: number;
  readonly totalGates: number;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validReceiptShape(receipt: ReleaseClosureReceiptV1): boolean {
  return receipt.schemaVersion === 1
    && COMMIT.test(receipt.candidateCommit)
    && SHA256.test(receipt.artifactSha256)
    && SHA256.test(receipt.evidenceHash)
    && nonEmpty(receipt.producer)
    && nonEmpty(receipt.reviewer)
    && nonEmpty(receipt.command)
    && nonEmpty(receipt.signature)
    && Number.isFinite(Date.parse(receipt.observedAt));
}

function metricPassed(metric: ReleaseCanaryMetricV1): boolean {
  if (!Number.isFinite(metric.observed) || !Number.isFinite(metric.threshold)) return false;
  return metric.direction === "minimum"
    ? metric.observed >= metric.threshold
    : metric.observed <= metric.threshold;
}

export function evaluateReleaseClosure(options: {
  readonly candidate: ReleaseCandidateV1;
  readonly receipts: readonly ReleaseClosureReceiptV1[];
  readonly canary?: ReleaseCanaryWindowV1;
  readonly verifySignature: (receipt: ReleaseClosureReceiptV1) => boolean;
}): ReleaseClosureEvaluation {
  const blockers: string[] = [];
  let closedGates = 0;
  let rollback = false;

  if (!options.candidate.clean) blockers.push("candidate:dirty");
  if (!COMMIT.test(options.candidate.commit)) blockers.push("candidate:commit");
  if (!SHA256.test(options.candidate.artifactSha256)) blockers.push("candidate:artifact");

  for (const receipt of options.receipts) {
    if (!(RELEASE_CLOSURE_GATES as readonly string[]).includes(receipt.gate)) {
      blockers.push(`unknown-gate:${String(receipt.gate)}`);
    }
  }

  for (const gate of RELEASE_CLOSURE_GATES) {
    const matching = options.receipts.filter((receipt) => receipt.gate === gate);
    if (matching.length === 0) {
      blockers.push(`missing:${gate}`);
      continue;
    }
    if (matching.length !== 1) {
      blockers.push(`duplicate:${gate}`);
      continue;
    }
    const receipt = matching[0]!;
    let valid = true;
    if (!validReceiptShape(receipt)) {
      blockers.push(`shape:${gate}`);
      valid = false;
    }
    if (
      receipt.candidateCommit !== options.candidate.commit
      || receipt.artifactSha256 !== options.candidate.artifactSha256
    ) {
      blockers.push(`candidate-mismatch:${gate}`);
      valid = false;
    }
    if (receipt.producer === receipt.reviewer) {
      blockers.push(`self-reviewed:${gate}`);
      valid = false;
    }
    if (receipt.status === "UNSUPPORTED") {
      blockers.push(`unsupported:${gate}`);
      valid = false;
    } else if (receipt.status === "FAIL" || receipt.exitCode !== 0) {
      blockers.push(`failed:${gate}`);
      valid = false;
    }
    let signatureVerified = false;
    try {
      signatureVerified = options.verifySignature(receipt);
    } catch {
      signatureVerified = false;
    }
    if (!signatureVerified) {
      blockers.push(`signature:${gate}`);
      valid = false;
    }
    if (valid) closedGates += 1;
  }

  const canary = options.canary;
  if (canary === undefined) {
    blockers.push("canary:missing");
  } else {
    const started = Date.parse(canary.startedAt);
    const ended = Date.parse(canary.endedAt);
    if (
      !Number.isFinite(started)
      || !Number.isFinite(ended)
      || ended < started
      || !Number.isSafeInteger(canary.minimumDurationMs)
      || canary.minimumDurationMs <= 0
      || ended - started < canary.minimumDurationMs
    ) blockers.push("canary:duration");
    if (
      !Number.isSafeInteger(canary.cohortSize)
      || !Number.isSafeInteger(canary.minimumCohortSize)
      || canary.cohortSize < 0
      || canary.minimumCohortSize <= 0
      || canary.cohortSize < canary.minimumCohortSize
    ) blockers.push("canary:cohort");
    if (canary.metrics.length === 0) blockers.push("canary:metrics-missing");
    for (const metric of canary.metrics) {
      if (nonEmpty(metric.name) && metricPassed(metric)) continue;
      blockers.push(`canary-metric:${metric.name || "unnamed"}`);
      rollback = true;
    }
  }

  return Object.freeze({
    decision: rollback ? "ROLLBACK" : blockers.length === 0 ? "GO" : "HOLD",
    blockers: Object.freeze(blockers),
    closedGates,
    totalGates: RELEASE_CLOSURE_GATES.length,
  });
}
