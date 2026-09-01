/**
 * Native interactive terminal adapter. Toolkit-facing shapes are private to this
 * directory so agent-core contracts remain semantic and terminal-neutral.
 */
import type {
  RuntimeUserInputV1,
  UiPort,
  UiInteractionRequest,
  UiInteractionResult,
} from "@octocodeai/agent-core";
import { NATIVE_DESIGN_CONTENT } from "../../presentation/design/tokens.js";
import type { NativeWorkerInboxSnapshot } from "../../native-worker-operations-snapshot.js";

import type {
  NativeInteractivePresentationPort,
  NativePresentationChromeUpdate,
  NativePresentationEvent,
  NativePresentationInputOwnership,
  NativePresentationInteractionRequest,
  NativePresentationMessageRole,
  NativePresentationMessageStatus,
  NativePresentationNotificationSeverity,
  NativePresentationWidget,
  NativePresentationWorkingState,
} from "../../presentation/contracts.js";
import { parseNativePresentationInteractionRequest } from "../../presentation/contracts.js";
import type {
  FooterConnectionState,
  FooterSnapshot,
} from "./widgets/footer.js";
import type { HeaderSnapshot } from "./widgets/header.js";
import type { PlanWidgetSnapshot } from "./widgets/plan.js";
import type { StatusNotificationInput } from "./widgets/status-notifications.js";

export type PresentationToolStatus =
  "pending" | "running" | "success" | "error" | "blocked" | "cancelled";

export interface PresentationChromeFacts extends NativePresentationChromeUpdate {
  readonly connection: FooterConnectionState;
}

export const MAX_PRESENTATION_MESSAGES = 200;
export const MAX_PRESENTATION_TOOLS = 100;
export const MAX_PRESENTATION_TURNS = 100;
export const MAX_PRESENTATION_TEXT = 16_000;
export const MAX_PRESENTATION_SECTION = 32_000;

export interface PresentationMessage {
  readonly id: string;
  readonly role: NativePresentationMessageRole;
  readonly turnId?: string;
  readonly status: NativePresentationMessageStatus;
  readonly segments: readonly {
    readonly kind: "text" | "thinking";
    readonly text: string;
  }[];
}

export interface PresentationToolRow {
  readonly callId: string;
  readonly name: string;
  readonly turnId?: string;
  readonly status: PresentationToolStatus;
  readonly input?: string;
  readonly progress?: {
    readonly message?: string;
    readonly current?: number;
    readonly total?: number;
  };
  readonly result?: string;
  readonly error?: { readonly message: string; readonly category?: string };
}

export interface PresentationTurn {
  readonly id: string;
  readonly status: "active" | "completed" | "cancelled" | "error";
}

export interface PresentationInteraction {
  /** Monotonic identity used to discard stale rendered interaction instances. */
  readonly generation: number;
  readonly request: NativePresentationInteractionRequest;
  readonly status:
    | "pending"
    | "validation"
    | "accepted"
    | "discuss"
    | "cancelled"
    | "timeout"
    | "unsupported";
  readonly validation?: string;
  readonly value?: string | boolean;
}

/** Runtime-owned semantic widget state. Display strings are deliberately excluded. */
export interface RuntimeWidgetState {
  readonly plan?: PlanWidgetSnapshot;
  readonly statusNotifications?: readonly StatusNotificationInput[];
}

export interface RuntimeWidgetSnapshots {
  /** `null` explicitly clears a previously projected plan; omission preserves it. */
  readonly plan?: PlanWidgetSnapshot | null;
  readonly statusNotifications?: readonly StatusNotificationInput[];
}

function copyPlanSnapshot(snapshot: PlanWidgetSnapshot): PlanWidgetSnapshot {
  return {
    ...snapshot,
    scope: { ...snapshot.scope },
    steps: snapshot.steps.map((step) => ({
      ...step,
      ...(step.dependsOn === undefined ? {} : { dependsOn: [...step.dependsOn] }),
      ...(step.receipt === undefined ? {} : { receipt: { ...step.receipt } }),
    })),
  };
}

function copyStatusNotification(
  snapshot: StatusNotificationInput,
): StatusNotificationInput {
  return {
    ...snapshot,
    ...(snapshot.action === undefined ? {} : { action: { ...snapshot.action } }),
  };
}

function copyWorkerInboxSnapshot(
  snapshot: NativeWorkerInboxSnapshot,
): NativeWorkerInboxSnapshot {
  return {
    ...snapshot,
    workers: snapshot.workers.map((worker) => ({
      ...worker,
      availableActions: [...worker.availableActions],
    })),
  };
}

export interface PresentationState {
  readonly ready: boolean;
  readonly working: NativePresentationWorkingState;
  readonly chrome?: PresentationChromeFacts;
  readonly activeTurnId?: string;
  readonly turns: readonly PresentationTurn[];
  readonly messages: readonly PresentationMessage[];
  readonly tools: readonly PresentationToolRow[];
  readonly workers: readonly PresentationWorkerRow[];
  readonly workerInbox?: NativeWorkerInboxSnapshot;
  readonly statuses: Readonly<Record<string, string>>;
  readonly notifications: readonly {
    severity: NativePresentationNotificationSeverity;
    message: string;
  }[];
  readonly widgets: Readonly<Record<string, NativePresentationWidget>>;
  readonly interactionHandler: "required" | "ready";
  readonly interaction?: PresentationInteraction;
  readonly runtimeWidgets?: RuntimeWidgetState;
}

export interface PresentationWorkerRow {
  readonly workerId: string;
  readonly agentType?: string;
  readonly state:
    "queued" | "running" | "succeeded" | "failed" | "aborted" | "killed";
  readonly active?: number;
  readonly queued?: number;
  readonly maxActive?: number;
  readonly planStepId?: string;
  readonly taskLabel?: string;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
}

export type PresentationEvent =
  | NativePresentationEvent
  | { type: "runtime-widgets-changed"; snapshots: RuntimeWidgetSnapshots };

/** Private renderer facade; concrete OpenTUI values never leave this module. */
export interface OpenTuiSemanticAnnouncement {
  readonly source: string;
  readonly politeness: "polite" | "assertive";
  readonly text: string;
}

export interface OpenTuiRendererFacade {
  render(state: PresentationState): void;
  /** Complete linear terminal output; this is an alternate-output seam, not an ARIA implementation. */
  alternateOutput?(): string;
  /** Drains semantic terminal announcements for tests and alternate-output hosts. */
  drainAnnouncements?(): readonly OpenTuiSemanticAnnouncement[];
  destroy(): void | Promise<void>;
}

export interface OpenTuiRendererEvents {
  readonly submitInput: (input: RuntimeUserInputV1) => void;
  readonly inputValidation?: (message: string) => void;
  readonly resolveInteraction: (
    generation: number,
    result: UiInteractionResult,
  ) => void;
  readonly interrupt: () => void;
  readonly failure?: (error: unknown) => void;
}

export interface OpenTuiTerminalDependencies<TStore> {
  createRenderer: (
    events: OpenTuiRendererEvents,
    store: TStore,
  ) => Promise<OpenTuiRendererFacade>;
  readonly inputOwnership?: NativePresentationInputOwnership;
}

export interface OpenTuiTerminal extends NativeInteractivePresentationPort {
  accept(event: PresentationEvent): void;
  snapshot(): PresentationState;
}

export function createInitialPresentationState(): PresentationState {
  return {
    ready: false,
    working: "idle",
    turns: [],
    messages: [],
    tools: [],
    workers: [],
    statuses: {},
    notifications: [],
    widgets: {},
    interactionHandler: "required",
  };
}

export function projectPresentationChrome(
  state: PresentationState,
  viewportWidth: number,
):
  | { readonly header: HeaderSnapshot; readonly footer: FooterSnapshot }
  | undefined {
  const chrome = state.chrome;
  if (chrome === undefined) return undefined;
  const interactionActive =
    state.interaction?.status === "pending" ||
    state.interaction?.status === "validation";
  const interactionType = interactionActive
    ? state.interaction?.request.type
    : undefined;
  const baseKeyHints =
    interactionType === "confirm"
      ? [
          { key: "Enter", label: "Choose", priority: 1 },
          { key: "Esc/Ctrl-C", label: "Cancel", priority: 2 },
          { key: "Tab", label: "Move choice", priority: 3 },
        ]
      : interactionType === "select"
        ? [
            { key: "Enter", label: "Choose", priority: 1 },
            { key: "Esc/Ctrl-C", label: "Cancel", priority: 2 },
            { key: "↑/↓", label: "Move choice", priority: 3 },
          ]
        : interactionType === "input"
          ? [
              { key: "Enter", label: "Submit", priority: 1 },
              { key: "Esc/Ctrl-C", label: "Cancel", priority: 2 },
            ]
          : interactionType === "editor"
            ? [
                { key: "Meta-Enter", label: "Submit", priority: 1 },
                { key: "Esc/Ctrl-C", label: "Cancel", priority: 2 },
              ]
            : state.working === "active"
              ? [
                  { key: "Enter", label: "Follow up", priority: 1 },
                  { key: "Esc/Ctrl-C", label: "Cancel turn", priority: 2 },
                  { key: "/steer", label: "Redirect", priority: 3 },
                  { key: "Tab", label: "Inspect activity", priority: 4 },
                ]
              : [
                  { key: "Enter", label: "Send", priority: 1 },
                  { key: "Ctrl-C", label: "Exit", priority: 2 },
                  { key: "Tab", label: "Inspect activity", priority: 3 },
                  { key: "/", label: "Commands", priority: 4 },
                  { key: "@", label: "Files", priority: 5 },
                ];
  const keyHints =
    state.interaction?.request.workflow?.allowDiscuss === true &&
    interactionActive
      ? [
          ...baseKeyHints.filter(({ key }) => key !== "Esc/Ctrl-C"),
          { key: "Ctrl-D", label: "Discuss", priority: 2 },
          ...baseKeyHints.filter(({ key }) => key === "Esc/Ctrl-C"),
        ]
      : baseKeyHints;
  const approvalRequired =
    state.runtimeWidgets?.statusNotifications?.some(
      ({ slot, lifecycle }) => slot === "permission" && lifecycle === "active",
    ) === true;
  const blocked = state.tools.some(({ status }) => status === "blocked");
  const failure =
    state.working === "failed" ||
    state.tools.some(({ status }) => status === "error") ||
    state.workers.some(
      ({ state: workerState }) =>
        workerState === "failed" || workerState === "killed",
    );
  const activeWorkers = state.workers.filter(
    ({ state: workerState }) => workerState === "running",
  ).length;
  const workerAggregate = state.workers.reduce<
    PresentationWorkerRow | undefined
  >(
    (latest, worker) =>
      worker.maxActive === undefined ||
      (latest !== undefined && latest.updatedAtMs > worker.updatedAtMs)
        ? latest
        : worker,
    undefined,
  );
  const activeTools = state.tools.filter(
    ({ status }) => status === "pending" || status === "running",
  ).length;
  const plan = state.runtimeWidgets?.plan;
  const planProgress =
    plan === undefined
      ? undefined
      : `Plan ${plan.steps.filter(({ status }) => status === "done").length}/${plan.steps.length}`;
  const activityParts = [
    workerAggregate !== undefined && workerAggregate.maxActive !== undefined
      ? `${workerAggregate.active ?? activeWorkers}/${workerAggregate.maxActive} subagent${(workerAggregate.active ?? activeWorkers) === 1 ? "" : "s"} active`
      : activeWorkers > 0
        ? `${activeWorkers} subagent${activeWorkers === 1 ? "" : "s"}`
        : undefined,
    (workerAggregate?.queued ?? 0) > 0
      ? `${workerAggregate!.queued} queued`
      : undefined,
    activeTools > 0
      ? `${activeTools} tool${activeTools === 1 ? "" : "s"} running`
      : undefined,
    planProgress,
    state.statuses["context.compaction"] === undefined
      ? undefined
      : "Compacting context",
  ].filter((value): value is string => value !== undefined);
  const activitySummary = approvalRequired
    ? { text: "Approval required", tone: "warning" as const }
    : failure
      ? { text: "Action failed · inspect Activity", tone: "error" as const }
      : blocked
        ? {
            text: "Action blocked · inspect Activity",
            tone: "warning" as const,
          }
        : activityParts.length > 0
          ? { text: activityParts.join(" · "), tone: "info" as const }
          : undefined;
  return {
    header: {
      authority: chrome.authority,
      title: chrome.title,
      ...(chrome.sessionId === undefined
        ? {}
        : { sessionId: chrome.sessionId }),
      ...(chrome.modelId === undefined ? {} : { modelId: chrome.modelId }),
      ...(chrome.version === undefined ? {} : { version: chrome.version }),
      trust: chrome.trust,
      working: state.working,
      width: Math.min(10_000, Math.max(1, viewportWidth)),
    },
    footer: {
      authority: chrome.authority,
      activeMode: interactionActive ? "respond" : "chat",
      connection: chrome.connection,
      widthColumns: Math.min(1_000, Math.max(20, viewportWidth)),
      keyHints,
      ...(activitySummary === undefined ? {} : { activitySummary }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function widgetId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : undefined;
}

function optionalTitle(value: unknown): string | undefined | false {
  return value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : false;
}

export function parsePresentationWidget(
  value: unknown,
):
  | NativePresentationWidget
  | { readonly id: string; readonly remove: true }
  | undefined {
  if (!isRecord(value)) return undefined;
  const id = widgetId(value.id);
  if (!id) return undefined;
  if (value.remove === true) return { id, remove: true };
  const title = optionalTitle(value.title);
  if (title === false) return undefined;
  switch (value.kind) {
    case "text":
      return typeof value.text === "string"
        ? { id, kind: "text", text: value.text }
        : undefined;
    case "list":
      return Array.isArray(value.items) &&
        value.items.length <= 100 &&
        value.items.every((item) => typeof item === "string")
        ? {
            id,
            kind: "list",
            ...(title === undefined ? {} : { title }),
            items: [...value.items],
          }
        : undefined;
    case "key-value": {
      if (!Array.isArray(value.rows) || value.rows.length > 100)
        return undefined;
      const rows = value.rows.map((row) =>
        isRecord(row) &&
        typeof row.label === "string" &&
        typeof row.value === "string"
          ? { label: row.label, value: row.value }
          : undefined,
      );
      return rows.every((row) => row !== undefined)
        ? {
            id,
            kind: "key-value",
            ...(title === undefined ? {} : { title }),
            rows: rows as { label: string; value: string }[],
          }
        : undefined;
    }
    case "progress": {
      if (
        typeof value.label !== "string" ||
        !Number.isFinite(value.current) ||
        (value.current as number) < 0
      )
        return undefined;
      if (
        value.total !== undefined &&
        (!Number.isFinite(value.total) ||
          (value.total as number) <= 0 ||
          (value.current as number) > (value.total as number))
      )
        return undefined;
      return {
        id,
        kind: "progress",
        label: value.label,
        current: value.current as number,
        ...(value.total === undefined ? {} : { total: value.total as number }),
      };
    }
    default:
      return undefined;
  }
}

function boundedText(text: string): string {
  return text.length <= MAX_PRESENTATION_TEXT
    ? text
    : text.slice(-MAX_PRESENTATION_TEXT);
}

function replaceMessage(
  state: PresentationState,
  message: PresentationMessage,
): PresentationState {
  const existing = state.messages.findIndex(({ id }) => id === message.id);
  const messages =
    existing < 0
      ? [...state.messages, message].slice(-MAX_PRESENTATION_MESSAGES)
      : state.messages.map((item, index) =>
          index === existing ? message : item,
        );
  return { ...state, messages };
}

function startMessage(
  state: PresentationState,
  message: Omit<PresentationMessage, "segments">,
): PresentationState {
  const existing = state.messages.find(({ id }) => id === message.id);
  return replaceMessage(state, {
    ...message,
    segments: existing?.segments ?? [],
  });
}

function appendMessageSegment(
  state: PresentationState,
  event: Extract<PresentationEvent, { type: "message-delta" }>,
): PresentationState {
  const messageId =
    event.messageId ??
    [...state.messages]
      .reverse()
      .find(
        ({ role, status, turnId }) =>
          role === "assistant" &&
          status === "streaming" &&
          turnId === (event.turnId ?? state.activeTurnId),
      )?.id ??
    `assistant:${event.turnId ?? state.activeTurnId ?? "unscoped"}`;
  const existing = state.messages.find(({ id }) => id === messageId);
  const kind = event.segment ?? "text";
  const previousSegments = existing?.segments ?? [];
  const last = previousSegments.at(-1);
  const segments =
    last?.kind === kind
      ? [
          ...previousSegments.slice(0, -1),
          { kind, text: boundedText(last.text + event.text) },
        ]
      : [...previousSegments, { kind, text: boundedText(event.text) }];
  return replaceMessage(state, {
    id: messageId,
    role: event.role ?? existing?.role ?? "assistant",
    ...((event.turnId ?? existing?.turnId ?? state.activeTurnId) === undefined
      ? {}
      : { turnId: event.turnId ?? existing?.turnId ?? state.activeTurnId }),
    status: "streaming",
    segments,
  });
}

function replaceTool(
  state: PresentationState,
  row: PresentationToolRow,
): PresentationState {
  const existing = state.tools.findIndex(({ callId }) => callId === row.callId);
  const tools =
    existing < 0
      ? [...state.tools, row].slice(-MAX_PRESENTATION_TOOLS)
      : state.tools.map((item, index) => (index === existing ? row : item));
  return { ...state, tools };
}

function updateTool(
  state: PresentationState,
  callId: string,
  name: string | undefined,
  update: Partial<PresentationToolRow>,
): PresentationState {
  const existing = state.tools.find(
    ({ callId: candidate }) => candidate === callId,
  );
  return replaceTool(state, {
    callId,
    name: name ?? existing?.name ?? "tool",
    ...((existing?.turnId ?? state.activeTurnId) === undefined
      ? {}
      : { turnId: existing?.turnId ?? state.activeTurnId }),
    status: existing?.status ?? "pending",
    ...existing,
    ...update,
  });
}

export function reducePresentation(
  state: PresentationState,
  event: PresentationEvent,
): PresentationState {
  switch (event.type) {
    case "context-cleared":
      return {
        ...state,
        working: "idle",
        activeTurnId: undefined,
        statuses: Object.fromEntries(
          Object.entries(state.statuses).filter(
            ([name]) => name !== "context.usage",
          ),
        ),
        interaction: undefined,
      };
    case "runtime-ready":
      return {
        ...state,
        ready: true,
        working: "idle",
        ...(state.chrome === undefined
          ? {}
          : { chrome: { ...state.chrome, connection: "connected" as const } }),
      };
    case "runtime-stopping":
      return {
        ...state,
        working: "cancelling",
        ...(state.chrome === undefined
          ? {}
          : { chrome: { ...state.chrome, connection: "connecting" as const } }),
      };
    case "runtime-failed":
      return {
        ...state,
        working: "failed",
        ...(state.chrome === undefined
          ? {}
          : { chrome: { ...state.chrome, connection: "error" as const } }),
      };
    case "chrome-changed":
      return {
        ...state,
        chrome: {
          ...event.chrome,
          connection:
            state.chrome?.connection ??
            (state.working === "failed"
              ? "error"
              : state.ready
                ? "connected"
                : "connecting"),
        },
      };
    case "turn-started": {
      const turns = [
        ...state.turns.filter(({ id }) => id !== event.turnId),
        { id: event.turnId, status: "active" as const },
      ].slice(-MAX_PRESENTATION_TURNS);
      let pendingUserIndex = -1;
      for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        const message = state.messages[index];
        if (message?.role === "user" && message.turnId === undefined) {
          pendingUserIndex = index;
          break;
        }
      }
      const messages =
        pendingUserIndex < 0
          ? state.messages
          : state.messages.map((message, index) =>
              index === pendingUserIndex
                ? { ...message, turnId: event.turnId }
                : message,
            );
      return {
        ...state,
        activeTurnId: event.turnId,
        turns,
        messages,
        working: "active",
      };
    }
    case "turn-ended": {
      const turns = state.turns.some(({ id }) => id === event.turnId)
        ? state.turns.map((turn) =>
            turn.id === event.turnId
              ? { ...turn, status: event.outcome }
              : turn,
          )
        : [...state.turns, { id: event.turnId, status: event.outcome }].slice(
            -MAX_PRESENTATION_TURNS,
          );
      return {
        ...state,
        activeTurnId:
          state.activeTurnId === event.turnId ? undefined : state.activeTurnId,
        turns,
        working: state.working === "failed" ? "failed" : "idle",
      };
    }
    case "input-received":
    case "user-message": {
      const turnId = event.turnId ?? state.activeTurnId;
      return replaceMessage(state, {
        id: event.messageId ?? `user:${turnId ?? state.messages.length + 1}`,
        role: "user",
        ...(turnId === undefined ? {} : { turnId }),
        status: "complete",
        segments: [{ kind: "text", text: boundedText(event.text) }],
      });
    }
    case "message-started":
      return startMessage(state, {
        id: event.messageId,
        role: event.role,
        ...((event.turnId ?? state.activeTurnId) === undefined
          ? {}
          : { turnId: event.turnId ?? state.activeTurnId }),
        status: "streaming",
      });
    case "message-delta":
      return appendMessageSegment(state, event);
    case "message-ended": {
      const message = state.messages.find(({ id }) => id === event.messageId);
      return message === undefined
        ? state
        : replaceMessage(state, {
            ...message,
            status: event.status ?? "complete",
          });
    }
    case "tool-prepared":
    case "tool-requested":
      return replaceTool(state, {
        callId: event.callId,
        name: event.name,
        ...((event.turnId ?? state.activeTurnId) === undefined
          ? {}
          : { turnId: event.turnId ?? state.activeTurnId }),
        status: "pending",
        ...(event.input === undefined
          ? {}
          : { input: boundedText(event.input) }),
      });
    case "tool-started":
      return updateTool(state, event.callId, event.name, { status: "running" });
    case "tool-progress":
    case "tool-updated":
      return updateTool(state, event.callId, event.name, {
        status: "running",
        progress: {
          ...(event.message === undefined
            ? {}
            : { message: boundedText(event.message) }),
          ...(Number.isFinite(event.current) ? { current: event.current } : {}),
          ...(Number.isFinite(event.total) ? { total: event.total } : {}),
        },
      });
    case "tool-result":
      return updateTool(state, event.callId, event.name, {
        status: "success",
        ...(event.result === undefined
          ? {}
          : { result: boundedText(event.result) }),
      });
    case "tool-ended":
      if (
        state.tools.find(({ callId }) => callId === event.callId)?.status ===
        "blocked"
      )
        return state;
      return event.error === undefined
        ? updateTool(state, event.callId, event.name, {
            status: "success",
            ...(event.result === undefined
              ? {}
              : { result: boundedText(event.result) }),
          })
        : updateTool(state, event.callId, event.name, {
            status: "error",
            error: {
              message: boundedText(event.error),
              ...(event.category === undefined
                ? {}
                : { category: event.category }),
            },
          });
    case "tool-failed":
      return updateTool(state, event.callId, event.name, {
        status: "error",
        error: {
          message: boundedText(event.message),
          ...(event.category === undefined ? {} : { category: event.category }),
        },
      });
    case "tool-blocked":
      return updateTool(state, event.callId, event.name, {
        status: "blocked",
        error: {
          message: boundedText(event.message),
          ...(event.category === undefined ? {} : { category: event.category }),
        },
      });
    case "tool-cancelled":
      return updateTool(state, event.callId, event.name, {
        status: "cancelled",
        ...(event.message === undefined
          ? {}
          : { error: { message: boundedText(event.message) } }),
      });
    case "interaction-handler-state": {
      const interactionHandler = event.ready ? "ready" : "required";
      return state.interactionHandler === interactionHandler
        ? state
        : { ...state, interactionHandler };
    }
    case "interaction-requested": {
      const request = parseNativePresentationInteractionRequest(event.request);
      if (request === undefined) return state;
      return {
        ...state,
        interaction: {
          generation: (state.interaction?.generation ?? 0) + 1,
          request,
          status: "pending",
        },
      };
    }
    case "interaction-validation":
      return state.interaction === undefined
        ? state
        : {
            ...state,
            interaction: {
              ...state.interaction,
              status: "validation",
              validation: event.message,
            },
          };
    case "interaction-resolved":
      return state.interaction === undefined
        ? state
        : {
            ...state,
            interaction: {
              generation: state.interaction.generation,
              request: state.interaction.request,
              status: event.result.status,
              ...(event.result.status === "accepted"
                ? { value: event.result.value }
                : {}),
            },
          };
    case "runtime-widgets-changed": {
      const runtimeWidgets: {
        plan?: PlanWidgetSnapshot;
        statusNotifications?: readonly StatusNotificationInput[];
      } = {
        ...state.runtimeWidgets,
      };
      if (event.snapshots.plan === null) delete runtimeWidgets.plan;
      else if (event.snapshots.plan !== undefined)
        runtimeWidgets.plan = copyPlanSnapshot(event.snapshots.plan);
      if (event.snapshots.statusNotifications !== undefined) {
        runtimeWidgets.statusNotifications = event.snapshots.statusNotifications.map(
          copyStatusNotification,
        );
      }
      return { ...state, runtimeWidgets };
    }
    case "plan-changed":
      return {
        ...state,
        runtimeWidgets:
          event.plan === null
            ? {
                ...(state.runtimeWidgets?.statusNotifications === undefined
                  ? {}
                  : {
                      statusNotifications:
                        state.runtimeWidgets.statusNotifications,
                    }),
              }
            : { ...state.runtimeWidgets, plan: copyPlanSnapshot(event.plan) },
      };
    case "worker-changed": {
      const existing = state.workers.find(
        ({ workerId }) => workerId === event.worker.workerId,
      );
      if (
        existing !== undefined &&
        event.worker.timestamp < existing.updatedAtMs
      )
        return state;
      if (
        existing !== undefined &&
        event.worker.timestamp === existing.updatedAtMs &&
        existing.state !== "running" &&
        event.worker.state === "running"
      )
        return state;
      const agentType = event.worker.agentType ?? existing?.agentType;
      const worker: PresentationWorkerRow = {
        workerId: event.worker.workerId,
        ...(agentType === undefined ? {} : { agentType }),
        state: event.worker.state,
        ...((event.worker.active ?? existing?.active) === undefined
          ? {}
          : { active: event.worker.active ?? existing?.active }),
        ...((event.worker.queued ?? existing?.queued) === undefined
          ? {}
          : { queued: event.worker.queued ?? existing?.queued }),
        ...((event.worker.maxActive ?? existing?.maxActive) === undefined
          ? {}
          : { maxActive: event.worker.maxActive ?? existing?.maxActive }),
        ...((event.worker.planStepId ?? existing?.planStepId) === undefined
          ? {}
          : { planStepId: event.worker.planStepId ?? existing?.planStepId }),
        ...((event.worker.taskLabel ?? existing?.taskLabel) === undefined
          ? {}
          : { taskLabel: event.worker.taskLabel ?? existing?.taskLabel }),
        startedAtMs: existing?.startedAtMs ?? event.worker.timestamp,
        updatedAtMs: Math.max(
          existing?.updatedAtMs ?? 0,
          event.worker.timestamp,
        ),
      };
      let workers =
        existing === undefined
          ? [...state.workers, worker].slice(-32)
          : state.workers.map((candidate) =>
              candidate.workerId === worker.workerId ? worker : candidate,
            );
      if (
        event.worker.active !== undefined &&
        event.worker.queued !== undefined &&
        event.worker.maxActive !== undefined
      ) {
        workers = workers.map((candidate) => ({
          ...candidate,
          active: event.worker.active,
          queued: event.worker.queued,
          maxActive: event.worker.maxActive,
        }));
      }
      return { ...state, workers };
    }
    case "worker-inbox-changed":
      if (
        state.workerInbox !== undefined &&
        event.inbox.generation < state.workerInbox.generation
      ) return state;
      return { ...state, workerInbox: copyWorkerInboxSnapshot(event.inbox) };
    case "notification":
      return {
        ...state,
        notifications: [
          ...state.notifications,
          { severity: event.severity, message: event.message },
        ].slice(-50),
      };
    case "status-changed": {
      const statuses = { ...state.statuses };
      if (event.text == null) delete statuses[event.name];
      else statuses[event.name] = event.text;
      return { ...state, statuses };
    }
    case "presentation-changed": {
      if (event.property === "working") {
        const working = event.value;
        return working === "idle" ||
          working === "active" ||
          working === "cancelling" ||
          working === "failed"
          ? { ...state, working }
          : state;
      }
      const widget = parsePresentationWidget(event.value);
      if (!widget) return state;
      const widgets = { ...state.widgets };
      if ("remove" in widget) delete widgets[widget.id];
      else widgets[widget.id] = widget;
      return { ...state, widgets };
    }
  }
  return state;
}

function formatWidget(widget: NativePresentationWidget): string {
  switch (widget.kind) {
    case "text":
      return widget.text;
    case "list":
      return [widget.title, ...widget.items.map((item) => `- ${item}`)]
        .filter((item): item is string => item !== undefined)
        .join("\n");
    case "key-value":
      return [
        widget.title,
        ...widget.rows.map((row) => `${row.label}: ${row.value}`),
      ]
        .filter((item): item is string => item !== undefined)
        .join("\n");
    case "progress":
      return `${widget.label}: ${widget.current}${widget.total === undefined ? "" : `/${widget.total}`}`;
  }
}

function boundedSection(parts: readonly string[]): string {
  const text = parts.filter(Boolean).join("\n");
  return text.length <= MAX_PRESENTATION_SECTION
    ? text
    : text.slice(-MAX_PRESENTATION_SECTION);
}

function formatMessage(message: PresentationMessage): string {
  const role =
    message.role === "user"
      ? "You"
      : message.role[0]!.toUpperCase() + message.role.slice(1);
  const content = message.segments.map((segment) =>
    segment.kind === "thinking" ? NATIVE_DESIGN_CONTENT.thinking : segment.text,
  );
  return [
    role,
    ...content,
    message.status === "complete" ? "" : `[${message.status}]`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatMessages(state: PresentationState): string {
  let previousTurnId: string | undefined;
  const parts: string[] = [];
  for (const message of state.messages) {
    if (message.turnId !== undefined && message.turnId !== previousTurnId) {
      const turn = state.turns.find(({ id }) => id === message.turnId);
      parts.push(
        `Turn ${message.turnId}${turn === undefined ? "" : ` · ${turn.status}`}`,
      );
      previousTurnId = message.turnId;
    }
    parts.push(formatMessage(message));
  }
  return boundedSection(parts);
}

function formatTool(row: PresentationToolRow): string {
  const progress =
    row.progress === undefined
      ? ""
      : [
          row.progress.message,
          row.progress.current === undefined
            ? undefined
            : `${row.progress.current}${row.progress.total === undefined ? "" : `/${row.progress.total}`}`,
        ]
          .filter((part): part is string => part !== undefined)
          .join(" · ");
  return [
    `${row.name} · ${row.status}`,
    row.input === undefined ? "" : `input: ${row.input}`,
    progress === "" ? "" : `progress: ${progress}`,
    row.result === undefined ? "" : `result: ${row.result}`,
    row.error === undefined
      ? ""
      : `${row.error.category === undefined ? "error" : row.error.category}: ${row.error.message}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatInteraction(
  interaction: PresentationInteraction | undefined,
): string {
  if (interaction === undefined) return "";
  const request = interaction.request;
  const workflow = request.workflow;
  const heading =
    workflow === undefined
      ? undefined
      : `${workflow.title ?? "Questions"} · Question ${workflow.index + 1} of ${workflow.total}`;
  const prompt = request.message;
  const options =
    request.type === "select"
      ? request.options.map((option, index) => `${index + 1}. ${option}`)
      : request.type === "confirm"
        ? ["yes / no"]
        : [];
  return [
    heading,
    prompt,
    ...options,
    workflow?.instructions,
    workflow === undefined
      ? undefined
      : `Actions: answer${workflow.allowDiscuss ? " · discuss" : ""} · cancel`,
    interaction.validation ?? "",
    interaction.status === "pending" || interaction.status === "validation"
      ? `[${interaction.status}]`
      : `[${interaction.status}]`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatWorkerInbox(inbox: NativeWorkerInboxSnapshot | undefined): string {
  if (inbox === undefined) return "";
  const selected = inbox.workers.find(({ workerId }) => workerId === inbox.selectedWorkerId) ?? inbox.workers[0];
  return [
    `Worker inbox · generation ${inbox.generation}`,
    ...inbox.workers.map((worker) => `${worker.workerId} [${worker.state}] · queue ${worker.queueDepth}`),
    ...(selected === undefined ? [] : [
      `Read-only: /workers status ${selected.workerId} ${inbox.generation}`,
      ...(selected.availableActions.includes("send") ? [`Send: /workers send ${selected.workerId} ${inbox.generation} <message>`] : []),
      ...(selected.availableActions.includes("follow-up") ? [`Follow-up: /workers follow-up ${selected.workerId} ${inbox.generation} <message>`] : []),
      ...(selected.availableActions.includes("steer") ? [`Steer: /workers steer ${selected.workerId} ${inbox.generation} <message>`] : []),
      ...(selected.availableActions.includes("abort") ? [`Graceful abort: /workers abort ${selected.workerId} ${inbox.generation} [reason]`] : []),
      ...(selected.forceKillAvailable ? [`Force kill (approval required): /workers kill ${selected.workerId} ${inbox.generation} [reason]`] : []),
    ]),
  ].join("\n");
}

export interface PresentationSections {
  readonly header: string;
  readonly messages: string;
  readonly tools: string;
  readonly sidebar: string;
  readonly editor: string;
  readonly footer: string;
}

export function formatPresentationSections(
  state: PresentationState,
): PresentationSections {
  return {
    header: boundedSection([
      "Octocode",
      state.ready ? `ready · ${state.working}` : `starting · ${state.working}`,
      `interactions · ${state.interactionHandler}`,
    ]),
    messages: formatMessages(state),
    tools: boundedSection(state.tools.map(formatTool)),
    sidebar: boundedSection([
      formatInteraction(state.interaction),
      formatWorkerInbox(state.workerInbox),
      ...Object.values(state.widgets).map(formatWidget),
      ...Object.entries(state.statuses).map(
        ([name, value]) => `${name}: ${value}`,
      ),
      ...state.notifications.map(
        (item) => `[${item.severity}] ${item.message}`,
      ),
    ]),
    editor: "",
    footer: "",
  };
}

export function formatPresentationFrame(state: PresentationState): string {
  return boundedSection(Object.values(formatPresentationSections(state)));
}

export type OpenTuiInteractionHandler = (
  request: UiInteractionRequest,
  signal: AbortSignal,
) => Promise<UiInteractionResult>;

/** Map the canonical semantic UI port onto the native terminal projection. */
export function createOpenTuiUiPort(
  terminal: OpenTuiTerminal,
  interact?: OpenTuiInteractionHandler,
): UiPort {
  const handler =
    interact ??
    terminal.interact?.bind(terminal) ??
    (async () => ({ status: "unsupported" as const }));
  terminal.accept({
    type: "interaction-handler-state",
    ready: interact !== undefined || terminal.interact !== undefined,
  });
  return {
    interact: handler,
    async notify(message, severity) {
      terminal.accept({ type: "notification", message, severity });
    },
    async setStatus(slot, text) {
      terminal.accept({ type: "status-changed", name: slot, text });
    },
    async present(command) {
      if (command.type === "working") {
        if (
          command.value === "idle" ||
          command.value === "active" ||
          command.value === "cancelling" ||
          command.value === "failed"
        ) {
          terminal.accept({
            type: "presentation-changed",
            property: "working",
            value: command.value,
          });
        }
        return;
      }
      const widget = parsePresentationWidget(command.value);
      if (widget !== undefined)
        terminal.accept({
          type: "presentation-changed",
          property: "widget",
          value: widget,
        });
    },
  };
}
