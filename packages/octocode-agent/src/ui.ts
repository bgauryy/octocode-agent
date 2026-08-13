/**
 * Dependency-free ANSI UI layer for the octocode-agent launcher.
 *
 * Brand system: a violet ⬢ mark + amber accents on a small 256-color palette.
 * All color is opt-out safe: disabled when NO_COLOR is set, when the stream is
 * not a TTY, or when the terminal is dumb. FORCE_COLOR=1 overrides detection.
 * Pure functions only (no side effects at import) so the launcher stays testable.
 *
 * Composition rules for every surface:
 *   - `header` opens a report scene; `banner` is the compact one-liner;
 *   - `section` groups; `kv` aligns facts; `checkLine` reports health;
 *   - `cmdRows` aligns command/desc pairs; `hint` points at the next action.
 * Alignment is computed on VISIBLE width (see padEndVisible) so paint never
 * breaks the columns.
 */

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  brand: '\x1b[38;5;141m',
  accent: '\x1b[38;5;214m',
} as const;

export type ColorName = keyof Omit<typeof CODES, 'reset'>;

export const BRAND_MARK = '⬢';
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
  };
}

/** Strip ANSI codes — used by tests and when piping to non-terminals. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
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

/** Compact branded one-line banner: `⬢ octocode-agent · <subtitle>`. */
export function banner(p: Painter, subtitle: string): string {
  return `${p.brand(BRAND_MARK)} ${p.bold(BRAND_NAME)} ${p.dim('· ' + subtitle)}`;
}

/** Report scene opener: blank line, branded title, thin rule. */
export function header(p: Painter, name: string): string {
  const title = name ? `${BRAND_NAME} ${name}` : BRAND_NAME;
  return ['', `${p.brand(BRAND_MARK)} ${p.bold(title)}`, rule(p)].join('\n');
}

/** A thin horizontal rule. */
export function rule(p: Painter, width: number = RULE_WIDTH): string {
  return p.gray('─'.repeat(width));
}

/** A section title inside a report. */
export function section(p: Painter, title: string): string {
  return p.accent(p.bold(title));
}

/** One aligned key/value fact: gray padded key, plain value. */
export function kv(p: Painter, key: string, value: string, keyWidth = 18): string {
  return `${p.gray(padEndVisible(key, keyWidth))} ${value}`;
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
  const lines = [`${mark} ${p.bold(padEndVisible(label, labelWidth))} ${detail}`];
  if (status === 'fail' && fix) lines.push(p.dim(`   fix: ${fix}`));
  return lines;
}

/** Aligned command/description rows — the help/sessions workhorse. */
export function cmdRows(
  p: Painter,
  rows: ReadonlyArray<readonly [string, string]>,
  indent = '  ',
): string[] {
  const width = Math.max(...rows.map(([cmd]) => visibleLength(cmd)));
  return rows.map(
    ([cmd, desc]) => `${indent}${p.brand(padEndVisible(cmd, width))}  ${p.dim(desc)}`,
  );
}

/** A dimmed next-action pointer: `→ <text>`. */
export function hint(p: Painter, text: string): string {
  return p.gray(`→ ${text}`);
}

/** Version trail for the launch banner: `v1.0.2 · core 1.3.0 · pi 0.80.3` (skips unknowns). */
export function launchBanner(
  p: Painter,
  versions: { launcher: string | null; core: string | null; pi: string | null },
): string {
  const parts = [
    versions.launcher ? `v${versions.launcher}` : null,
    versions.core ? `core ${versions.core}` : null,
    versions.pi ? `pi ${versions.pi}` : null,
  ].filter(Boolean) as string[];
  return `${p.brand(BRAND_MARK)} ${p.bold(BRAND_NAME)}${parts.length ? p.dim('  ' + parts.join(' · ')) : ''}`;
}

/** Style a diagnostic line destined for stderr: dim brand prefix preserved. */
export function diagLine(p: Painter, msg: string): string {
  const prefix = `${BRAND_NAME}:`;
  return msg.startsWith(prefix)
    ? p.dim(BRAND_NAME) + msg.slice(BRAND_NAME.length)
    : `${p.dim(BRAND_NAME)}: ${msg}`;
}
