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
import {
  assertStableTerminalId,
  sanitizeSingleLineText,
  segmentGraphemes,
  truncateGraphemes,
} from './sanitize.js';

const MAX_OPTIONS = 50;
const MAX_OPTION_ID_LENGTH = 57;
const MAX_VIEWPORT_DIMENSION = 10_000;
const OPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SEARCH_GRAPHEMES = 128;

export interface SelectWidgetOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
  readonly disabledReason?: string;
}

/** Complete viewport-independent option data consumed by native listbox adapters. */
export interface SelectWidgetNativeOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly recommended: boolean;
}

export interface SelectWidgetOptions {
  readonly id: string;
  /** Visible prompt and accessible listbox label. */
  readonly label: string;
  readonly description?: string;
  readonly options: readonly SelectWidgetOption[];
  readonly selectedId?: string;
  /** Consequential choices must never be initialized with a selected answer. */
  readonly consequential?: boolean;
  readonly searchEnabled?: boolean;
}

export type SelectWidgetIntent =
  | { readonly type: 'select'; readonly optionId: string }
  | { readonly type: 'cancel'; readonly reason: 'escape' | 'interrupt' | 'semantic' };

export type SelectWidgetResult = WidgetInputResult<SelectWidgetIntent>;

interface NormalizedSelectOptions {
  readonly label: string;
  readonly description?: string;
  readonly options: readonly Readonly<SelectWidgetOption>[];
  readonly selectedId?: string;
  readonly consequential: boolean;
  readonly searchEnabled: boolean;
}

function validationError(message: string): never {
  throw new WidgetContractError('validation', message);
}

function boundedText(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) validationError(`${field} must be a non-empty string`);
  if (normalized.length > MAX_WIDGET_TEXT_LENGTH) validationError(`${field} exceeds its length bound`);
  const safe = sanitizeSingleLineText(normalized, {
    maxGraphemes: MAX_WIDGET_TEXT_LENGTH,
    tabWidth: 0,
    ellipsis: '',
  });
  if (safe !== normalized) {
    validationError(`${field} must not contain terminal, C0/C1, bidi, or line-break controls`);
  }
  return normalized;
}

function optionalText(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : boundedText(value, field);
}

function normalizedVisibleLabel(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function stableOptionId(value: string | undefined, field: string): string {
  if (typeof value !== 'string') validationError(`${field} is invalid`);
  try {
    const id = assertStableTerminalId(value, { maxLength: MAX_OPTION_ID_LENGTH });
    // Render-region IDs intentionally use option IDs and the shared render contract excludes colon.
    if (!OPTION_ID_PATTERN.test(id)) validationError(`${field} is invalid`);
    return id;
  } catch {
    return validationError(`${field} is invalid or contains terminal control or bidi characters`);
  }
}

function removeLastGrapheme(value: string): string {
  const segments = segmentGraphemes(value);
  segments.pop();
  return segments.join('');
}

function normalizeOptions(options: SelectWidgetOptions): NormalizedSelectOptions {
  const label = boundedText(options.label, 'label');
  if (!Array.isArray(options.options) || options.options.length === 0) {
    validationError('options must contain at least one option');
  }
  if (options.options.length > MAX_OPTIONS) {
    validationError(`options must contain no more than ${MAX_OPTIONS} entries`);
  }

  const ids = new Set<string>();
  const labels = new Set<string>();
  const normalizedOptions = options.options.map((option, index) => {
    const id = stableOptionId(option.id, `options[${index}].id`);
    if (ids.has(id)) validationError(`option id '${id}' is duplicated`);
    ids.add(id);

    const optionLabel = boundedText(option.label, `options[${index}].label`);
    const visibleLabel = normalizedVisibleLabel(optionLabel);
    if (labels.has(visibleLabel)) {
      validationError(`option label '${optionLabel}' is duplicated or visually ambiguous`);
    }
    labels.add(visibleLabel);

    return Object.freeze({
      id,
      label: optionLabel,
      ...(optionalText(option.description, `options[${index}].description`) === undefined
        ? {}
        : { description: optionalText(option.description, `options[${index}].description`) }),
      ...(option.recommended === undefined ? {} : { recommended: option.recommended }),
      ...(optionalText(option.disabledReason, `options[${index}].disabledReason`) === undefined
        ? {}
        : { disabledReason: optionalText(option.disabledReason, `options[${index}].disabledReason`) }),
    });
  });

  if (options.consequential && options.selectedId !== undefined) {
    validationError('a consequential select must not preselect an answer');
  }
  if (options.selectedId !== undefined) {
    const selectedId = stableOptionId(options.selectedId, 'selectedId');
    const selected = normalizedOptions.find((option) => option.id === selectedId);
    if (!selected) validationError(`selectedId '${options.selectedId}' does not match an option`);
    if (selected.disabledReason) validationError(`selectedId '${options.selectedId}' is disabled`);
  }

  const normalized: NormalizedSelectOptions = {
    label,
    ...(optionalText(options.description, 'description') === undefined
      ? {}
      : { description: optionalText(options.description, 'description') }),
    options: Object.freeze(normalizedOptions),
    ...(options.selectedId === undefined ? {} : { selectedId: options.selectedId }),
    consequential: options.consequential ?? false,
    searchEnabled: options.searchEnabled ?? true,
  };

  // The alternate representation is intentionally complete rather than truncated.
  const alternateLength = buildAlternateOutput(normalized, normalized.selectedId).length;
  if (alternateLength > MAX_WIDGET_TEXT_LENGTH) {
    validationError('numbered alternate output exceeds its length bound; shorten unambiguous option text');
  }
  return Object.freeze(normalized);
}

function buildInstructions(searchEnabled: boolean, consequential: boolean): WidgetAgentInstructions {
  return {
    purpose: 'Present one explicit, bounded listbox and return the stable ID of the option the user chooses.',
    useWhen: [
      'The valid answers are a finite set whose stable IDs are known before prompting.',
      consequential
        ? 'The choice has consequences and must remain unanswered until the user explicitly chooses it.'
        : 'A finite choice is clearer and safer than free-form input.',
    ],
    avoidWhen: [
      'Use the confirm widget for a binary approval and the input widget for genuinely free-form text.',
      'Do not use duplicate, visually ambiguous, or silently truncated labels.',
    ],
    inputs: [
      'Provide a visible label and options with unique stable IDs plus distinct complete labels.',
      'Mark unavailable options with a disabled reason and mark at most contextually useful recommendations without forcing them.',
    ],
    stateAndOutput: [
      'Highlight, committed selection, search query, and scroll offset are separate state; resize must not change the selected stable option ID.',
      'Enter emits a typed select intent containing only the chosen stable option ID; cancellation emits a typed cancel intent.',
    ],
    keys: [
      'Arrow keys move; Home/End jump; PageUp/PageDown move by a viewport; Enter chooses; Escape or Ctrl-C cancels.',
      searchEnabled
        ? 'Typing searches enabled labels and Backspace edits the search query.'
        : 'Type search is disabled for this listbox.',
    ],
    accessibility: [
      'Expose an explicit listbox label and textual focused, selected, recommended, and disabled markers; never rely on color alone.',
      'Keep disabled reasons visible, keep the highlighted option in view, and provide complete bounded numbered linear output.',
    ],
    recovery: [
      'If no enabled option matches or can be chosen, preserve prior state, announce the problem, and allow navigation or cancellation.',
      'On cancellation, return control without inventing, coercing, or retaining a new answer.',
    ],
  };
}

function buildAlternateOutput(options: NormalizedSelectOptions, selectedId: string | undefined): string {
  const lines = [
    options.label,
    `Selection: ${selectedId ?? (options.consequential ? 'none (explicit choice required)' : 'none')}`,
  ];
  options.options.forEach((option, index) => {
    let marker = '[available]';
    if (option.disabledReason) marker = `[disabled: ${option.disabledReason}]`;
    else if (option.id === selectedId) marker = '[selected]';
    else if (option.recommended) marker = '[recommended]';
    const detail = option.disabledReason || !option.description ? '' : ` — ${option.description}`;
    lines.push(`${index + 1}. ${marker} ${option.label}${detail}`);
  });
  return lines.join('\n');
}

export class SelectWidget extends OpenTuiWidget<SelectWidgetIntent> {
  readonly focusOnActivation = true;
  private readonly optionsState: NormalizedSelectOptions;
  private readonly nativeOptionState: readonly Readonly<SelectWidgetNativeOption>[];
  private currentSelectedId?: string;
  private currentHighlightedId?: string;
  private currentSearchQuery = '';
  private viewportWidthValue = 80;
  private viewportRowsValue = 8;
  private scrollOffsetValue = 0;

  constructor(options: SelectWidgetOptions) {
    const normalized = normalizeOptions(options);
    super({
      id: options.id,
      kind: 'prompt.select',
      capabilities: { focusable: true, inputMode: 'selection' },
      accessibility: {
        role: 'listbox',
        label: normalized.label,
        description: normalized.description ?? 'Choose one enabled option.',
        liveRegion: 'polite',
        keyboardHelp: [
          'Arrow keys move; Home, End, PageUp, and PageDown jump',
          normalized.searchEnabled ? 'Typing searches enabled options' : 'Type search is disabled',
          'Enter chooses; Escape or Ctrl-C cancels',
        ],
      },
      instructions: buildInstructions(normalized.searchEnabled, normalized.consequential),
    });
    this.optionsState = normalized;
    this.nativeOptionState = Object.freeze(normalized.options.map((option) => Object.freeze({
      id: option.id,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
      disabled: option.disabledReason !== undefined,
      ...(option.disabledReason === undefined ? {} : { disabledReason: option.disabledReason }),
      recommended: option.recommended ?? false,
    })));
    this.currentSelectedId = normalized.selectedId;
    this.currentHighlightedId = normalized.selectedId ?? this.enabledOptions()[0]?.id;
  }

  get selectedId(): string | undefined {
    return this.currentSelectedId;
  }

  get highlightedId(): string | undefined {
    return this.currentHighlightedId;
  }

  get searchQuery(): string {
    return this.currentSearchQuery;
  }

  get scrollOffset(): number {
    return this.scrollOffsetValue;
  }

  get viewportWidth(): number {
    return this.viewportWidthValue;
  }

  get viewportRows(): number {
    return this.viewportRowsValue;
  }

  /** All normalized options, independent of viewport clipping and scroll state. */
  get nativeOptions(): readonly Readonly<SelectWidgetNativeOption>[] {
    return this.nativeOptionState;
  }

  override activate(): void {
    super.activate();
    this.focus();
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  resize(width: number, rows: number): void {
    if (!Number.isSafeInteger(width) || width < 1 || width > MAX_VIEWPORT_DIMENSION) {
      validationError(`viewport width must be between 1 and ${MAX_VIEWPORT_DIMENSION}`);
    }
    if (!Number.isSafeInteger(rows) || rows < 1 || rows > MAX_OPTIONS) {
      validationError(`viewport rows must be between 1 and ${MAX_OPTIONS}`);
    }
    if (width === this.viewportWidthValue && rows === this.viewportRowsValue) return;
    this.viewportWidthValue = width;
    this.viewportRowsValue = rows;
    this.ensureHighlightedVisible();
    this.invalidate();
  }

  alternateOutput(): string {
    return buildAlternateOutput(this.optionsState, this.currentSelectedId);
  }

  selectById(optionId: string): SelectWidgetResult {
    const option = this.enabledOptionById(optionId);
    if ('status' in option) return option;
    this.currentHighlightedId = option.id;
    this.currentSelectedId = option.id;
    this.currentSearchQuery = '';
    this.ensureHighlightedVisible();
    this.invalidate();
    return { status: 'handled', output: { type: 'select', optionId: option.id } };
  }

  /** Synchronize native listbox highlight by stable ID without committing an answer. */
  highlightById(optionId: string): SelectWidgetResult {
    const option = this.enabledOptionById(optionId);
    if ('status' in option) return option;
    return this.setHighlight(option.id);
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const regions: WidgetRenderRegion[] = [
      { id: 'label', role: 'prompt', text: this.optionsState.label },
    ];
    const end = Math.min(this.optionsState.options.length, this.scrollOffsetValue + this.viewportRowsValue);
    for (let index = this.scrollOffsetValue; index < end; index += 1) {
      const option = this.optionsState.options[index];
      if (!option) continue;
      const focused = option.id === this.currentHighlightedId ? '> ' : '  ';
      let marker = '[ ]';
      if (option.disabledReason) marker = '[disabled]';
      else if (option.id === this.currentSelectedId) marker = '[selected]';
      const recommended = option.recommended ? ' [recommended]' : '';
      const detail = option.disabledReason ?? option.description;
      regions.push({
        id: `option-${option.id}`,
        role: 'option',
        text: `${focused}${marker} ${option.label}${recommended}${detail ? ` — ${detail}` : ''}`,
      });
    }
    regions.push({
      id: 'help',
      role: 'help',
      text: this.optionsState.searchEnabled
        ? 'Arrows move; Home/End and PageUp/PageDown jump; type searches; Enter chooses; Esc/Ctrl-C cancels.'
        : 'Arrows move; Home/End and PageUp/PageDown jump; Enter chooses; Esc/Ctrl-C cancels.',
    });
    if (this.currentSearchQuery) {
      regions.push({ id: 'search', role: 'status', text: `Search: ${this.currentSearchQuery}` });
    }
    return regions;
  }

  protected onInput(input: WidgetInput): SelectWidgetResult {
    switch (input.type) {
      case 'select':
        return this.highlightByIndex(input.index);
      case 'text':
      case 'paste':
        return this.search(input.text);
      case 'submit':
        return this.commitHighlighted();
      case 'cancel':
        return this.cancel('semantic');
      case 'key':
        return this.onKey(input.key);
      default:
        return { status: 'ignored' };
    }
  }

  private onKey(key: string): SelectWidgetResult {
    switch (key.toLowerCase()) {
      case 'arrowup':
      case 'up':
      case 'k':
        return this.move(-1, true);
      case 'arrowdown':
      case 'down':
      case 'j':
        return this.move(1, true);
      case 'home':
        return this.moveToBoundary(false);
      case 'end':
        return this.moveToBoundary(true);
      case 'pageup':
        return this.move(-this.viewportRowsValue, false);
      case 'pagedown':
        return this.move(this.viewportRowsValue, false);
      case 'enter':
      case 'return':
        return this.commitHighlighted();
      case 'escape':
      case 'esc':
        return this.cancel('escape');
      case 'ctrl+c':
      case 'c-c':
      case '\u0003':
        return this.cancel('interrupt');
      case 'backspace':
        return this.removeSearchCharacter();
      default:
        return key.length === 1 && key !== ' ' ? this.search(key) : { status: 'ignored' };
    }
  }

  private enabledOptions(): readonly Readonly<SelectWidgetOption>[] {
    return this.optionsState.options.filter((option) => !option.disabledReason);
  }

  private enabledOptionById(
    optionId: string,
  ): Readonly<SelectWidgetOption> | SelectWidgetResult {
    let stableId: string;
    try {
      stableId = stableOptionId(optionId, 'optionId');
    } catch {
      return { status: 'invalid', message: 'Option ID is invalid or unsafe.' };
    }
    const option = this.optionsState.options.find((candidate) => candidate.id === stableId);
    if (!option) return { status: 'invalid', message: `Unknown option ID: ${optionId}.` };
    if (option.disabledReason) {
      return { status: 'invalid', message: `Option ${option.id} is disabled: ${option.disabledReason}` };
    }
    return option;
  }

  private move(delta: number, wrap: boolean): SelectWidgetResult {
    const enabled = this.enabledOptions();
    if (enabled.length === 0) return { status: 'invalid', message: 'No enabled options are available.' };
    const current = enabled.findIndex((option) => option.id === this.currentHighlightedId);
    const start = current < 0 ? 0 : current;
    const raw = start + delta;
    const next = wrap
      ? ((raw % enabled.length) + enabled.length) % enabled.length
      : Math.max(0, Math.min(enabled.length - 1, raw));
    return this.setHighlight(enabled[next]?.id);
  }

  private moveToBoundary(end: boolean): SelectWidgetResult {
    const enabled = this.enabledOptions();
    if (enabled.length === 0) return { status: 'invalid', message: 'No enabled options are available.' };
    return this.setHighlight((end ? enabled.at(-1) : enabled[0])?.id);
  }

  private highlightByIndex(index: number): SelectWidgetResult {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.optionsState.options.length) {
      return { status: 'invalid', message: 'Selection index is outside the option list.' };
    }
    const option = this.optionsState.options[index];
    if (!option) return { status: 'invalid', message: 'Selection index is outside the option list.' };
    if (option.disabledReason) {
      return { status: 'invalid', message: `Option ${option.id} is disabled: ${option.disabledReason}` };
    }
    return this.setHighlight(option.id);
  }

  private setHighlight(optionId: string | undefined): SelectWidgetResult {
    if (!optionId) return { status: 'invalid', message: 'No enabled options are available.' };
    if (optionId !== this.currentHighlightedId || this.currentSearchQuery) {
      this.currentHighlightedId = optionId;
      this.currentSearchQuery = '';
      this.ensureHighlightedVisible();
      this.invalidate();
    }
    return { status: 'handled' };
  }

  private search(raw: string): SelectWidgetResult {
    if (!this.optionsState.searchEnabled) return { status: 'ignored' };
    const text = sanitizeSingleLineText(raw, {
      maxGraphemes: MAX_SEARCH_GRAPHEMES,
      tabWidth: 0,
      ellipsis: '',
    }).trimStart();
    if (!text) return { status: 'handled' };
    const candidate = truncateGraphemes(
      this.currentSearchQuery + text,
      MAX_SEARCH_GRAPHEMES,
      '',
    );
    const query = normalizedVisibleLabel(candidate);
    const enabled = this.enabledOptions();
    const match = enabled.find((option) => normalizedVisibleLabel(option.label).startsWith(query))
      ?? enabled.find((option) => normalizedVisibleLabel(option.label).includes(query));
    if (!match) {
      return { status: 'invalid', message: `No enabled option matches '${candidate}'.` };
    }
    this.currentSearchQuery = candidate;
    this.currentHighlightedId = match.id;
    this.ensureHighlightedVisible();
    this.invalidate();
    return { status: 'handled' };
  }

  private removeSearchCharacter(): SelectWidgetResult {
    if (!this.optionsState.searchEnabled || !this.currentSearchQuery) return { status: 'handled' };
    this.currentSearchQuery = removeLastGrapheme(this.currentSearchQuery);
    this.invalidate();
    return { status: 'handled' };
  }

  private commitHighlighted(): SelectWidgetResult {
    if (!this.currentHighlightedId) {
      return { status: 'invalid', message: 'No enabled option is available to choose.' };
    }
    return this.selectById(this.currentHighlightedId);
  }

  private cancel(reason: Extract<SelectWidgetIntent, { type: 'cancel' }>['reason']): SelectWidgetResult {
    return { status: 'handled', output: { type: 'cancel', reason } };
  }

  private ensureHighlightedVisible(): void {
    if (!this.currentHighlightedId) return;
    const index = this.optionsState.options.findIndex((option) => option.id === this.currentHighlightedId);
    if (index < this.scrollOffsetValue) this.scrollOffsetValue = index;
    else if (index >= this.scrollOffsetValue + this.viewportRowsValue) {
      this.scrollOffsetValue = index - this.viewportRowsValue + 1;
    }
    const maximum = Math.max(0, this.optionsState.options.length - this.viewportRowsValue);
    this.scrollOffsetValue = Math.max(0, Math.min(maximum, this.scrollOffsetValue));
  }
}
