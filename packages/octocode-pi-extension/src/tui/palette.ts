/**
 * palette — single source of truth for Octocode TUI presentation.
 *
 * The shipped `themes/octocode-dark.json` / `octocode-light.json` own the actual
 * hex values; pi resolves a *token name* passed to `theme.fg(token, text)`.
 * This module names those tokens semantically (path / link / count / …) so tool
 * renderers stop sprinkling magic strings and every surface presents the same
 * kind of data in the same colour. It also owns the terminal "hacks" that pi's
 * theme cannot express: OSC 8 hyperlinks, a NO_COLOR/FORCE_COLOR gate, and the
 * context-window gauge bar.
 */

// ─── Semantic token names (must exist in the shipped theme `colors` map) ───────

/**
 * Semantic → theme-token mapping. Keys are how the rest of the extension should
 * think about a value ("this is a path"); values are the concrete theme tokens
 * defined in themes/octocode-*.json. Change a mapping here, not in every caller.
 */
export const TOKEN = {
  /** Brand accent (teal). */
  brand: 'accent',
  /** File / directory paths. */
  path: 'accent',
  /** Clickable URLs / links (lavender, matches markdown links). */
  link: 'mdLink',
  /** The raw URL tail shown after a link. */
  linkUrl: 'mdLinkUrl',
  /** Numeric counts / totals (gold). */
  count: 'syntaxNumber',
  /** Symbol / identifier names (cyan). */
  symbol: 'syntaxType',
  /** Tool title. */
  title: 'toolTitle',
  /** Success / ok. */
  success: 'success',
  /** Error / failure. */
  error: 'error',
  /** Warning / in-progress. */
  warning: 'warning',
  /** Secondary text. */
  muted: 'muted',
  /** Tertiary / faint text. */
  dim: 'dim',
  /** Added diff line. */
  diffAdd: 'toolDiffAdded',
  /** Removed diff line. */
  diffRemove: 'toolDiffRemoved',
  /** Unchanged diff context line. */
  diffContext: 'toolDiffContext',
} as const;

export type SemanticToken = keyof typeof TOKEN;

/** Minimal theme surface used by presentation helpers (subset of PiTheme). */
export interface PaintTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/**
 * Paint `text` with a semantic token via the active theme. Falls back to the
 * raw text when no theme is available (non-TUI / plain output).
 */
export function paint(theme: PaintTheme | undefined, token: SemanticToken, text: string): string {
  return theme?.fg(TOKEN[token], text) ?? text;
}

// ─── Terminal capability gates ─────────────────────────────────────────────────

function envFlag(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Whether ANSI colour should be emitted for raw (non-theme) output streams.
 *
 * Honors the https://no-color.org convention: `NO_COLOR` (any non-empty value)
 * wins and disables colour; `FORCE_COLOR` forces it on. Theme-routed rendering
 * is unaffected — pi owns that — this only guards raw escape codes we emit
 * ourselves (e.g. diff text in a tool result string).
 */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlag(env['NO_COLOR'])) return false;
  if (envFlag(env['FORCE_COLOR'])) return true;
  return true;
}

/**
 * Whether to emit OSC 8 hyperlinks. Off when colour is off. Some emulators
 * mangle OSC 8 (e.g. Guacamole, certain multiplexers), so `OCTOCODE_HYPERLINKS`
 * ("0"/"false" to disable, any other value to force) provides an explicit
 * override.
 */
export function hyperlinksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env['OCTOCODE_HYPERLINKS'];
  if (override !== undefined) return envFlag(override);
  return colorEnabled(env);
}

// ─── OSC 8 hyperlinks ───────────────────────────────────────────────────────────

const OSC = '\x1b]8;;';
const BEL = '\x07';

/**
 * Wrap `text` in an OSC 8 terminal hyperlink pointing at `url`.
 *
 * Returns `text` unchanged when hyperlinks are disabled or `url` is empty, so
 * callers can use it unconditionally. Display text defaults to the URL.
 */
export function hyperlink(url: string, text = url, env: NodeJS.ProcessEnv = process.env): string {
  if (!url || !hyperlinksEnabled(env)) return text;
  return `${OSC}${url}${BEL}${text}${OSC}${BEL}`;
}

/** True when `value` looks like an http(s) URL we can linkify. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

// ─── Context-window gauge ───────────────────────────────────────────────────────

export interface ContextGauge {
  /** The bar glyphs, e.g. "▓▓▓░░░░░". */
  bar: string;
  /** Semantic token reflecting fill severity (success → warning → error). */
  token: SemanticToken;
  /** Number of filled cells. */
  filled: number;
  /** Clamped 0–100 percentage. */
  pct: number;
}

const GAUGE_FILL = '▓';
const GAUGE_EMPTY = '░';

/**
 * Build a fixed-width unicode gauge for context-window usage.
 *
 * Severity token: <75% success, <90% warning, ≥90% error — so a filling
 * context window visibly shifts colour before it runs out.
 *
 * @param pct    Usage percentage (clamped to 0–100).
 * @param cells  Bar width in cells (default 8, min 1).
 */
export function contextGauge(pct: number, cells = 8): ContextGauge {
  const clampedPct = Math.max(0, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)));
  const width = Math.max(1, Math.floor(cells));
  const filled = Math.max(0, Math.min(width, Math.round((clampedPct / 100) * width)));
  const bar = GAUGE_FILL.repeat(filled) + GAUGE_EMPTY.repeat(width - filled);
  const token: SemanticToken = clampedPct >= 90 ? 'error' : clampedPct >= 75 ? 'warning' : 'success';
  return { bar, token, filled, pct: clampedPct };
}
