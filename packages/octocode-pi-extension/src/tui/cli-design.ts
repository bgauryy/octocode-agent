/**
 * cli-design — shared visual contract for Octocode CLI/TUI surfaces.
 *
 * Keep glyphs, progress wording, inline payload summaries, and raw ANSI fallback
 * styling in one place so the Pi extension UI and the owned OctocodeShell do not
 * drift into separate visual languages.
 */

import { truncateToWidth } from '@earendil-works/pi-tui';
import { TOKEN, colorEnabled, paint, sanitizeLine, type PaintTheme, type SemanticToken } from './palette.js';

export const CLI_GLYPH = {
  brand: '◆',
  tool: '◇',
  prompt: '›',
  thinking: '🧠',
  running: '⚙',
  update: '↳',
  success: '✓',
  error: '✗',
} as const;

export const CLI_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export const CLI_STATUS_TEXT = {
  running: 'running…',
  fetching: 'Fetching…',
  processing: 'Processing…',
  connectingChrome: '⧗ Connecting to Chrome…',
  editing: '… editing',
  done: 'done',
  cancelled: 'cancelled',
  unavailable: 'no interactive UI',
} as const;

const ANSI_RESET = '\u001b[0m';
const ANSI_BY_TOKEN: Partial<Record<SemanticToken, string>> = {
  brand: '\u001b[36m',
  path: '\u001b[36m',
  link: '\u001b[35m',
  linkUrl: '\u001b[35m',
  count: '\u001b[33m',
  symbol: '\u001b[36m',
  title: '\u001b[36m',
  success: '\u001b[32m',
  error: '\u001b[31m',
  warning: '\u001b[33m', // yellow — tracks the themes' gold warning, not magenta
  muted: '\u001b[2m',
  dim: '\u001b[2m',
  diffAdd: '\u001b[32m',
  diffRemove: '\u001b[31m',
  diffContext: '\u001b[2m',
};

/** Theme paint with a raw ANSI fallback for shell transcript rows. */
export function cliPaint(
  theme: PaintTheme | undefined,
  token: SemanticToken,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (theme) return theme.fg(TOKEN[token], text) ?? text;
  const code = ANSI_BY_TOKEN[token];
  return code && colorEnabled(env) ? `${code}${text}${ANSI_RESET}` : text;
}

export function cliSpinnerFrame(now = Date.now()): string {
  return CLI_SPINNER_FRAMES[Math.floor(now / 120) % CLI_SPINNER_FRAMES.length] ?? CLI_SPINNER_FRAMES[0];
}

export function cliStatusGlyph(ok: boolean): string {
  return ok ? CLI_GLYPH.success : CLI_GLYPH.error;
}

export function cliStatusToken(ok: boolean): Extract<SemanticToken, 'success' | 'error'> {
  return ok ? 'success' : 'error';
}

export function cliToolTitle(theme: PaintTheme | undefined, toolName: string, opts: { bold?: boolean } = {}): string {
  const text = opts.bold && theme ? theme.bold(toolName) : toolName;
  return theme?.fg(TOKEN.title, text) ?? toolName;
}

/** Compact unknown payloads for one-line transcript/status rows. */
export function summarizeInlineValue(value: unknown, max = 90): string {
  if (value === undefined) return '';
  const raw = typeof value === 'string'
    ? value
    : (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })();
  const compact = sanitizeLine(raw.replace(/\s+/g, ' ').trim());
  // Cell-width aware so CJK/emoji payloads truncate to `max` visible cells and
  // never overflow the row (byte-length .slice under-counts wide glyphs).
  return truncateToWidth(compact, max);
}

export type CliToolRowState = 'queued' | 'running' | 'update' | 'done' | 'failed';

/** One-line, text-labeled tool row for the alpha OctocodeShell transcript. */
export function formatCliToolRow(
  state: CliToolRowState,
  toolName: string | undefined,
  payload?: unknown,
  theme?: PaintTheme,
): string {
  const name = toolName ?? 'tool';
  const detail = summarizeInlineValue(payload);
  const detailText = detail ? cliPaint(theme, 'dim', ` · ${detail}`) : '';
  const title = cliPaint(theme, 'title', name);

  if (state === 'queued') {
    return `${cliPaint(theme, 'warning', `╭─ ${CLI_GLYPH.tool} tool call`)} ${title}${detailText}`;
  }
  if (state === 'running') {
    return `${cliPaint(theme, 'title', `╭─ ${CLI_GLYPH.running}`)} ${title} ${cliPaint(theme, 'dim', CLI_STATUS_TEXT.running)}${detailText}`;
  }
  if (state === 'update') {
    return `${cliPaint(theme, 'dim', `│  ${CLI_GLYPH.update}`)} ${cliPaint(theme, 'dim', detail || 'streaming update…')}`;
  }
  if (state === 'failed') {
    return `${cliPaint(theme, 'error', `╰─ ${CLI_GLYPH.error}`)} ${cliPaint(theme, 'error', name)}${detailText}`;
  }
  return `${cliPaint(theme, 'success', `╰─ ${CLI_GLYPH.success}`)} ${cliPaint(theme, 'success', name)}${detailText}`;
}

/** Text-labeled thinking boundary row for accessible streamed reasoning blocks. */
export function formatThinkingRow(boundary: 'start' | 'end', theme?: PaintTheme): string {
  if (boundary === 'start') {
    return `${cliPaint(theme, 'warning', `╭─ ${CLI_GLYPH.thinking} thinking`)} ${cliPaint(theme, 'dim', 'model reasoning')}`;
  }
  return cliPaint(theme, 'warning', '╰─ thinking ready');
}

/** Use the existing semantic theme painter for non-raw TUI component renderers. */
export { paint };
