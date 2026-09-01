import { OpenTuiWidget } from "./base.js";
import type {
  WidgetInput,
  WidgetInputResult,
  WidgetRenderAdapter,
  WidgetRenderRegion,
  WidgetRenderState,
} from "./contracts.js";
import { fitTerminalText } from "./layout.js";
import { assertStableTerminalId, sanitizeSingleLineText } from "./sanitize.js";

export type PlanWidgetPhase =
  "empty" | "draft" | "approved" | "active" | "complete";
export type PlanWidgetStepStatus = "todo" | "doing" | "done";
export type PlanWidgetVerificationStatus = "SUCCESS" | "FAILED";

export interface PlanWidgetScope {
  readonly sessionId: string;
  readonly workspace: string;
}

export interface PlanWidgetVerificationReceipt {
  readonly authority: "runtime";
  readonly command: string;
  readonly status: PlanWidgetVerificationStatus;
  readonly message: string;
}

export interface PlanWidgetStep {
  readonly id: string;
  readonly text: string;
  readonly activeForm?: string;
  readonly status: PlanWidgetStepStatus;
  readonly dependsOn?: readonly string[];
  readonly checkCommand?: string;
  readonly receipt?: PlanWidgetVerificationReceipt;
  readonly workerId?: string;
}

export interface PlanWidgetSnapshot {
  readonly authority: "runtime";
  readonly planId: string;
  readonly scope: PlanWidgetScope;
  readonly revision: number;
  readonly phase: PlanWidgetPhase;
  readonly steps: readonly PlanWidgetStep[];
}

export interface PlanWidgetOptions {
  readonly widthColumns?: number;
  readonly viewportRows?: number;
}

const MAX_ID_LENGTH = 128;
const MAX_SCOPE_LENGTH = 2_048;
const MAX_STEP_TEXT_LENGTH = 2_048;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_RECEIPT_MESSAGE_LENGTH = 2_048;
const MAX_STEPS = 256;
const MIN_WIDTH = 20;
const MAX_WIDTH = 1_000;
const MIN_VIEWPORT_ROWS = 1;
const MAX_VIEWPORT_ROWS = 61;
const DEFAULT_WIDTH = 80;
const DEFAULT_VIEWPORT_ROWS = 10;
const PHASES: ReadonlySet<string> = new Set([
  "empty",
  "draft",
  "approved",
  "active",
  "complete",
]);
const STATUSES: ReadonlySet<string> = new Set(["todo", "doing", "done"]);
const RECEIPT_STATUSES: ReadonlySet<string> = new Set(["SUCCESS", "FAILED"]);

const AGENT_INSTRUCTIONS = {
  purpose:
    "Render one authoritative execution-plan snapshot as a bounded, keyboard-scrollable, read-only ordered list.",
  useWhen: [
    "An authoritative plan store supplies a stable plan identity, scope, revision, phase, and ordered steps.",
    "A user needs to inspect current work, dependencies, checks, and recorded verification without mutating the plan.",
  ],
  avoidWhen: [
    "The agent is proposing, approving, editing, reordering, starting, completing, or clearing plan state.",
    "Plan identity, revision, phase, step status, dependency, or verification data is inferred instead of supplied by the runtime.",
  ],
  inputs: [
    "Use stable plan and step IDs plus the exact authoritative session and workspace scope.",
    "Provide monotonically increasing revisions and explicit empty, draft, approved, active, or complete phases.",
    "Provide each step text, optional active form, status, stable dependency IDs, optional worker owner, optional check command, and optional verification receipt.",
    "Accept only snapshots and verification receipts marked with runtime authority; treat receipt command, status, and message as an indivisible runtime-issued record.",
  ],
  stateAndOutput: [
    "Preserve authoritative step order, keep worker ownership visible, and mark every bounded concurrent doing step with the literal words CURRENT and DOING.",
    "Never fabricate completion or verification, reorder stable IDs, hide blockers, or infer that draft means approved.",
    "A done step without a receipt remains visibly NOT RECORDED; a failed receipt remains visibly FAILED.",
    "The visual viewport may be bounded, but the alternate snapshot always includes plan ID, scope, revision, phase, and every step and detail.",
    "Rendering is observational only and cannot mutate plan state, approval, step status, or verification receipts.",
  ],
  keys: [
    "Arrow Up and Arrow Down scroll one step; Page Up and Page Down scroll one viewport.",
    "Home and End jump to the beginning or end; no key approves, edits, reorders, starts, or completes a plan.",
  ],
  accessibility: [
    "Expose the widget as a labeled plan region followed by a linear ordered-list label and ordered step rows.",
    "Express phase, status, current step, dependencies, blockers, and verification with words and symbols rather than color alone.",
    "Preserve the current step and scroll position across resize whenever the resulting bounds permit it.",
    "Announce phase, current-step, and completed-count changes only; never announce an unchanged render.",
  ],
  recovery: [
    "Reject missing or non-runtime authority, stale revisions, identity or scope drift, duplicate stable IDs, unknown dependencies, and more than four doing steps.",
    "Use the shared terminal sanitizer to strip terminal and bidirectional controls and redact recognizable credentials from all visual and alternate output.",
    "On a narrow terminal, keep one bounded row per step and expose the full unsqueezed content through the alternate snapshot.",
  ],
} as const;

function safeText(value: string, label: string, limit: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = sanitizeSingleLineText(value, {
    maxGraphemes: limit,
    redactCredentials: true,
    tabWidth: 1,
  })
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must be a bounded non-empty value`);
  }
  return normalized;
}

function safeId(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return assertStableTerminalId(value, { maxLength: MAX_ID_LENGTH });
}

function validateViewport(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw new Error(`${label} is outside its supported bounds`);
  }
  return normalized;
}

function normalizeReceipt(
  value: PlanWidgetVerificationReceipt,
  stepIndex: number,
): PlanWidgetVerificationReceipt {
  if (value.authority !== "runtime")
    throw new Error(
      `step ${stepIndex} verification receipt requires runtime authority`,
    );
  if (!RECEIPT_STATUSES.has(value.status))
    throw new Error(`step ${stepIndex} receipt status is invalid`);
  return Object.freeze({
    authority: "runtime",
    command: safeText(
      value.command,
      `step ${stepIndex} receipt command`,
      MAX_COMMAND_LENGTH,
    ),
    status: value.status,
    message: safeText(
      value.message,
      `step ${stepIndex} receipt message`,
      MAX_RECEIPT_MESSAGE_LENGTH,
    ),
  });
}

function normalizeSnapshot(value: PlanWidgetSnapshot): PlanWidgetSnapshot {
  if (value.authority !== "runtime")
    throw new Error("plan snapshot requires runtime authority");
  const planId = safeId(value.planId, "plan identity");
  const scope = Object.freeze({
    sessionId: safeText(
      value.scope.sessionId,
      "plan scope session id",
      MAX_SCOPE_LENGTH,
    ),
    workspace: safeText(
      value.scope.workspace,
      "plan scope workspace",
      MAX_SCOPE_LENGTH,
    ),
  });
  if (!Number.isSafeInteger(value.revision) || value.revision < 0)
    throw new Error("plan revision must be a non-negative integer");
  if (!PHASES.has(value.phase)) throw new Error("plan phase is invalid");
  if (!Array.isArray(value.steps) || value.steps.length > MAX_STEPS)
    throw new Error("plan steps exceed their item bound");
  if (value.phase !== "empty" && value.steps.length === 0)
    throw new Error("a non-empty plan phase requires steps");
  if (value.phase === "empty" && value.steps.length > 0)
    throw new Error("an empty plan phase cannot contain steps");

  const ids = new Set<string>();
  let doingCount = 0;
  const partial = value.steps.map((step, index) => {
    const number = index + 1;
    const id = safeId(step.id, `step ${number} id`);
    if (ids.has(id)) throw new Error(`duplicate step id '${id}'`);
    ids.add(id);
    if (!STATUSES.has(step.status))
      throw new Error(`step ${number} status is invalid`);
    if (step.status === "doing") doingCount += 1;
    if (
      step.receipt !== undefined &&
      step.checkCommand !== undefined &&
      step.receipt.command !== step.checkCommand
    ) {
      throw new Error(
        `step ${number} receipt command must exactly match its check command`,
      );
    }
    const dependsOn =
      step.dependsOn === undefined
        ? undefined
        : Object.freeze(
            step.dependsOn.map((dependency: string, dependencyIndex: number) =>
              safeId(
                dependency,
                `step ${number} dependency ${dependencyIndex + 1}`,
              ),
            ),
          );
    if (
      dependsOn !== undefined &&
      new Set(dependsOn).size !== dependsOn.length
    ) {
      throw new Error(`step ${number} contains duplicate dependencies`);
    }
    return {
      id,
      text: safeText(step.text, `step ${number} text`, MAX_STEP_TEXT_LENGTH),
      status: step.status,
      ...(step.activeForm === undefined
        ? {}
        : {
            activeForm: safeText(
              step.activeForm,
              `step ${number} active form`,
              MAX_STEP_TEXT_LENGTH,
            ),
          }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
      ...(step.checkCommand === undefined
        ? {}
        : {
            checkCommand: safeText(
              step.checkCommand,
              `step ${number} check command`,
              MAX_COMMAND_LENGTH,
            ),
          }),
      ...(step.receipt === undefined
        ? {}
        : { receipt: normalizeReceipt(step.receipt, number) }),
      ...(step.workerId === undefined
        ? {}
        : { workerId: safeId(step.workerId, `step ${number} worker id`) }),
    } satisfies PlanWidgetStep;
  });
  if (doingCount > 4)
    throw new Error("a plan cannot contain more than four doing steps");
  const steps = partial.map((step, index) => {
    for (const dependency of step.dependsOn ?? []) {
      if (!ids.has(dependency))
        throw new Error(
          `step ${index + 1} dependency '${dependency}' is unknown`,
        );
      if (dependency === step.id)
        throw new Error(`step ${index + 1} cannot depend on itself`);
    }
    if (step.receipt !== undefined && step.checkCommand === undefined) {
      throw new Error(
        `step ${index + 1} verification receipt requires a check command`,
      );
    }
    if (
      step.receipt !== undefined &&
      step.receipt.command !== step.checkCommand
    ) {
      throw new Error(
        `step ${index + 1} receipt command must match its check command`,
      );
    }
    if (
      step.status === "done" &&
      step.checkCommand !== undefined &&
      step.receipt?.status !== "SUCCESS"
    ) {
      throw new Error(
        `step ${index + 1} cannot be complete without successful recorded verification`,
      );
    }
    return Object.freeze(step);
  });
  if (
    value.phase === "complete" &&
    steps.some((step) => step.status !== "done")
  ) {
    throw new Error("a complete plan phase requires every step to be done");
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("plan dependencies contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
  return Object.freeze({
    authority: "runtime",
    planId,
    scope,
    revision: value.revision,
    phase: value.phase,
    steps: Object.freeze(steps),
  });
}

function currentStepIds(snapshot: PlanWidgetSnapshot): readonly string[] {
  return snapshot.steps.filter((step) => step.status === "doing").map((step) => step.id);
}

function completedCount(snapshot: PlanWidgetSnapshot): number {
  return snapshot.steps.filter((step) => step.status === "done").length;
}

export class PlanWidget extends OpenTuiWidget {
  private snapshot: PlanWidgetSnapshot;
  private widthColumns: number;
  private viewportRows: number;
  private currentScrollOffset = 0;
  private readonly announcements: string[] = [];

  constructor(
    id: string,
    initial: PlanWidgetSnapshot,
    options: PlanWidgetOptions = {},
  ) {
    super({
      id,
      kind: "plan",
      capabilities: { focusable: true, inputMode: "keys" },
      accessibility: {
        role: "list",
        label: "Execution plan",
        description:
          "A read-only ordered plan with current step, dependencies, checks, and verification receipts.",
        liveRegion: "polite",
        keyboardHelp: [
          "Use arrows, Page Up, Page Down, Home, and End to scroll; this view cannot change the plan.",
        ],
      },
      instructions: AGENT_INSTRUCTIONS,
    });
    this.snapshot = normalizeSnapshot(initial);
    this.widthColumns = validateViewport(
      options.widthColumns,
      DEFAULT_WIDTH,
      MIN_WIDTH,
      MAX_WIDTH,
      "plan width",
    );
    this.viewportRows = validateViewport(
      options.viewportRows,
      DEFAULT_VIEWPORT_ROWS,
      MIN_VIEWPORT_ROWS,
      MAX_VIEWPORT_ROWS,
      "plan viewport rows",
    );
    this.revealCurrentStep();
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  get scrollOffset(): number {
    return this.currentScrollOffset;
  }

  hasIdentity(value: Pick<PlanWidgetSnapshot, "planId" | "scope">): boolean {
    return (
      value.planId === this.snapshot.planId &&
      value.scope.sessionId === this.snapshot.scope.sessionId &&
      value.scope.workspace === this.snapshot.scope.workspace
    );
  }

  update(nextValue: PlanWidgetSnapshot): void {
    const next = normalizeSnapshot(nextValue);
    if (!this.hasIdentity(next)) {
      throw new Error("plan identity or scope cannot change within a widget");
    }
    if (next.revision < this.snapshot.revision)
      throw new Error("stale plan revision");
    if (next.revision === this.snapshot.revision) {
      if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
      throw new Error("a plan revision cannot describe different state");
    }
    const previousPhase = this.snapshot.phase;
    const previousCurrent = currentStepIds(this.snapshot);
    const previousCompleted = completedCount(this.snapshot);
    this.snapshot = next;

    if (previousPhase !== next.phase)
      this.announcements.push(`Plan phase changed to ${next.phase}.`);
    const nextCurrent = currentStepIds(next);
    if (previousCurrent.join("\0") !== nextCurrent.join("\0")) {
      this.announcements.push(
        nextCurrent.length === 0
          ? "No plan step is currently active."
          : `Active plan steps changed to ${nextCurrent.join(", ")}.`,
      );
      this.revealCurrentStep();
    } else {
      this.clampScroll();
    }
    const nextCompleted = completedCount(next);
    if (previousCompleted !== nextCompleted) {
      this.announcements.push(
        `Plan progress changed to ${nextCompleted} of ${next.steps.length} steps complete.`,
      );
    }
    this.invalidate();
  }

  resize(widthColumns: number, viewportRows: number): void {
    const width = validateViewport(
      widthColumns,
      DEFAULT_WIDTH,
      MIN_WIDTH,
      MAX_WIDTH,
      "plan width",
    );
    const rows = validateViewport(
      viewportRows,
      DEFAULT_VIEWPORT_ROWS,
      MIN_VIEWPORT_ROWS,
      MAX_VIEWPORT_ROWS,
      "plan viewport rows",
    );
    if (width === this.widthColumns && rows === this.viewportRows) return;
    this.widthColumns = width;
    this.viewportRows = rows;
    this.clampScroll();
    this.invalidate();
  }

  takeAnnouncements(): readonly string[] {
    const result = Object.freeze([...this.announcements]);
    this.announcements.length = 0;
    return result;
  }

  toPlainText(): string {
    const lines = [
      `Plan ${this.snapshot.planId} — revision ${this.snapshot.revision} — phase ${this.snapshot.phase.toUpperCase()}`,
      `Scope — session: ${this.snapshot.scope.sessionId} — workspace: ${this.snapshot.scope.workspace}`,
      `Steps — ${completedCount(this.snapshot)} of ${this.snapshot.steps.length} complete`,
    ];
    if (this.snapshot.steps.length === 0) lines.push("No plan steps.");
    this.snapshot.steps.forEach((step, index) => {
      const current = step.status === "doing" ? " >> CURRENT" : "";
      lines.push(
        `${index + 1}. [${step.status.toUpperCase()}] ${step.id}: ${step.text}${current}`,
      );
      if (step.activeForm !== undefined)
        lines.push(`   active form: ${step.activeForm}`);
      if (step.workerId !== undefined)
        lines.push(`   worker: ${step.workerId}`);
      if (step.dependsOn !== undefined && step.dependsOn.length > 0) {
        lines.push(`   depends on: ${step.dependsOn.join(", ")}`);
        const blockers = step.dependsOn.filter(
          (id) =>
            this.snapshot.steps.find((candidate) => candidate.id === id)
              ?.status !== "done",
        );
        if (blockers.length > 0)
          lines.push(
            `   blocked by: ${blockers.map((id) => `${id} [${this.statusFor(id)}]`).join(", ")}`,
          );
      }
      if (step.checkCommand !== undefined)
        lines.push(`   check: ${step.checkCommand}`);
      if (step.receipt === undefined) {
        if (step.status === "done") lines.push("   verification: NOT RECORDED");
      } else {
        lines.push(
          `   verification: ${step.receipt.status} — ${step.receipt.command} — ${step.receipt.message}`,
        );
      }
    });
    return lines.join("\n");
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const total = this.snapshot.steps.length;
    const end = Math.min(total, this.currentScrollOffset + this.viewportRows);
    const visible = this.snapshot.steps.slice(this.currentScrollOffset, end);
    return [
      {
        id: "summary",
        role: "status",
        text: fitTerminalText(
          `Plan ${this.snapshot.planId} · revision ${this.snapshot.revision} · phase ${this.snapshot.phase.toUpperCase()} · ${completedCount(this.snapshot)}/${total} complete`,
          this.widthColumns,
        ),
      },
      {
        id: "list-label",
        role: "content",
        text: `Ordered tasks ${total === 0 ? "(empty)" : `${this.currentScrollOffset + 1}–${end} of ${total}`}:`,
      },
      ...visible.map((step, visibleIndex) => ({
        id: `step-${step.id}`,
        role: "option" as const,
        tone: this.stepTone(step),
        text: fitTerminalText(
          this.stepRow(step, this.currentScrollOffset + visibleIndex),
          this.widthColumns,
        ),
      })),
      {
        id: "help",
        role: "help",
        text: "Read only · ↑/↓ scroll · PgUp/PgDn viewport · Home/End bounds",
      },
    ];
  }

  protected onInput(input: WidgetInput): WidgetInputResult {
    if (input.type !== "key") return { status: "ignored" };
    const key = input.key.toLowerCase();
    let target: number | undefined;
    if (key === "arrowdown" || key === "j")
      target = this.currentScrollOffset + 1;
    else if (key === "arrowup" || key === "k")
      target = this.currentScrollOffset - 1;
    else if (key === "pagedown")
      target = this.currentScrollOffset + this.viewportRows;
    else if (key === "pageup")
      target = this.currentScrollOffset - this.viewportRows;
    else if (key === "home") target = 0;
    else if (key === "end") target = this.maximumScrollOffset();
    else return { status: "ignored" };
    const next = Math.max(0, Math.min(this.maximumScrollOffset(), target));
    if (next !== this.currentScrollOffset) {
      this.currentScrollOffset = next;
      this.invalidate();
    }
    return { status: "handled" };
  }

  private stepRow(step: PlanWidgetStep, index: number): string {
    const current = step.status === "doing" ? " >> CURRENT" : "";
    const blockers = (step.dependsOn ?? []).filter(
      (id) =>
        this.snapshot.steps.find((candidate) => candidate.id === id)?.status !==
        "done",
    );
    const blocked =
      blockers.length === 0 ? "" : ` · BLOCKED BY ${blockers.join(", ")}`;
    const verification =
      step.receipt === undefined
        ? step.status === "done"
          ? " · verification NOT RECORDED"
          : ""
        : ` · verification ${step.receipt.status}`;
    const worker =
      step.workerId === undefined ? "" : ` · WORKER ${step.workerId}`;
    return `${index + 1}. [${step.status.toUpperCase()}]${current} ${step.id}: ${step.activeForm ?? step.text}${worker}${blocked}${verification}`;
  }

  private stepTone(
    step: PlanWidgetStep,
  ): "info" | "success" | "warning" | "error" {
    if (step.receipt?.status === "FAILED") return "error";
    const blocked = (step.dependsOn ?? []).some(
      (id) =>
        this.snapshot.steps.find((candidate) => candidate.id === id)?.status !==
        "done",
    );
    if (blocked || (step.status === "done" && step.receipt === undefined))
      return "warning";
    if (step.status === "done") return "success";
    return "info";
  }

  private statusFor(id: string): string {
    return (
      this.snapshot.steps
        .find((step) => step.id === id)
        ?.status.toUpperCase() ?? "UNKNOWN"
    );
  }

  private maximumScrollOffset(): number {
    return Math.max(0, this.snapshot.steps.length - this.viewportRows);
  }

  private clampScroll(): void {
    this.currentScrollOffset = Math.max(
      0,
      Math.min(this.maximumScrollOffset(), this.currentScrollOffset),
    );
  }

  private revealCurrentStep(): void {
    const index = this.snapshot.steps.findIndex(
      (step) => step.status === "doing",
    );
    if (index < 0) {
      this.clampScroll();
      return;
    }
    if (index < this.currentScrollOffset) this.currentScrollOffset = index;
    else if (index >= this.currentScrollOffset + this.viewportRows)
      this.currentScrollOffset = index - this.viewportRows + 1;
    this.clampScroll();
  }
}
