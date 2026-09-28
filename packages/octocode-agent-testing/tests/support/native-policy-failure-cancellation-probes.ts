import fs from "node:fs";
import path from "node:path";

import {
  InMemorySessionStore,
  ToolRegistry,
  createEffectSet,
  createRuntimeKernel,
  revision,
  sessionId,
  type ModelPort,
  type RuntimeEvent,
  type SessionEvent,
  type SessionStore,
  type ToolDefinition,
} from "@octocodeai/agent-core";
import {
  createDefaultNativeRuntime,
  parseNativeArgs,
} from "../../../octocode-agent/src/native-launcher.js";
import { createRuntimeEventPersister } from "../../../octocode-agent/src/native-runtime-session-projector.js";
import type { ProductionScenarioProbe } from "../../src/production-host-adapters.js";

const POLICY_BOUNDARIES = ["plan", "trust", "approval"] as const;
type PolicyBoundary = (typeof POLICY_BOUNDARIES)[number];

function policyTool(
  boundary: PolicyBoundary,
  executed: () => void,
): ToolDefinition {
  const common = {
    name: `productionProbePolicy${boundary.replace(/\W+/gu, "-")}`,
    label: `Production policy ${boundary}`,
    description: `Production conformance policy driver for ${boundary}.`,
    schemaVersion: 1,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    outputSchema: { type: "object" },
    outputVersion: 1,
    presentation: {
      callLabel: `Policy ${boundary}`,
      resultLabel: `Policy ${boundary} result`,
    },
    async execute() {
      executed();
      return { ok: true, content: { boundary }, detailsVersion: 1 };
    },
  } satisfies Omit<ToolDefinition, "policy">;

  if (boundary === "plan") {
    return {
      ...common,
      policy: {
        effects: createEffectSet("read"),
        trust: "none",
        approval: "never",
        plan: "required",
      },
    };
  }
  if (boundary === "trust") {
    return {
      ...common,
      policy: {
        effects: createEffectSet("read"),
        trust: "workspace",
        approval: "never",
        plan: "allowed",
      },
    };
  }
  return {
    ...common,
    policy: {
      effects: createEffectSet("write"),
      trust: "none",
      approval: "always",
      plan: "allowed",
    },
  };
}

function policyModel(tools: ReadonlyMap<PolicyBoundary, string>): ModelPort {
  let request = 0;
  return {
    run: async (_input, context) => {
      request += 1;
      if (request === 1) {
        let index = 0;
        for (const boundary of POLICY_BOUNDARIES) {
          index += 1;
          await context.emit?.({
            type: "tool-call",
            id: `probe-policy-${index}`,
            name: tools.get(boundary)!,
            input: { value: `deny:${boundary}` },
          });
        }
        return {
          stop: "tool",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return {
        stop: "complete",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

/**
 * Drives the plan, trust, and approval deny-first gates through the native
 * production runtime. The receipt is emitted only after every executor remains untouched and the
 * runtime has returned to idle.
 */
export function createNativePolicyDenialProbe(root: string): ProductionScenarioProbe {
  return async ({ scenario }) => {
    if (scenario.id !== "policy-denial-matrix")
      throw new Error(`Unexpected native policy scenario: ${scenario.id}`);

    const home = path.join(root, "policy-home");
    const workspace = path.join(root, "policy-workspace");
    const nativeEnv = {
      OCTOCODE_HOME: home,
      OCTOCODE_AGENT_ID: "production-native",
    };
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    const registry = new ToolRegistry();
    const toolNames = new Map<PolicyBoundary, string>();
    let executions = 0;
    for (const boundary of POLICY_BOUNDARIES) {
      const definition = policyTool(boundary, () => {
        executions += 1;
      });
      registry.register(definition, "production-conformance");
      toolNames.set(boundary, definition.name);
    }

    const events: RuntimeEvent[] = [];
    const runtime = await createDefaultNativeRuntime({
      env: nativeEnv,
      cwd: workspace,
      args: parseNativeArgs(["--mode", "json", "--no-session"]),
      tools: registry,
      model: policyModel(toolNames),
    });
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    try {
      await runtime.start();
      await runtime.submit("exercise policy denials");
      const ended = events.filter(
        (event) =>
          event.type === "tool.ended" &&
          (event.payload as { outcome?: unknown }).outcome === "blocked",
      );
      const categories = ended.map(
        (event) => (event.payload as { category?: unknown }).category,
      );
      if (
        executions !== 0 ||
        runtime.snapshot().state !== "ready" ||
        ended.length !== POLICY_BOUNDARIES.length ||
        !categories.includes("plan-policy") ||
        !categories.includes("trust") ||
        !categories.includes("approval")
      ) {
        throw new Error(
          `Native deny-first probe failed: executions=${executions} state=${runtime.snapshot().state} categories=${categories.join(",")}`,
        );
      }
      return {
        source: "native-production-composition" as const,
        events: POLICY_BOUNDARIES.map((boundary, index) => ({
          kind: "policy.denied",
          data: {
            boundary,
            blocked: true,
            callId: `probe-policy-${index + 1}`,
          },
        })),
        effects: [],
        observations: [
          {
            kind: "native.policy-proof",
            data: { executorCalls: executions, idle: true, categories },
          },
        ],
      };
    } finally {
      unsubscribe();
      await runtime.stop().catch(() => undefined);
    }
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function stopQuietly(runtime: Awaited<ReturnType<typeof createDefaultNativeRuntime>>) {
  await runtime.stop().catch(() => undefined);
}

/** Drives cancellation at four independently owned native boundaries. */
export function createNativeCancellationProbe(root: string): ProductionScenarioProbe {
  return async ({ scenario }) => {
    if (scenario.id !== "cancellation-boundaries")
      throw new Error(`Unexpected native cancellation scenario: ${scenario.id}`);

    const home = path.join(root, "cancellation-home");
    const workspace = path.join(root, "cancellation-workspace");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const env = { OCTOCODE_HOME: home };
    const args = parseNativeArgs(["--mode", "json", "--no-session"]);
    const canonical: Array<{ kind: string; data: unknown }> = [];

    const modelStarted = deferred();
    const modelRuntime = await createDefaultNativeRuntime({
      env,
      cwd: workspace,
      args,
      tools: new ToolRegistry(),
      model: {
        run: async (_request, context) => {
          modelStarted.resolve();
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            stop: "cancelled",
            usage: { inputTokens: 1, outputTokens: 0 },
          };
        },
      },
    });
    try {
      await modelRuntime.start();
      const running = modelRuntime.submit("cancel model");
      await modelStarted.promise;
      await modelRuntime.cancel("production model cancellation");
      await running;
      const idle = modelRuntime.snapshot().state === "ready";
      if (!idle) throw new Error("Native model cancellation leaked active work");
      canonical.push({ kind: "cancellation.model-stream", data: { idle } });
    } finally {
      await stopQuietly(modelRuntime);
    }

    const toolStarted = deferred();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      {
        name: "productionProbeCancellationTool",
        label: "Production cancellation tool",
        description: "Abort-aware production tool cancellation driver.",
        schemaVersion: 1,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        outputSchema: { type: "object" },
        outputVersion: 1,
        policy: {
          effects: createEffectSet("read"),
          trust: "none",
          approval: "never",
          plan: "allowed",
        },
        presentation: {
          callLabel: "Cancellation tool",
          resultLabel: "Cancellation tool result",
        },
        async execute({ signal }) {
          toolStarted.resolve();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("production tool observed cancellation");
        },
      },
      "production-conformance",
    );
    let toolModelRequest = 0;
    const toolRuntime = await createDefaultNativeRuntime({
      env,
      cwd: workspace,
      args,
      tools: toolRegistry,
      model: {
        run: async (_request, context) => {
          toolModelRequest += 1;
          if (toolModelRequest === 1) {
            await context.emit?.({
              type: "tool-call",
              id: "probe-cancel-tool",
              name: "productionProbeCancellationTool",
              input: { value: "wait" },
            });
            return {
              stop: "tool",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
          return {
            stop: "complete",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });
    try {
      await toolRuntime.start();
      const running = toolRuntime.submit("cancel tool");
      await toolStarted.promise;
      await toolRuntime.cancel("production tool cancellation");
      await running;
      const idle = toolRuntime.snapshot().state === "ready";
      if (!idle) throw new Error("Native tool cancellation leaked active work");
      canonical.push({ kind: "cancellation.tool-work", data: { idle } });
    } finally {
      await stopQuietly(toolRuntime);
    }

    const compactionStarted = deferred();
    let seedRequest = 0;
    const compactionRuntime = await createDefaultNativeRuntime({
      env,
      cwd: workspace,
      args,
      tools: new ToolRegistry(),
      customization: {
        schemaVersion: 1,
        id: "production.conformance.cancellation",
        compaction: {
          summarize: async ({ signal }) => {
            compactionStarted.resolve();
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error("production compaction observed cancellation");
          },
        },
      },
      model: {
        run: async () => {
          seedRequest += 1;
          return {
            stop: "complete",
            usage: { inputTokens: seedRequest, outputTokens: 1 },
          };
        },
      },
    });
    try {
      await compactionRuntime.start();
      await compactionRuntime.submit("compaction seed");
      const compacting = compactionRuntime.execute({
        type: "context.compact",
        reason: "manual",
      });
      await compactionStarted.promise;
      const cancelled = await compactionRuntime.execute({
        type: "context.cancel-compaction",
      });
      const completed = await compacting;
      if (cancelled.ok !== true || completed.ok !== false)
        throw new Error(
          `Native compaction cancellation failed: cancel=${JSON.stringify(cancelled)} compact=${JSON.stringify(completed)}`,
        );
      canonical.push({
        kind: "compaction.cancelled",
        data: {
          reason: "manual",
          aborted: true,
          willRetry: false,
          persisted: false,
        },
      });
    } finally {
      await stopQuietly(compactionRuntime);
    }

    let stoppedModelCalls = 0;
    const stoppedRuntime = await createDefaultNativeRuntime({
      env,
      cwd: workspace,
      args,
      tools: new ToolRegistry(),
      model: {
        run: async () => {
          stoppedModelCalls += 1;
          return {
            stop: "complete",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });
    await stoppedRuntime.start();
    await stoppedRuntime.stop();
    const rejected = await stoppedRuntime
      .submit("must not reach provider")
      .then(() => false, () => true);
    if (!rejected || stoppedModelCalls !== 0)
      throw new Error(
        `Native pre-submit cancellation failed: rejected=${rejected} modelCalls=${stoppedModelCalls}`,
      );
    canonical.push({
      kind: "cancellation.before-submit",
      data: {
        enforced: true,
        sdkCallAvoided: true,
        boundary: "production-probe-adapter",
      },
    });

    return {
      source: "native-production-composition" as const,
      events: canonical,
      effects: [],
      observations: [
        {
          kind: "native.cancellation-proof",
          data: {
            modelIdle: true,
            toolIdle: true,
            compactionCancelled: true,
            stoppedSubmitRejected: true,
          },
        },
      ],
    };
  };
}

function failureTool(
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name: "productionProbeFailureTool",
    label: "Production failure tool",
    description: "Production conformance tool-failure driver.",
    schemaVersion: 1,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    outputSchema: { type: "object" },
    outputVersion: 1,
    policy: {
      effects: createEffectSet("read"),
      trust: "none",
      approval: "never",
      plan: "allowed",
    },
    presentation: {
      callLabel: "Failure tool",
      resultLabel: "Failure tool result",
    },
    execute,
  };
}

function oneToolCallModel(
  callId: string,
  input: unknown,
  onRequest?: (request: number) => void,
): ModelPort {
  let request = 0;
  return {
    run: async (_modelRequest, context) => {
      request += 1;
      onRequest?.(request);
      if (request === 1) {
        await context.emit?.({
          type: "tool-call",
          id: callId,
          name: "productionProbeFailureTool",
          input,
        });
        return {
          stop: "tool",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return {
        stop: "complete",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

async function driveNativeToolFailure(options: {
  root: string;
  id: string;
  input: unknown;
  execute: ToolDefinition["execute"];
}): Promise<{ events: RuntimeEvent[]; executions: number; idle: boolean }> {
  const home = path.join(options.root, `${options.id}-home`);
  const workspace = path.join(options.root, `${options.id}-workspace`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(
    failureTool(async (request) => {
      executions += 1;
      return await options.execute(request);
    }),
    "production-conformance",
  );
  const runtime = await createDefaultNativeRuntime({
    env: { OCTOCODE_HOME: home },
    cwd: workspace,
    args: parseNativeArgs(["--mode", "json", "--no-session"]),
    tools: registry,
    model: oneToolCallModel(options.id, options.input),
  });
  const events: RuntimeEvent[] = [];
  const unsubscribe = runtime.subscribe((event) => events.push(event));
  try {
    await runtime.start();
    await runtime.submit(`exercise ${options.id}`);
    return {
      events,
      executions,
      idle: runtime.snapshot().state === "ready",
    };
  } finally {
    unsubscribe();
    await stopQuietly(runtime);
  }
}

/**
 * Drives schema, executor, and session-commit failures through the production
 * runtime boundaries. The persistence fault wraps the real native session
 * projector and rejects exactly the tool-result transaction; earlier durable
 * entries and the backing projection remain inspectable.
 */
export function createNativeToolFailureProbe(root: string): ProductionScenarioProbe {
  return async ({ scenario }) => {
    if (scenario.id !== "tool-failure-matrix")
      throw new Error(`Unexpected native tool-failure scenario: ${scenario.id}`);

    const before = await driveNativeToolFailure({
      root,
      id: "probe-invalid",
      input: {},
      execute: async () => ({ ok: true, content: {}, detailsVersion: 1 }),
    });
    const beforeBlocked = before.events.find(
      (event) =>
        event.type === "tool.blocked" &&
        (event.payload as { callId?: unknown }).callId === "probe-invalid",
    );
    if (
      before.executions !== 0 ||
      !before.idle ||
      (beforeBlocked?.payload as { category?: unknown } | undefined)?.category !==
        "validation"
    )
      throw new Error(
        `Native schema failure did not stop before execution: executions=${before.executions} idle=${before.idle}`,
      );

    const during = await driveNativeToolFailure({
      root,
      id: "probe-throw",
      input: { value: "throw" },
      execute: async () => {
        throw new Error("production probe tool execution failed");
      },
    });
    const duringEnded = during.events.find(
      (event) =>
        event.type === "tool.ended" &&
        (event.payload as { callId?: unknown }).callId === "probe-throw",
    );
    if (
      during.executions !== 1 ||
      !during.idle ||
      (duringEnded?.payload as { outcome?: unknown } | undefined)?.outcome !==
        "error" ||
      (duringEnded?.payload as { category?: unknown } | undefined)?.category !==
        "tool-execution"
    )
      throw new Error(
        `Native executor failure was not classified: executions=${during.executions} idle=${during.idle}`,
      );

    const backing = new InMemorySessionStore();
    const persistenceSessionId = sessionId("production:tool-result-persistence");
    let toolResultCommitAttempted = false;
    const sessions: SessionStore = {
      load: (id) => backing.load(id),
      append: async (id, expectedRevision, events) => {
        const toolResult = events.some(
          ({ event }) =>
            event.type === "message.appended" && event.role === "tool",
        );
        if (toolResult) {
          toolResultCommitAttempted = true;
          throw new Error("production probe result persistence failure");
        }
        return await backing.append(id, expectedRevision, events);
      },
    };
    const persistedEvents: RuntimeEvent[] = [];
    const persist = createRuntimeEventPersister({
      sessions,
      activeSessionId: persistenceSessionId,
      initialRevision: revision("0"),
    });
    let persistenceExecutions = 0;
    let modelRequests = 0;
    const persistenceRegistry = new ToolRegistry();
    persistenceRegistry.register(
      failureTool(async () => {
        persistenceExecutions += 1;
        return {
          ok: true,
          content: { value: "persist" },
          detailsVersion: 1,
        };
      }),
      "production-conformance",
    );
    const persistenceRuntime = createRuntimeKernel({
      sessionId: persistenceSessionId,
      cwd: path.join(root, "persistence-workspace"),
      mode: "json",
      tools: persistenceRegistry,
      model: oneToolCallModel("probe-persist", { value: "persist" }, () => {
        modelRequests += 1;
      }),
      emit: async (event) => {
        persistedEvents.push(event);
        return await persist(event);
      },
    });
    let promptRejected = false;
    try {
      await persistenceRuntime.start();
      await persistenceRuntime
        .submit("fail result persistence")
        .catch(() => {
          promptRejected = true;
        });
    } finally {
      await persistenceRuntime.stop().catch(() => undefined);
    }
    const projection = await backing.load(persistenceSessionId);
    const persistedToolResult = projection.events.some(
      (entry: SessionEvent) =>
        entry.event.type === "message.appended" && entry.event.role === "tool",
    );
    const persistenceWasClassified = persistedEvents.some(
      (event) =>
        event.type === "tool.ended" &&
        (event.payload as { callId?: unknown; outcome?: unknown }).callId ===
          "probe-persist" &&
        (event.payload as { outcome?: unknown }).outcome === "error",
    );
    if (
      !toolResultCommitAttempted ||
      persistedToolResult ||
      persistenceExecutions !== 1 ||
      modelRequests !== 2 ||
      promptRejected ||
      !persistenceWasClassified
    )
      throw new Error(
        `Native result-persistence fault missed its commit boundary: attempted=${toolResultCommitAttempted} persisted=${persistedToolResult} executions=${persistenceExecutions} modelRequests=${modelRequests} rejected=${promptRejected} classified=${persistenceWasClassified}`,
      );

    return {
      source: "native-production-composition" as const,
      events: [
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
      ],
      effects: [],
      observations: [
        {
          kind: "native.tool-failure-proof",
          data: {
            beforeExecutorCalls: before.executions,
            duringExecutorCalls: during.executions,
            persistenceExecutorCalls: persistenceExecutions,
            toolResultCommitAttempted,
            persistedToolResult,
            promptRejected,
          },
        },
      ],
    };
  };
}
