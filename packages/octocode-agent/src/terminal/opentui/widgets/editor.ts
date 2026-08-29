import { OpenTuiWidget } from './base.js';
import {
  MAX_WIDGET_TEXT_LENGTH,
  WidgetContractError,
  type WidgetAgentInstructions,
  type WidgetInput,
  type WidgetInputResult,
  type WidgetRenderAdapter,
  type WidgetRenderRegion,
  type WidgetRenderState,
} from './contracts.js';
import { sanitizeMultilineText, sanitizeSingleLineText, segmentGraphemes } from './sanitize.js';

const DEFAULT_MAX_LENGTH = MAX_WIDGET_TEXT_LENGTH;
const MAX_VIEWPORT_DIMENSION = 10_000;
const MAX_SANITIZE_GRAPHEMES = 1_000_000;
const MAX_HISTORY_ENTRIES = 64;
const MAX_HISTORY_BYTES = 256 * 1_024;
const SECRET_REQUEST = /\b(?:api[- ]?key|access token|auth token|password|passphrase|private key|secret|credential)\b/i;
const DESTRUCTIVE_TEXT_APPROVAL = /(?:\btype\b|\benter\b).{0,40}\b(?:confirm|delete|destroy|erase|remove|wipe|drop|overwrite)\b|\bconfirm\b.{0,40}\b(?:delete|destroy|erase|remove|wipe|drop|overwrite)\b/i;

export interface EditorWidgetOptions {
  readonly id: string;
  /** Visible label and accessible name. */
  readonly label: string;
  readonly help?: string;
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly patternDescription?: string;
  readonly sensitive?: boolean;
  readonly redactionLabel?: string;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
}

export type EditorWidgetIntent =
  | { readonly type: 'submit'; readonly value: string; readonly sensitive: boolean }
  | { readonly type: 'cancel'; readonly reason: 'escape' | 'interrupt' | 'semantic' };

export type EditorWidgetResult = WidgetInputResult<EditorWidgetIntent>;

interface EditorSnapshot {
  readonly buffer: string;
  readonly cursor: number;
  readonly selectionAnchor?: number;
  readonly scrollLine: number;
}

interface NormalizedEditorOptions {
  readonly label: string;
  readonly help?: string;
  readonly placeholder?: string;
  readonly initialValue: string;
  readonly required: boolean;
  readonly minLength: number;
  readonly maxLength: number;
  readonly pattern?: RegExp;
  readonly patternDescription?: string;
  readonly sensitive: boolean;
  readonly redactionLabel: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

function validationError(message: string): never {
  throw new WidgetContractError('validation', message);
}

function boundedOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > MAX_WIDGET_TEXT_LENGTH) validationError(`${field} exceeds its length bound`);
  const normalized = sanitizeSingleLineText(value, {
    maxGraphemes: MAX_SANITIZE_GRAPHEMES,
    redactCredentials: true,
  }).trim();
  if (!normalized) validationError(`${field} must not be empty`);
  if (normalized.length > MAX_WIDGET_TEXT_LENGTH) validationError(`${field} exceeds its length bound`);
  return normalized;
}

function normalizeMultiline(value: string): string {
  return sanitizeMultilineText(value, {
    maxGraphemes: MAX_SANITIZE_GRAPHEMES,
    tabWidth: 2,
  });
}

function graphemes(value: string): string[] {
  return segmentGraphemes(value);
}

function normalizeDimension(value: number | undefined, fallback: number, field: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > MAX_VIEWPORT_DIMENSION) {
    validationError(`${field} must be between 1 and ${MAX_VIEWPORT_DIMENSION}`);
  }
  return normalized;
}

function normalizeOptions(options: EditorWidgetOptions): NormalizedEditorOptions {
  if (typeof options.label !== 'string' || options.label.length > MAX_WIDGET_TEXT_LENGTH) {
    validationError('label must be an explicit, bounded string');
  }
  const label = sanitizeSingleLineText(options.label, {
    maxGraphemes: MAX_SANITIZE_GRAPHEMES,
    redactCredentials: true,
  }).trim();
  if (!label) validationError('label must be an explicit, non-empty string');
  if (label.length > MAX_WIDGET_TEXT_LENGTH) validationError('label exceeds its length bound');
  if (DESTRUCTIVE_TEXT_APPROVAL.test(label)) {
    validationError('destructive approval must use the confirm widget, not an editor');
  }

  const sensitive = options.sensitive ?? false;
  if (SECRET_REQUEST.test(label) && !sensitive) {
    validationError('secret-like editor input must explicitly enable sensitive redaction');
  }

  const minLength = options.minLength ?? 0;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (!Number.isSafeInteger(minLength) || minLength < 0) {
    validationError('minLength must be a non-negative integer');
  }
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > MAX_WIDGET_TEXT_LENGTH) {
    validationError(`maxLength must be between 1 and ${MAX_WIDGET_TEXT_LENGTH}`);
  }
  if (minLength > maxLength) validationError('minLength must not exceed maxLength');

  if ((options.initialValue ?? '').length > maxLength) validationError('initialValue exceeds maxLength');
  const initialValue = normalizeMultiline(options.initialValue ?? '');
  if (initialValue.length > maxLength) validationError('initialValue exceeds maxLength');
  if (options.pattern && options.pattern.source.length > 1_024) {
    validationError('pattern exceeds its length bound');
  }

  const help = boundedOptionalText(options.help, 'help');
  const placeholder = boundedOptionalText(options.placeholder, 'placeholder');
  const patternDescription = boundedOptionalText(options.patternDescription, 'patternDescription');
  return Object.freeze({
    label,
    ...(help === undefined ? {} : { help }),
    ...(placeholder === undefined ? {} : { placeholder }),
    initialValue,
    required: options.required ?? false,
    minLength,
    maxLength,
    ...(options.pattern === undefined
      ? {}
      : { pattern: new RegExp(options.pattern.source, options.pattern.flags.replace(/[gy]/g, '')) }),
    ...(patternDescription === undefined ? {} : { patternDescription }),
    sensitive,
    redactionLabel: boundedOptionalText(options.redactionLabel, 'redactionLabel') ?? 'hidden editor value',
    viewportWidth: normalizeDimension(options.viewportWidth, 80, 'viewportWidth'),
    viewportHeight: normalizeDimension(options.viewportHeight, 12, 'viewportHeight'),
  });
}

function buildInstructions(sensitive: boolean): WidgetAgentInstructions {
  return {
    purpose: 'Collect and edit one bounded multiline text value in a labeled editor.',
    useWhen: [
      'The user needs to author or revise prose, code, a plan, or another multiline value.',
      'The caller can validate the complete buffer before accepting it.',
    ],
    avoidWhen: [
      'Use prompt input for a single line, select for finite choices, and confirm for approval or destructive actions.',
      'Never turn typed destructive phrases into approval and never request secrets without explicit sensitive mode.',
    ],
    inputs: [
      'Provide a visible label, optional help and placeholder, bounded initial content, and explicit validation rules.',
      sensitive
        ? 'Treat the entire buffer as sensitive; do not repeat it in rendered, alternate, logged, or agent-visible output.'
        : 'Enable sensitive mode before requesting credentials, tokens, passwords, private keys, or secrets.',
    ],
    stateAndOutput: [
      'Editing preserves a grapheme-indexed cursor, optional selection, undo/redo history, and scroll position across resize.',
      'Submit emits a typed value intent; cancel emits a typed reason and never silently submits or discards on behalf of the caller.',
    ],
    keys: [
      'Enter inserts a newline; Ctrl+Enter or Meta+Enter submits; Escape or Ctrl-C cancels.',
      'Arrows, Home, End, PageUp, and PageDown navigate; Shift with navigation extends selection.',
      'Backspace and Delete edit by grapheme; Ctrl+A selects all; Ctrl+Z undoes; Ctrl+Shift+Z or Ctrl+Y redoes; paste inserts normalized multiline text.',
    ],
    accessibility: [
      'The visible label is the textbox name; placeholder text never substitutes for the label.',
      'Expose focus, validation, cursor position, selection, and keyboard help without relying on color, position, or animation.',
      'Provide a plain-text alternate output with editing, submit, and cancel shortcuts; redact all sensitive content.',
    ],
    recovery: [
      'On validation failure, preserve buffer, cursor, selection, undo history, and scroll, announce the error, and allow correction.',
      'On cancellation, emit the reason and let the caller decide whether to retain, retry, or discard the draft.',
    ],
  };
}

export class EditorWidget extends OpenTuiWidget<EditorWidgetIntent> {
  readonly focusOnActivation = true;
  private readonly options: NormalizedEditorOptions;

  get sensitive(): boolean {
    return this.options.sensitive;
  }
  private buffer: string;
  private cursorIndex: number;
  private selectionAnchor?: number;
  private width: number;
  private height: number;
  private scrollOffset = 0;
  private readonly undoStack: EditorSnapshot[] = [];
  private readonly redoStack: EditorSnapshot[] = [];
  private validationMessage?: string;
  private lastIntent: 'editing' | 'submitted' | 'cancelled' = 'editing';

  constructor(options: EditorWidgetOptions) {
    const normalized = normalizeOptions(options);
    super({
      id: options.id,
      kind: 'prompt.editor',
      capabilities: { focusable: true, inputMode: 'multiline' },
      accessibility: {
        role: 'textbox',
        label: normalized.label,
        description: normalized.help ?? 'Multiline text editor.',
        liveRegion: 'polite',
        keyboardHelp: [
          'Enter inserts a newline; Ctrl+Enter or Meta+Enter submits',
          'Escape or Ctrl-C cancels',
          'Arrow, Home, End, Page, selection, undo, redo, delete, and paste commands edit the buffer',
        ],
      },
      instructions: buildInstructions(normalized.sensitive),
    });
    this.options = normalized;
    this.buffer = normalized.initialValue;
    this.cursorIndex = graphemes(this.buffer).length;
    this.width = normalized.viewportWidth;
    this.height = normalized.viewportHeight;
    this.scrollOffset = Math.max(0, this.cursorPosition.line - this.height + 1);
  }

  get value(): string {
    return this.buffer;
  }

  /** Cursor offset in grapheme clusters, never UTF-16 code units. */
  get cursor(): number {
    return this.cursorIndex;
  }

  get cursorPosition(): { readonly line: number; readonly column: number } {
    const units = graphemes(this.buffer);
    let line = 0;
    let column = 0;
    for (let index = 0; index < this.cursorIndex; index += 1) {
      if (units[index] === '\n') {
        line += 1;
        column = 0;
      } else {
        column += 1;
      }
    }
    return Object.freeze({ line, column });
  }

  get selection(): { readonly start: number; readonly end: number } | undefined {
    if (this.selectionAnchor === undefined || this.selectionAnchor === this.cursorIndex) return undefined;
    return Object.freeze({
      start: Math.min(this.selectionAnchor, this.cursorIndex),
      end: Math.max(this.selectionAnchor, this.cursorIndex),
    });
  }

  get scrollLine(): number {
    return this.scrollOffset;
  }

  get viewport(): { readonly width: number; readonly height: number } {
    return Object.freeze({ width: this.width, height: this.height });
  }

  override activate(): void {
    super.activate();
    this.focus();
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  resize(width: number, height: number): void {
    const nextWidth = normalizeDimension(width, width, 'viewportWidth');
    const nextHeight = normalizeDimension(height, height, 'viewportHeight');
    if (nextWidth !== this.width || nextHeight !== this.height) {
      this.width = nextWidth;
      this.height = nextHeight;
      this.invalidate();
    }
  }

  /**
   * Synchronize a complete value emitted by a native multiline control.
   * Cursor offsets are grapheme-cluster indexes, never UTF-16 offsets.
   */
  replaceValue(value: string, cursor?: number): EditorWidgetResult {
    if (value.length > MAX_SANITIZE_GRAPHEMES) {
      return this.invalid(`Enter no more than ${this.options.maxLength} characters.`);
    }

    const candidate = normalizeMultiline(value);
    if (candidate.length > this.options.maxLength) {
      return this.invalid(`Enter no more than ${this.options.maxLength} characters.`);
    }
    const candidateLength = graphemes(candidate).length;
    const nextCursor = cursor ?? candidateLength;
    if (!Number.isSafeInteger(nextCursor) || nextCursor < 0 || nextCursor > candidateLength) {
      return this.invalid(`Cursor must be a grapheme offset between 0 and ${candidateLength}.`);
    }

    const contentChanged = candidate !== this.buffer;
    const stateChanged = contentChanged
      || nextCursor !== this.cursorIndex
      || this.selectionAnchor !== undefined
      || this.validationMessage !== undefined
      || this.lastIntent !== 'editing';
    if (!stateChanged) return { status: 'handled' };

    if (contentChanged) this.recordMutation();
    this.buffer = candidate;
    this.cursorIndex = nextCursor;
    this.selectionAnchor = undefined;
    return this.changed();
  }

  alternateOutput(): string {
    const value = this.options.sensitive
      ? this.redactedValue()
      : (this.buffer || this.options.placeholder || '(empty)');
    const position = this.cursorPosition;
    const lines = [
      `Editor: ${this.options.label}`,
      `State: ${this.lastIntent}`,
      `Value: ${value}`,
      `Cursor: line ${position.line + 1}, column ${position.column + 1}`,
      'Shortcuts: Enter: newline; Ctrl+Enter or Meta+Enter: submit; Escape or Ctrl-C: cancel.',
    ];
    if (this.options.help) lines.push(`Help: ${this.options.help}`);
    if (this.selection) lines.push(`Selection: graphemes ${this.selection.start}-${this.selection.end}`);
    if (this.validationMessage) lines.push(`Validation: ${this.validationMessage}`);
    return lines.join('\n');
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const position = this.cursorPosition;
    const selection = this.selection;
    const regions: WidgetRenderRegion[] = [
      { id: 'label', role: 'prompt', text: this.options.label },
      {
        id: 'value',
        role: 'content',
        text: this.options.sensitive && this.buffer.length > 0 ? this.redactedValue() : this.buffer,
      },
      {
        id: 'cursor',
        role: 'status',
        text: `Line ${position.line + 1}, column ${position.column + 1}${selection ? `; ${selection.end - selection.start} graphemes selected` : ''}`,
      },
      {
        id: 'shortcuts',
        role: 'help',
        text: 'Enter newline · Ctrl+Enter/Meta+Enter submit · Escape/Ctrl-C cancel',
      },
    ];
    if (!this.buffer && this.options.placeholder) {
      regions.push({ id: 'placeholder', role: 'help', text: this.options.placeholder });
    }
    if (this.options.help) regions.push({ id: 'help', role: 'help', text: this.options.help });
    if (this.validationMessage) {
      regions.push({ id: 'validation', role: 'status', text: this.validationMessage });
    }
    return regions;
  }

  protected onInput(input: WidgetInput): EditorWidgetResult {
    switch (input.type) {
      case 'text':
      case 'paste':
        return this.insert(input.text);
      case 'submit':
        return this.submit();
      case 'cancel':
        return this.cancel('semantic');
      case 'key':
        return this.onKey(input.key);
      default:
        return { status: 'ignored' };
    }
  }

  private onKey(rawKey: string): EditorWidgetResult {
    const key = rawKey.toLowerCase();
    if (key === 'ctrl+enter' || key === 'control+enter' || key === 'meta+enter'
      || key === 'cmd+enter' || key === 'command+enter') return this.submit();
    if (key === 'escape' || key === 'esc') return this.cancel('escape');
    if (key === 'ctrl+c' || key === 'c-c' || rawKey === '\u0003') return this.cancel('interrupt');
    if (key === 'ctrl+z') return this.undo();
    if (key === 'ctrl+shift+z' || key === 'ctrl+y' || key === 'meta+shift+z') return this.redo();
    if (key === 'ctrl+a' || key === 'meta+a') return this.selectAll();
    if (key === 'enter' || key === 'return') return this.insert('\n');
    if (key === 'backspace') return this.deleteBackward();
    if (key === 'delete') return this.deleteForward();

    const selecting = key.startsWith('shift+');
    const navigationKey = selecting ? key.slice('shift+'.length) : key;
    switch (navigationKey) {
      case 'arrowleft':
      case 'left':
        return this.navigateHorizontal(-1, selecting);
      case 'arrowright':
      case 'right':
        return this.navigateHorizontal(1, selecting);
      case 'arrowup':
      case 'up':
        return this.navigateVertical(-1, selecting);
      case 'arrowdown':
      case 'down':
        return this.navigateVertical(1, selecting);
      case 'home':
        return this.navigateLineBoundary('start', selecting);
      case 'end':
        return this.navigateLineBoundary('end', selecting);
      case 'pageup':
        return this.navigateVertical(-this.height, selecting);
      case 'pagedown':
        return this.navigateVertical(this.height, selecting);
      default:
        return rawKey.length === 1 ? this.insert(rawKey) : { status: 'ignored' };
    }
  }

  private insert(raw: string): EditorWidgetResult {
    const text = normalizeMultiline(raw);
    if (!text) return { status: 'handled' };
    const units = graphemes(this.buffer);
    const selected = this.selection;
    const start = selected?.start ?? this.cursorIndex;
    const end = selected?.end ?? this.cursorIndex;
    const candidate = [...units.slice(0, start), ...graphemes(text), ...units.slice(end)].join('');
    if (candidate.length > this.options.maxLength) {
      return this.invalid(`Enter no more than ${this.options.maxLength} characters.`);
    }
    this.recordMutation();
    this.buffer = candidate;
    this.cursorIndex = start + graphemes(text).length;
    this.selectionAnchor = undefined;
    return this.changed();
  }

  private deleteBackward(): EditorWidgetResult {
    const selected = this.selection;
    if (selected) return this.deleteRange(selected.start, selected.end);
    if (this.cursorIndex === 0) return { status: 'handled' };
    return this.deleteRange(this.cursorIndex - 1, this.cursorIndex);
  }

  private deleteForward(): EditorWidgetResult {
    const selected = this.selection;
    if (selected) return this.deleteRange(selected.start, selected.end);
    if (this.cursorIndex === graphemes(this.buffer).length) return { status: 'handled' };
    return this.deleteRange(this.cursorIndex, this.cursorIndex + 1);
  }

  private deleteRange(start: number, end: number): EditorWidgetResult {
    const units = graphemes(this.buffer);
    this.recordMutation();
    this.buffer = [...units.slice(0, start), ...units.slice(end)].join('');
    this.cursorIndex = start;
    this.selectionAnchor = undefined;
    return this.changed();
  }

  private navigateHorizontal(delta: -1 | 1, selecting: boolean): EditorWidgetResult {
    const selected = this.selection;
    if (!selecting && selected) return this.moveCursor(delta < 0 ? selected.start : selected.end, false);
    return this.moveCursor(
      Math.max(0, Math.min(graphemes(this.buffer).length, this.cursorIndex + delta)),
      selecting,
    );
  }

  private navigateVertical(deltaLines: number, selecting: boolean): EditorWidgetResult {
    const { line, column } = this.cursorPosition;
    const lines = this.lineBounds();
    const targetLine = Math.max(0, Math.min(lines.length - 1, line + deltaLines));
    const target = Math.min(lines[targetLine]!.end, lines[targetLine]!.start + column);
    return this.moveCursor(target, selecting);
  }

  private navigateLineBoundary(boundary: 'start' | 'end', selecting: boolean): EditorWidgetResult {
    const lines = this.lineBounds();
    const current = lines[this.cursorPosition.line]!;
    return this.moveCursor(boundary === 'start' ? current.start : current.end, selecting);
  }

  private moveCursor(next: number, selecting: boolean): EditorWidgetResult {
    if (selecting && this.selectionAnchor === undefined) this.selectionAnchor = this.cursorIndex;
    if (!selecting) this.selectionAnchor = undefined;
    if (next !== this.cursorIndex || selecting) {
      this.cursorIndex = next;
      this.keepCursorVisible();
      this.invalidate();
    }
    return { status: 'handled' };
  }

  private lineBounds(): Array<{ start: number; end: number }> {
    const units = graphemes(this.buffer);
    const lines: Array<{ start: number; end: number }> = [];
    let start = 0;
    for (let index = 0; index < units.length; index += 1) {
      if (units[index] === '\n') {
        lines.push({ start, end: index });
        start = index + 1;
      }
    }
    lines.push({ start, end: units.length });
    return lines;
  }

  private selectAll(): EditorWidgetResult {
    const length = graphemes(this.buffer).length;
    this.selectionAnchor = 0;
    this.cursorIndex = length;
    this.keepCursorVisible();
    this.invalidate();
    return { status: 'handled' };
  }

  private undo(): EditorWidgetResult {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return { status: 'handled' };
    this.pushBounded(this.redoStack, this.snapshot());
    this.restore(snapshot);
    return this.changed(false);
  }

  private redo(): EditorWidgetResult {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return { status: 'handled' };
    this.pushBounded(this.undoStack, this.snapshot());
    this.restore(snapshot);
    return this.changed(false);
  }

  private recordMutation(): void {
    this.pushBounded(this.undoStack, this.snapshot());
    this.redoStack.length = 0;
  }

  private pushBounded(stack: EditorSnapshot[], snapshot: EditorSnapshot): void {
    stack.push(snapshot);
    let bytes = stack.reduce((total, entry) => total + (entry.buffer.length * 2) + 32, 0);
    while (stack.length > MAX_HISTORY_ENTRIES || bytes > MAX_HISTORY_BYTES) {
      const removed = stack.shift();
      if (!removed) break;
      bytes -= (removed.buffer.length * 2) + 32;
    }
  }

  private snapshot(): EditorSnapshot {
    return {
      buffer: this.buffer,
      cursor: this.cursorIndex,
      ...(this.selectionAnchor === undefined ? {} : { selectionAnchor: this.selectionAnchor }),
      scrollLine: this.scrollOffset,
    };
  }

  private restore(snapshot: EditorSnapshot): void {
    this.buffer = snapshot.buffer;
    this.cursorIndex = snapshot.cursor;
    this.selectionAnchor = snapshot.selectionAnchor;
    this.scrollOffset = snapshot.scrollLine;
  }

  private changed(updateScroll = true): EditorWidgetResult {
    this.validationMessage = undefined;
    this.lastIntent = 'editing';
    if (updateScroll) this.keepCursorVisible();
    this.invalidate();
    return { status: 'handled' };
  }

  private keepCursorVisible(): void {
    const line = this.cursorPosition.line;
    if (line < this.scrollOffset) this.scrollOffset = line;
    if (line >= this.scrollOffset + this.height) this.scrollOffset = line - this.height + 1;
  }

  private submit(): EditorWidgetResult {
    const message = this.validate();
    if (message) return this.invalid(message);
    this.validationMessage = undefined;
    this.lastIntent = 'submitted';
    this.invalidate();
    return {
      status: 'handled',
      output: { type: 'submit', value: this.buffer, sensitive: this.options.sensitive },
    };
  }

  private cancel(reason: Extract<EditorWidgetIntent, { type: 'cancel' }>['reason']): EditorWidgetResult {
    this.lastIntent = 'cancelled';
    this.invalidate();
    return { status: 'handled', output: { type: 'cancel', reason } };
  }

  private validate(): string | undefined {
    if (this.options.required && this.buffer.length === 0) return 'A value is required.';
    if (this.buffer.length < this.options.minLength) {
      return `Enter at least ${this.options.minLength} characters.`;
    }
    if (this.buffer.length > this.options.maxLength) {
      return `Enter no more than ${this.options.maxLength} characters.`;
    }
    if (this.options.pattern && !this.options.pattern.test(this.buffer)) {
      return this.options.patternDescription ?? 'The value does not match the required format.';
    }
    return undefined;
  }

  private invalid(message: string): EditorWidgetResult {
    this.validationMessage = message;
    this.invalidate();
    return { status: 'invalid', message };
  }

  private redactedValue(): string {
    const lineCount = this.buffer.length === 0 ? 0 : this.buffer.split('\n').length;
    return `[${this.options.redactionLabel}: ${this.buffer.length} characters, ${lineCount} lines]`;
  }
}
