/**
 * ui-extras — pure formatting helpers for Octocode's TUI surfaces.
 *
 * Kept side-effect-free so they can be unit-tested and reused by the footer,
 * working indicator, theme sync, and session-naming wiring in index.ts.
 */

import { contextGauge, type SemanticToken } from './tui/palette.js';

export const OCTOCODE_SPINNER_FRAMES = ['◆', '◇', '◈', '◇'] as const;

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

export interface FooterInput {
  tokens: number;
  contextWindow: number;
  completedTurns: number;
  activeTurnMs?: number;
  lastTurnMs?: number;
  sessionMs: number;
  activeWorkers: number;
  /** Workers waiting on the lead (normalized [BLOCKED]). */
  blockedWorkers?: number;
  /** Workers that failed / crashed. */
  failedWorkers?: number;
  /** Live progress note for the most-recent running worker (name or its deltaSummary). */
  agentDoing?: string;
  planDone: number;
  planTotal: number;
  /** Text of the plan step currently in progress (status "doing"), if any. */
  planDoing?: string;
  branch?: string;
  dirty: boolean;
}

/** A footer segment plus the semantic colour it should paint with (default: dim). */
export interface FooterSegment {
  text: string;
  token?: SemanticToken;
}

/** Max width of the inline plan-step label before it is ellipsized. */
const PLAN_DOING_MAX = 24;

function ellipsize(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Ordered footer segments with per-segment colour. Optional segments (agents,
 * attention flags, plan, git) are dropped when empty. Attention flags
 * (blocked/failed workers) get warning/error colour so a stuck worker is
 * visible in the toolbar without opening /octocode-agents.
 */
export function buildFooterSegments(input: FooterInput): FooterSegment[] {
  const segs: FooterSegment[] = [];

  if (input.contextWindow > 0) {
    const pct = Math.round((input.tokens / input.contextWindow) * 100);
    const { bar } = contextGauge(pct);
    segs.push({ text: `ctx ${bar} ${pct}% ${formatCompact(input.tokens)}/${formatCompact(input.contextWindow)}` });
  }

  segs.push({ text: `turns ${input.completedTurns}` });

  segs.push({
    text: input.activeTurnMs !== undefined
      ? `active ${formatDurationShort(input.activeTurnMs)}`
      : `last ${formatDurationShort(input.lastTurnMs)}`,
  });

  segs.push({ text: `session ${formatDurationShort(input.sessionMs)}` });

  if (input.activeWorkers > 0) {
    const label = input.agentDoing ? ` ‣ ${ellipsize(input.agentDoing, PLAN_DOING_MAX)}` : '';
    segs.push({ text: `agents ${input.activeWorkers}${label}` });
  }
  if (input.blockedWorkers && input.blockedWorkers > 0) {
    segs.push({ text: `⚠${input.blockedWorkers}`, token: 'warning' });
  }
  if (input.failedWorkers && input.failedWorkers > 0) {
    segs.push({ text: `✗${input.failedWorkers}`, token: 'error' });
  }

  if (input.planTotal > 0) {
    const label = input.planDoing ? ` ‣ ${ellipsize(input.planDoing, PLAN_DOING_MAX)}` : '';
    segs.push({ text: `plan ${input.planDone}/${input.planTotal}${label}` });
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
  if (clean.length <= SESSION_NAME_MAX) return clean;
  return `${clean.slice(0, SESSION_NAME_MAX - 1)}…`;
}
