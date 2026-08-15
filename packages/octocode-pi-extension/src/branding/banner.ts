/**
 * Pure functions for rendering the Octocode banner and tagline.
 *
 * All output is width-safe: every line is measured and truncated through the
 * same ANSI-aware helpers used by the rest of the extension so pi's TUI never
 * sees a line whose visible width exceeds the terminal width.
 */

import { truncateToWidth, visibleWidth } from '../tools/render-helpers.js';

// ─── Minimal theme interface ──────────────────────────────────────────────────

/** Subset of PiTheme required by banner functions. */
export interface BannerTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GLYPH = '◆';
const WORDMARK = 'Octocode';
const TAGLINE_TEXT = 'Your AI coding agent';

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the main Octocode banner block.
 *
 * Returns an array of width-safe strings (ANSI codes included) ready to be
 * passed to a pi TUI renderer. Each string is individually truncated to
 * `width` so callers can append them directly to a `makeRenderer` output.
 *
 * @param theme  A BannerTheme (fg + bold).
 * @param width  Available terminal width in columns.
 * @param version  Optional semver string shown after the wordmark, e.g. `"1.2.3"`.
 */
export function renderBannerLines(
  theme: BannerTheme,
  width: number,
  version?: string,
): string[] {
  const glyph = theme.fg('accent', GLYPH);
  const wordmark = theme.bold(theme.fg('accent', WORDMARK));
  const versionStr = version ? theme.fg('muted', ` v${version}`) : '';
  const mainLine = `${glyph} ${wordmark}${versionStr}`;

  return [truncateToWidth(mainLine, width)];
}

/**
 * Build a single tagline line.
 *
 * @param theme  A BannerTheme (fg + bold).
 * @param width  Available terminal width in columns.
 */
export function renderTagline(theme: BannerTheme, width: number): string {
  const line = theme.fg('muted', TAGLINE_TEXT);
  return truncateToWidth(line, width);
}

/**
 * Convenience: return banner lines followed by the tagline.
 */
export function renderBannerWithTagline(
  theme: BannerTheme,
  width: number,
  version?: string,
): string[] {
  return [...renderBannerLines(theme, width, version), renderTagline(theme, width)];
}

export { visibleWidth, truncateToWidth };
