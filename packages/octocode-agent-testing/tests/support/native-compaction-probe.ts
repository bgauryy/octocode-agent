import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ModelContextOverflowError,
  ToolRegistry,
  type ModelMessage,
  type ModelPort,
  type ModelRequest,
  type RuntimeEvent,
} from "@octocodeai/agent-core";
import {
  createDefaultNativeRuntime,
  parseNativeArgs,
} from "../../../octocode-agent/src/native-launcher.js";
import type { NativeContextArtifactSources } from "../../../octocode-agent/src/native-context-artifacts.js";
import type { ProductionScenarioProbe } from "../../src/production-host-adapters.js";

type NativeRuntime = Awaited<ReturnType<typeof createDefaultNativeRuntime>>;

interface CompactionRunEvidence {
  readonly events: RuntimeEvent[];
  readonly requests: ModelRequest[];
  readonly projections: Array<{
    readonly stablePrefixDigest: string;
    readonly blocks: readonly { readonly kind: string; readonly digest: string }[];
    readonly dropped: readonly unknown[];
  }>;
  readonly summaries: Array<{
    readonly reason: "manual" | "threshold" | "overflow";
    readonly attempt: number;
    readonly sourceMessages: number;
  }>;
  readonly timeline: string[];
  readonly runtime: NativeRuntime;
}

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const contextSources = (): NativeContextArtifactSources => ({
  generatedAt: 42,
  plan: {
    authority: "runtime",
    planId: "plan:production-compaction",
    scope: {
      sessionId: "session:production-compaction",
      workspace: "/workspace",
    },
    revision: 7,
    phase: "active",
    steps: [
      {
        id: "step:production-compaction:1",
        text: "Keep the active plan after compaction",
        status: "doing",
      },
    ],
  },
  skills: [
    {
      name: "production-compaction",
      description: "Verify durable context compaction.",
    },
  ],
  memoryLeads: [
    {
      id: "memory:production-compaction",
      text: "Rehydrate inspectable context artifacts after compaction.",
      sourceRevision: "6",
    },
  ],
  tools: [],
});

async function stopQuietly(runtime: NativeRuntime): Promise<void> {
  await runtime.stop().catch(() => undefined);
}

function systemPrompt(request: ModelRequest | undefined): ModelMessage | undefined {
  return request?.messages.find(({ role }) => role === "system");
}

function hasActivePlan(request: ModelRequest | undefined): boolean {
  return Boolean(
    request?.messages.some(
      ({ content }) =>
        content.includes("plan-snapshot") &&
        content.includes("Keep the active plan after compaction"),
    ),
  );
}

function compactionTypes(events: readonly RuntimeEvent[]): string[] {
  return events
    .filter(
      ({ type }) =>
        type === "context.compaction-started" ||
        type === "context.compacted" ||
        type === "context.compaction-failed" ||
        type === "context.artifacts-projected",
    )
    .map(({ type }) => type);
}

async function composeRun(
  root: string,
  name: string,
  model: ModelPort,
  inputTokenThreshold = 64_000,
): Promise<CompactionRunEvidence> {
  const home = path.join(root, `${name}-home`);
  const workspace = path.join(root, `${name}-workspace`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const events: RuntimeEvent[] = [];
  const requests: ModelRequest[] = [];
  const projections: CompactionRunEvidence["projections"] extends readonly (infer T)[]
    ? T[]
    : never = [];
  const summaries: CompactionRunEvidence["summaries"] extends readonly (infer T)[]
    ? T[]
    : never = [];
  const timeline: string[] = [];
  const observedModel: ModelPort = {
    run: async (request, context) => {
      timeline.push("provider");
      requests.push(structuredClone(request));
      return model.run(request, context);
    },
  };
  const runtime = await createDefaultNativeRuntime({
    env: { OCTOCODE_HOME: home },
    cwd: workspace,
    args: parseNativeArgs(["--mode", "json", "--no-session"]),
    tools: new ToolRegistry(),
    contextArtifacts: contextSources(),
    onContextProjection: (projection) => {
      projections.push({
        stablePrefixDigest: projection.stablePrefixDigest,
        blocks: projection.blocks.map(({ artifactId, kind }) => ({
          kind,
          digest:
            projection.manifest.artifacts.find(
              (artifact) => artifact.artifactId === artifactId,
            )?.digest ?? "",
        })),
        dropped: structuredClone(projection.dropped),
      });
    },
    customization: {
      schemaVersion: 1,
      id: `production.conformance.compaction.${name}`,
      compaction: {
        inputTokenThreshold,
        summarize: async ({ messages, reason, attempt }) => {
          timeline.push(`compaction:${reason}`);
          summaries.push({ reason, attempt, sourceMessages: messages.length });
          return {
            summary: `production ${reason} summary attempt ${attempt}`,
            retainedEventIds: [],
          };
        },
      },
    },
    model: observedModel,
  });
  runtime.subscribe((event) => events.push(event));
  await runtime.start();
  return { events, requests, projections, summaries, timeline, runtime };
}

function completeUsage(inputTokens = 12) {
  return {
    stop: "complete" as const,
    usage: {
      inputTokens,
      outputTokens: 2,
      cachedInputTokens: 7,
      cacheWriteInputTokens: 3,
    },
  };
}

/**
 * Drives the canonical five-state compaction matrix through native production
 * composition. Canonical events deliberately match Pi semantics; native-only
 * durability, projection, prompt-prefix, and cache evidence stays observational.
 */
export function createNativeCompactionProbe(root: string): ProductionScenarioProbe {
  return async ({ scenario }) => {
    if (scenario.id !== "compaction-matrix")
      throw new Error(`Unexpected native compaction scenario: ${scenario.id}`);

    const canonical: Array<{ kind: string; data: unknown }> = [];
    const observations: Array<{ kind: string; data: unknown }> = [];

    const manual = await composeRun(root, "manual", {
      run: async () => completeUsage(),
    });
    try {
      await manual.runtime.submit("manual compaction seed");
      const before = manual.requests.at(-1);
      const result = await manual.runtime.execute({
        type: "context.compact",
        reason: "manual",
      });
      await manual.runtime.submit("after manual compaction");
      const after = manual.requests.at(-1);
      const beforeSystem = systemPrompt(before)?.content;
      const afterSystem = systemPrompt(after)?.content;
      const cacheStable = manual.requests.every(
        ({ cache }) => cache?.stablePrefixMessageCount === 1,
      );
      const projectionDigests = manual.projections.map(
        ({ stablePrefixDigest }) => stablePrefixDigest,
      );
      const planDigests = manual.projections.map(({ blocks }) =>
        blocks.find(({ kind }) => kind === "plan-snapshot")?.digest,
      );
      const planProjectionStable =
        planDigests.length >= 2 &&
        planDigests.every(
          (planDigest) =>
            planDigest !== undefined && planDigest === planDigests[0],
        );
      if (
        result.ok !== true ||
        beforeSystem === undefined ||
        afterSystem === undefined ||
        beforeSystem !== afterSystem ||
        !cacheStable ||
        !hasActivePlan(before) ||
        !hasActivePlan(after) ||
        !planProjectionStable ||
        manual.projections.some(({ dropped }) => dropped.length > 0)
      ) {
        throw new Error(
          `Native manual compaction lost stable or rehydrated context: ${JSON.stringify({
            ok: result.ok,
            hasBeforeSystem: beforeSystem !== undefined,
            hasAfterSystem: afterSystem !== undefined,
            sameSystem: beforeSystem === afterSystem,
            cacheStable,
            planBefore: hasActivePlan(before),
            planAfter: hasActivePlan(after),
            planProjectionStable,
            projectionCount: manual.projections.length,
            blockKinds: manual.projections.map(({ blocks }) =>
              blocks.map(({ kind }) => kind),
            ),
            planDigests,
            dropped: manual.projections.map(({ dropped }) => dropped.length),
          })}`,
        );
      }
      canonical.push(
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
      );
      observations.push({
        kind: "native.compaction-context-proof",
        data: {
          promptDigestBefore: digest(beforeSystem),
          promptDigestAfter: digest(afterSystem),
          stablePrefixMessageCount: 1,
          initialProjectionDigest: projectionDigests[0],
          compactedProjectionDigest: projectionDigests[1],
          activePlanDigest: planDigests[0],
          projectionPhases: manual.projections.length,
          activePlanRehydrated: true,
          droppedArtifacts: 0,
          cacheReadTokens: manual.runtime.snapshot().usage.cachedInputTokens,
          cacheWriteTokens: manual.runtime.snapshot().usage.cacheWriteInputTokens,
          lifecycle: compactionTypes(manual.events),
        },
      });
    } finally {
      await stopQuietly(manual.runtime);
    }

    let thresholdProviderCalls = 0;
    const threshold = await composeRun(root, "threshold", {
      run: async () => {
        thresholdProviderCalls += 1;
        return completeUsage(11);
      },
    });
    try {
      await threshold.runtime.submit(`preflight ${"x".repeat(300_000)}`);
      if (
        thresholdProviderCalls !== 1 ||
        threshold.summaries.length !== 1 ||
        threshold.summaries[0]?.reason !== "threshold" ||
        !compactionTypes(threshold.events).includes("context.compacted")
      )
        throw new Error("Native model-aware threshold preflight was not proven");
      canonical.push(
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
      );
      observations.push({
        kind: "native.compaction-preflight-proof",
        data: {
          providerCalls: thresholdProviderCalls,
          summarizerCalls: threshold.summaries.length,
          compactedBeforeProvider:
            threshold.timeline[0] === "compaction:threshold" &&
            threshold.timeline[1] === "provider",
          requestBytes: 300_010,
        },
      });
    } finally {
      await stopQuietly(threshold.runtime);
    }

    const overflowDirect = await composeRun(root, "overflow-direct", {
      run: async () => completeUsage(),
    }, 2_000_000);
    try {
      await overflowDirect.runtime.submit("overflow seed");
      const result = await overflowDirect.runtime.execute({
        type: "context.compact",
        reason: "overflow",
      });
      if (result.ok !== true || overflowDirect.summaries[0]?.reason !== "overflow")
        throw new Error("Native explicit overflow compaction did not commit");
      canonical.push(
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
      );
    } finally {
      await stopQuietly(overflowDirect.runtime);
    }

    let overflowCalls = 0;
    let overflowSeeded = false;
    const overflowRetry = await composeRun(root, "overflow-retry", {
      run: async () => {
        if (!overflowSeeded) {
          overflowSeeded = true;
          return completeUsage();
        }
        overflowCalls += 1;
        if (overflowCalls === 1)
          throw new ModelContextOverflowError("input", "production overflow");
        return completeUsage();
      },
    }, 2_000_000);
    try {
      await overflowRetry.runtime.submit(`overflow history ${"h".repeat(100_000)}`);
      await overflowRetry.runtime.submit("retry after provider overflow");
      if (
        overflowCalls !== 2 ||
        overflowRetry.summaries.length !== 1 ||
        overflowRetry.summaries[0]?.reason !== "overflow"
      )
        throw new Error("Native overflow did not compact and retry exactly once");
      canonical.push(
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
      );
      observations.push({
        kind: "native.compaction-overflow-retry-proof",
        data: {
          providerCalls: overflowCalls,
          summarizerCalls: overflowRetry.summaries.length,
          retryBounded: true,
        },
      });
    } finally {
      await stopQuietly(overflowRetry.runtime);
    }

    let failedCalls = 0;
    let failedSeeded = false;
    const failedRetry = await composeRun(root, "failed-retry", {
      run: async () => {
        if (!failedSeeded) {
          failedSeeded = true;
          return completeUsage();
        }
        failedCalls += 1;
        throw new ModelContextOverflowError("input", "production repeated overflow");
      },
    }, 2_000_000);
    try {
      await failedRetry.runtime.submit(`failed retry history ${"h".repeat(100_000)}`);
      let rejected = false;
      try {
        await failedRetry.runtime.submit("fail the single overflow retry");
      } catch {
        rejected = true;
      }
      if (
        !rejected ||
        failedCalls !== 2 ||
        failedRetry.summaries.length !== 1 ||
        failedRetry.summaries[0]?.reason !== "overflow" ||
        failedRetry.runtime.snapshot().state !== "failed"
      )
        throw new Error(
          `Native repeated overflow did not fail after one safe retry: ${JSON.stringify({
            rejected,
            failedCalls,
            summaries: failedRetry.summaries,
            state: failedRetry.runtime.snapshot().state,
          })}`,
        );
      canonical.push(
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
      );
      observations.push({
        kind: "native.compaction-failed-retry-proof",
        data: {
          providerCalls: failedCalls,
          summarizerCalls: failedRetry.summaries.length,
          retryBounded: true,
          providerError: "Context overflow after compaction retry",
          terminalState: "failed",
          terminalSignals: 2,
          lifecycle: failedRetry.events.map(({ type }) => type),
        },
      });
    } finally {
      await stopQuietly(failedRetry.runtime);
    }

    return {
      source: "native-production-composition" as const,
      events: canonical,
      effects: [],
      observations,
    };
  };
}
