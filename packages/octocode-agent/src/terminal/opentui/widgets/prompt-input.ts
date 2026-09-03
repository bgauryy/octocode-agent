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
import { graphemeBoundaries, sanitizeSingleLineText } from './sanitize.js';

const DEFAULT_MAX_LENGTH = 4_096;
const MAX_VIEWPORT_WIDTH = 10_000;
const SECRET_REQUEST = /\b(?:api[- ]?key|access token|auth token|password|passphrase|private key|secret|credential)\b/i;
const DESTRUCTIVE_TEXT_APPROVAL = /(?:\btype\b|\benter\b).{0,40}\b(?:confirm|delete|destroy|erase|remove|wipe|drop|overwrite)\b|\bconfirm\b.{0,40}\b(?:delete|destroy|erase|remove|wipe|drop|overwrite)\b/i;

export interface PromptInputWidgetOptions {
  readonly id: string;
  /** Visible question and accessible label. A placeholder is never used in its place. */
  readonly question: string;
  readonly placeholder?: string;
  readonly help?: string;
  readonly initialValue?: string;
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly patternDescription?: string;
  readonly sensitive?: boolean;
  readonly redactionLabel?: string;
}

export type PromptInputIntent =
  | { readonly type: 'submit'; readonly value: string; readonly sensitive: boolean }
  | { readonly type: 'cancel'; readonly reason: 'escape' | 'interrupt' | 'semantic' };

export type PromptInputResult = WidgetInputResult<PromptInputIntent>;

interface NormalizedPromptOptions {
  readonly question: string;
  readonly placeholder?: string;
  readonly help?: string;
  readonly initialValue: string;
  readonly required: boolean;
  readonly minLength: number;
  readonly maxLength: number;
  readonly pattern?: RegExp;
  readonly patternDescription?: string;
  readonly sensitive: boolean;
  readonly redactionLabel: string;
}

function validationError(message: string): never {
  throw new WidgetContractError('validation', message);
}

function boundedOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = sanitizePromptSingleLine(value).trim();
  if (normalized.length === 0) validationError(`${field} must not be empty`);
  if (normalized.length > MAX_WIDGET_TEXT_LENGTH) validationError(`${field} exceeds its length bound`);
  return normalized;
}

function sanitizeSingleLine(value: string): string {
  return sanitizePromptSingleLine(value);
}

function sanitizePromptSingleLine(value: string): string {
  return sanitizeSingleLineText(
    value.replace(/\r\n?|\n|[\u2028\u2029]/g, ' '),
    { maxGraphemes: MAX_WIDGET_TEXT_LENGTH, tabWidth: 1 },
  );
}

function graphemeCount(value: string): number {
  return graphemeBoundaries(value).length - 1;
}

function previousGraphemeBoundary(value: string, cursor: number): number {
  const boundaries = graphemeBoundaries(value);
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index];
    if (boundary !== undefined && boundary < cursor) return boundary;
  }
  return 0;
}

function nextGraphemeBoundary(value: string, cursor: number): number {
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > cursor) return boundary;
  }
  return value.length;
}

/** Move forward when insertion causes neighboring code points to merge into one grapheme. */
function boundaryAtOrAfter(value: string, cursor: number): number {
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary >= cursor) return boundary;
  }
  return value.length;
}

function normalizeOptions(options: PromptInputWidgetOptions): NormalizedPromptOptions {
  const question = sanitizePromptSingleLine(options.question ?? '').trim();
  if (!question) validationError('question must be an explicit, non-empty label');
  if (question.length > MAX_WIDGET_TEXT_LENGTH) validationError('question exceeds its length bound');
  if (DESTRUCTIVE_TEXT_APPROVAL.test(question)) {
    validationError('destructive approval must use the confirm widget, not a text input');
  }

  const sensitive = options.sensitive ?? false;
  if (SECRET_REQUEST.test(question) && !sensitive) {
    validationError('secret-like input must explicitly enable sensitive redaction');
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

  const initialValue = sanitizeSingleLine(options.initialValue ?? '');
  if (graphemeCount(initialValue) > maxLength || initialValue.length > MAX_WIDGET_TEXT_LENGTH) {
    validationError('initialValue exceeds maxLength');
  }
  if (options.pattern && options.pattern.source.length > 1_024) {
    validationError('pattern exceeds its length bound');
  }

  return Object.freeze({
    question,
    ...(boundedOptionalText(options.placeholder, 'placeholder') === undefined
      ? {}
      : { placeholder: boundedOptionalText(options.placeholder, 'placeholder') }),
    ...(boundedOptionalText(options.help, 'help') === undefined
      ? {}
      : { help: boundedOptionalText(options.help, 'help') }),
    initialValue,
    required: options.required ?? false,
    minLength,
    maxLength,
    ...(options.pattern === undefined
      ? {}
      : { pattern: new RegExp(options.pattern.source, options.pattern.flags.replace(/[gy]/g, '')) }),
    ...(boundedOptionalText(options.patternDescription, 'patternDescription') === undefined
      ? {}
      : { patternDescription: boundedOptionalText(options.patternDescription, 'patternDescription') }),
    sensitive,
    redactionLabel: boundedOptionalText(options.redactionLabel, 'redactionLabel') ?? 'hidden value',
  });
}

function buildInstructions(sensitive: boolean): WidgetAgentInstructions {
  return {
    purpose: 'Collect one bounded, single-line text value after showing an explicit question.',
    useWhen: [
      'A user must provide free-form text that cannot be represented as a finite select choice.',
      'The value can be validated locally before it is submitted.',
    ],
    avoidWhen: [
      'Use the select widget for finite choices and the confirm widget for approval, especially destructive approval.',
      'Do not ask for credentials unless sensitive mode and redaction are explicitly enabled.',
    ],
    inputs: [
      'Provide a visible question, optional help and placeholder, and explicit validation bounds.',
      sensitive
        ? 'Treat the submitted value as sensitive and never repeat it in messages, logs, or alternate output.'
        : 'Use sensitive mode before requesting a password, token, secret, private key, or credential.',
    ],
    stateAndOutput: [
      'Editing mutates the bounded buffer and cursor; resize changes only viewport metadata.',
      'Submit emits a typed submit intent; cancellation emits a typed cancel intent without inventing an answer.',
    ],
    keys: [
      'Text and paste insert at the cursor; pasted or typed newlines become spaces.',
      'Left/Right/Home/End move; Backspace/Delete edit; Enter submits; Escape or Ctrl-C cancels.',
    ],
    accessibility: [
      'The visible question is also the textbox label; a placeholder never substitutes for a label.',
      'Focus the textbox on activation and expose help plus validation without relying on color or cursor position.',
      'Offer alternate plain-text output, redacting sensitive values.',
    ],
    recovery: [
      'On validation failure, preserve the value and cursor, announce the error politely, and allow correction.',
      'On cancellation, stop the prompt flow and let the caller decide whether to retry or abort.',
    ],
  };
}

export class PromptInputWidget extends OpenTuiWidget<PromptInputIntent> {
  readonly focusOnActivation = true;
  private readonly options: NormalizedPromptOptions;
  private buffer: string;
  private cursorIndex: number;
  private width = 80;
  private validationMessage?: string;

  get sensitive(): boolean {
    return this.options.sensitive;
  }

  constructor(options: PromptInputWidgetOptions) {
    const normalized = normalizeOptions(options);
    super({
      id: options.id,
      kind: 'prompt.input',
      capabilities: { focusable: true, inputMode: 'text' },
      accessibility: {
        role: 'textbox',
        label: normalized.question,
        description: normalized.help ?? 'Single-line text input.',
        liveRegion: 'polite',
        keyboardHelp: [
          'Enter submits',
          'Escape or Ctrl-C cancels',
          'Arrow keys, Home, End, Backspace, and Delete edit the value',
        ],
      },
      instructions: buildInstructions(normalized.sensitive),
    });
    this.options = normalized;
    this.buffer = normalized.initialValue;
    this.cursorIndex = this.buffer.length;
  }

  get value(): string {
    return this.buffer;
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  get viewportWidth(): number {
    return this.width;
  }

  override activate(): void {
    super.activate();
    this.focus();
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  resize(width: number): void {
    if (!Number.isSafeInteger(width) || width < 1 || width > MAX_VIEWPORT_WIDTH) {
      validationError(`viewport width must be between 1 and ${MAX_VIEWPORT_WIDTH}`);
    }
    if (width !== this.width) {
      this.width = width;
      this.invalidate();
    }
  }

  /** Synchronize a native input's complete buffer without exposing its value in the result. */
  replaceValue(value: string, cursor?: number): PromptInputResult {
    if (value.length > MAX_WIDGET_TEXT_LENGTH) {
      return this.invalid(`Enter no more than ${this.options.maxLength} characters.`);
    }

    const sanitized = sanitizeSingleLine(value);
    if (sanitized.length > MAX_WIDGET_TEXT_LENGTH
      || graphemeCount(sanitized) > this.options.maxLength) {
      return this.invalid(`Enter no more than ${this.options.maxLength} characters.`);
    }

    const rawCursor = cursor ?? value.length;
    if (!Number.isSafeInteger(rawCursor) || rawCursor < 0 || rawCursor > value.length) {
      return { status: 'invalid', message: 'cursor must be within the replacement value.' };
    }
    const sanitizedCursor = sanitizeSingleLine(value.slice(0, rawCursor)).length;

    this.buffer = sanitized;
    this.cursorIndex = boundaryAtOrAfter(sanitized, Math.min(sanitizedCursor, sanitized.length));
    this.validationMessage = undefined;
    this.invalidate();
    return { status: 'handled' };
  }

  alternateOutput(): string {
    const value = this.options.sensitive
      ? this.redactedValue()
      : (this.buffer || this.options.placeholder || '(empty)');
    const lines = [`Question: ${this.options.question}`, `Value: ${value}`];
    if (this.options.help) lines.push(`Help: ${this.options.help}`);
    if (this.validationMessage) lines.push(`Validation: ${this.validationMessage}`);
    return lines.join('\n');
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const regions: WidgetRenderRegion[] = [
      { id: 'question', role: 'prompt', text: this.options.question },
      {
        id: 'value',
        role: 'content',
        text: this.options.sensitive && this.buffer.length > 0 ? this.redactedValue() : this.buffer,
      },
    ];
    if (!this.buffer && this.options.placeholder) {
      regions.push({ id: 'placeholder', role: 'help', text: this.options.placeholder });
    }
    if (this.options.help) regions.push({ id: 'help', role: 'help', text: this.options.help });
    if (this.validationMessage) {
      regions.push({ id: 'validation', role: 'status', tone: 'error', text: this.validationMessage });
    }
    return regions;
  }

  protected onInput(input: WidgetInput): PromptInputResult {
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

  private onKey(key: string): PromptInputResult {
    switch (key.toLowerCase()) {
      case 'enter':
      case 'return':
        return this.submit();
      case 'escape':
      case 'esc':
        return this.cancel('escape');
      case 'ctrl+c':
      case 'c-c':
      case '\u0003':
        return this.cancel('interrupt');
      case 'arrowleft':
      case 'left':
        return this.moveCursor(previousGraphemeBoundary(this.buffer, this.cursorIndex));
      case 'arrowright':
      case 'right':
        return this.moveCursor(nextGraphemeBoundary(this.buffer, this.cursorIndex));
      case 'home':
        return this.moveCursor(0);
      case 'end':
        return this.moveCursor(this.buffer.length);
      case 'backspace':
        if (this.cursorIndex === 0) return { status: 'handled' };
        {
          const previous = previousGraphemeBoundary(this.buffer, this.cursorIndex);
          this.buffer = this.buffer.slice(0, previous) + this.buffer.slice(this.cursorIndex);
          this.cursorIndex = previous;
        }
        return this.changed();
      case 'delete':
        if (this.cursorIndex === this.buffer.length) return { status: 'handled' };
        this.buffer = this.buffer.slice(0, this.cursorIndex)
          + this.buffer.slice(nextGraphemeBoundary(this.buffer, this.cursorIndex));
        return this.changed();
      default:
        return key.length === 1 ? this.insert(key) : { status: 'ignored' };
    }
  }

  private insert(raw: string): PromptInputResult {
    const text = sanitizeSingleLine(raw);
    if (!text) return { status: 'handled' };
    const candidate = this.buffer.slice(0, this.cursorIndex) + text + this.buffer.slice(this.cursorIndex);
    if (candidate.length > MAX_WIDGET_TEXT_LENGTH || graphemeCount(candidate) > this.options.maxLength) {
      return this.invalid(`Enter no more than ${this.options.maxLength} characters.`);
    }
    this.buffer = candidate;
    this.cursorIndex = boundaryAtOrAfter(candidate, this.cursorIndex + text.length);
    return this.changed();
  }

  private moveCursor(next: number): PromptInputResult {
    if (next !== this.cursorIndex) {
      this.cursorIndex = next;
      this.invalidate();
    }
    return { status: 'handled' };
  }

  private changed(): PromptInputResult {
    this.validationMessage = undefined;
    this.invalidate();
    return { status: 'handled' };
  }

  private submit(): PromptInputResult {
    const message = this.validate();
    if (message) return this.invalid(message);
    this.validationMessage = undefined;
    return {
      status: 'handled',
      output: { type: 'submit', value: this.buffer, sensitive: this.options.sensitive },
    };
  }

  private cancel(reason: Extract<PromptInputIntent, { type: 'cancel' }>['reason']): PromptInputResult {
    return { status: 'handled', output: { type: 'cancel', reason } };
  }

  private validate(): string | undefined {
    if (this.options.required && this.buffer.length === 0) return 'A value is required.';
    const length = graphemeCount(this.buffer);
    if (length < this.options.minLength) {
      return `Enter at least ${this.options.minLength} characters.`;
    }
    if (length > this.options.maxLength) {
      return `Enter no more than ${this.options.maxLength} characters.`;
    }
    if (this.options.pattern && !this.options.pattern.test(this.buffer)) {
      return this.options.patternDescription ?? 'The value does not match the required format.';
    }
    return undefined;
  }

  private invalid(message: string): PromptInputResult {
    this.validationMessage = message;
    this.invalidate();
    return { status: 'invalid', message };
  }

  private redactedValue(): string {
    return this.buffer.length === 0
      ? `[${this.options.redactionLabel}]`
      : `[${this.options.redactionLabel}: ${graphemeCount(this.buffer)} characters]`;
  }
}
