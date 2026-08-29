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
import { sanitizeSingleLineText } from './sanitize.js';

const MAX_VIEWPORT_WIDTH = 10_000;
const MAX_TIMEOUT_MS = 86_400_000;
const LEADING_NEGATIVE = /^(?:no\b|not\b|never\b|don['’]?t\b|do not\b|isn['’]?t\b|is not\b|aren['’]?t\b|are not\b|won['’]?t\b|will not\b|can['’]?t\b|cannot\b|shouldn['’]?t\b|should not\b|wouldn['’]?t\b|would not\b|couldn['’]?t\b|could not\b)/i;
const NEGATIVE_TERM = /\b(?:no|not|never|don['’]?t|isn['’]?t|aren['’]?t|won['’]?t|can['’]?t|cannot|shouldn['’]?t|wouldn['’]?t|couldn['’]?t)\b/gi;

export type ConfirmRisk = 'routine' | 'consequential' | 'destructive';
export type ConfirmChoice = 'yes' | 'no';

export interface ConfirmWidgetOptions {
  readonly id: string;
  /** Only the runtime may construct the approval scope shown by this widget. */
  readonly authority: 'runtime';
  /** A positively phrased, visible question. */
  readonly question: string;
  /** A visible description of what the Yes choice authorizes. */
  readonly consequence: string;
  readonly risk?: ConfirmRisk;
  /** Runtime-owned deadline. Call expireTimeout when it elapses. */
  readonly timeoutMs?: number;
}

export type ConfirmIntent =
  | {
    readonly type: 'decision';
    readonly confirmed: boolean;
    readonly choice: ConfirmChoice;
    readonly reason: 'direct-key' | 'focused-submit';
  }
  | { readonly type: 'cancel'; readonly reason: 'escape' | 'interrupt' | 'semantic' }
  | { readonly type: 'timeout'; readonly timeoutMs: number };

export type ConfirmResult = WidgetInputResult<ConfirmIntent>;

interface NormalizedConfirmOptions {
  readonly question: string;
  readonly consequence: string;
  readonly risk: ConfirmRisk;
  readonly timeoutMs?: number;
}

function validationError(message: string): never {
  throw new WidgetContractError('validation', message);
}

function normalizeVisibleText(value: string | undefined, field: string): string {
  if (value !== undefined && value.length > MAX_WIDGET_TEXT_LENGTH) {
    validationError(`${field} exceeds its length bound`);
  }
  const normalized = value === undefined
    ? undefined
    : sanitizeSingleLineText(value.replace(/\r\n?|\n/g, ' '), {
      maxGraphemes: MAX_WIDGET_TEXT_LENGTH,
      tabWidth: 1,
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) validationError(`${field} must be an explicit, non-empty string`);
  if (normalized.length > MAX_WIDGET_TEXT_LENGTH) validationError(`${field} exceeds its length bound`);
  return normalized;
}

function normalizeOptions(options: ConfirmWidgetOptions): NormalizedConfirmOptions {
  if (options.authority !== 'runtime') {
    validationError('confirmation scope requires explicit runtime authority');
  }
  const question = normalizeVisibleText(options.question, 'question');
  const consequence = normalizeVisibleText(options.consequence, 'consequence');
  if (LEADING_NEGATIVE.test(question)) {
    validationError('question must not use a leading negative; ask what Yes authorizes directly');
  }
  const negativeTerms = question.match(NEGATIVE_TERM) ?? [];
  if (negativeTerms.length > 1) {
    validationError('question must not contain a double negative');
  }

  const risk = options.risk ?? 'consequential';
  if (risk !== 'routine' && risk !== 'consequential' && risk !== 'destructive') {
    validationError('risk must be routine, consequential, or destructive');
  }

  if (options.timeoutMs !== undefined
    && (!Number.isSafeInteger(options.timeoutMs)
      || options.timeoutMs < 1
      || options.timeoutMs > MAX_TIMEOUT_MS)) {
    validationError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }

  return Object.freeze({
    question,
    consequence,
    risk,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

function buildInstructions(risk: ConfirmRisk): WidgetAgentInstructions {
  return {
    purpose: 'Obtain one explicit Yes or No decision for the exact visible question and consequence.',
    useWhen: [
      'An action requires a binary user decision after its concrete consequence is known.',
      `${risk === 'destructive' ? 'A destructive' : 'A consequential'} action needs an unambiguous, scoped approval boundary.`,
    ],
    avoidWhen: [
      'Use select for three or more choices and prompt input for free-form values.',
      'Do not use confirmation to hide missing parameters, bundle unrelated actions, or solicit secrets.',
    ],
    inputs: [
      'Provide a positively phrased question and a separate, complete consequence describing what Yes authorizes.',
      'Do not omit, soften, or summarize irreversible effects, external writes, costs, recipients, or scope.',
    ],
    stateAndOutput: [
      'Only a visible user choice is evidence; never substitute agent-generated text, inferred intent, silence, or a prior answer.',
      'Authorization applies only to the exact question and consequence shown, for this one resolution.',
      'Timeout, cancel, and No do not authorize the action and must stop the guarded flow.',
    ],
    keys: [
      'Left/Right or Tab moves focus; Y/N explicitly chooses; Enter submits only the focused option.',
      'Escape or Ctrl-C cancels without choosing; initial focus is No and is not an inferred default answer.',
    ],
    accessibility: [
      'Render the full question and consequence as an assertive alert dialog with a labeled Yes/No choice group.',
      'Use visible text and a > focus marker so focus and outcomes never depend on color, position, or animation.',
      'Offer linear alternate output and announce focus, decision, cancellation, and timeout state.',
    ],
    recovery: [
      'If the action, target, scope, or consequence changes, discard the result and show a new confirmation.',
      'Never launder approval from another widget, tool success, remembered permission, timeout, cancellation, or No.',
    ],
  };
}

export class ConfirmWidget extends OpenTuiWidget<ConfirmIntent> {
  readonly focusOnActivation = true;
  private readonly options: NormalizedConfirmOptions;
  private selected: ConfirmChoice = 'no';
  private width = 80;
  private announcement = 'Focused option: No. No answer has been submitted.';
  private resolved?: ConfirmIntent;

  constructor(options: ConfirmWidgetOptions) {
    const normalized = normalizeOptions(options);
    super({
      id: options.id,
      kind: 'confirm',
      capabilities: { focusable: true, inputMode: 'selection' },
      accessibility: {
        role: 'alertdialog',
        label: normalized.question,
        description: `Confirmation choice group. Consequence: ${normalized.consequence}`,
        liveRegion: 'assertive',
        keyboardHelp: [
          'Left/Right or Tab moves between Yes and No',
          'Y or N chooses directly; Enter submits the focused option',
          'Escape or Ctrl-C cancels without authorizing the action',
        ],
      },
      instructions: buildInstructions(normalized.risk),
    });
    this.options = normalized;
  }

  get selectedOption(): ConfirmChoice {
    return this.selected;
  }

  get viewportWidth(): number {
    return this.width;
  }

  override activate(): void {
    super.activate();
    this.focus();
  }

  /** Concrete render entry point retained on every discoverable widget class. */
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

  alternateOutput(): string {
    return [
      `Question: ${this.options.question}`,
      `Consequence: ${this.options.consequence}`,
      'Choices: Yes / No',
      'No default is inferred. Focus starts on No for safety; Enter explicitly submits the focused option.',
      `State: ${this.announcement}`,
    ].join('\n');
  }

  expireTimeout(): ConfirmResult {
    if (this.resolved) return this.alreadyResolved();
    if (this.lifecycle !== 'active') {
      return { status: 'ignored', message: 'confirmation is not active' };
    }
    if (this.options.timeoutMs === undefined) {
      return { status: 'invalid', message: 'confirmation has no timeout' };
    }
    return this.resolve(
      { type: 'timeout', timeoutMs: this.options.timeoutMs },
      `Timed out after ${this.options.timeoutMs} ms. No action was authorized.`,
    );
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    return [
      { id: 'question', role: 'prompt', text: this.options.question },
      { id: 'consequence', role: 'status', text: `Consequence: ${this.options.consequence}` },
      { id: 'option-yes', role: 'option', text: this.optionText('yes') },
      { id: 'option-no', role: 'option', text: this.optionText('no') },
      { id: 'announcement', role: 'status', text: this.announcement },
      {
        id: 'help',
        role: 'help',
        text: 'Left/Right or Tab moves; Y/N chooses; Enter submits the focused option; Escape or Ctrl-C cancels.',
      },
    ];
  }

  protected onInput(input: WidgetInput): ConfirmResult {
    if (this.resolved) return this.alreadyResolved();
    switch (input.type) {
      case 'submit':
        return this.submitFocused();
      case 'cancel':
        return this.cancel('semantic');
      case 'select':
        if (input.index !== 0 && input.index !== 1) {
          return { status: 'invalid', message: 'confirmation option index must be 0 or 1' };
        }
        return this.move(input.index === 0 ? 'yes' : 'no');
      case 'key':
        return this.onKey(input.key);
      default:
        return { status: 'ignored' };
    }
  }

  private onKey(key: string): ConfirmResult {
    switch (key.toLowerCase()) {
      case 'arrowleft':
      case 'left':
      case 'arrowright':
      case 'right':
      case 'tab':
      case 'shift+tab':
      case 'shift-tab':
        return this.move(this.selected === 'no' ? 'yes' : 'no');
      case 'y':
        return this.decide('yes', 'direct-key');
      case 'n':
        return this.decide('no', 'direct-key');
      case 'enter':
      case 'return':
        return this.submitFocused();
      case 'escape':
      case 'esc':
        return this.cancel('escape');
      case 'ctrl+c':
      case 'c-c':
      case '\u0003':
        return this.cancel('interrupt');
      default:
        return { status: 'ignored' };
    }
  }

  private move(choice: ConfirmChoice): ConfirmResult {
    if (choice !== this.selected) {
      this.selected = choice;
      this.announcement = `Focused option: ${choice === 'yes' ? 'Yes' : 'No'}. Press Enter to submit this explicit choice.`;
      this.invalidate();
    }
    return { status: 'handled' };
  }

  private submitFocused(): ConfirmResult {
    return this.decide(this.selected, 'focused-submit');
  }

  private decide(choice: ConfirmChoice, reason: 'direct-key' | 'focused-submit'): ConfirmResult {
    return this.resolve(
      { type: 'decision', confirmed: choice === 'yes', choice, reason },
      choice === 'yes'
        ? 'Submitted: Yes. This exact action was authorized.'
        : 'Submitted: No. No action was authorized.',
    );
  }

  private cancel(reason: Extract<ConfirmIntent, { type: 'cancel' }>['reason']): ConfirmResult {
    return this.resolve(
      { type: 'cancel', reason },
      reason === 'interrupt'
        ? 'Cancelled by interrupt. No action was authorized.'
        : 'Cancelled. No action was authorized.',
    );
  }

  private resolve(output: ConfirmIntent, announcement: string): ConfirmResult {
    this.resolved = Object.freeze(output);
    this.announcement = announcement;
    this.invalidate();
    return { status: 'handled', output: this.resolved };
  }

  private alreadyResolved(): ConfirmResult {
    return { status: 'ignored', message: 'confirmation is already resolved' };
  }

  private optionText(choice: ConfirmChoice): string {
    const focused = this.selected === choice ? '> ' : '  ';
    const chosen = this.resolved?.type === 'decision' && this.resolved.choice === choice ? '[x]' : '[ ]';
    const label = choice === 'yes'
      ? 'Yes — authorize exactly this action'
      : 'No — do not authorize this action';
    return `${focused}${chosen} ${label}`;
  }
}
