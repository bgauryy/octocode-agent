/**
 * ui-extras — pure formatting helpers for Octocode's TUI surfaces.
 *
 * Kept side-effect-free so they can be unit-tested and reused by the footer,
 * working indicator, theme sync, and session-naming wiring in index.ts.
 */

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
  tokens?: number;
}

/** "◆ Octocode · 12s · 13.4k tokens" (tokens omitted when unknown). */
export function buildWorkingLabel(input: WorkingLabelInput): string {
  const elapsed = formatDurationShort(input.now - input.startedAt);
  const parts = ['◆ Octocode', elapsed];
  if (typeof input.tokens === 'number' && input.tokens > 0) {
    parts.push(`${formatCompact(input.tokens)} tokens`);
  }
  return parts.join(' · ');
}

export interface FooterInput {
  tokens: number;
  contextWindow: number;
  completedTurns: number;
  activeTurnMs?: number;
  lastTurnMs?: number;
  sessionMs: number;
  activeWorkers: number;
  planDone: number;
  planTotal: number;
  branch?: string;
  dirty: boolean;
}

/** Ordered footer segments; optional ones (agents, plan, git) are dropped when empty. */
export function buildFooterSegments(input: FooterInput): string[] {
  const segs: string[] = [];

  if (input.contextWindow > 0) {
    const pct = Math.round((input.tokens / input.contextWindow) * 100);
    segs.push(`ctx ${pct}% ${formatCompact(input.tokens)}/${formatCompact(input.contextWindow)}`);
  }

  segs.push(`turns ${input.completedTurns}`);

  segs.push(
    input.activeTurnMs !== undefined
      ? `active ${formatDurationShort(input.activeTurnMs)}`
      : `last ${formatDurationShort(input.lastTurnMs)}`,
  );

  segs.push(`session ${formatDurationShort(input.sessionMs)}`);

  if (input.activeWorkers > 0) segs.push(`agents ${input.activeWorkers}`);
  if (input.planTotal > 0) segs.push(`plan ${input.planDone}/${input.planTotal}`);
  if (input.branch) segs.push(`${input.branch}${input.dirty ? '*' : ''}`);

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
