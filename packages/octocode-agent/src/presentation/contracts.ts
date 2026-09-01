import type {
  RuntimeUserInputV1,
  UiInteractionRequest,
  UiInteractionResult,
  UiInteractionWorkflowStep,
} from "@octocodeai/agent-core";
import {
  MAX_UI_INTERACTION_OPTIONS,
  MAX_UI_INTERACTION_TEXT,
  MAX_UI_WORKFLOW_STEPS,
} from "@octocodeai/agent-core";

import type { RuntimePlanSnapshot } from "../native-plan.js";
import type { NativeWorkerInboxSnapshot } from "../native-worker-operations-snapshot.js";

export type NativePresentationNotificationSeverity =
  "info" | "success" | "warning" | "error";
export type NativePresentationMessageRole =
  "system" | "user" | "assistant" | "tool";
export type NativePresentationMessageStatus =
  "streaming" | "complete" | "cancelled" | "error";
export type NativePresentationWorkingState =
  "idle" | "active" | "cancelling" | "failed";
export type NativePresentationWorkerState =
  "queued" | "running" | "succeeded" | "failed" | "aborted" | "killed";

export interface NativePresentationWorkerUpdate {
  readonly workerId: string;
  readonly agentType?: string;
  readonly state: NativePresentationWorkerState;
  readonly active?: number;
  readonly queued?: number;
  readonly maxActive?: number;
  readonly planStepId?: string;
  readonly taskLabel?: string;
  readonly timestamp: number;
}

export interface NativePresentationChromeUpdate {
  readonly authority: "runtime";
  readonly title: string;
  readonly sessionId?: string;
  readonly modelId?: string;
  readonly version?: string;
  readonly trust: "trusted" | "untrusted" | "unknown";
}

type NativePresentationWorkflowAware = {
  readonly workflow?: UiInteractionWorkflowStep;
};

export type NativePresentationInteractionRequest =
  | ({
      readonly type: "confirm";
      readonly message: string;
    } & NativePresentationWorkflowAware)
  | ({
      readonly type: "select";
      readonly message: string;
      readonly options: readonly string[];
    } & NativePresentationWorkflowAware)
  | ({
      readonly type: "input";
      readonly message: string;
      readonly initial?: string;
    } & NativePresentationWorkflowAware)
  | ({
      readonly type: "editor";
      readonly message: string;
      readonly initial: string;
    } & NativePresentationWorkflowAware);

const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function interactionText(
  value: unknown,
  max = MAX_UI_INTERACTION_TEXT,
): string | undefined {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max
    ? value
    : undefined;
}

function interactionWorkflow(
  value: unknown,
): UiInteractionWorkflowStep | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.workflowId !== "string" ||
    !INTERACTION_ID.test(record.workflowId) ||
    typeof record.questionId !== "string" ||
    !INTERACTION_ID.test(record.questionId) ||
    !Number.isSafeInteger(record.index) ||
    !Number.isSafeInteger(record.total) ||
    (record.index as number) < 0 ||
    (record.total as number) < 1 ||
    (record.total as number) > MAX_UI_WORKFLOW_STEPS ||
    (record.index as number) >= (record.total as number) ||
    typeof record.allowDiscuss !== "boolean"
  )
    return undefined;
  const title =
    record.title === undefined ? undefined : interactionText(record.title, 256);
  const instructions =
    record.instructions === undefined
      ? undefined
      : interactionText(record.instructions, 2_048);
  if (
    (record.title !== undefined && title === undefined) ||
    (record.instructions !== undefined && instructions === undefined)
  )
    return undefined;
  return Object.freeze({
    workflowId: record.workflowId,
    questionId: record.questionId,
    index: record.index as number,
    total: record.total as number,
    ...(title === undefined ? {} : { title }),
    ...(instructions === undefined ? {} : { instructions }),
    allowDiscuss: record.allowDiscuss,
  });
}

/** Strict decoder at the renderer-neutral interaction boundary. */
export function parseNativePresentationInteractionRequest(
  value: unknown,
): NativePresentationInteractionRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const message = interactionText(record.message);
  if (message === undefined) return undefined;
  const workflow =
    record.workflow === undefined
      ? undefined
      : interactionWorkflow(record.workflow);
  if (record.workflow !== undefined && workflow === undefined) return undefined;
  const common = { message, ...(workflow === undefined ? {} : { workflow }) };
  if (record.type === "confirm")
    return Object.freeze({ type: "confirm", ...common });
  if (record.type === "select") {
    if (
      !Array.isArray(record.options) ||
      record.options.length < 1 ||
      record.options.length > MAX_UI_INTERACTION_OPTIONS
    )
      return undefined;
    const options = record.options.map((option) => interactionText(option));
    if (options.some((option) => option === undefined)) return undefined;
    return Object.freeze({
      type: "select",
      ...common,
      options: Object.freeze(options as string[]),
    });
  }
  if (record.type === "input") {
    if (record.initial !== undefined && typeof record.initial !== "string")
      return undefined;
    if (
      typeof record.initial === "string" &&
      record.initial.length > MAX_UI_INTERACTION_TEXT
    )
      return undefined;
    return Object.freeze({
      type: "input",
      ...common,
      ...(record.initial === undefined
        ? {}
        : { initial: record.initial as string }),
    });
  }
  if (record.type === "editor") {
    if (
      typeof record.initial !== "string" ||
      record.initial.length > MAX_UI_INTERACTION_TEXT
    )
      return undefined;
    return Object.freeze({
      type: "editor",
      ...common,
      initial: record.initial,
    });
  }
  return undefined;
}

export type NativePresentationWidget =
  | { readonly id: string; readonly kind: "text"; readonly text: string }
  | {
      readonly id: string;
      readonly kind: "list";
      readonly title?: string;
      readonly items: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "key-value";
      readonly title?: string;
      readonly rows: readonly {
        readonly label: string;
        readonly value: string;
      }[];
    }
  | {
      readonly id: string;
      readonly kind: "progress";
      readonly label: string;
      readonly current: number;
      readonly total?: number;
    };

export type NativePresentationWidgetUpdate =
  NativePresentationWidget | { readonly id: string; readonly remove: true };

/** Renderer-neutral semantic events accepted by every interactive presentation adapter. */
export type NativePresentationEvent =
  | { type: "runtime-ready" }
  | { type: "runtime-stopping" }
  | { type: "runtime-failed" }
  | { type: "context-cleared" }
  | { type: "chrome-changed"; chrome: NativePresentationChromeUpdate }
  | { type: "turn-started"; turnId: string }
  | {
      type: "turn-ended";
      turnId: string;
      outcome: "completed" | "cancelled" | "error";
    }
  | {
      type: "input-received";
      text: string;
      messageId?: string;
      turnId?: string;
    }
  | { type: "user-message"; text: string; messageId?: string; turnId?: string }
  | {
      type: "message-started";
      messageId: string;
      role: NativePresentationMessageRole;
      turnId?: string;
    }
  | {
      type: "message-delta";
      text: string;
      messageId?: string;
      role?: NativePresentationMessageRole;
      turnId?: string;
      segment?: "text" | "thinking";
    }
  | {
      type: "message-ended";
      messageId: string;
      status?: NativePresentationMessageStatus;
    }
  | {
      type: "tool-prepared";
      callId: string;
      name: string;
      turnId?: string;
      input?: string;
    }
  | {
      type: "tool-requested";
      callId: string;
      name: string;
      turnId?: string;
      input?: string;
    }
  | { type: "tool-started"; callId: string; name: string; turnId?: string }
  | {
      type: "tool-progress";
      callId: string;
      name?: string;
      message?: string;
      current?: number;
      total?: number;
    }
  | {
      type: "tool-updated";
      callId: string;
      name?: string;
      message?: string;
      current?: number;
      total?: number;
    }
  | { type: "tool-result"; callId: string; name: string; result?: string }
  | {
      type: "tool-ended";
      callId: string;
      name: string;
      result?: string;
      error?: string;
      category?: string;
    }
  | {
      type: "tool-failed";
      callId: string;
      name: string;
      message: string;
      category?: string;
    }
  | {
      type: "tool-blocked";
      callId: string;
      name: string;
      message: string;
      category?: string;
    }
  | { type: "tool-cancelled"; callId: string; name: string; message?: string }
  | { type: "interaction-handler-state"; ready: boolean }
  | {
      type: "interaction-requested";
      request: NativePresentationInteractionRequest;
    }
  | { type: "interaction-validation"; message: string }
  | {
      type: "interaction-resolved";
      result:
        | { status: "accepted"; value: string | boolean }
        | { status: "discuss" | "cancelled" | "timeout" | "unsupported" };
    }
  | { type: "plan-changed"; plan: RuntimePlanSnapshot | null }
  | { type: "worker-changed"; worker: NativePresentationWorkerUpdate }
  | { type: "worker-inbox-changed"; inbox: NativeWorkerInboxSnapshot }
  | { type: "status-changed"; name: string; text?: string }
  | {
      type: "notification";
      severity: NativePresentationNotificationSeverity;
      message: string;
    }
  | {
      type: "presentation-changed";
      property: "working";
      value: NativePresentationWorkingState;
    }
  | {
      type: "presentation-changed";
      property: "widget";
      value: NativePresentationWidgetUpdate;
    };

export type NativePresentationInputOwnership = "renderer" | "external";

export type NativePresentationInputEvent =
  | { readonly type: "line"; readonly line: string }
  | { readonly type: "input"; readonly input: RuntimeUserInputV1 }
  | { readonly type: "interrupt" };

export interface NativePresentationSnapshot {
  readonly working: NativePresentationWorkingState;
}

/** Host-side port owned by orchestration and implemented by a concrete renderer adapter. */
export interface NativeInteractivePresentationPort {
  readonly inputOwnership: NativePresentationInputOwnership;
  start(): Promise<void>;
  accept(event: NativePresentationEvent): void;
  interact?(
    request: UiInteractionRequest,
    signal: AbortSignal,
  ): Promise<UiInteractionResult>;
  acceptInput?(line: string): boolean;
  subscribeInput?(
    listener: (event: NativePresentationInputEvent) => void | Promise<void>,
  ): () => void;
  subscribeFailure?(listener: (error: unknown) => void): () => void;
  cancelInteraction?(): boolean;
  snapshot(): NativePresentationSnapshot;
  stop(): Promise<void>;
}
