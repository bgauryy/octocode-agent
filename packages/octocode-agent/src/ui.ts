/**
 * Dependency-free ANSI UI layer for the octocode-agent launcher.
 *
 * SCOPE (deliberate, do NOT merge with @octocodeai/pi-extension branding/):
 *   This paints the LAUNCHER's pre-session CLI surfaces (help, version, doctor,
 *   auth/setup wizards) with zero runtime deps. The extension's `branding/`
 *   (theme.ts/banner.ts/renderers.ts) paints the IN-SESSION Pi TUI and depends
 *   on Pi's theme runtime. They intentionally overlap on the brand palette but
 *   live in different processes/lifecycles and different dependency budgets;
 *   unifying them would force a shared third package for a ~10-token palette —
 *   premature. Keep the palette values in sync by eye (both mirror the shipped
 *   octocode-dark theme); abstract only if a third consumer appears.
 *
 * Brand system: the Octocode teal ◆ mark + gold accents (matches the in-session
 * octocode-dark/light themes shipped by @octocodeai/pi-extension), 256-color ANSI.
 * All color is opt-out safe: disabled when NO_COLOR is set, when the stream is
 * not a TTY, or when the terminal is dumb. FORCE_COLOR=1 overrides detection.
 * Pure functions only (no side effects at import) so the launcher stays testable.
 *
 * Composition rules for every surface:
 *   - `header` opens a report scene;
 *   - `section` groups; `kv` aligns facts; `checkLines` reports health;
 *   - `cmdRows` aligns command/desc pairs; `hint` points at the next action.
 * Alignment is computed on VISIBLE width (see padEndVisible) so paint never
 * breaks the columns.
 */

import os from 'node:os';
import path from 'node:path';

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  brand: '\x1b[38;5;86m',
  accent: '\x1b[38;5;214m',
  purple: '\x1b[38;5;147m',
} as const;

export type ColorName = keyof Omit<typeof CODES, 'reset'>;

export const BRAND_MARK = '◆';
export const BRAND_NAME = 'octocode-agent';

const RULE_WIDTH = 56;

/**
 * Decide whether to emit ANSI colors.
 * Precedence: NO_COLOR (off) < FORCE_COLOR (on) < TTY detection.
 */
export function colorEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean((process.stdout as { isTTY?: boolean }).isTTY),
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR === '1' || env.FORCE_COLOR === 'true') return true;
  if (env.TERM === 'dumb') return false;
  return isTTY;
}

/** A painter bound to an enabled flag. When disabled every helper is identity. */
export interface Painter {
  enabled: boolean;
  paint: (name: ColorName, s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  gray: (s: string) => string;
  brand: (s: string) => string;
  accent: (s: string) => string;
  purple: (s: string) => string;
}

export function makePainter(enabled: boolean): Painter {
  const wrap = (name: ColorName, s: string): string =>
    enabled ? `${CODES[name]}${s}${CODES.reset}` : s;
  return {
    enabled,
    paint: wrap,
    bold: (s) => wrap('bold', s),
    dim: (s) => wrap('dim', s),
    green: (s) => wrap('green', s),
    red: (s) => wrap('red', s),
    yellow: (s) => wrap('yellow', s),
    cyan: (s) => wrap('cyan', s),
    gray: (s) => wrap('gray', s),
    brand: (s) => wrap('brand', s),
    accent: (s) => wrap('accent', s),
    purple: (s) => wrap('purple', s),
  };
}

/** Strip ANSI codes — used by tests and when piping to non-terminals. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\][^\x1b]*\x1b\\/g, '');
}

/** Length of the string the user actually sees. */
export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

/** padEnd that ignores ANSI sequences — paint first, then pad. */
export function padEndVisible(s: string, width: number): string {
  const pad = width - visibleLength(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

// ── Width-aware layer (P1) ──────────────────────────────────────────────────

/** Terminal width: stdout.columns → $COLUMNS → fallback, clamped to CLI-sane bounds. */
export function terminalWidth(fallback = 80): number {
  const cols = Number(process.stdout.columns) || Number(process.env.COLUMNS) || fallback;
  return Math.min(Math.max(cols, 40), 200);
}

/** s if it fits, else tail-truncated with … to exactly `max` visible chars. */
export function ellipsizeEnd(s: string, max: number): string {
  if (max < 1) return '';
  if (visibleLength(s) <= max) return s;
  if (max === 1) return '…';
  return stripAnsi(s).slice(0, max - 1) + '…';
}

/** s if it fits, else middle-collapsed `abc…xyz` to exactly `max` visible chars. */
export function ellipsizeMiddle(s: string, max: number): string {
  if (visibleLength(s) <= max) return s;
  if (max <= 3) return ellipsizeEnd(s, max);
  const keep = max - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  const plain = stripAnsi(s);
  return `${plain.slice(0, head)}…${plain.slice(plain.length - tail)}`;
}

/** Collapse the user's home prefix to `~` (config/doctor value readability). */
export function tildePath(filePath: string, home: string = os.homedir()): string {
  return filePath === home || filePath.startsWith(home + path.sep)
    ? `~${filePath.slice(home.length)}`
    : filePath;
}

/** Width-fit: paths middle-collapse; prose tail-collapses. */
export function fitText(s: string, max: number): string {
  return /^[~/.]/.test(stripAnsi(s).trimStart()) ? ellipsizeMiddle(s, max) : ellipsizeEnd(s, max);
}

/**
 * Word-wrap plain prose to `width` (ANSI-safe via stripAnsi measurement).
 * Continuation lines get `indent`. Words longer than the width are left intact
 * (a path/url beats a broken string).
 */
export function wrapText(text: string, width: number, indent = ''): string[] {
  const w = Math.max(width, 20);
  const words = stripAnsi(text).split(/ +/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur === '' ? word : `${cur} ${word}`;
    if (visibleLength(candidate) <= w) {
      cur = candidate;
      continue;
    }
    if (cur !== '') lines.push(cur);
    cur = (lines.length > 0 ? indent : '') + word;
  }
  if (cur !== '') lines.push(cur);
  return lines.length > 0 ? lines : [''];
}

/** OSC-8 hyperlink when enabled (interactive TTY); falls back to `text (url)`. */
export function link(p: Painter, url: string, text: string, interactive = false): string {
  if (!interactive || !p.enabled) return `${text} (${url})`;
  // Brand teal, matching every other accent surface — cyan was off-brand for
  // the only hyperlink color in the launcher.
  return `\x1b]8;;${url}\x1b\\${p.brand(text)}\x1b]8;;\x1b\\`;
}

/** Report scene opener: blank line, branded title, thin rule. */
export function header(p: Painter, name: string): string {
  const title = name ? `${BRAND_NAME} ${name}` : BRAND_NAME;
  return ['', `${p.brand(BRAND_MARK)} ${p.bold(title)}`, rule(p)].join('\n');
}

/** A thin horizontal rule; adapts down on narrow terminals, never wider than RULE_WIDTH. */
export function rule(p: Painter, width?: number): string {
  const w = Math.max(20, Math.min(width ?? RULE_WIDTH, terminalWidth() - 2));
  return p.gray('─'.repeat(w));
}

/** A section title inside a report. */
export function section(p: Painter, title: string): string {
  return p.accent(p.bold(title));
}

/** One aligned key/value fact: gray padded key, plain value width-fitted. */
export function kv(p: Painter, key: string, value: string, keyWidth = 18): string {
  const kw = Math.max(keyWidth, visibleLength(key));
  const budget = terminalWidth() - kw - 3;
  return `${p.gray(padEndVisible(key, kw))} ${fitText(value, budget)}`;
}

export type CheckStatus = 'ok' | 'fail' | 'warn';

const CHECK_GLYPHS: Record<CheckStatus, string> = { ok: '✓', fail: '✗', warn: '!' };

/**
 * One health/status line: colored glyph, bold padded label, plain detail.
 * A failing check may add a dim `fix:` continuation line (returned in the array).
 */
export function checkLines(
  p: Painter,
  status: CheckStatus,
  label: string,
  detail: string,
  fix?: string,
  labelWidth = 12,
): string[] {
  const mark =
    status === 'ok'
      ? p.green(CHECK_GLYPHS.ok)
      : status === 'fail'
        ? p.red(CHECK_GLYPHS.fail)
        : p.yellow(CHECK_GLYPHS.warn);
  const budget = terminalWidth() - labelWidth - 4;
  const lines = [`${mark} ${p.bold(padEndVisible(label, labelWidth))} ${fitText(detail, budget)}`];
  if (status === 'fail' && fix) lines.push(p.dim(`   fix: ${fitText(fix, budget)}`));
  return lines;
}

/** Aligned command/description rows — the help/sessions workhorse. */
export function cmdRows(
  p: Painter,
  rows: ReadonlyArray<readonly [string, string]>,
  indent = '  ',
): string[] {
  const maxCmd = Math.max(...rows.map(([cmd]) => visibleLength(cmd)));
  // At narrow widths the command column itself must shrink (it overflowed on
  // 40-col terminals): keep ≥14 cols for the description, else squeeze cmd.
  const cmdW = Math.min(maxCmd, Math.max(terminalWidth() - indent.length - 16, 8));
  const budget = Math.max(terminalWidth() - indent.length - cmdW - 4, 8);
  return rows.map(
    ([cmd, desc]) => `${indent}${p.brand(padEndVisible(ellipsizeEnd(cmd, cmdW), cmdW))}  ${p.dim(ellipsizeEnd(desc, budget))}`,
  );
}

/** A dimmed next-action pointer: `→ <text>`. */
export function hint(p: Painter, text: string): string {
  return p.gray(`→ ${text}`);
}

/** Style a diagnostic line destined for stderr: dim brand prefix preserved. */
export function diagLine(p: Painter, msg: string): string {
  const prefix = `${BRAND_NAME}:`;
  return msg.startsWith(prefix)
    ? p.dim(BRAND_NAME) + msg.slice(BRAND_NAME.length)
    : `${p.dim(BRAND_NAME)}: ${msg}`;
}
