import { randomUUID } from "node:crypto";
import {
  correlationId,
  createEffectSet,
  packetId,
  workerId,
  type JsonSchema,
  type SessionId,
  type ToolDefinition,
  type ToolExecutionInput,
  type ToolRegistry,
  type WorkerCapabilities,
  type WorkerAuthorityV1,
  type WorkerCommand,
  type WorkerController,
  type WorkerId,
  type WorkerPacket,
  type WorkerSpawnPacket,
  type WorkerTerminalPacket,
} from "@octocodeai/agent-core";
import type {
  NativePlanWorkerOwnershipPort,
  PlanScope,
} from "./native-plan.js";
import type { NativeWorkerDagSchedulerPort } from "./native-worker-dag-scheduler.js";
import {
  assertNativeWorkerAuthorityContext,
  mintNativeWorkerAuthority,
  requireNativeWorkerAdmission,
} from "./native-worker-authority.js";

const MAX_TASK_CHARS = 16_384;
const MAX_TEXT_CHARS = 8_192;
const MAX_REASON_CHARS = 512;
const MAX_ID_CHARS = 128;
const MAX_REVISION_CHARS = 256;
const MAX_TOOLS = 32;
const MAX_TURNS = 100;
const MAX_PUBLIC_HANDBACK_CHARS = 16_384;

type WorkerAction =
  | "spawn"
  | "schedule"
  | "list"
  | "status"
  | "wait"
  | "send"
  | "steer"
  | "follow-up"
  | "abort"
  | "kill";
type ModelRef = { readonly providerId: string; readonly modelId: string };
type WorkspaceInput =
  | { readonly mode: "shared" }
  | {
      readonly mode: "worktree";
      readonly baseRevision: string;
    };

export interface NativeWorkerToolOptions {
  readonly controller: WorkerController;
  /** Immutable identity of the base prompt/configuration used by every worker spawned by this tool instance. */
  readonly promptSnapshotId: string;
  readonly allowedTools?: readonly string[];
  readonly defaultTools?: readonly string[];
  readonly allowedOctocodeTools?: readonly string[];
  readonly allowedModels?: readonly ModelRef[];
  readonly defaultModel?: ModelRef;
  readonly defaultMaxTurns?: number;
  readonly maxWaitMs?: number;
  /** Worktrees are rejected unless the native host explicitly declares support here. */
  readonly allowWorktree?: boolean;
  readonly resolveWorktree?: (request: {
    readonly workerId: WorkerId;
    readonly sessionId: SessionId;
    readonly baseRevision: string;
  }) => Extract<WorkerSpawnPacket["workspace"], { mode: "worktree" }>;
  /** Test seam. Generated values remain internal and are never accepted from model input. */
  readonly idFactory?: () => string;
  /** Optional native-plan bridge. Shared Awareness ownership remains independent. */
  readonly planOwnership?: NativePlanWorkerOwnershipPort;
  /** Runs a complete plan DAG inside this admitted worker-tool lifecycle. */
  readonly dependencyScheduler?: NativeWorkerDagSchedulerPort;
}

interface WorkerBinding {
  readonly workerId: WorkerId;
  readonly correlationId: ReturnType<typeof correlationId>;
  readonly sessionId: SessionId;
  readonly authority: WorkerAuthorityV1;
  readonly planStepId?: string;
  ownershipStatus?: "active" | "released";
}

interface ParsedInput {
  readonly action: WorkerAction;
  readonly workerId?: string;
  readonly task?: string;
  readonly taskLabel?: string;
  readonly text?: string;
  readonly reason?: string;
  readonly timeoutMs?: number;
  readonly tools?: readonly string[];
  readonly octocodeTools?: readonly string[];
  readonly model?: ModelRef;
  readonly maxTurns?: number;
  readonly workspace?: WorkspaceInput;
  readonly planStepId?: string;
  readonly maxParallel?: number;
}

class NativeWorkerToolError extends Error {
  constructor(
    readonly category:
      "validation" | "not-found" | "timeout" | "cancelled" | "worker",
    message: string,
  ) {
    super(message);
  }
}

const stringSchema = (maxLength: number, minLength = 1): JsonSchema => ({
  type: "string",
  minLength,
  maxLength,
});
const modelSchema: JsonSchema = {
  type: "object",
  properties: {
    providerId: stringSchema(MAX_ID_CHARS),
    modelId: stringSchema(MAX_ID_CHARS),
  },
  required: ["providerId", "modelId"],
  additionalProperties: false,
};
const workspaceSchema: JsonSchema = {
  oneOf: [
    {
      type: "object",
      properties: { mode: { const: "shared" } },
      required: ["mode"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        mode: { const: "worktree" },
        baseRevision: stringSchema(MAX_REVISION_CHARS),
      },
      required: ["mode", "baseRevision"],
      additionalProperties: false,
    },
  ],
};

const branch = (
  action: WorkerAction,
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema => ({
  type: "object",
  properties: { action: { const: action }, ...properties },
  required: ["action", ...required],
  additionalProperties: false,
});

export const NATIVE_WORKER_INPUT_SCHEMA: JsonSchema = {
  oneOf: [
    branch(
      "spawn",
      {
        task: stringSchema(MAX_TASK_CHARS),
        taskLabel: stringSchema(MAX_ID_CHARS),
        tools: {
          type: "array",
          items: stringSchema(MAX_ID_CHARS),
          maxItems: MAX_TOOLS,
          uniqueItems: true,
        },
        octocodeTools: {
          type: "array",
          items: stringSchema(MAX_ID_CHARS),
          maxItems: MAX_TOOLS,
          uniqueItems: true,
        },
        model: modelSchema,
        maxTurns: { type: "integer", minimum: 1, maximum: MAX_TURNS },
        workspace: workspaceSchema,
        planStepId: stringSchema(MAX_ID_CHARS),
      },
      ["task"],
    ),
    branch(
      "schedule",
      {
        tools: {
          type: "array",
          items: stringSchema(MAX_ID_CHARS),
          maxItems: MAX_TOOLS,
          uniqueItems: true,
        },
        octocodeTools: {
          type: "array",
          items: stringSchema(MAX_ID_CHARS),
          maxItems: MAX_TOOLS,
          uniqueItems: true,
        },
        model: modelSchema,
        maxTurns: { type: "integer", minimum: 1, maximum: MAX_TURNS },
        maxParallel: { type: "integer", minimum: 1, maximum: 4 },
        workspace: workspaceSchema,
      },
      [],
    ),
    branch("list", {}, []),
    branch("status", { workerId: stringSchema(MAX_ID_CHARS) }, ["workerId"]),
    branch(
      "wait",
      {
        workerId: stringSchema(MAX_ID_CHARS),
        timeoutMs: { type: "integer", minimum: 1 },
      },
      ["workerId"],
    ),
    branch(
      "send",
      {
        workerId: stringSchema(MAX_ID_CHARS),
        text: stringSchema(MAX_TEXT_CHARS),
      },
      ["workerId", "text"],
    ),
    branch(
      "steer",
      {
        workerId: stringSchema(MAX_ID_CHARS),
        text: stringSchema(MAX_TEXT_CHARS),
      },
      ["workerId", "text"],
    ),
    branch(
      "follow-up",
      {
        workerId: stringSchema(MAX_ID_CHARS),
        text: stringSchema(MAX_TEXT_CHARS),
      },
      ["workerId", "text"],
    ),
    branch(
      "abort",
      {
        workerId: stringSchema(MAX_ID_CHARS),
        reason: stringSchema(MAX_REASON_CHARS),
      },
      ["workerId"],
    ),
    branch(
      "kill",
      {
        workerId: stringSchema(MAX_ID_CHARS),
        reason: stringSchema(MAX_REASON_CHARS),
      },
      ["workerId"],
    ),
  ],
};

const publicWorkerSchema: JsonSchema = {
  type: "object",
  properties: {
    workerId: { type: "string" },
    correlationId: { type: "string" },
    state: { type: "string" },
    queueDepth: { type: "integer" },
    planStepId: { type: "string" },
    ownershipStatus: { type: "string", enum: ["active", "released"] },
    terminal: {
      type: "object",
      properties: {
        outcome: { type: "string" },
        hasHandback: { type: "boolean" },
        hasReason: { type: "boolean" },
        handback: {
          type: "object",
          properties: {
            summary: { type: "string", maxLength: MAX_PUBLIC_HANDBACK_CHARS },
            text: { type: "string", maxLength: MAX_PUBLIC_HANDBACK_CHARS },
            truncated: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["outcome", "hasHandback", "hasReason"],
      additionalProperties: false,
    },
  },
  required: ["workerId", "correlationId", "state", "queueDepth"],
  additionalProperties: false,
};

export const NATIVE_WORKER_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    action: { type: "string" },
    worker: { anyOf: [publicWorkerSchema, { type: "null" }] },
    workers: { type: "array", items: publicWorkerSchema },
    acknowledged: { type: "boolean" },
    schedule: {
      type: "object",
      properties: {
        graphId: stringSchema(512),
        state: { type: "string", enum: ["succeeded", "failed"] },
        items: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            properties: {
              itemId: stringSchema(512),
              state: {
                type: "string",
                enum: ["pending", "claimed", "succeeded", "failed", "blocked"],
              },
              workerId: stringSchema(512),
            },
            required: ["itemId", "state"],
            additionalProperties: false,
          },
        },
      },
      required: ["graphId", "state", "items"],
      additionalProperties: false,
    },
  },
  required: ["action"],
  additionalProperties: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    throw new NativeWorkerToolError(
      "validation",
      `${name} must contain 1-${max} characters`,
    );
  return value;
}

function integer(value: unknown, name: string, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > max
  )
    throw new NativeWorkerToolError(
      "validation",
      `${name} must be an integer from 1 to ${max}`,
    );
  return value as number;
}

function assertOnly(
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unknown !== undefined)
    throw new NativeWorkerToolError("validation", `Unknown field: ${unknown}`);
}

function parseWorkspace(
  value: unknown,
  allowWorktree: boolean,
): WorkspaceInput {
  if (!isRecord(value))
    throw new NativeWorkerToolError(
      "validation",
      "workspace must be an object",
    );
  if (value["mode"] === "shared") {
    assertOnly(value, ["mode"]);
    return { mode: "shared" };
  }
  if (value["mode"] !== "worktree")
    throw new NativeWorkerToolError("validation", "workspace mode is invalid");
  if (!allowWorktree)
    throw new NativeWorkerToolError(
      "validation",
      "Worktree worker isolation is unavailable",
    );
  assertOnly(value, ["mode", "baseRevision"]);
  return {
    mode: "worktree",
    baseRevision: boundedString(
      value["baseRevision"],
      "workspace.baseRevision",
      MAX_REVISION_CHARS,
    ),
  };
}

function parseInput(
  value: unknown,
  options: { allowWorktree: boolean; maxWaitMs: number },
): ParsedInput {
  if (!isRecord(value))
    throw new NativeWorkerToolError(
      "validation",
      "Worker input must be an object",
    );
  const action = value["action"];
  if (
    action !== "spawn" &&
    action !== "schedule" &&
    action !== "list" &&
    action !== "status" &&
    action !== "wait" &&
    action !== "send" &&
    action !== "steer" &&
    action !== "follow-up" &&
    action !== "abort" &&
    action !== "kill"
  ) {
    throw new NativeWorkerToolError("validation", "Worker action is invalid");
  }
  if (action === "list") {
    assertOnly(value, ["action"]);
    return { action };
  }
  if (action === "spawn" || action === "schedule") {
    assertOnly(value, [
      "action",
      "tools",
      "octocodeTools",
      "model",
      "maxTurns",
      "workspace",
      ...(action === "spawn"
        ? ["task", "taskLabel", "planStepId"]
        : ["maxParallel"]),
    ]);
    let tools: readonly string[] | undefined;
    if (value["tools"] !== undefined) {
      if (!Array.isArray(value["tools"]) || value["tools"].length > MAX_TOOLS)
        throw new NativeWorkerToolError(
          "validation",
          `tools must contain at most ${MAX_TOOLS} entries`,
        );
      tools = value["tools"].map((tool) =>
        boundedString(tool, "tool", MAX_ID_CHARS),
      );
      if (new Set(tools).size !== tools.length)
        throw new NativeWorkerToolError("validation", "tools must be unique");
    }
    let octocodeTools: readonly string[] | undefined;
    if (value["octocodeTools"] !== undefined) {
      if (
        !Array.isArray(value["octocodeTools"]) ||
        value["octocodeTools"].length > MAX_TOOLS
      )
        throw new NativeWorkerToolError(
          "validation",
          `octocodeTools must contain at most ${MAX_TOOLS} entries`,
        );
      octocodeTools = value["octocodeTools"].map((tool) =>
        boundedString(tool, "octocodeTool", MAX_ID_CHARS),
      );
      if (new Set(octocodeTools).size !== octocodeTools.length)
        throw new NativeWorkerToolError(
          "validation",
          "octocodeTools must be unique",
        );
    }
    let model: ModelRef | undefined;
    if (value["model"] !== undefined) {
      if (!isRecord(value["model"]))
        throw new NativeWorkerToolError(
          "validation",
          "model must be an object",
        );
      assertOnly(value["model"], ["providerId", "modelId"]);
      model = {
        providerId: boundedString(
          value["model"]["providerId"],
          "model.providerId",
          MAX_ID_CHARS,
        ),
        modelId: boundedString(
          value["model"]["modelId"],
          "model.modelId",
          MAX_ID_CHARS,
        ),
      };
    }
    return {
      action,
      ...(action !== "spawn"
        ? {}
        : { task: boundedString(value["task"], "task", MAX_TASK_CHARS) }),
      ...(action !== "spawn" || value["taskLabel"] === undefined
        ? {}
        : {
            taskLabel: boundedString(
              value["taskLabel"],
              "taskLabel",
              MAX_ID_CHARS,
            ),
          }),
      ...(tools === undefined ? {} : { tools }),
      ...(octocodeTools === undefined ? {} : { octocodeTools }),
      ...(model === undefined ? {} : { model }),
      ...(value["maxTurns"] === undefined
        ? {}
        : { maxTurns: integer(value["maxTurns"], "maxTurns", MAX_TURNS) }),
      ...(value["workspace"] === undefined
        ? {}
        : {
            workspace: parseWorkspace(
              value["workspace"],
              options.allowWorktree,
            ),
          }),
      ...(action !== "spawn" || value["planStepId"] === undefined
        ? {}
        : {
            planStepId: boundedString(
              value["planStepId"],
              "planStepId",
              MAX_ID_CHARS,
            ),
          }),
      ...(action !== "schedule"
        ? {}
        : {
            maxParallel:
              value["maxParallel"] === undefined
                ? 4
                : integer(value["maxParallel"], "maxParallel", 4),
          }),
    };
  }
  const worker = boundedString(value["workerId"], "workerId", MAX_ID_CHARS);
  if (action === "status") {
    assertOnly(value, ["action", "workerId"]);
    return { action, workerId: worker };
  }
  if (action === "wait") {
    assertOnly(value, ["action", "workerId", "timeoutMs"]);
    return {
      action,
      workerId: worker,
      ...(value["timeoutMs"] === undefined
        ? {}
        : {
            timeoutMs: integer(
              value["timeoutMs"],
              "timeoutMs",
              options.maxWaitMs,
            ),
          }),
    };
  }
  if (action === "send" || action === "steer" || action === "follow-up") {
    assertOnly(value, ["action", "workerId", "text"]);
    return {
      action,
      workerId: worker,
      text: boundedString(value["text"], "text", MAX_TEXT_CHARS),
    };
  }
  assertOnly(value, ["action", "workerId", "reason"]);
  return {
    action,
    workerId: worker,
    ...(value["reason"] === undefined
      ? {}
      : { reason: boundedString(value["reason"], "reason", MAX_REASON_CHARS) }),
  };
}

function publicHandback(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const summary =
    typeof value["summary"] === "string" ? value["summary"] : undefined;
  const text = typeof value["text"] === "string" ? value["text"] : undefined;
  if (summary === undefined && text === undefined) return undefined;
  let remaining = MAX_PUBLIC_HANDBACK_CHARS;
  const publicSummary = summary?.slice(0, remaining);
  remaining -= publicSummary?.length ?? 0;
  const publicText = text?.slice(0, remaining);
  const truncated =
    (summary?.length ?? 0) + (text?.length ?? 0) > MAX_PUBLIC_HANDBACK_CHARS;
  return {
    ...(publicSummary === undefined ? {} : { summary: publicSummary }),
    ...(publicText === undefined ? {} : { text: publicText }),
    ...(truncated ? { truncated: true } : {}),
  };
}

function publicTerminal(value: WorkerTerminalPacket): Record<string, unknown> {
  const handback = publicHandback(value.handback);
  return {
    outcome: value.outcome,
    hasHandback: value.handback !== undefined,
    hasReason: value.reason !== undefined,
    ...(handback === undefined ? {} : { handback }),
  };
}

function publicWorker(
  value: unknown,
  binding?: WorkerBinding,
): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    typeof value["workerId"] !== "string" ||
    typeof value["correlationId"] !== "string" ||
    typeof value["state"] !== "string" ||
    !Number.isInteger(value["queueDepth"])
  )
    return null;
  const terminal =
    isRecord(value["terminal"]) &&
    value["terminal"]["type"] === "worker.terminal"
      ? publicTerminal(value["terminal"] as unknown as WorkerTerminalPacket)
      : undefined;
  return {
    workerId: value["workerId"],
    correlationId: value["correlationId"],
    state: value["state"],
    queueDepth: value["queueDepth"],
    ...(binding?.planStepId === undefined
      ? {}
      : {
          planStepId: binding.planStepId,
          ownershipStatus: binding.ownershipStatus,
        }),
    ...(terminal === undefined ? {} : { terminal }),
  };
}

function publicTerminalWorker(
  value: unknown,
  binding?: WorkerBinding,
): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    value["type"] !== "worker.terminal" ||
    typeof value["workerId"] !== "string" ||
    typeof value["correlationId"] !== "string" ||
    typeof value["outcome"] !== "string"
  )
    return null;
  return {
    workerId: value["workerId"],
    correlationId: value["correlationId"],
    state: value["outcome"],
    queueDepth: 0,
    ...(binding?.planStepId === undefined
      ? {}
      : {
          planStepId: binding.planStepId,
          ownershipStatus: binding.ownershipStatus,
        }),
    terminal: publicTerminal(value as unknown as WorkerTerminalPacket),
  };
}

function waitBounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(
        new NativeWorkerToolError("cancelled", "Worker operation cancelled"),
      );
      return;
    }
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new NativeWorkerToolError(
              "timeout",
              `Worker wait timed out after ${timeoutMs}ms`,
            ),
          ),
        ),
      timeoutMs,
    );
    const onAbort = (): void =>
      finish(() =>
        reject(
          new NativeWorkerToolError("cancelled", "Worker operation cancelled"),
        ),
      );
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      () =>
        finish(() =>
          reject(
            new NativeWorkerToolError("worker", "Worker operation failed"),
          ),
        ),
    );
  });
}

export function createNativeWorkerTool(
  options: NativeWorkerToolOptions,
): ToolDefinition {
  const promptSnapshotId = boundedString(
    options.promptSnapshotId,
    "promptSnapshotId",
    512,
  );
  const idFactory = options.idFactory ?? randomUUID;
  const allowedTools = new Set(options.allowedTools ?? []);
  const allowedOctocodeTools =
    options.allowedOctocodeTools === undefined
      ? undefined
      : new Set(options.allowedOctocodeTools);
  const allowedModels = new Set(
    (options.allowedModels ?? []).map(
      (model) => `${model.providerId}\0${model.modelId}`,
    ),
  );
  const defaultTools = [...(options.defaultTools ?? [])];
  const defaultModel =
    options.defaultModel === undefined
      ? undefined
      : { ...options.defaultModel };
  const defaultMaxTurns = integer(
    options.defaultMaxTurns ?? 16,
    "defaultMaxTurns",
    MAX_TURNS,
  );
  const maxWaitMs = integer(
    options.maxWaitMs ?? 300_000,
    "maxWaitMs",
    3_600_000,
  );
  for (const tool of defaultTools)
    if (!allowedTools.has(tool))
      throw new NativeWorkerToolError(
        "validation",
        `Default tool is not allowed: ${tool}`,
      );
  if (
    defaultModel !== undefined &&
    !allowedModels.has(`${defaultModel.providerId}\0${defaultModel.modelId}`)
  )
    throw new NativeWorkerToolError(
      "validation",
      "Default model is not allowed",
    );
  const bindings = new Map<string, WorkerBinding>();

  const resolveWorkspace = (
    workspace: WorkspaceInput | undefined,
    id: WorkerId,
    session: SessionId,
  ): WorkerSpawnPacket["workspace"] => {
    if (workspace === undefined || workspace.mode === "shared")
      return { mode: "shared" };
    if (options.resolveWorktree === undefined)
      throw new NativeWorkerToolError(
        "validation",
        "Host-owned worktree resolution is unavailable",
      );
    const resolved = options.resolveWorktree({
      workerId: id,
      sessionId: session,
      baseRevision: workspace.baseRevision,
    });
    if (
      resolved.mode !== "worktree" ||
      resolved.path.trim().length === 0 ||
      resolved.baseRevision.trim().length === 0
    )
      throw new NativeWorkerToolError(
        "validation",
        "Host-owned worktree resolution returned an invalid identity",
      );
    return Object.freeze({ ...resolved });
  };

  const planScope = (request: ToolExecutionInput): PlanScope => ({
    sessionId: String(request.context.sessionId),
    workspace: request.context.cwd,
  });
  const releaseOwnership = async (
    binding: WorkerBinding,
    request: ToolExecutionInput,
  ): Promise<void> => {
    if (
      binding.planStepId === undefined ||
      binding.ownershipStatus !== "active" ||
      options.planOwnership === undefined
    )
      return;
    await options.planOwnership.release({
      scope: planScope(request),
      planStepId: binding.planStepId,
      workerId: binding.workerId,
      signal: request.signal,
    });
    binding.ownershipStatus = "released";
  };

  const requireBinding = (id: string, session: SessionId): WorkerBinding => {
    const binding = bindings.get(id);
    if (binding === undefined || binding.sessionId !== session)
      throw new NativeWorkerToolError(
        "not-found",
        "Worker not found in this session",
      );
    return binding;
  };

  const execute = async (
    request: ToolExecutionInput,
  ): Promise<Record<string, unknown>> => {
    const admission = requireNativeWorkerAdmission(request.context.admission);
    const input = parseInput(request.input, {
      allowWorktree: options.allowWorktree === true,
      maxWaitMs,
    });
    await request.update({
      version: 1,
      kind: "status",
      message: `Worker ${input.action}`,
    });
    if (input.action === "schedule") {
      if (options.dependencyScheduler === undefined)
        throw new NativeWorkerToolError(
          "validation",
          "Native dependency scheduling is unavailable",
        );
      const tools = input.tools ?? defaultTools;
      for (const tool of tools)
        if (!allowedTools.has(tool))
          throw new NativeWorkerToolError(
            "validation",
            `Tool is not allowed: ${tool}`,
          );
      if (tools.includes("worker"))
        throw new NativeWorkerToolError(
          "validation",
          "Scheduled children cannot receive the worker tool",
        );
      if (input.octocodeTools !== undefined && !tools.includes("octocode"))
        throw new NativeWorkerToolError(
          "validation",
          "octocodeTools requires the octocode facade",
        );
      if (allowedOctocodeTools !== undefined)
        for (const tool of input.octocodeTools ?? [])
          if (!allowedOctocodeTools.has(tool))
            throw new NativeWorkerToolError(
              "validation",
              `Octocode tool is not allowed: ${tool}`,
            );
      const model = input.model ?? defaultModel;
      if (
        model !== undefined &&
        !allowedModels.has(`${model.providerId}\0${model.modelId}`)
      )
        throw new NativeWorkerToolError("validation", "Model is not allowed");
      const capabilities: WorkerCapabilities = {
        tools: [...tools],
        ...(input.octocodeTools === undefined
          ? {}
          : { octocodeTools: [...input.octocodeTools] }),
        models: model === undefined ? [] : [{ ...model }],
        maxTurns: input.maxTurns ?? defaultMaxTurns,
      };
      try {
        const schedule = await options.dependencyScheduler.run({
          scope: planScope(request),
          maxParallel: input.maxParallel ?? 4,
          signal: request.signal,
          packet: (step, generatedWorkerId) => {
            const scheduledWorkerId = workerId(generatedWorkerId);
            const scheduledCorrelationId = correlationId(idFactory());
            const authority = mintNativeWorkerAuthority({
              admission,
              sessionId: request.context.sessionId,
              workerId: scheduledWorkerId,
              correlationId: scheduledCorrelationId,
              capabilities,
              planStepId: step.itemId,
            });
            return Object.freeze({
              schemaVersion: 1,
              type: "worker.spawn",
              packetId: packetId(idFactory()),
              workerId: scheduledWorkerId,
              correlationId: scheduledCorrelationId,
              sessionId: request.context.sessionId,
              redaction: "sensitive",
              authority,
              prompt: step.prompt,
              promptSnapshotId,
              workspace: resolveWorkspace(
                input.workspace,
                scheduledWorkerId,
                request.context.sessionId,
              ),
              capabilities: Object.freeze({
                ...capabilities,
                tools: Object.freeze([...capabilities.tools]),
                ...(capabilities.octocodeTools === undefined
                  ? {}
                  : {
                      octocodeTools: Object.freeze([
                        ...capabilities.octocodeTools,
                      ]),
                    }),
                models: Object.freeze(
                  capabilities.models.map((item) => Object.freeze({ ...item })),
                ),
              }),
              presentation: Object.freeze({ planStepId: step.itemId }),
            });
          },
        });
        return { action: "schedule", schedule };
      } catch (error) {
        if (error instanceof NativeWorkerToolError) throw error;
        throw new NativeWorkerToolError(
          "worker",
          "Worker dependency schedule failed",
        );
      }
    }
    if (input.action === "spawn") {
      if (input.planStepId !== undefined && options.planOwnership === undefined)
        throw new NativeWorkerToolError(
          "validation",
          "Native plan-step ownership is unavailable",
        );
      const tools = input.tools ?? defaultTools;
      for (const tool of tools)
        if (!allowedTools.has(tool))
          throw new NativeWorkerToolError(
            "validation",
            `Tool is not allowed: ${tool}`,
          );
      if (input.octocodeTools !== undefined && !tools.includes("octocode"))
        throw new NativeWorkerToolError(
          "validation",
          "octocodeTools requires the octocode facade",
        );
      if (allowedOctocodeTools !== undefined)
        for (const tool of input.octocodeTools ?? [])
          if (!allowedOctocodeTools.has(tool))
            throw new NativeWorkerToolError(
              "validation",
              `Octocode tool is not allowed: ${tool}`,
            );
      const model = input.model ?? defaultModel;
      if (
        model !== undefined &&
        !allowedModels.has(`${model.providerId}\0${model.modelId}`)
      )
        throw new NativeWorkerToolError("validation", "Model is not allowed");
      const spawnedWorkerId = workerId(idFactory());
      const spawnedCorrelationId = correlationId(idFactory());
      const capabilities: WorkerCapabilities = {
        tools: [...tools],
        ...(input.octocodeTools === undefined
          ? {}
          : { octocodeTools: [...input.octocodeTools] }),
        models: model === undefined ? [] : [{ ...model }],
        maxTurns: input.maxTurns ?? defaultMaxTurns,
      };
      const authority = mintNativeWorkerAuthority({
        admission,
        sessionId: request.context.sessionId,
        workerId: spawnedWorkerId,
        correlationId: spawnedCorrelationId,
        capabilities,
        ...(input.planStepId === undefined
          ? {}
          : { planStepId: input.planStepId }),
      });
      const binding: WorkerBinding = {
        workerId: spawnedWorkerId,
        correlationId: spawnedCorrelationId,
        sessionId: request.context.sessionId,
        authority,
        ...(input.planStepId === undefined
          ? {}
          : {
              planStepId: input.planStepId,
              ownershipStatus: "active" as const,
            }),
      };
      const packet: WorkerSpawnPacket = Object.freeze({
        schemaVersion: 1,
        type: "worker.spawn",
        packetId: packetId(idFactory()),
        workerId: binding.workerId,
        correlationId: binding.correlationId,
        sessionId: binding.sessionId,
        redaction: "sensitive",
        authority,
        prompt: input.task!,
        promptSnapshotId,
        workspace: resolveWorkspace(
          input.workspace,
          binding.workerId,
          binding.sessionId,
        ),
        capabilities: Object.freeze({
          ...capabilities,
          tools: Object.freeze([...capabilities.tools]),
          ...(capabilities.octocodeTools === undefined
            ? {}
            : {
                octocodeTools: Object.freeze([...capabilities.octocodeTools]),
              }),
          models: Object.freeze(
            capabilities.models.map((item) => Object.freeze({ ...item })),
          ),
        }),
        ...(binding.planStepId === undefined && input.taskLabel === undefined
          ? {}
          : {
              presentation: Object.freeze({
                ...(binding.planStepId === undefined
                  ? {}
                  : { planStepId: binding.planStepId }),
                ...(input.taskLabel === undefined
                  ? {}
                  : { taskLabel: input.taskLabel }),
              }),
            }),
      });
      if (binding.planStepId !== undefined) {
        try {
          await options.planOwnership!.claim({
            scope: planScope(request),
            planStepId: binding.planStepId,
            workerId: binding.workerId,
            signal: request.signal,
          });
        } catch {
          throw new NativeWorkerToolError(
            "validation",
            `Plan step ${binding.planStepId} cannot be claimed`,
          );
        }
      }
      bindings.set(binding.workerId, binding);
      try {
        const result = await options.controller.execute({
          type: "spawn",
          packet,
        });
        return {
          action: "spawn",
          worker: publicWorker(result, binding) ?? {
            workerId: binding.workerId,
            correlationId: binding.correlationId,
            state: "queued",
            queueDepth: 0,
            ...(binding.planStepId === undefined
              ? {}
              : {
                  planStepId: binding.planStepId,
                  ownershipStatus: binding.ownershipStatus,
                }),
          },
        };
      } catch {
        try {
          await releaseOwnership(binding, request);
        } catch {
          /* retain the primary spawn failure */
        }
        bindings.delete(binding.workerId);
        throw new NativeWorkerToolError("worker", "Worker spawn failed");
      }
    }
    if (input.action === "list") {
      let result: unknown;
      try {
        result = await options.controller.execute({ type: "list" });
      } catch {
        throw new NativeWorkerToolError("worker", "Worker list failed");
      }
      const visible = Array.isArray(result)
        ? result.filter(
            (item) =>
              isRecord(item) &&
              typeof item["workerId"] === "string" &&
              bindings.get(item["workerId"])?.sessionId ===
                request.context.sessionId,
          )
        : [];
      for (const item of visible) {
        const binding = bindings.get(
          (item as Record<string, unknown>)["workerId"] as string,
        )!;
        if (isRecord((item as Record<string, unknown>)["terminal"]))
          await releaseOwnership(binding, request);
      }
      const workers = visible
        .map((item) =>
          publicWorker(
            item,
            bindings.get(
              (item as Record<string, unknown>)["workerId"] as string,
            ),
          ),
        )
        .filter((item): item is Record<string, unknown> => item !== null);
      return { action: "list", workers };
    }
    const binding = requireBinding(input.workerId!, request.context.sessionId);
    assertNativeWorkerAuthorityContext(
      binding.authority,
      admission,
      request.context.sessionId,
    );
    let command: WorkerCommand;
    if (
      input.action === "send" ||
      input.action === "steer" ||
      input.action === "follow-up"
    ) {
      const packet: WorkerPacket = Object.freeze({
        schemaVersion: 1,
        type: `worker.${input.action}`,
        packetId: packetId(idFactory()),
        workerId: binding.workerId,
        correlationId: binding.correlationId,
        sessionId: binding.sessionId,
        redaction: "sensitive",
        authority: binding.authority,
        text: input.text!,
      });
      command = { type: input.action, packet };
    } else if (input.action === "status" || input.action === "wait")
      command = {
        type: input.action,
        workerId: binding.workerId,
        authority: binding.authority,
      };
    else
      command = {
        type: input.action,
        workerId: binding.workerId,
        authority: binding.authority,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      };
    try {
      const operation = options.controller.execute(command);
      const result =
        input.action === "wait"
          ? await waitBounded(
              operation,
              input.timeoutMs ?? maxWaitMs,
              request.signal,
            )
          : await operation;
      if (input.action === "status") {
        if (isRecord(result) && isRecord(result["terminal"]))
          await releaseOwnership(binding, request);
        return { action: input.action, worker: publicWorker(result, binding) };
      }
      if (input.action === "wait") {
        if (isRecord(result) && result["type"] === "worker.terminal")
          await releaseOwnership(binding, request);
        return {
          action: input.action,
          worker: publicTerminalWorker(result, binding),
        };
      }
      if (input.action === "abort" || input.action === "kill")
        await releaseOwnership(binding, request);
      return { action: input.action, acknowledged: true };
    } catch (error) {
      if (error instanceof NativeWorkerToolError) throw error;
      throw new NativeWorkerToolError(
        "worker",
        `Worker ${input.action} failed`,
      );
    }
  };

  return {
    name: "worker",
    label: "Worker",
    description:
      "Root-only native worker lifecycle. Run the active plan as a dependency schedule or spawn parallel leaf children, then send, steer, wait, abort, or kill them. Children never receive this tool and cannot create subagents.",
    schemaVersion: 1,
    inputSchema: NATIVE_WORKER_INPUT_SCHEMA,
    outputSchema: NATIVE_WORKER_OUTPUT_SCHEMA,
    outputVersion: 1,
    policy: {
      effects: createEffectSet("network", "process"),
      trust: "workspace",
      approval: "on-request",
      plan: "allowed",
      concurrency: (input) => {
        const action = (input as ParsedInput).action;
        return action === "send" || action === "steer" || action === "follow-up"
          ? undefined
          : { lane: "native-worker", maxActive: 4 };
      },
      resolve: (input) => {
        const action = (input as ParsedInput).action;
        return action === "list" || action === "status" || action === "wait"
          ? {
              effects: createEffectSet("read"),
              trust: "none",
              approval: "never",
            }
          : {
              effects: createEffectSet("network", "process"),
              trust: "workspace",
              approval: "on-request",
            };
      },
    },
    presentation: { callLabel: "Worker action", resultLabel: "Worker result" },
    async execute(request) {
      const content = await execute(request);
      return { ok: true, content, detailsVersion: 1 };
    },
  };
}

export function registerNativeWorkerTool(
  registry: ToolRegistry,
  options: NativeWorkerToolOptions,
): ToolDefinition {
  const tool = createNativeWorkerTool(options);
  registry.register(tool, "native-worker");
  return tool;
}
