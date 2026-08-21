/**
 * Pure functions for rendering the Octocode banner and tagline.
 *
 * All output is width-safe: every line is measured and truncated through the
 * same ANSI-aware helpers used by the rest of the extension so pi's TUI never
 * sees a line whose visible width exceeds the terminal width.
 */

import { truncatePlainToWidth, truncateToWidth } from '../tools/render-helpers.js';

// ─── Minimal theme interface ──────────────────────────────────────────────────

/** Subset of PiTheme required by banner functions. */
export interface BannerTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GLYPH = '◆';
const TAGLINE_TEXT = 'Your AI coding agent';

/** Theme token that resolves to the lavender/purple brand var (#A5B4FC). */
const OCTOPUS_COLOR = 'mdLink';

/**
 * Purple octopus mascot shown above the wordmark in the header, animated like a
 * tiny shader: the glyph frame is a pure function of a time tick (tentacles
 * sway, the skirt ripples, eyes blink, sparkles twinkle) and the paint pass
 * sweeps a bold diagonal gloss band across the body. Sparkles (✦ ✧) paint
 * gold; the body paints the lavender brand var. Width-safe: every line is
 * clipped to the terminal width before painting.
 */
const OCTOPUS_BASE: readonly string[] = [
  '       .-~~~-.',
  '   ✦  ( o   o )',
  '       )  ~  (   ✧',
  "    .-'~~~~~~~'-.",
  '   ( ( ( | | ) ) )',
  '    \\_/ / | \\ \\_/',
  '       (_/ \\_)',
];

/** Alternate tentacle pose (rows 4-6): outer arms swing, feet curl the other way. */
const OCTOPUS_SWAY: readonly string[] = [
  '   ) ( ( | | ) ) (',
  '    \\_\\ \\ | / /_/',
  '       (_) (_)',
];

/** First row of OCTOPUS_BASE replaced by OCTOPUS_SWAY on odd ticks. */
const SWAY_ROW = 4;
/** Rows whose `~` glyphs carry the travelling ripple (head crown + skirt hem). */
const RIPPLE_ROWS: ReadonlySet<number> = new Set([0, 3]);
/** Eyes blink for one tick out of every BLINK_EVERY. */
const BLINK_EVERY = 8;

/** One animation tick (frame advance) every this many ms. */
export const OCTOPUS_TICK_MS = 240;
/** One full gloss sweep across the mascot takes this many ticks. */
const SHIMMER_BAND = 3;
const OCTOPUS_SPAN =
  Math.max(...OCTOPUS_BASE.map((l) => l.length)) + OCTOPUS_BASE.length + SHIMMER_BAND;

/**
 * The plain (unpainted) glyph frame for an animation tick: tentacles alternate
 * between two poses, a ripple travels through the `~` rows, the eyes blink
 * every BLINK_EVERY ticks, and the sparkles trade shapes. Pure — same tick,
 * same frame.
 */
export function octopusGlyphFrame(tick: number): string[] {
  const t = Math.max(0, Math.floor(tick));
  const rows = [...OCTOPUS_BASE];
  if (t % 2 === 1) OCTOPUS_SWAY.forEach((line, i) => { rows[SWAY_ROW + i] = line; });
  return rows.map((line, row) => {
    let out = line;
    if (RIPPLE_ROWS.has(row)) {
      out = [...out].map((ch, col) => (ch === '~' && (col + t) % 3 === 0 ? '-' : ch)).join('');
    }
    if (row === 1 && t % BLINK_EVERY === BLINK_EVERY - 1) out = out.replace(/o/g, '-');
    if (t % 2 === 1) out = out.replace(/[✦✧]/g, (m) => (m === '✦' ? '✧' : '✦'));
    return out;
  });
}

/**
 * Paint the animated octopus. The frame and the diagonal gloss-band position
 * both derive from `nowMs`, so the mascot moves and shines whenever the host
 * re-renders (pi redraws the header on every working tick); between renders it
 * is simply a static, valid frame. Pass a fixed `nowMs` for deterministic
 * output in tests.
 */
export function renderOctopusLines(
  theme: BannerTheme,
  width: number,
  nowMs: number = Date.now(),
): string[] {
  const tick = Math.floor(nowMs / OCTOPUS_TICK_MS);
  const phase = (tick % OCTOPUS_SPAN) - SHIMMER_BAND;
  return octopusGlyphFrame(tick).map((line, row) => {
    // Clip the PLAIN art to width first (truncatePlainToWidth injects no SGR
    // resets, unlike truncateToWidth), then paint the surviving glyphs — the
    // per-character paint calls would otherwise distort the width measurement.
    const clipped = truncatePlainToWidth(line, width);
    let painted = '';
    for (let col = 0; col < clipped.length; col++) {
      const ch = clipped[col]!;
      if (ch === ' ') {
        painted += ch;
      } else if (ch === '✦' || ch === '✧') {
        painted += theme.fg('warning', ch);
      } else {
        const d = col - row - phase;
        painted +=
          d >= 0 && d < SHIMMER_BAND
            ? theme.bold(theme.fg('text', ch))
            : theme.fg(OCTOPUS_COLOR, ch);
      }
    }
    return painted;
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// 'text' maps to the default foreground in the shipped themes (no band at all),
// so the middle band uses the lavender brand var instead — gray → purple → teal
// actually reads as three metallic bands.
const METALLIC_WORDMARK_PARTS: Array<readonly [color: string, text: string]> = [
  ['muted', 'Oct'],
  [OCTOPUS_COLOR, 'oco'],
  ['accent', 'de'],
];

/**
 * Static shimmer-style wordmark: use a few semantic color bands so it reads as
 * metallic without a terminal animation loop, noisy ANSI output, or width drift.
 */
function renderMetallicWordmark(theme: BannerTheme): string {
  return theme.bold(
    METALLIC_WORDMARK_PARTS.map(([color, text]) => theme.fg(color, text)).join('')
  );
}

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
  const wordmark = renderMetallicWordmark(theme);
  const versionStr = version ? theme.fg('muted', ` v${version}`) : '';
  const mainLine = `${glyph} ${wordmark}${versionStr}`;

  return [...renderOctopusLines(theme, width), truncateToWidth(mainLine, width)];
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
