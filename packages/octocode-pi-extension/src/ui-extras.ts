/**
 * ui-extras — pure formatting helpers for Octocode's TUI surfaces.
 *
 * Kept side-effect-free so they can be unit-tested and reused by the footer,
 * working indicator, theme sync, and session-naming wiring in index.ts.
 */

import { contextGauge, paint, type PaintTheme, type SemanticToken } from './tui/palette.js';
// Route width helpers through render-helpers (which sanitizes tabs/control chars) rather
// than raw pi-tui, so footer/session strings are measured and cut at the true cell width.
import { truncateToWidth, truncatePlainToWidth } from './tools/render-helpers.js';
import { estimateTokens } from './utils.js';

export const OCTOCODE_SPINNER_FRAMES = ['✦', '✧', '✶', '✺', '✹', '✷', '✶', '✧'] as const;
export const OCTOCODE_SPINNER_INTERVAL_MS = 120;
const OCTOCODE_SPINNER_TOKENS: readonly SemanticToken[] = [
  'brand',
  'dim',
  'warning',
  'success',
  'brand',
  'link',
  'warning',
  'dim',
];

export interface WorkingIndicatorConfig {
  frames: string[];
  intervalMs: number;
}

/** Branded, color-pulsing working spinner frames for Pi's live working row. */
export function buildWorkingIndicator(theme?: PaintTheme): WorkingIndicatorConfig {
  return {
    frames: OCTOCODE_SPINNER_FRAMES.map((frame, index) =>
      paint(theme, OCTOCODE_SPINNER_TOKENS[index % OCTOCODE_SPINNER_TOKENS.length] ?? 'brand', frame),
    ),
    intervalMs: OCTOCODE_SPINNER_INTERVAL_MS,
  };
}

/** Shipped theme ids (single source of truth — used by the theme command + sync). */
export const OCTOCODE_THEME_DARK = 'octocode-dark';
export const OCTOCODE_THEME_LIGHT = 'octocode-light';
export type OctocodeThemeName = typeof OCTOCODE_THEME_DARK | typeof OCTOCODE_THEME_LIGHT;

/** 1234 → "1.2k", 45_000_000 → "45M", <1000 → as-is. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value < 1000) return String(Math.max(0, Math.round(value || 0)));
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  const m = value / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(m >= 10 ? 0 : 1)}M`;
}

/** ms → "0s" | "12s" | "1m 3s" | "1h 2m". Undefined → "—". */
export function formatDurationShort(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m ${totalSec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export interface WorkingLabelInput {
  startedAt: number;
  now: number;
}

/** Word shown in the live working line while a turn is active. */
export const WORKING_WORD = 'Thinking';

/**
 * Animated working-line label: `Thinking` with a cycling 1–3 dot tail driven by
 * elapsed time (advances once per second alongside the footer ticker).
 *
 * Deliberately carries NO elapsed time or token count — those already live in
 * the footer's `active`/`ctx` segments, so repeating them here was on-screen
 * redundancy. The smooth glyph animation comes from the working *indicator*
 * frames; this text supplies the "…" pulse.
 */
export function buildWorkingLabel(input: WorkingLabelInput): string {
  const elapsedMs = Math.max(0, input.now - input.startedAt);
  const dots = '.'.repeat((Math.floor(elapsedMs / 1000) % 3) + 1);
  return `${WORKING_WORD}${dots}`;
}

/**
 * Themed working message. Keeps the accessible word stable while the suffix
 * pulses in a brighter attention color; without a theme it is plain text.
 */
export function buildWorkingMessage(input?: WorkingLabelInput, theme?: PaintTheme): string {
  const suffix = input ? buildWorkingLabel(input).slice(WORKING_WORD.length) : '…';
  return `${paint(theme, 'brand', WORKING_WORD)}${paint(theme, 'warning', suffix)}`;
}

export interface FooterInput {
  tokens: number;
  contextWindow: number;
  completedTurns: number;
  activeTurnMs?: number;
  lastTurnMs?: number;
  sessionMs: number;
  activeWorkers: number;
  /** Total spawned worker records still tracked in the session ledger. */
  workerTotal?: number;
  /** Workers waiting on the lead (normalized [BLOCKED]). */
  blockedWorkers?: number;
  /** Workers that failed / crashed. */
  failedWorkers?: number;
  /** Live progress note for the most-recent running worker (name or its deltaSummary). */
  agentDoing?: string;
  /** Awareness Lite agents present in this workspace, shown in the lower toolbar. */
  awarenessAgents?: number;
  /** Active model-dial label (e.g. the dial preset name), shown as a branded segment. */
  dial?: string;
  /**
   * Per-turn Octocode harness prompt overhead, for the context-breakdown segment.
   * Estimated tokens use the ~4 chars/token heuristic. Distinct from the live `ctx`
   * running-total gauge (which comes from Pi's getContextUsage).
   */
  overhead?: { totalChars: number; sysChars: number; mcpServers: number; mcpTools: number; skills: number };
  branch?: string;
  dirty: boolean;
}

/** A footer segment plus the semantic colour it should paint with (default: dim). */
export interface FooterSegment {
  text: string;
  token?: SemanticToken;
}

/** Max width of inline footer progress labels before they are ellipsized. */
const INLINE_STATUS_MAX = 24;

function ellipsize(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  // Cell-width aware: CJK/emoji agent labels are 2 cells each, so a byte-length
  // cap would let the footer segment overflow its budget.
  return truncateToWidth(clean, max);
}

/**
 * Footer density modes (review follow-up: the toolbar should be tunable noise).
 * - compact: high-signal only — context gauge, worker count, blocked/failed
 *   attention flags, git branch.
 * - default: everything except the session-duration segment (rarely actionable).
 * - full: every segment, including session duration.
 */
export type FooterDensity = 'compact' | 'default' | 'full';

let footerDensity: FooterDensity = 'default';

export function getFooterDensity(): FooterDensity {
  return footerDensity;
}

export function setFooterDensity(density: FooterDensity): void {
  footerDensity = density;
}

/** Parse a user-supplied density name; undefined for anything unrecognized. */
export function parseFooterDensity(value: string | undefined): FooterDensity | undefined {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'compact' || normalized === 'default' || normalized === 'full' ? normalized : undefined;
}

/**
 * Ordered footer segments with per-segment colour. Optional segments (agents,
 * attention flags, git) are dropped when empty. Attention flags
 * (blocked/failed workers) get warning/error colour so a stuck worker is
 * visible in the toolbar without opening /octocode-agents. `density` trims
 * lower-signal segments; it defaults to the session-wide mode set by
 * /octocode-footer.
 */
export function buildFooterSegments(input: FooterInput, density: FooterDensity = footerDensity): FooterSegment[] {
  const segs: FooterSegment[] = [];
  const compact = density === 'compact';

  if (input.contextWindow > 0) {
    const gauge = contextGauge((input.tokens / input.contextWindow) * 100);
    segs.push({
      text: `ctx ${gauge.bar} ${gauge.pct}% ${formatCompact(input.tokens)}/${formatCompact(input.contextWindow)}`,
      token: gauge.token,
    });
  }

  if (!compact) {
    segs.push({ text: `turns ${input.completedTurns}` });

    segs.push({
      text: input.activeTurnMs !== undefined
        ? `active ${formatDurationShort(input.activeTurnMs)}`
        : `last ${formatDurationShort(input.lastTurnMs)}`,
    });

    if (density === 'full') segs.push({ text: `session ${formatDurationShort(input.sessionMs)}` });
  }

  const workerTotal = input.workerTotal ?? input.activeWorkers;
  if (workerTotal > 0) {
    const active = input.activeWorkers > 0 ? `/${input.activeWorkers} live` : '';
    const label = !compact && input.agentDoing ? ` ‣ ${ellipsize(input.agentDoing, INLINE_STATUS_MAX)}` : '';
    segs.push({ text: `agents ${workerTotal}${active}${label}` });
  }
  if (!compact && input.awarenessAgents && input.awarenessAgents > 0) {
    segs.push({ text: `aware-agents ${input.awarenessAgents}`, token: 'brand' });
  }
  if (input.blockedWorkers && input.blockedWorkers > 0) {
    segs.push({ text: `⚠${input.blockedWorkers}`, token: 'warning' });
  }
  if (input.failedWorkers && input.failedWorkers > 0) {
    segs.push({ text: `✗${input.failedWorkers}`, token: 'error' });
  }

  if (!compact && input.dial) {
    segs.push({ text: `◉ ${input.dial}`, token: 'brand' });
  }

  // Harness prompt overhead: total est. tokens with a system/mcp/skills breakdown.
  // Full density adds the breakdown; default shows just the total; compact drops it.
  if (!compact && input.overhead && input.overhead.totalChars > 0) {
    const o = input.overhead;
    const tok = (chars: number): string => formatCompact(estimateTokens(chars));
    const breakdown = density === 'full'
      ? ` (sys ${tok(o.sysChars)} · mcp ${o.mcpServers}/${o.mcpTools} · skills ${o.skills})`
      : '';
    segs.push({ text: `Σ~${tok(o.totalChars)}${breakdown}`, token: 'dim' });
  }

  if (input.branch) segs.push({ text: `${input.branch}${input.dirty ? '*' : ''}` });

  return segs;
}

/** Map macOS `AppleInterfaceStyle` ("Dark" when dark; unset otherwise) to our theme names. */
export function resolveSystemTheme(appleInterfaceStyle: string | null | undefined): OctocodeThemeName {
  return String(appleInterfaceStyle ?? '').trim().toLowerCase() === 'dark' ? OCTOCODE_THEME_DARK : OCTOCODE_THEME_LIGHT;
}

export interface SystemThemeSignals {
  platform: NodeJS.Platform | string;
  /** macOS `defaults read -g AppleInterfaceStyle` output ("Dark" only in dark mode). */
  appleInterfaceStyle?: string;
  /** Terminal COLORFGBG env, "fg;bg" (bg 0-6 = dark, 7/15 = light). */
  colorfgbg?: string;
}

/**
 * Cross-platform system theme detection. macOS is always decidable from
 * AppleInterfaceStyle; other platforms use the terminal's COLORFGBG background
 * code. Returns null when nothing decisive is available so callers can KEEP the
 * current theme instead of wrongly forcing light.
 */
export function resolveSystemThemeName(signals: SystemThemeSignals): OctocodeThemeName | null {
  if (signals.platform === 'darwin') {
    return resolveSystemTheme(signals.appleInterfaceStyle);
  }
  const cfb = String(signals.colorfgbg ?? '').trim();
  if (!cfb) return null;
  const parts = cfb.split(';');
  const bgRaw = parts[parts.length - 1];
  const bg = Number(bgRaw);
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return null;
  // Standard terminal palette: 0-6 (+8-14) are dark backgrounds; 7 and 15 are light.
  return bg === 7 || bg === 15 ? OCTOCODE_THEME_LIGHT : OCTOCODE_THEME_DARK;
}

const SESSION_NAME_MAX = 48;

/** First non-empty line, whitespace-collapsed, truncated to a session-name length. */
export function deriveSessionName(text: string): string {
  const firstLine = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  // Cell-width aware: CJK/emoji names are 2 cells each and must not overflow or be
  // sliced mid-surrogate the way a code-unit .slice would.
  return truncatePlainToWidth(clean, SESSION_NAME_MAX);
}
