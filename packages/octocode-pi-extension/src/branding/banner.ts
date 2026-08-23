/**
 * Pure functions for rendering the Octocode banner and tagline.
 *
 * All output is width-safe: every line is measured and truncated through the
 * same ANSI-aware helpers used by the rest of the extension so pi's TUI never
 * sees a line whose visible width exceeds the terminal width.
 */

import { truncatePlainToWidth, truncateToWidth, visibleWidth } from '../tools/render-helpers.js';
import { BETA_ISSUES_PREFIX, BETA_ISSUES_URL, BETA_LABEL, TAGLINE } from '../tui/content.js';
import { paint, SEP, type SemanticToken } from '../tui/palette.js';

// ─── Minimal theme interface ──────────────────────────────────────────────────

/** Subset of PiTheme required by banner functions. */
export interface BannerTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// ─── Constants ────────────────────────────────────────────────────────────────


/**
 * Octocode banner art: the lens + octopus emblem on top, the block-style
 * OCTOCODE wordmark (figlet "ANSI Shadow" face) below. Painted by
 * renderWordmarkLines with a STATIC purple gradient. Duplicated by design in
 * octocode-agent `src/ui.ts` (raw 256-color substrate) — keep the two copies
 * in sync by eye.
 */
const WORDMARK_ART: readonly string[] = [
  ' ██████╗  ██████╗████████╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔═══██╗██╔════╝╚══██╔══╝██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██║   ██║██║        ██║   ██║   ██║██║     ██║   ██║██║  ██║█████╗',
  '██║   ██║██║        ██║   ██║   ██║██║     ██║   ██║██║  ██║██╔══╝',
  '╚██████╔╝╚██████╗   ██║   ╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗',
  ' ╚═════╝  ╚═════╝   ╚═╝    ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

/**
 * Natural column width of the wordmark art — the widest of its rows (~68).
 * Below this the art can't be shown honestly: a hard clip turns every row into
 * a mid-letter fragment + "…", stacking six ellipses over broken block-letters.
 * So under this width renderWordmarkLines drops the art and falls back to the
 * compact `🔍🐙 Octocode` brand mark, which reads fine at any width.
 */
const WORDMARK_WIDTH = WORDMARK_ART.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);

/** Emoji lens+octopus mark prefixing the compact brand line (same glyphs as the HTML page / octocode CLI). */
const BRAND_MARK_EMOJI = '🔍🐙';

/** Product name shown after the emoji mark on the compact brand line. */
const BRAND_NAME = 'Octocode';

/**
 * Static purple ramp keyed by a small math equation instead of fixed columns.
 * `gradient = 0.68·diagonal + 0.24·sinusoidalGlow - 0.20·lensGlint` keeps
 * the mark mostly purple/lavender, adds a glossy highlight where the lens
 * should catch light, and leaves a muted violet shadow at the far edge.
 * No teal/cyan detours: the banner should read as purple first.
 *
 * Deliberately NOT animated: the banner is a transcript entry at the top of
 * the scrollback, and any time-varying bytes there invalidate pi-tui's line
 * diff for everything below it on every repaint — which surfaced as scroll
 * jumps while the model streamed.
 */
const PURPLE_RAMP: readonly SemanticToken[] = [
  'bright', // white/lavender glint
  'link',   // lavender
  'brand',  // purple accent
  'title',  // saturated purple title token
  'brand',
  'link',
  'muted',  // violet-gray shadow
];

function purpleGradientToken(row: number, col: number, lineWidth: number): SemanticToken {
  const maxRow = Math.max(1, WORDMARK_ART.length - 1);
  const maxCol = Math.max(1, lineWidth - 1);
  const x = col / maxCol;
  const y = row / maxRow;
  const diagonal = (x + y) / 2;
  const sinusoidalGlow = 0.5 + 0.5 * Math.sin(Math.PI * (1.2 * x - 0.65 * y + 0.18));
  const lensGlint = Math.max(0, 1 - Math.hypot(x - 0.16, y - 0.08) * 7);
  const gradient = Math.max(0, Math.min(1, 0.68 * diagonal + 0.24 * sinusoidalGlow - 0.2 * lensGlint));
  return PURPLE_RAMP[Math.min(PURPLE_RAMP.length - 1, Math.floor(gradient * PURPLE_RAMP.length))] ?? 'brand';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * The banner art painted with the static brand gradient. Pure in (theme,
 * width): identical input → byte-identical output, so repaints are free.
 * Width-safe: the PLAIN art is clipped first (truncatePlainToWidth injects no
 * SGR resets), then the surviving glyphs are painted.
 */
export function renderWordmarkLines(theme: BannerTheme, width: number): string[] {
  // Narrow terminals: the ~68-column ANSI-Shadow art cannot survive a hard clip
  // (each row degrades to a mid-letter fragment + "…"), so below the art's
  // natural width fall back to the single compact brand mark, which renders
  // cleanly at any width. Still pure in (theme, width) — no animation.
  if (width < WORDMARK_WIDTH) {
    const mark = `${BRAND_MARK_EMOJI} ${paint(theme, 'title', theme.bold(BRAND_NAME))}`;
    return [truncateToWidth(mark, width)];
  }
  return WORDMARK_ART.map((line, row) => {
    const clipped = truncatePlainToWidth(line, width);
    let painted = '';
    let col = 0;
    // Code-point iteration keeps any future astral-plane glyph in the art
    // from being split into lone surrogates by a code-unit index.
    for (const ch of clipped) {
      if (ch === ' ') {
        painted += ch;
      } else {
        painted += paint(theme, purpleGradientToken(row, col, clipped.length), ch);
      }
      col++;
    }
    return painted;
  });
}

/**
 * Build the main Octocode banner block: the colored OCTOCODE wordmark topped
 * off with the official `🔍🐙 Octocode` brand line (same mark as the published
 * `octocode` CLI), which also carries the optional version.
 *
 * Returns an array of width-safe strings (ANSI codes included) ready to be
 * passed to a pi TUI renderer. Each string is individually truncated to
 * `width` so callers can append them directly to a `makeRenderer` output.
 *
 * @param theme  A BannerTheme (fg + bold).
 * @param width  Available terminal width in columns.
 * @param version  Optional semver string shown after the wordmark, e.g. `"1.2.3"`.
 */
export function renderBannerLines(theme: BannerTheme, width: number, version?: string): string[] {
  const versionStr = version ? paint(theme, 'muted', `v${version}`) : '';
  const wordmark = renderWordmarkLines(theme, width);

  return versionStr ? [...wordmark, truncateToWidth(versionStr, width)] : wordmark;
}

/**
 * Build a single tagline line.
 *
 * @param theme  A BannerTheme (fg + bold).
 * @param width  Available terminal width in columns.
 */
export function renderTagline(theme: BannerTheme, width: number): string {
  const line = paint(theme, 'muted', TAGLINE);
  return truncateToWidth(line, width);
}

/**
 * Beta notice: gold label (this IS an act-on-me state — expect rough edges)
 * followed by a visible issue-tracker URL. Keep the URL literal instead of OSC 8
 * here: startup lines are width-sanitized/truncated, and raw URLs are more
 * reliable across terminals while still auto-linking in most emulators.
 */
export function renderBetaNotice(theme: BannerTheme, width: number): string {
  const line = `${paint(theme, 'warning', BETA_LABEL)} ${paint(theme, 'muted', `· ${BETA_ISSUES_PREFIX}`)} ${paint(theme, 'link', BETA_ISSUES_URL)}`;
  return truncateToWidth(line, width);
}

/**
 * Optional live session snapshot surfaced below the beta notice.
 * Data is captured once when the banner entry is appended (at session_start)
 * so it reads as a startup summary, not a live readout — avoids time-varying
 * bytes in a transcript entry (which would invalidate pi-tui's line diff and
 * cause scroll jumps during streaming).
 */
export interface BannerSessionInfo {
  /** Model identifier (e.g. "claude-opus-4-5"). */
  model?: string;
  /** Provider name (e.g. "anthropic"). */
  provider?: string;
  /** Thinking level active at session start (e.g. "medium"). */
  thinking?: string;
}

/**
 * Render a single muted session-info line: `model: provider/id · thinking: level`.
 * Returns `null` when there is nothing worth showing.
 */
export function renderSessionInfoLine(theme: BannerTheme, width: number, info: BannerSessionInfo): string | null {
  const parts: string[] = [];
  if (info.model && info.provider) parts.push(`model: ${info.provider}/${info.model}`);
  else if (info.model) parts.push(`model: ${info.model}`);
  if (info.thinking) parts.push(`thinking: ${info.thinking}`);
  if (parts.length === 0) return null;
  return truncateToWidth(paint(theme, 'muted', parts.join(SEP)), width);
}

/**
 * Convenience: banner lines, then the tagline, then the beta notice,
 * and optionally a session-info snapshot line when `info` is provided.
 */
export function renderBannerWithTagline(theme: BannerTheme, width: number, version?: string, info?: BannerSessionInfo): string[] {
  const lines: string[] = [...renderBannerLines(theme, width, version), renderTagline(theme, width), renderBetaNotice(theme, width)];
  if (info) {
    const infoLine = renderSessionInfoLine(theme, width, info);
    if (infoLine !== null) lines.push(infoLine);
  }
  return lines;
}
