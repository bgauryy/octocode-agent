import { OpenTuiWidget } from "./base.js";
import type {
  WidgetInput,
  WidgetInputResult,
  WidgetRenderAdapter,
  WidgetRenderRegion,
  WidgetRenderState,
} from "./contracts.js";
import {
  assertStableTerminalId,
  sanitizeCollapsedSingleLine,
  truncateGraphemes,
} from "./sanitize.js";
import { toolStatusTone } from "../../../presentation/design/semantics.js";

export type ToolProgressStatus =
  "pending" | "running" | "success" | "blocked" | "cancelled" | "error";

export type ToolOutcomeClassification =
  | "result"
  | "validation"
  | "permission"
  | "policy"
  | "timeout"
  | "cancelled"
  | "system";

export interface ToolProgressOutcome {
  readonly authority: "runtime";
  readonly classification: ToolOutcomeClassification;
  readonly summary: string;
}

export interface ToolProgressSnapshot {
  readonly authority: "runtime";
  readonly callId: string;
  readonly toolName: string;
  readonly label?: string;
  readonly status: ToolProgressStatus;
  readonly inputSummary?: string;
  readonly message?: string;
  readonly outcome?: ToolProgressOutcome;
  readonly current?: number;
  readonly total?: number;
  readonly reducedMotion?: boolean;
}

export interface ToolProgressPlainTextOptions {
  readonly expanded?: boolean;
}

const COLLAPSED_TEXT_LIMIT = 480;
const EXPANDED_TEXT_LIMIT = 1_200;
const INPUT_SUMMARY_LIMIT = 240;
const OUTCOME_SUMMARY_LIMIT = 360;
const IDENTITY_LIMIT = 160;
const PROGRESS_ANNOUNCE_INTERVAL_MS = 1_500;
const PROGRESS_ANNOUNCE_PERCENT_STEP = 5;

const TERMINAL_STATUSES = new Set<ToolProgressStatus>([
  "success",
  "blocked",
  "cancelled",
  "error",
]);

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "success",
  "blocked",
  "cancelled",
  "error",
]);

const VALID_OUTCOME_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "result",
  "validation",
  "permission",
  "policy",
  "timeout",
  "cancelled",
  "system",
]);

const STATUS_PRESENTATION: Readonly<
  Record<ToolProgressStatus, { glyph: string; word: string }>
> = {
  pending: { glyph: "○", word: "PENDING" },
  running: { glyph: "◐", word: "RUNNING" },
  success: { glyph: "✓", word: "SUCCESS" },
  blocked: { glyph: "!", word: "BLOCKED" },
  cancelled: { glyph: "×", word: "CANCELLED" },
  error: { glyph: "✗", word: "ERROR" },
};

const AGENT_INSTRUCTIONS = {
  purpose:
    "Present one tool call as a stable, bounded, accessible progress record.",
  useWhen: [
    "A tool call has been accepted and its pending, running, blocked, cancelled, success, or error state must be shown.",
    "The user needs a concise alternate plain-text record of tool progress.",
  ],
  avoidWhen: [
    "No real tool call ID and tool name are available.",
    "The content is an assistant message rather than tool execution state.",
  ],
  inputs: [
    "A runtime-authoritative stable call ID, stable tool name, and explicit status.",
    "An already-minimized input summary; it is redacted and bounded again before display.",
    "Optional current and total counts only when both are truthful.",
    "A classified, bounded result or error summary; never a raw tool response.",
  ],
  stateAndOutput: [
    "Always render the explicit status word and a color-independent glyph.",
    "Never fabricate a percentage, current count, total, duration, or completion estimate.",
    "Emit a start announcement once, material throttled progress only, and a terminal outcome once.",
    "Accept the first terminal state as authoritative and never emit duplicate or contradictory terminal outcomes.",
  ],
  keys: [
    "Tab focuses a tool row; Enter expands or collapses its bounded input and outcome details.",
    "Expansion is observational and must preserve the same runtime-authoritative state.",
  ],
  accessibility: [
    "Do not rely on color: pair every glyph with the pending, running, success, blocked, cancelled, or error word.",
    "In reduced motion mode use a static ellipsis for running instead of a spinner.",
    "Deduplicate live announcements so screen readers hear only material transitions.",
  ],
  recovery: [
    "If progress totals are missing or inconsistent, show in progress and do not infer them.",
    "If a secret or raw tool dump reaches the summary boundary, redact secrets and collapse bounded text before rendering.",
    "If a later event contradicts a terminal state, retain the first terminal state and do not announce the duplicate.",
  ],
} as const;

function bounded(value: string, limit: number): string {
  return truncateGraphemes(value, limit);
}

function safeSummary(
  value: string | undefined,
  limit: number,
): string | undefined {
  if (value === undefined) return undefined;
  return sanitizeCollapsedSingleLine(value, {
    maxGraphemes: limit,
  });
}

function validateProgress(
  current: number | undefined,
  total: number | undefined,
): void {
  if (
    current !== undefined &&
    (!Number.isSafeInteger(current) || current < 0)
  ) {
    throw new Error(
      "truthful progress requires a non-negative integer current value",
    );
  }
  if (total !== undefined && (!Number.isSafeInteger(total) || total <= 0)) {
    throw new Error("truthful progress requires a positive integer total");
  }
  if (current !== undefined && total !== undefined && current > total) {
    throw new Error(
      "truthful progress requires current to be less than or equal to total",
    );
  }
}

function normalizeSnapshot(
  snapshot: ToolProgressSnapshot,
): ToolProgressSnapshot {
  if (snapshot.authority !== "runtime") {
    throw new Error("tool progress requires runtime authority");
  }
  const callId = assertStableTerminalId(snapshot.callId, {
    maxLength: IDENTITY_LIMIT,
  });
  const toolName = assertStableTerminalId(snapshot.toolName, {
    maxLength: IDENTITY_LIMIT,
  });
  const label = safeSummary(snapshot.label, IDENTITY_LIMIT);
  if (!VALID_STATUSES.has(snapshot.status))
    throw new Error("tool progress status is invalid");
  if (
    snapshot.outcome !== undefined &&
    !VALID_OUTCOME_CLASSIFICATIONS.has(snapshot.outcome.classification)
  ) {
    throw new Error("tool outcome classification is invalid");
  }
  if (
    snapshot.outcome !== undefined &&
    snapshot.outcome.authority !== "runtime"
  ) {
    throw new Error("tool outcome classification requires runtime authority");
  }
  validateProgress(snapshot.current, snapshot.total);
  return Object.freeze({
    authority: "runtime",
    callId,
    toolName,
    ...(label === undefined ? {} : { label }),
    status: snapshot.status,
    ...(snapshot.inputSummary === undefined
      ? {}
      : {
          inputSummary: safeSummary(snapshot.inputSummary, INPUT_SUMMARY_LIMIT),
        }),
    ...(snapshot.message === undefined
      ? {}
      : { message: safeSummary(snapshot.message, OUTCOME_SUMMARY_LIMIT) }),
    ...(snapshot.outcome === undefined
      ? {}
      : {
          outcome: Object.freeze({
            authority: "runtime" as const,
            classification: snapshot.outcome.classification,
            summary:
              safeSummary(snapshot.outcome.summary, OUTCOME_SUMMARY_LIMIT) ??
              "",
          }),
        }),
    ...(snapshot.current === undefined ? {} : { current: snapshot.current }),
    ...(snapshot.total === undefined ? {} : { total: snapshot.total }),
    ...(snapshot.reducedMotion === undefined
      ? {}
      : { reducedMotion: snapshot.reducedMotion }),
  });
}

function fallbackOutcome(
  status: ToolProgressStatus,
): ToolProgressOutcome | undefined {
  switch (status) {
    case "success":
      return {
        authority: "runtime",
        classification: "result",
        summary: "No result summary.",
      };
    case "blocked":
      return {
        authority: "runtime",
        classification: "policy",
        summary: "No blocked reason supplied.",
      };
    case "cancelled":
      return {
        authority: "runtime",
        classification: "cancelled",
        summary: "Tool call cancelled.",
      };
    case "error":
      return {
        authority: "runtime",
        classification: "system",
        summary: "No error summary.",
      };
    default:
      return undefined;
  }
}

export class ToolProgressWidget extends OpenTuiWidget {
  private snapshot: ToolProgressSnapshot;
  private readonly announcements: string[] = [];
  private startAnnounced = false;
  private terminalAnnounced = false;
  private lastProgressAnnouncementAt: number;
  private lastAnnouncedProgress: number | undefined;
  private lastAnnouncedMessage: string | undefined;
  private expanded = false;

  constructor(id: string, initial: ToolProgressSnapshot, nowMs = Date.now()) {
    super({
      id,
      kind: "tool.progress",
      capabilities: { focusable: true, inputMode: "selection" },
      accessibility: {
        role: "progressbar",
        label: "Tool execution progress",
        description: "A bounded status record for one stable tool call.",
        liveRegion: "polite",
        keyboardHelp: [
          "Enter expands or collapses bounded input and outcome details.",
        ],
      },
      instructions: AGENT_INSTRUCTIONS,
    });
    this.snapshot = normalizeSnapshot(initial);
    this.lastProgressAnnouncementAt = nowMs;
    this.queueTransitionAnnouncement(nowMs);
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  update(next: ToolProgressSnapshot, nowMs = Date.now()): void {
    const normalized = normalizeSnapshot(next);
    if (normalized.callId !== this.snapshot.callId)
      throw new Error("call id cannot change");
    if (normalized.toolName !== this.snapshot.toolName)
      throw new Error("tool name cannot change");
    if (normalized.label !== this.snapshot.label)
      throw new Error("tool label cannot change");
    if (TERMINAL_STATUSES.has(this.snapshot.status)) return;

    this.snapshot = normalized;
    this.queueTransitionAnnouncement(nowMs);
    this.invalidate();
  }

  takeAnnouncements(): readonly string[] {
    const pending = Object.freeze([...this.announcements]);
    this.announcements.length = 0;
    return pending;
  }

  toPlainText(options: ToolProgressPlainTextOptions = {}): string {
    const limit =
      options.expanded === true ? EXPANDED_TEXT_LIMIT : COLLAPSED_TEXT_LIMIT;
    const lines = this.buildLines(options.expanded === true);
    return bounded(lines.join("\n"), limit);
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const presentation = this.presentation();
    const outcome =
      this.snapshot.outcome ?? fallbackOutcome(this.snapshot.status);
    return [
      {
        id: "status",
        role: "status",
        tone: toolStatusTone(this.snapshot.status),
        text: `${presentation.glyph} [${presentation.word}]`,
      },
      {
        id: "identity",
        role: "content",
        text: this.expanded
          ? `${this.displayName()} · call ${this.snapshot.callId}`
          : this.displayName(),
      },
      {
        id: "progress",
        role: "status",
        tone: "count",
        text: this.progressText(),
      },
      ...(this.snapshot.inputSummary === undefined
        ? []
        : [
            {
              id: "input",
              role: "content" as const,
              text: `input: ${this.expanded ? this.snapshot.inputSummary : bounded(this.snapshot.inputSummary, 96)}`,
            },
          ]),
      ...(outcome === undefined
        ? []
        : [
            {
              id: "outcome",
              role: "status" as const,
              tone: toolStatusTone(this.snapshot.status),
              text: `${outcome.classification}: ${this.expanded ? outcome.summary : bounded(outcome.summary, 144)}`,
            },
          ]),
      {
        id: "details",
        role: "help",
        text: `Enter: details ${this.expanded ? "expanded" : "collapsed"}`,
      },
    ];
  }

  protected onInput(input: WidgetInput): WidgetInputResult {
    if (
      input.type !== "key" ||
      (input.key.toLowerCase() !== "enter" &&
        input.key.toLowerCase() !== "return")
    ) {
      return { status: "ignored" };
    }
    this.expanded = !this.expanded;
    this.invalidate();
    return { status: "handled" };
  }

  private buildLines(expanded: boolean): readonly string[] {
    const presentation = this.presentation();
    const collapsedInputLimit = 96;
    const collapsedOutcomeLimit = 144;
    const lines = [
      `${presentation.glyph} [${presentation.word}] ${this.displayName()} (${this.snapshot.callId})`,
      this.progressText(),
    ];
    if (this.snapshot.inputSummary !== undefined) {
      lines.push(
        `input: ${
          expanded
            ? this.snapshot.inputSummary
            : bounded(this.snapshot.inputSummary, collapsedInputLimit)
        }`,
      );
    }
    const outcome =
      this.snapshot.outcome ?? fallbackOutcome(this.snapshot.status);
    if (outcome !== undefined) {
      lines.push(
        `${outcome.classification}: ${
          expanded
            ? outcome.summary
            : bounded(outcome.summary, collapsedOutcomeLimit)
        }`,
      );
    }
    if (
      !expanded &&
      ((this.snapshot.inputSummary?.length ?? 0) > collapsedInputLimit ||
        (outcome?.summary.length ?? 0) > collapsedOutcomeLimit)
    ) {
      lines.push("… details collapsed");
    }
    return lines;
  }

  private presentation(): { glyph: string; word: string } {
    const value = STATUS_PRESENTATION[this.snapshot.status];
    if (
      this.snapshot.status === "running" &&
      this.snapshot.reducedMotion === true
    ) {
      return { glyph: "…", word: value.word };
    }
    return value;
  }

  private progressText(): string {
    const message = this.snapshot.message;
    if (
      this.snapshot.current !== undefined &&
      this.snapshot.total !== undefined
    ) {
      return `${this.snapshot.current}/${this.snapshot.total}${message === undefined ? "" : ` · ${message}`}`;
    }
    if (TERMINAL_STATUSES.has(this.snapshot.status)) {
      return `terminal state: ${this.snapshot.status}`;
    }
    return (
      message ??
      (this.snapshot.status === "pending" ? "waiting to start" : "in progress")
    );
  }

  private queueTransitionAnnouncement(nowMs: number): void {
    if (TERMINAL_STATUSES.has(this.snapshot.status)) {
      if (!this.terminalAnnounced) {
        this.announcements.push(
          `Tool ${this.displayName()} finished: ${this.snapshot.status} (${this.snapshot.callId}).`,
        );
        this.terminalAnnounced = true;
      }
      return;
    }

    if (!this.startAnnounced) {
      this.announcements.push(
        `Tool ${this.displayName()} started (${this.snapshot.callId}).`,
      );
      this.startAnnounced = true;
      this.lastAnnouncedProgress = this.snapshot.current;
      this.lastAnnouncedMessage = this.snapshot.message;
      return;
    }

    const { current, total } = this.snapshot;
    if (
      this.snapshot.message !== undefined &&
      this.snapshot.message !== this.lastAnnouncedMessage &&
      nowMs - this.lastProgressAnnouncementAt >= PROGRESS_ANNOUNCE_INTERVAL_MS
    ) {
      this.announcements.push(
        `Tool ${this.displayName()}: ${this.snapshot.message} (${this.snapshot.callId}).`,
      );
      this.lastAnnouncedMessage = this.snapshot.message;
      this.lastProgressAnnouncementAt = nowMs;
      return;
    }
    if (
      current === undefined ||
      total === undefined ||
      current === this.lastAnnouncedProgress
    )
      return;
    const previous = this.lastAnnouncedProgress ?? 0;
    const material =
      ((current - previous) / total) * 100 >= PROGRESS_ANNOUNCE_PERCENT_STEP;
    if (
      !material ||
      nowMs - this.lastProgressAnnouncementAt < PROGRESS_ANNOUNCE_INTERVAL_MS
    )
      return;
    this.announcements.push(
      `Tool ${this.displayName()} progress: ${current}/${total} (${this.snapshot.callId}).`,
    );
    this.lastAnnouncedProgress = current;
    this.lastProgressAnnouncementAt = nowMs;
  }

  private displayName(): string {
    return this.snapshot.label ?? this.snapshot.toolName;
  }
}
