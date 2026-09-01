import { OpenTuiWidget } from "./base.js";
import type {
  WidgetRenderAdapter,
  WidgetRenderRegion,
  WidgetRenderState,
} from "./contracts.js";
import { fitTerminalText, terminalDisplayWidth } from "./layout.js";
import { sanitizeSingleLineText, segmentGraphemes } from "./sanitize.js";
import { isNarrowOpenTuiLayout } from "../layout-policy.js";

export type FooterConnectionState =
  "connected" | "connecting" | "degraded" | "offline" | "error";
export type FooterContextThreshold =
  "unavailable" | "normal" | "warning" | "critical";

export interface FooterKeyHint {
  readonly key: string;
  readonly label: string;
  readonly priority?: number;
}

export interface FooterContextUsage {
  readonly used: number;
  readonly limit: number;
}

export interface FooterSnapshot {
  /** Only the runtime may assert footer connection, usage, and keymap facts. */
  readonly authority: "runtime";
  readonly activeMode: string;
  readonly connection: FooterConnectionState;
  readonly widthColumns: number;
  readonly keyHints: readonly FooterKeyHint[];
  readonly contextUsage?: FooterContextUsage;
  readonly activitySummary?: {
    readonly text: string;
    readonly tone: "info" | "success" | "warning" | "error" | "count";
  };
}

const MAX_MODE_LENGTH = 96;
const MAX_KEY_LENGTH = 48;
const MAX_KEY_LABEL_LENGTH = 160;
const MAX_KEY_HINTS = 12;
const MIN_WIDTH_COLUMNS = 20;
const MAX_WIDTH_COLUMNS = 1_000;

const CONNECTION_STATES: ReadonlySet<string> = new Set([
  "connected",
  "connecting",
  "degraded",
  "offline",
  "error",
]);
const ACTIVITY_TONES: ReadonlySet<string> = new Set([
  "info",
  "success",
  "warning",
  "error",
  "count",
]);

const AGENT_INSTRUCTIONS = {
  purpose:
    "Render the persistent terminal footer with active mode, connection, truthful context usage, and canonical key help.",
  useWhen: [
    "The interactive terminal needs a compact persistent summary of current mode and connection state.",
    "The active view has canonical keyboard actions or truthful context usage to expose.",
  ],
  avoidWhen: [
    "Rendering a transient notification, interaction prompt, transcript message, or tool result.",
    "Token counts, costs, connection state, or shortcuts are inferred rather than supplied by authoritative state.",
  ],
  inputs: [
    "A runtime-authoritative snapshot; reject model-authored or untagged connection, context, and keymap claims.",
    "A bounded active mode and one explicit connected, connecting, degraded, offline, or error state.",
    "The active keymap as unique key and action-label pairs in deterministic priority order.",
    "Optional used and limit counts only when both are truthful non-negative integers.",
    "The current terminal width in columns for responsive projection.",
  ],
  stateAndOutput: [
    "Keep mode and connection first, then a material context warning, then key hints by ascending priority.",
    "Never fabricate token counts, percentages, costs, key bindings, or connection health.",
    "Announce only mode changes, connection changes, and transitions between unavailable, normal, warning, and critical context thresholds.",
    "Provide a full linear alternate output even when the visual footer omits low-priority hints.",
  ],
  keys: [
    "This footer is read only and never receives focus or direct keyboard input.",
    "Display only shortcuts from the active canonical keymap; do not create footer-only bindings.",
  ],
  accessibility: [
    "Pair every connection and context state with explicit words; never rely on color alone.",
    "Expose a complete linear reading order of mode, connection, context, and active keys.",
    "Fit terminal text by Unicode grapheme without splitting emoji, combining marks, or joiner sequences.",
    "Keep live output polite and deduplicate non-material usage updates.",
  ],
  recovery: [
    "When truthful context counts are unavailable, say Context: unavailable and omit percentage and cost claims.",
    "When the terminal is narrow, retain mode and connection and progressively omit context and lower-priority key hints.",
    "Reject invalid widths, usage ratios, connection states, duplicate shortcuts, and oversized input at the state boundary.",
  ],
} as const;

function safeSingleLine(value: string, label: string, limit: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = sanitizeSingleLineText(
    value.replace(/[\r\n\u2028\u2029]/gu, " "),
    { maxGraphemes: 1_000_000, tabWidth: 1 },
  )
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0 || graphemes(normalized).length > limit) {
    throw new Error(`${label} must be a bounded non-empty value`);
  }
  return normalized;
}

function graphemes(value: string): readonly string[] {
  return segmentGraphemes(value);
}

function contextThreshold(
  usage: FooterContextUsage | undefined,
): FooterContextThreshold {
  if (usage === undefined) return "unavailable";
  const ratio = usage.used / usage.limit;
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.75) return "warning";
  return "normal";
}

function usagePercent(usage: FooterContextUsage): number {
  return Math.round((usage.used / usage.limit) * 100);
}

function contextText(usage: FooterContextUsage | undefined): string {
  if (usage === undefined) return "Context: unavailable";
  const threshold = contextThreshold(usage).toUpperCase();
  return `Context: ${threshold} ${usagePercent(usage)}% (${usage.used}/${usage.limit})`;
}

function normalizeSnapshot(snapshot: FooterSnapshot): FooterSnapshot {
  if (snapshot?.authority !== "runtime") {
    throw new Error("footer snapshot requires runtime authority");
  }
  const activeMode = safeSingleLine(
    snapshot.activeMode,
    "active mode",
    MAX_MODE_LENGTH,
  );
  if (!CONNECTION_STATES.has(snapshot.connection))
    throw new Error("connection state is invalid");
  if (
    !Number.isSafeInteger(snapshot.widthColumns) ||
    snapshot.widthColumns < MIN_WIDTH_COLUMNS ||
    snapshot.widthColumns > MAX_WIDTH_COLUMNS
  ) {
    throw new Error("footer width is outside its supported bounds");
  }
  if (
    !Array.isArray(snapshot.keyHints) ||
    snapshot.keyHints.length > MAX_KEY_HINTS
  ) {
    throw new Error("footer key hints exceed their item bound");
  }

  const seen = new Set<string>();
  const keyHints = snapshot.keyHints
    .map((hint, index) => {
      const key = safeSingleLine(
        hint.key,
        `key hint ${index} key`,
        MAX_KEY_LENGTH,
      );
      const label = safeSingleLine(
        hint.label,
        `key hint ${index} label`,
        MAX_KEY_LABEL_LENGTH,
      );
      const normalizedKey = key.toLocaleLowerCase("en-US");
      if (seen.has(normalizedKey))
        throw new Error(`duplicate key hint '${key}'`);
      seen.add(normalizedKey);
      const priority = hint.priority ?? index;
      if (!Number.isSafeInteger(priority) || priority < 0 || priority > 1_000) {
        throw new Error(`key hint ${index} priority is invalid`);
      }
      return Object.freeze({ key, label, priority });
    })
    .sort(
      (left, right) =>
        left.priority - right.priority || left.key.localeCompare(right.key),
    );

  let contextUsage: FooterContextUsage | undefined;
  if (snapshot.contextUsage !== undefined) {
    const { used, limit } = snapshot.contextUsage;
    if (
      !Number.isSafeInteger(used) ||
      !Number.isSafeInteger(limit) ||
      used < 0 ||
      limit <= 0 ||
      used > limit
    ) {
      throw new Error(
        "context usage requires truthful used and limit integers",
      );
    }
    contextUsage = Object.freeze({ used, limit });
  }
  if (
    snapshot.activitySummary !== undefined &&
    !ACTIVITY_TONES.has(snapshot.activitySummary.tone)
  ) {
    throw new Error("activity summary tone is invalid");
  }
  const activitySummary =
    snapshot.activitySummary === undefined
      ? undefined
      : Object.freeze({
          text: safeSingleLine(
            snapshot.activitySummary.text,
            "activity summary",
            240,
          ),
          tone: snapshot.activitySummary.tone,
        });

  return Object.freeze({
    authority: "runtime",
    activeMode,
    connection: snapshot.connection,
    widthColumns: snapshot.widthColumns,
    keyHints: Object.freeze(keyHints),
    ...(contextUsage === undefined ? {} : { contextUsage }),
    ...(activitySummary === undefined ? {} : { activitySummary }),
  });
}

function sameSnapshot(left: FooterSnapshot, right: FooterSnapshot): boolean {
  if (
    left.activeMode !== right.activeMode ||
    left.connection !== right.connection ||
    left.widthColumns !== right.widthColumns ||
    left.contextUsage?.used !== right.contextUsage?.used ||
    left.contextUsage?.limit !== right.contextUsage?.limit ||
    left.activitySummary?.text !== right.activitySummary?.text ||
    left.activitySummary?.tone !== right.activitySummary?.tone ||
    left.keyHints.length !== right.keyHints.length
  )
    return false;
  return left.keyHints.every((hint, index) => {
    const other = right.keyHints[index];
    return (
      other !== undefined &&
      hint.key === other.key &&
      hint.label === other.label &&
      hint.priority === other.priority
    );
  });
}

export class FooterWidget extends OpenTuiWidget {
  private snapshot: FooterSnapshot;
  private readonly announcements: string[] = [];

  constructor(id: string, initial: FooterSnapshot) {
    super({
      id,
      kind: "footer",
      capabilities: { focusable: false, inputMode: "none" },
      accessibility: {
        role: "contentinfo",
        label: "Terminal footer",
        description:
          "Active mode, connection, context usage, and canonical keyboard help.",
        liveRegion: "polite",
        keyboardHelp: [
          "Read only; listed shortcuts are handled by their owning active view.",
        ],
      },
      instructions: AGENT_INSTRUCTIONS,
    });
    this.snapshot = normalizeSnapshot(initial);
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  update(next: FooterSnapshot): void {
    const normalized = normalizeSnapshot(next);
    if (sameSnapshot(this.snapshot, normalized)) return;

    if (this.snapshot.activeMode !== normalized.activeMode) {
      this.announcements.push(
        `Active mode changed to ${normalized.activeMode}.`,
      );
    }
    if (this.snapshot.connection !== normalized.connection) {
      this.announcements.push(
        `Connection state changed to ${normalized.connection}.`,
      );
    }
    const previousThreshold = contextThreshold(this.snapshot.contextUsage);
    const nextThreshold = contextThreshold(normalized.contextUsage);
    if (previousThreshold !== nextThreshold) {
      const suffix =
        normalized.contextUsage === undefined
          ? ""
          : ` at ${usagePercent(normalized.contextUsage)}%`;
      this.announcements.push(
        `Context usage entered ${nextThreshold}${suffix}.`,
      );
    }

    this.snapshot = normalized;
    this.invalidate();
  }

  takeAnnouncements(): readonly string[] {
    const pending = Object.freeze([...this.announcements]);
    this.announcements.length = 0;
    return pending;
  }

  toPlainText(): string {
    return [
      `Mode: ${this.snapshot.activeMode}`,
      `Connection: ${this.snapshot.connection.toUpperCase()}`,
      contextText(this.snapshot.contextUsage),
      ...(this.snapshot.activitySummary === undefined
        ? []
        : [`Activity: ${this.snapshot.activitySummary.text}`]),
      "Active keys:",
      ...(this.snapshot.keyHints.length === 0
        ? ["- None"]
        : this.snapshot.keyHints.map((hint) => `- ${hint.key}: ${hint.label}`)),
    ].join("\n");
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const separatorWidth = 3;
    const connection = `Connection: ${this.snapshot.connection.toUpperCase()}`;
    if (
      isNarrowOpenTuiLayout(this.snapshot.widthColumns) &&
      this.snapshot.activitySummary !== undefined
    ) {
      return [
        {
          id: "activity",
          role: "status",
          tone: this.snapshot.activitySummary.tone,
          text: fitTerminalText(
            `${this.snapshot.activitySummary.text} · ${connection}`,
            this.snapshot.widthColumns,
          ),
        },
      ];
    }
    const modeAvailable = Math.max(
      4,
      this.snapshot.widthColumns -
        terminalDisplayWidth(connection) -
        separatorWidth,
    );
    const mode = fitTerminalText(
      `Mode: ${this.snapshot.activeMode}`,
      modeAvailable,
    );
    const regions: WidgetRenderRegion[] = [
      { id: "mode", role: "content", text: mode },
      {
        id: "connection",
        role: "status",
        text: fitTerminalText(
          connection,
          this.snapshot.widthColumns -
            terminalDisplayWidth(mode) -
            separatorWidth,
        ),
      },
    ];
    let usedWidth =
      terminalDisplayWidth(mode) +
      separatorWidth +
      terminalDisplayWidth(regions[1]?.text ?? "");

    const candidates: WidgetRenderRegion[] = [
      ...(this.snapshot.activitySummary === undefined
        ? []
        : [
            {
              id: "activity",
              role: "status" as const,
              tone: this.snapshot.activitySummary.tone,
              text: this.snapshot.activitySummary.text,
            },
          ]),
      {
        id: "context",
        role: "status",
        text: contextText(this.snapshot.contextUsage),
      },
      ...this.snapshot.keyHints.map((hint, index) => ({
        id: `key-${index}`,
        role: "help" as const,
        text: `${hint.key} ${hint.label}`,
      })),
    ];
    const acceptedKeys: string[] = [];
    for (const candidate of candidates) {
      const candidateWidth =
        separatorWidth + terminalDisplayWidth(candidate.text);
      if (usedWidth + candidateWidth > this.snapshot.widthColumns) continue;
      usedWidth += candidateWidth;
      if (candidate.role === "help") acceptedKeys.push(candidate.text);
      else regions.push(candidate);
    }
    if (acceptedKeys.length > 0) {
      regions.push({
        id: "keys",
        role: "help",
        text: acceptedKeys.join(" · "),
      });
    }
    return regions;
  }
}
