import { OpenTuiWidget } from "./base.js";
import type {
  WidgetRenderAdapter,
  WidgetRenderRegion,
  WidgetRenderState,
} from "./contracts.js";
import {
  assertStableTerminalId,
  sanitizeCollapsedSingleLine,
} from "./sanitize.js";

export type SkillActivityAction =
  | "discover"
  | "enable"
  | "disable"
  | "refresh"
  | "install"
  | "update"
  | "remove";

export type SkillActivityState =
  | "pending"
  | "running"
  | "approval-required"
  | "rejected"
  | "completed"
  | "failed"
  | "cancelled";

export interface SkillActivitySnapshot {
  readonly authority: "runtime";
  readonly operationId: string;
  readonly name: string;
  readonly sourceScope: string;
  readonly action: SkillActivityAction;
  readonly state: SkillActivityState;
  readonly result: string;
}

const ACTIONS: ReadonlySet<string> = new Set([
  "discover",
  "enable",
  "disable",
  "refresh",
  "install",
  "update",
  "remove",
]);
const STATES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "approval-required",
  "rejected",
  "completed",
  "failed",
  "cancelled",
]);
const TERMINAL_STATES: ReadonlySet<SkillActivityState> = new Set([
  "rejected",
  "completed",
  "failed",
  "cancelled",
]);
const STATE_PRESENTATION: Readonly<
  Record<SkillActivityState, { glyph: string; word: string; tone?: "info" | "success" | "warning" | "error" }>
> = {
  pending: { glyph: "○", word: "PENDING", tone: "info" },
  running: { glyph: "◐", word: "RUNNING", tone: "info" },
  "approval-required": { glyph: "?", word: "APPROVAL REQUIRED", tone: "warning" },
  rejected: { glyph: "!", word: "REJECTED", tone: "warning" },
  completed: { glyph: "✓", word: "COMPLETED", tone: "success" },
  failed: { glyph: "✗", word: "FAILED", tone: "error" },
  cancelled: { glyph: "×", word: "CANCELLED", tone: "warning" },
};

const AGENT_INSTRUCTIONS = {
  purpose: "Present one Skill discovery or mutation as a stable, bounded lifecycle card.",
  useWhen: ["A validated Skill discovery or mutation has user-visible lifecycle state."],
  avoidWhen: ["The Skill operation is a read or load with no mutation lifecycle."],
  inputs: ["Runtime-authoritative public Skill identity, scope, action, state, and bounded result."],
  stateAndOutput: ["Preserve the first terminal outcome and never render raw arguments, paths, or credentials."],
  keys: ["This card is observational and has no direct input."],
  accessibility: ["Pair every state marker with an explicit state word and preserve the same plain-text order."],
  recovery: ["Reject invalid actions and states; sanitize and bound every public text field."],
} as const;

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function redactPaths(value: string): string {
  return value
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/gu, "[REDACTED]")
    .replace(/(?:\/(?:[^/\s]+)){2,}/gu, "[REDACTED]");
}

function safeText(value: string, maxGraphemes: number): string {
  const pathsRedacted = redactPaths(value);
  const containsSensitiveText = pathsRedacted !== value ||
    /(?:token|password|secret|authorization)\s*[:=]|\bsk-[A-Za-z0-9_-]{8,}/iu.test(value);
  const sanitized = sanitizeCollapsedSingleLine(pathsRedacted, {
    maxGraphemes,
    redactCredentials: true,
  });
  return containsSensitiveText && !sanitized.includes("[REDACTED]")
    ? sanitizeCollapsedSingleLine(`[REDACTED] ${sanitized}`, {
        maxGraphemes,
        redactCredentials: true,
      })
    : sanitized;
}

function normalize(snapshot: SkillActivitySnapshot): SkillActivitySnapshot {
  if (snapshot.authority !== "runtime")
    throw new Error("Skill activity requires runtime authority");
  if (!ACTIONS.has(snapshot.action)) throw new Error("Skill activity action is invalid");
  if (!STATES.has(snapshot.state)) throw new Error("Skill activity state is invalid");
  return Object.freeze({
    authority: "runtime",
    operationId: assertStableTerminalId(snapshot.operationId, { maxLength: 160 }),
    name: safeText(snapshot.name, 80) || "Catalog",
    sourceScope: safeText(snapshot.sourceScope, 80) || "Unknown",
    action: snapshot.action,
    state: snapshot.state,
    result: safeText(snapshot.result, 96),
  });
}

export class SkillActivityWidget extends OpenTuiWidget {
  private snapshot: SkillActivitySnapshot;

  constructor(id: string, initial: SkillActivitySnapshot) {
    super({
      id,
      kind: "skill.activity",
      capabilities: { focusable: false, inputMode: "none" },
      accessibility: {
        role: "status",
        label: "Skill activity",
        description: "A bounded Skill discovery or mutation lifecycle record.",
        liveRegion: "polite",
        keyboardHelp: ["This card is read-only."],
      },
      instructions: AGENT_INSTRUCTIONS,
    });
    this.snapshot = normalize(initial);
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  update(next: SkillActivitySnapshot): void {
    const normalized = normalize(next);
    if (normalized.operationId !== this.snapshot.operationId)
      throw new Error("Skill operation id cannot change");
    if (normalized.action !== this.snapshot.action)
      throw new Error("Skill activity action cannot change");
    if (TERMINAL_STATES.has(this.snapshot.state)) return;
    this.snapshot = normalized;
    this.invalidate();
  }

  toPlainText(): string {
    return this.renderRegions().map(({ text }) => text).join("\n");
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const state = STATE_PRESENTATION[this.snapshot.state];
    return [
      { id: "skill", role: "content", text: `Skill: ${this.snapshot.name}` },
      { id: "source", role: "content", text: `Source: ${this.snapshot.sourceScope}` },
      { id: "action", role: "content", text: `Action: ${titleCase(this.snapshot.action)}` },
      {
        id: "state",
        role: "status",
        ...(state.tone === undefined ? {} : { tone: state.tone }),
        text: `State: ${state.glyph} ${state.word}`,
      },
      { id: "result", role: "status", text: `Result: ${this.snapshot.result}` },
    ];
  }
}
