import {
  MAX_WIDGET_ID_LENGTH,
  MAX_WIDGET_INSTRUCTION_ITEMS,
  MAX_WIDGET_KIND_LENGTH,
  MAX_WIDGET_RENDER_REGIONS,
  MAX_WIDGET_TEXT_LENGTH,
  WidgetContractError,
  type WidgetAccessibilityMetadata,
  type WidgetAgentInstructions,
  type WidgetCapabilities,
  type WidgetContract,
  type WidgetInput,
  type WidgetInputResult,
  type WidgetLifecycle,
  type WidgetRenderAdapter,
  type WidgetRenderRegion,
  type WidgetRenderState,
} from './contracts.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KIND_PATTERN = /^[a-z][a-z0-9.-]*$/;

export interface OpenTuiWidgetOptions<
  TInstructions extends WidgetAgentInstructions = WidgetAgentInstructions,
> {
  readonly id: string;
  readonly kind: string;
  readonly capabilities: WidgetCapabilities;
  readonly accessibility: WidgetAccessibilityMetadata;
  readonly instructions: TInstructions;
}

function fail(message: string): never {
  throw new WidgetContractError('validation', message);
}

function boundedText(value: string, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    fail(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_WIDGET_TEXT_LENGTH) fail(`${field} exceeds its length bound`);
  return value;
}

function boundedList(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) fail(`${field} must contain at least one item`);
  if (values.length > MAX_WIDGET_INSTRUCTION_ITEMS) fail(`${field} exceeds its item bound`);
  return Object.freeze(values.map((value, index) => boundedText(value, `${field}[${index}]`)));
}

function validateIdentity(id: string, kind: string): void {
  if (id.length > MAX_WIDGET_ID_LENGTH || !ID_PATTERN.test(id)) fail('widget id is invalid');
  if (kind.length > MAX_WIDGET_KIND_LENGTH || !KIND_PATTERN.test(kind)) fail('widget kind is invalid');
}

const ACCESSIBILITY_ROLES = new Set<WidgetAccessibilityMetadata['role']>([
  'alert',
  'alertdialog',
  'banner',
  'button',
  'contentinfo',
  'form',
  'group',
  'list',
  'listbox',
  'log',
  'option',
  'progressbar',
  'region',
  'status',
  'textbox',
]);
const LIVE_REGION_VALUES = new Set<WidgetAccessibilityMetadata['liveRegion']>(['off', 'polite', 'assertive']);
const DESIGN_TONES = new Set(['info', 'success', 'warning', 'error', 'count']);

function copyAccessibility(value: WidgetAccessibilityMetadata): WidgetAccessibilityMetadata {
  if (!ACCESSIBILITY_ROLES.has(value.role)) fail('accessibility.role is invalid');
  if (!LIVE_REGION_VALUES.has(value.liveRegion)) fail('accessibility.liveRegion is invalid');
  return Object.freeze({
    role: value.role,
    label: boundedText(value.label, 'accessibility.label'),
    ...(value.description === undefined
      ? {}
      : { description: boundedText(value.description, 'accessibility.description') }),
    liveRegion: value.liveRegion,
    keyboardHelp: boundedList(value.keyboardHelp, 'accessibility.keyboardHelp'),
  });
}

function copyInstructions<TInstructions extends WidgetAgentInstructions>(value: TInstructions): TInstructions {
  return Object.freeze({
    purpose: boundedText(value.purpose, 'instructions.purpose'),
    useWhen: boundedList(value.useWhen, 'instructions.useWhen'),
    avoidWhen: boundedList(value.avoidWhen, 'instructions.avoidWhen'),
    inputs: boundedList(value.inputs, 'instructions.inputs'),
    stateAndOutput: boundedList(value.stateAndOutput, 'instructions.stateAndOutput'),
    keys: boundedList(value.keys, 'instructions.keys'),
    accessibility: boundedList(value.accessibility, 'instructions.accessibility'),
    recovery: boundedList(value.recovery, 'instructions.recovery'),
  }) as TInstructions;
}

function copyRegions(values: readonly WidgetRenderRegion[]): readonly WidgetRenderRegion[] {
  if (!Array.isArray(values)) fail('render regions must be an array');
  if (values.length > MAX_WIDGET_RENDER_REGIONS) fail('render regions exceed their item bound');
  const ids = new Set<string>();
  return Object.freeze(values.map((region, index) => {
    if (!ID_PATTERN.test(region.id) || region.id.length > MAX_WIDGET_ID_LENGTH) {
      fail(`render region ${index} has an invalid id`);
    }
    if (ids.has(region.id)) fail(`render region id '${region.id}' is duplicated`);
    if (region.tone !== undefined && !DESIGN_TONES.has(region.tone)) {
      fail(`render region '${region.id}' has an invalid tone`);
    }
    ids.add(region.id);
    return Object.freeze({
      id: region.id,
      role: region.role,
      text: boundedText(region.text, `render region '${region.id}' text`, true),
      ...(region.tone === undefined ? {} : { tone: region.tone }),
    });
  }));
}

export abstract class OpenTuiWidget<
  TOutput = unknown,
  TInstructions extends WidgetAgentInstructions = WidgetAgentInstructions,
> implements WidgetContract<TOutput, TInstructions> {
  readonly id: string;
  readonly kind: string;
  readonly capabilities: WidgetCapabilities;
  readonly accessibility: WidgetAccessibilityMetadata;
  private readonly configuredInstructions: TInstructions;

  private currentLifecycle: WidgetLifecycle = 'created';
  private currentRevision = 0;
  private isFocused = false;

  protected constructor(options: OpenTuiWidgetOptions<TInstructions>) {
    validateIdentity(options.id, options.kind);
    if (!options.capabilities.focusable && options.capabilities.inputMode !== 'none') {
      fail('a widget with input capability must be focusable');
    }
    this.id = options.id;
    this.kind = options.kind;
    this.capabilities = Object.freeze({ ...options.capabilities });
    this.accessibility = copyAccessibility(options.accessibility);
    this.configuredInstructions = copyInstructions(options.instructions);
  }

  get instructions(): TInstructions {
    return this.configuredInstructions;
  }

  get lifecycle(): WidgetLifecycle {
    return this.currentLifecycle;
  }

  mount(): void {
    this.transition('created', 'mounted');
  }

  activate(): void {
    if (this.currentLifecycle !== 'mounted' && this.currentLifecycle !== 'disabled') {
      throw new WidgetContractError('lifecycle', `cannot activate widget from ${this.currentLifecycle}`);
    }
    this.currentLifecycle = 'active';
    this.invalidate();
  }

  disable(): void {
    if (this.currentLifecycle !== 'mounted' && this.currentLifecycle !== 'active') {
      throw new WidgetContractError('lifecycle', `cannot disable widget from ${this.currentLifecycle}`);
    }
    this.isFocused = false;
    this.currentLifecycle = 'disabled';
    this.invalidate();
  }

  focus(): void {
    if (!this.capabilities.focusable || this.currentLifecycle !== 'active') {
      throw new WidgetContractError('lifecycle', 'only an active, focusable widget can receive focus');
    }
    if (!this.isFocused) {
      this.isFocused = true;
      this.invalidate();
    }
  }

  blur(): void {
    if (this.isFocused) {
      this.isFocused = false;
      this.invalidate();
    }
  }

  render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    if (this.currentLifecycle === 'destroyed') {
      throw new WidgetContractError('lifecycle', 'cannot render a destroyed widget');
    }
    try {
      const state = Object.freeze({
        id: this.id,
        kind: this.kind,
        lifecycle: this.currentLifecycle,
        revision: this.currentRevision,
        focused: this.isFocused,
        capabilities: this.capabilities,
        accessibility: this.accessibility,
        regions: copyRegions(this.renderRegions()),
      });
      adapter?.render(state);
      return state;
    } catch (error) {
      this.currentLifecycle = 'failed';
      this.isFocused = false;
      throw error;
    }
  }

  handleInput(input: WidgetInput): WidgetInputResult<TOutput> {
    if (this.currentLifecycle !== 'active' || !this.isFocused || this.capabilities.inputMode === 'none') {
      return Object.freeze({ status: 'ignored' });
    }
    if (('text' in input && input.text.length > MAX_WIDGET_TEXT_LENGTH)
      || ('key' in input && input.key.length > MAX_WIDGET_TEXT_LENGTH)) {
      return Object.freeze({ status: 'invalid', message: 'input exceeds its length bound' });
    }
    return Object.freeze(this.onInput(input));
  }

  destroy(adapter?: WidgetRenderAdapter): void {
    if (this.currentLifecycle === 'destroyed') return;
    this.currentLifecycle = 'destroyed';
    this.isFocused = false;
    this.currentRevision += 1;
    adapter?.destroy(this.id);
  }

  protected abstract renderRegions(): readonly WidgetRenderRegion[];

  protected onInput(_input: WidgetInput): WidgetInputResult<TOutput> {
    return { status: 'ignored' };
  }

  protected invalidate(): void {
    if (this.currentLifecycle === 'destroyed') {
      throw new WidgetContractError('lifecycle', 'cannot invalidate a destroyed widget');
    }
    this.currentRevision += 1;
  }

  private transition(from: WidgetLifecycle, to: WidgetLifecycle): void {
    if (this.currentLifecycle !== from) {
      throw new WidgetContractError('lifecycle', `cannot transition widget from ${this.currentLifecycle} to ${to}`);
    }
    this.currentLifecycle = to;
    this.invalidate();
  }
}
