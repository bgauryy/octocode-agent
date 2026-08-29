const DEFAULT_MAX_GRAPHEMES = 8_192;
const MAX_ALLOWED_GRAPHEMES = 1_000_000;
const MAX_TAB_WIDTH = 16;
const DEFAULT_STABLE_ID_LENGTH = 64;

const OSC_SEQUENCE = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const TERMINAL_STRING_SEQUENCE =
  /(?:\u001b[P_X^]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g;
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const ESC_SEQUENCE = /\u001b[ -/]*[0-~]/g;
const C0_AND_C1 = /[\u0000-\u001f\u007f-\u009f]/g;
const C0_AND_C1_EXCEPT_LINE_FEED = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const BIDI_FORMATTING = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/g;
const UNICODE_LINE_BREAK = /[\u2028\u2029]/g;
const STABLE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface TerminalTextSanitizeOptions {
  /** Maximum grapheme clusters in the returned value, including the ellipsis. */
  readonly maxGraphemes?: number;
  /** Number of spaces used for each tab. Zero removes tabs. */
  readonly tabWidth?: number;
  /** Marker reserved at the end of a truncated value. */
  readonly ellipsis?: string;
  /** Redact common bearer tokens, API keys, passwords, and provider token prefixes. */
  readonly redactCredentials?: boolean;
}

export interface StableTerminalIdOptions {
  readonly maxLength?: number;
}

export class TerminalTextValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalTextValidationError';
  }
}

export function segmentGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

export function graphemeBoundaries(value: string): readonly number[] {
  const boundaries = [0];
  for (const segment of graphemeSegmenter.segment(value)) {
    const end = segment.index + segment.segment.length;
    if (end !== boundaries.at(-1)) boundaries.push(end);
  }
  return boundaries;
}

export function sanitizeCollapsedSingleLine(
  value: string,
  options: TerminalTextSanitizeOptions = {},
): string {
  return sanitizeSingleLineText(value.replace(/[\r\n]+/gu, ' '), {
    tabWidth: 1,
    redactCredentials: true,
    ...options,
  }).replace(/\s{2,}/gu, ' ').trim();
}

function assertIntegerInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TerminalTextValidationError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

function stripTerminalSequences(value: string): string {
  return value
    .replace(OSC_SEQUENCE, '')
    .replace(TERMINAL_STRING_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(BIDI_FORMATTING, '');
}

function normalizeTabs(value: string, tabWidth: number): string {
  return value.replace(/\t/g, ' '.repeat(tabWidth));
}

function assertSafeEllipsis(value: string): void {
  const safe = stripTerminalSequences(value)
    .replace(UNICODE_LINE_BREAK, '')
    .replace(C0_AND_C1, '');
  if (safe !== value) {
    throw new TerminalTextValidationError(
      'ellipsis must not contain terminal control, bidi formatting, or line-break characters.',
    );
  }
}

function resolveOptions(options: TerminalTextSanitizeOptions): Required<TerminalTextSanitizeOptions> {
  const maxGraphemes = options.maxGraphemes ?? DEFAULT_MAX_GRAPHEMES;
  const tabWidth = options.tabWidth ?? 2;
  const ellipsis = options.ellipsis ?? '…';
  assertIntegerInRange('maxGraphemes', maxGraphemes, 0, MAX_ALLOWED_GRAPHEMES);
  assertIntegerInRange('tabWidth', tabWidth, 0, MAX_TAB_WIDTH);
  assertSafeEllipsis(ellipsis);
  return {
    maxGraphemes,
    tabWidth,
    ellipsis,
    redactCredentials: options.redactCredentials ?? false,
  };
}

export function truncateGraphemes(value: string, maxGraphemes: number, ellipsis = '…'): string {
  assertIntegerInRange('maxGraphemes', maxGraphemes, 0, MAX_ALLOWED_GRAPHEMES);
  assertSafeEllipsis(ellipsis);
  if (maxGraphemes === 0) return '';

  const valueSegments = segmentGraphemes(value);
  if (valueSegments.length <= maxGraphemes) return value;

  const ellipsisSegments = segmentGraphemes(ellipsis);
  if (ellipsisSegments.length > maxGraphemes) {
    throw new TerminalTextValidationError(
      `ellipsis must contain at most ${maxGraphemes} grapheme clusters.`,
    );
  }

  return `${valueSegments.slice(0, maxGraphemes - ellipsisSegments.length).join('')}${ellipsis}`;
}

export function redactCommonCredentials(value: string): string {
  return value
    .replace(/\b(Bearer)[ \t]+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|npm_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      '[REDACTED]',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function sanitizeSingleLineText(
  value: string,
  options: TerminalTextSanitizeOptions = {},
): string {
  const resolved = resolveOptions(options);
  let safe = normalizeTabs(stripTerminalSequences(value), resolved.tabWidth)
    .replace(UNICODE_LINE_BREAK, '')
    .replace(C0_AND_C1, '');
  if (resolved.redactCredentials) safe = redactCommonCredentials(safe);
  return truncateGraphemes(safe, resolved.maxGraphemes, resolved.ellipsis);
}

export function sanitizeMultilineText(
  value: string,
  options: TerminalTextSanitizeOptions = {},
): string {
  const resolved = resolveOptions(options);
  let safe = stripTerminalSequences(value)
    .replace(/\r\n?/g, '\n')
    .replace(UNICODE_LINE_BREAK, '\n');
  safe = normalizeTabs(safe, resolved.tabWidth).replace(C0_AND_C1_EXCEPT_LINE_FEED, '');
  if (resolved.redactCredentials) safe = redactCommonCredentials(safe);
  return truncateGraphemes(safe, resolved.maxGraphemes, resolved.ellipsis);
}

export function assertStableTerminalId(
  value: string,
  options: StableTerminalIdOptions = {},
): string {
  const maxLength = options.maxLength ?? DEFAULT_STABLE_ID_LENGTH;
  assertIntegerInRange('maxLength', maxLength, 1, 256);

  if (stripTerminalSequences(value).replace(C0_AND_C1, '') !== value) {
    throw new TerminalTextValidationError('Stable ID contains terminal control or bidi formatting characters.');
  }
  if (value.length > maxLength) {
    throw new TerminalTextValidationError(`Stable ID must contain at most ${maxLength} characters.`);
  }
  if (!STABLE_ID.test(value)) {
    throw new TerminalTextValidationError(
      'Stable ID must use ASCII letters, digits, dot, underscore, colon, or hyphen without edge punctuation.',
    );
  }
  return value;
}
