import { OpenTuiWidget } from "./base.js";
import type {
  WidgetRenderAdapter,
  WidgetRenderRegion,
  WidgetRenderState,
} from "./contracts.js";
import { sanitizeSingleLineText } from "./sanitize.js";

export type WorkerProgressState =
  "queued" | "running" | "succeeded" | "failed" | "aborted" | "killed";

export interface WorkerProgressSnapshot {
  readonly authority: "runtime";
  readonly workerId: string;
  readonly agentType?: string;
  readonly state: WorkerProgressState;
  readonly active?: number;
  readonly queued?: number;
  readonly maxActive?: number;
  readonly planStepId?: string;
  readonly taskLabel?: string;
  readonly listPosition?: number;
  readonly listTotal?: number;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
}

const STATES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "killed",
]);

function safeLabel(value: string, field: string): string {
  const safe = sanitizeSingleLineText(value, {
    maxGraphemes: 128,
    redactCredentials: true,
  }).trim();
  if (!safe) throw new Error(`${field} must be a bounded non-empty value`);
  return safe;
}

function normalize(snapshot: WorkerProgressSnapshot): WorkerProgressSnapshot {
  if (snapshot.authority !== "runtime")
    throw new Error("worker progress requires runtime authority");
  if (!STATES.has(snapshot.state))
    throw new Error("worker progress state is invalid");
  if (
    !Number.isSafeInteger(snapshot.startedAtMs) ||
    !Number.isSafeInteger(snapshot.updatedAtMs) ||
    snapshot.startedAtMs < 0 ||
    snapshot.updatedAtMs < snapshot.startedAtMs
  ) {
    throw new Error("worker progress timestamps are invalid");
  }
  if (
    (snapshot.listPosition === undefined) !== (snapshot.listTotal === undefined) ||
    (snapshot.listPosition !== undefined &&
      (!Number.isSafeInteger(snapshot.listPosition) ||
        !Number.isSafeInteger(snapshot.listTotal) ||
        snapshot.listPosition < 1 ||
        snapshot.listTotal! < snapshot.listPosition))
  ) {
    throw new Error("worker list position is invalid");
  }
  return Object.freeze({
    authority: "runtime",
    workerId: safeLabel(snapshot.workerId, "worker id"),
    ...(snapshot.agentType === undefined
      ? {}
      : { agentType: safeLabel(snapshot.agentType, "agent type") }),
    state: snapshot.state,
    startedAtMs: snapshot.startedAtMs,
    updatedAtMs: snapshot.updatedAtMs,
    ...(snapshot.listPosition === undefined
      ? {}
      : { listPosition: snapshot.listPosition, listTotal: snapshot.listTotal }),
  });
}

function tone(
  state: WorkerProgressState,
): "info" | "success" | "warning" | "error" {
  if (state === "succeeded") return "success";
  if (state === "aborted") return "warning";
  if (state === "failed" || state === "killed") return "error";
  return "info";
}

function marker(state: WorkerProgressState): string {
  if (state === "queued") return "○";
  if (state === "succeeded") return "✓";
  if (state === "aborted") return "!";
  if (state === "failed" || state === "killed") return "×";
  return "●";
}

function duration(startedAtMs: number, updatedAtMs: number): string {
  const seconds = Math.floor((updatedAtMs - startedAtMs) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export class WorkerProgressWidget extends OpenTuiWidget {
  private snapshot: WorkerProgressSnapshot;
  private readonly announcements: string[] = [];

  constructor(id: string, initial: WorkerProgressSnapshot) {
    super({
      id,
      kind: "worker.progress",
      capabilities: { focusable: false, inputMode: "none" },
      accessibility: {
        role: "status",
        label: "Subagent progress",
        description: "A bounded operational summary for one leaf worker.",
        liveRegion: "polite",
        keyboardHelp: [
          "Read only; use the Activity tab to inspect worker progress.",
        ],
      },
      instructions: {
        purpose:
          "Show truthful, bounded worker state and elapsed time without exposing private worker data.",
        useWhen: [
          "A canonical worker lifecycle event supplies runtime-authoritative state.",
        ],
        avoidWhen: [
          "Worker state is inferred from transcript text or unvalidated process output.",
        ],
        inputs: [
          "Use worker id only as an internal stable key; public output uses only optional agent type, canonical state, and presentation timestamps.",
        ],
        stateAndOutput: [
          "Keep terminal workers visible after completion and update by stable worker id without rendering the id, assignment, plan step, capacity, prompt, reason, or handback data.",
        ],
        keys: ["This read-only widget receives no direct input."],
        accessibility: ["Pair tone with a marker and explicit state word."],
        recovery: [
          "Reject invalid state, timestamps, empty identifiers, and control text.",
        ],
      },
    });
    this.snapshot = normalize(initial);
    this.announcements.push(this.toPlainText());
  }

  update(next: WorkerProgressSnapshot): void {
    const normalized = normalize(next);
    if (normalized.workerId !== this.snapshot.workerId)
      throw new Error("worker id cannot change");
    const stateChanged = normalized.state !== this.snapshot.state;
    this.snapshot = normalized;
    if (stateChanged) this.announcements.push(this.toPlainText());
    this.invalidate();
  }

  takeAnnouncements(): readonly string[] {
    const pending = Object.freeze([...this.announcements]);
    this.announcements.length = 0;
    return pending;
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  toPlainText(): string {
    const position = this.snapshot.listPosition === undefined
      ? ""
      : `Subagent ${this.snapshot.listPosition}/${this.snapshot.listTotal} · `;
    const agentType =
      this.snapshot.agentType === undefined ? "" : `${this.snapshot.agentType} · `;
    return `${marker(this.snapshot.state)} ${position}${agentType}${this.snapshot.state.toUpperCase()} · ${duration(this.snapshot.startedAtMs, this.snapshot.updatedAtMs)}`;
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const agentType = this.snapshot.agentType === undefined
      ? "Worker"
      : this.snapshot.agentType;
    const position = this.snapshot.listPosition === undefined
      ? ""
      : `Subagent ${this.snapshot.listPosition}/${this.snapshot.listTotal} · `;
    return [
      {
        id: "summary",
        role: "status",
        tone: tone(this.snapshot.state),
        text: `${marker(this.snapshot.state)} ${position}${agentType} · ${this.snapshot.state.toUpperCase()} · ${duration(this.snapshot.startedAtMs, this.snapshot.updatedAtMs)}`,
      },
    ];
  }
}
