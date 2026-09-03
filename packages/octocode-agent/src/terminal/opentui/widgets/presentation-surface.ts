import { OpenTuiWidget } from './base.js';
import {
  WidgetContractError,
  type WidgetInput,
  type WidgetInputResult,
  type WidgetRenderAdapter,
  type WidgetRenderRegion,
  type WidgetRenderState,
} from './contracts.js';
import { fitTerminalText } from './layout.js';
import {
  assertStableTerminalId,
  sanitizeMultilineText,
  sanitizeSingleLineText,
  segmentGraphemes,
} from './sanitize.js';

export interface PresentationTextPayload {
  readonly kind: 'text';
  readonly text: string;
}

export interface PresentationListPayload {
  readonly kind: 'list';
  readonly title?: string;
  readonly items: readonly string[];
}

export interface PresentationKeyValuePayload {
  readonly kind: 'key-value';
  readonly title?: string;
  readonly rows: readonly {
    readonly label: string;
    readonly value: string;
  }[];
}

export interface PresentationProgressPayload {
  readonly kind: 'progress';
  readonly label: string;
  readonly current: number;
  readonly total?: number;
}

export type PresentationSurfacePayload =
  | PresentationTextPayload
  | PresentationListPayload
  | PresentationKeyValuePayload
  | PresentationProgressPayload;

export interface PresentationSurfaceSnapshot {
  readonly authority: 'runtime';
  readonly id: string;
  readonly revision: number;
  readonly payload: PresentationSurfacePayload;
}

export interface PresentationSurfaceWidgetOptions {
  readonly widthColumns?: number;
  readonly viewportRows?: number;
}

const MAX_ITEMS = 100;
const MAX_ROWS = 100;
const MAX_TEXT_GRAPHEMES = 8_192;
const MAX_TEXT_LINES = 256;
const MAX_TITLE_GRAPHEMES = 256;
const MAX_ITEM_GRAPHEMES = 1_024;
const MAX_ROW_FIELD_GRAPHEMES = 1_024;
const MIN_WIDTH = 20;
const MAX_WIDTH = 240;
const DEFAULT_WIDTH = 80;
const MIN_VIEWPORT_ROWS = 1;
const MAX_VIEWPORT_ROWS = 16;
const DEFAULT_VIEWPORT_ROWS = 10;

const AGENT_INSTRUCTIONS = {
  purpose: 'Render one runtime-authoritative generic text, list, key-value, or numeric progress surface as bounded read-only terminal content.',
  useWhen: [
    'The runtime emits a stable presentation command whose content does not require a specialized semantic widget.',
    'A user needs a deterministic linear view plus complete alternate plain-text output.',
  ],
  avoidWhen: [
    'Conversation content belongs in the transcript widget, tool execution belongs in tool progress, or execution state belongs in the plan widget.',
    'A question needs approval, confirmation, selection, prompt input, editing, or any other user mutation or action.',
  ],
  inputs: [
    'Provide runtime authority, a stable surface ID, a monotonic revision, and exactly one discriminated text, list, key-value, or progress payload.',
    'For progress, provide a non-negative integer current value and either a positive integer total not below current or omit total when it is unknown.',
  ],
  stateAndOutput: [
    'Preserve runtime order and labels; never infer completion, success, failure, totals, missing rows, or actions.',
    'Known-total percentages are arithmetic display aids only; unknown totals remain visibly UNKNOWN.',
    'Rendering and keyboard scrolling are observational and cannot mutate runtime or session state.',
    'alternateOutput() returns every sanitized payload row independent of the visible viewport.',
  ],
  keys: [
    'Arrow Up and Arrow Down scroll one row; Page Up and Page Down scroll one viewport.',
    'Home and End jump to the beginning and end; no key submits, approves, selects, edits, or cancels.',
  ],
  accessibility: [
    'Expose a labeled read-only region with kind, stable identity, revision, viewport position, and linear content.',
    'Use literal list numbers, label/value separators, numeric progress values, and UNKNOWN rather than color, position, or animation alone.',
    'Provide complete alternate output for screen readers, redirected output, and non-interactive terminals.',
  ],
  recovery: [
    'Reject non-runtime authority, identity drift, stale or conflicting revisions, ambiguous payload fields, invalid progress bounds, and excess item or row counts.',
    'Strip terminal and bidirectional controls, redact recognizable credentials, and truncate text at safe grapheme and viewport bounds.',
  ],
} as const;

function fail(message: string): never {
  throw new WidgetContractError('validation', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !expected.has(key));
  if (unexpected !== undefined) fail(`${label} contains unexpected field '${unexpected}'; provide exactly one payload shape`);
}

function graphemes(value: string): readonly string[] {
  return segmentGraphemes(value);
}

function boundedCodeUnits(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const kept: string[] = [];
  let length = 1;
  for (const grapheme of graphemes(value)) {
    if (length + grapheme.length > maximum) break;
    kept.push(grapheme);
    length += grapheme.length;
  }
  return `${kept.join('')}…`;
}

function safeSingleLine(value: unknown, label: string, maxGraphemes: number, allowEmpty = false): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const safe = boundedCodeUnits(sanitizeSingleLineText(value, {
    maxGraphemes,
    redactCredentials: true,
    tabWidth: 1,
  }).replace(/\s+/gu, ' ').trim(), maxGraphemes * 2);
  if (!allowEmpty && safe.length === 0) fail(`${label} must not be empty`);
  return safe;
}

function safeMultiline(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const safe = boundedCodeUnits(sanitizeMultilineText(value, {
    maxGraphemes: MAX_TEXT_GRAPHEMES,
    redactCredentials: true,
  }), MAX_TEXT_GRAPHEMES);
  const lines = safe.split('\n');
  if (lines.length <= MAX_TEXT_LINES) return safe;
  return [...lines.slice(0, MAX_TEXT_LINES - 1), `… [${label} truncated after ${MAX_TEXT_LINES} lines]`].join('\n');
}

function safeProgressInteger(value: unknown, label: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    fail(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
  return value as number;
}

function normalizePayload(value: unknown): PresentationSurfacePayload {
  if (!isRecord(value) || typeof value.kind !== 'string') fail('presentation payload must be a discriminated object');
  switch (value.kind) {
    case 'text':
      assertOnlyKeys(value, ['kind', 'text'], 'text payload');
      return Object.freeze({ kind: 'text', text: safeMultiline(value.text, 'text payload') });
    case 'list': {
      assertOnlyKeys(value, ['kind', 'title', 'items'], 'list payload');
      if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) fail('list payload exceeds its item bound');
      const title = value.title === undefined
        ? undefined
        : safeSingleLine(value.title, 'list title', MAX_TITLE_GRAPHEMES);
      return Object.freeze({
        kind: 'list',
        ...(title === undefined ? {} : { title }),
        items: Object.freeze(value.items.map((item, index) => safeSingleLine(item, `list item ${index + 1}`, MAX_ITEM_GRAPHEMES, true))),
      });
    }
    case 'key-value': {
      assertOnlyKeys(value, ['kind', 'title', 'rows'], 'key-value payload');
      if (!Array.isArray(value.rows) || value.rows.length > MAX_ROWS) fail('key-value payload exceeds its row bound');
      const title = value.title === undefined
        ? undefined
        : safeSingleLine(value.title, 'key-value title', MAX_TITLE_GRAPHEMES);
      const rows = value.rows.map((row, index) => {
        if (!isRecord(row)) fail(`key-value row ${index + 1} must be an object`);
        assertOnlyKeys(row, ['label', 'value'], `key-value row ${index + 1}`);
        return Object.freeze({
          label: safeSingleLine(row.label, `key-value row ${index + 1} label`, MAX_ROW_FIELD_GRAPHEMES),
          value: safeSingleLine(row.value, `key-value row ${index + 1} value`, MAX_ROW_FIELD_GRAPHEMES, true),
        });
      });
      return Object.freeze({ kind: 'key-value', ...(title === undefined ? {} : { title }), rows: Object.freeze(rows) });
    }
    case 'progress': {
      assertOnlyKeys(value, ['kind', 'label', 'current', 'total'], 'progress payload');
      const current = safeProgressInteger(value.current, 'progress current', true);
      const total = value.total === undefined
        ? undefined
        : safeProgressInteger(value.total, 'progress total', false);
      if (total !== undefined && current > total) fail('progress current cannot exceed progress total');
      return Object.freeze({
        kind: 'progress',
        label: safeSingleLine(value.label, 'progress label', MAX_TITLE_GRAPHEMES),
        current,
        ...(total === undefined ? {} : { total }),
      });
    }
    default:
      return fail('presentation payload kind is invalid');
  }
}

function normalizeSnapshot(value: unknown): PresentationSurfaceSnapshot {
  if (!isRecord(value)) fail('presentation snapshot must be an object');
  assertOnlyKeys(value, ['authority', 'id', 'revision', 'payload'], 'presentation snapshot');
  if (value.authority !== 'runtime') fail('presentation snapshot requires runtime authority');
  if (typeof value.id !== 'string') fail('presentation identity is invalid');
  let id: string;
  try {
    id = assertStableTerminalId(value.id, { maxLength: 128 });
  } catch {
    return fail('presentation identity must be a stable terminal ID');
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    fail('presentation revision must be a non-negative safe integer');
  }
  return Object.freeze({
    authority: 'runtime',
    id,
    revision: value.revision as number,
    payload: normalizePayload(value.payload),
  });
}

function viewportValue(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    fail(`${label} is outside its supported bounds`);
  }
  return normalized;
}

function kindLabel(kind: PresentationSurfacePayload['kind']): string {
  return kind === 'key-value' ? 'KEY VALUE' : kind.toUpperCase();
}

function percentage(current: number, total: number): string {
  const value = (current / total) * 100;
  return `${value.toFixed(1).replace(/\.0$/u, '')}%`;
}

function payloadTitle(payload: PresentationSurfacePayload): string | undefined {
  if (payload.kind === 'list' || payload.kind === 'key-value') return payload.title;
  return undefined;
}

function payloadLines(payload: PresentationSurfacePayload): readonly string[] {
  switch (payload.kind) {
    case 'text': {
      const lines = payload.text.split('\n');
      return lines.length === 1 && lines[0] === '' ? ['(empty text)'] : lines;
    }
    case 'list':
      return payload.items.length === 0
        ? ['No items.']
        : payload.items.map((item, index) => `${index + 1}. ${item}`);
    case 'key-value':
      return payload.rows.length === 0
        ? ['No rows.']
        : payload.rows.map(({ label, value }) => `${label}: ${value}`);
    case 'progress':
      return [payload.total === undefined
        ? `${payload.label}: ${payload.current}; total UNKNOWN`
        : `${payload.label}: ${payload.current} of ${payload.total} (${percentage(payload.current, payload.total)})`];
  }
}

export class PresentationSurfaceWidget extends OpenTuiWidget {
  private snapshot: PresentationSurfaceSnapshot;
  private widthColumns: number;
  private viewportRows: number;
  private currentScrollOffset = 0;

  constructor(id: string, initial: PresentationSurfaceSnapshot, options: PresentationSurfaceWidgetOptions = {}) {
    super({
      id,
      kind: 'presentation-surface',
      capabilities: { focusable: true, inputMode: 'keys' },
      accessibility: {
        role: 'region',
        label: 'Runtime presentation',
        description: 'Read-only text, list, key-value, or numeric progress content with complete alternate output.',
        liveRegion: 'off',
        keyboardHelp: ['Use arrows, Page Up, Page Down, Home, and End to scroll; this surface cannot perform actions.'],
      },
      instructions: AGENT_INSTRUCTIONS,
    });
    this.snapshot = normalizeSnapshot(initial);
    this.widthColumns = viewportValue(options.widthColumns, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH, 'presentation width');
    this.viewportRows = viewportValue(options.viewportRows, DEFAULT_VIEWPORT_ROWS, MIN_VIEWPORT_ROWS, MAX_VIEWPORT_ROWS, 'presentation viewport rows');
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  get scrollOffset(): number {
    return this.currentScrollOffset;
  }

  update(nextValue: PresentationSurfaceSnapshot): void {
    const next = normalizeSnapshot(nextValue);
    if (next.id !== this.snapshot.id) fail('presentation identity cannot change within a widget');
    if (next.revision < this.snapshot.revision) fail('presentation update has a stale revision');
    if (next.revision === this.snapshot.revision) {
      if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
      fail('a presentation revision cannot describe different state');
    }
    this.snapshot = next;
    this.clampScroll();
    this.invalidate();
  }

  resize(widthColumns: number, viewportRows: number): void {
    const width = viewportValue(widthColumns, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH, 'presentation width');
    const rows = viewportValue(viewportRows, DEFAULT_VIEWPORT_ROWS, MIN_VIEWPORT_ROWS, MAX_VIEWPORT_ROWS, 'presentation viewport rows');
    if (width === this.widthColumns && rows === this.viewportRows) return;
    this.widthColumns = width;
    this.viewportRows = rows;
    this.clampScroll();
    this.invalidate();
  }

  alternateOutput(): string {
    const title = payloadTitle(this.snapshot.payload);
    return [
      `Presentation ${this.snapshot.id} — revision ${this.snapshot.revision} — ${kindLabel(this.snapshot.payload.kind)}`,
      ...(title === undefined ? [] : [title]),
      ...payloadLines(this.snapshot.payload),
    ].join('\n');
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const lines = payloadLines(this.snapshot.payload);
    const end = Math.min(lines.length, this.currentScrollOffset + this.viewportRows);
    const title = payloadTitle(this.snapshot.payload);
    return [
      {
        id: 'summary',
        role: 'content',
        text: fitTerminalText(
          title === undefined
            ? kindLabel(this.snapshot.payload.kind)
            : `${title} · ${kindLabel(this.snapshot.payload.kind)}`,
          this.widthColumns,
        ),
      },
      {
        id: 'content',
        role: 'content',
        text: lines.slice(this.currentScrollOffset, end).map((line) => fitTerminalText(line, this.widthColumns)).join('\n'),
      },
      {
        id: 'viewport',
        role: 'help',
        text: `Rows ${lines.length === 0 ? 0 : this.currentScrollOffset + 1}–${end} of ${lines.length} · Read only`,
      },
      { id: 'help', role: 'help', text: '↑/↓ row · PgUp/PgDn viewport · Home/End bounds · no actions' },
    ];
  }

  protected onInput(input: WidgetInput): WidgetInputResult {
    if (input.type !== 'key') return { status: 'ignored' };
    const key = input.key.toLowerCase();
    let target: number | undefined;
    if (key === 'arrowdown' || key === 'down' || key === 'j') target = this.currentScrollOffset + 1;
    else if (key === 'arrowup' || key === 'up' || key === 'k') target = this.currentScrollOffset - 1;
    else if (key === 'pagedown') target = this.currentScrollOffset + this.viewportRows;
    else if (key === 'pageup') target = this.currentScrollOffset - this.viewportRows;
    else if (key === 'home') target = 0;
    else if (key === 'end') target = this.maximumScrollOffset();
    else return { status: 'ignored' };
    const next = Math.max(0, Math.min(this.maximumScrollOffset(), target));
    if (next !== this.currentScrollOffset) {
      this.currentScrollOffset = next;
      this.invalidate();
    }
    return { status: 'handled' };
  }

  private maximumScrollOffset(): number {
    return Math.max(0, payloadLines(this.snapshot.payload).length - this.viewportRows);
  }

  private clampScroll(): void {
    this.currentScrollOffset = Math.max(0, Math.min(this.maximumScrollOffset(), this.currentScrollOffset));
  }
}
