export const MAX_WIDGET_ID_LENGTH = 64;
export const MAX_WIDGET_KIND_LENGTH = 64;
export const MAX_WIDGET_TEXT_LENGTH = 8_192;
export const MAX_WIDGET_RENDER_REGIONS = 64;
export const MAX_WIDGET_INSTRUCTION_ITEMS = 16;
export const MAX_WIDGET_REGISTRY_ENTRIES = 128;

export type WidgetLifecycle =
  | 'created'
  | 'mounted'
  | 'active'
  | 'disabled'
  | 'failed'
  | 'destroyed';

export type WidgetInputMode = 'none' | 'keys' | 'text' | 'multiline' | 'selection';

export interface WidgetCapabilities {
  readonly focusable: boolean;
  readonly inputMode: WidgetInputMode;
}

export type WidgetAccessibilityRole =
  | 'alert'
  | 'alertdialog'
  | 'banner'
  | 'button'
  | 'contentinfo'
  | 'form'
  | 'group'
  | 'list'
  | 'listbox'
  | 'log'
  | 'option'
  | 'progressbar'
  | 'region'
  | 'status'
  | 'textbox';

export interface WidgetAccessibilityMetadata {
  readonly role: WidgetAccessibilityRole;
  readonly label: string;
  readonly description?: string;
  readonly liveRegion: 'off' | 'polite' | 'assertive';
  readonly keyboardHelp: readonly string[];
}

export interface WidgetAgentInstructions {
  readonly purpose: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly inputs: readonly string[];
  readonly stateAndOutput: readonly string[];
  readonly keys: readonly string[];
  readonly accessibility: readonly string[];
  readonly recovery: readonly string[];
}

export type WidgetRenderRegionRole = 'content' | 'status' | 'prompt' | 'help' | 'option';

export interface WidgetRenderRegion {
  readonly id: string;
  readonly role: WidgetRenderRegionRole;
  readonly text: string;
  /** Explicit meaning for color, marker, and alternate text; never inferred from prose. */
  readonly tone?: NativeDesignTone;
}

export interface WidgetRenderState {
  readonly id: string;
  readonly kind: string;
  readonly lifecycle: WidgetLifecycle;
  readonly revision: number;
  readonly focused: boolean;
  readonly capabilities: WidgetCapabilities;
  readonly accessibility: WidgetAccessibilityMetadata;
  readonly regions: readonly WidgetRenderRegion[];
}

/** Narrow boundary implemented by the OpenTUI-specific renderer. */
export interface WidgetRenderAdapter {
  render(state: WidgetRenderState): void;
  destroy(widgetId: string): void;
}

export type WidgetInput =
  | { readonly type: 'key'; readonly key: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'paste'; readonly text: string }
  | { readonly type: 'select'; readonly index: number }
  | { readonly type: 'submit' }
  | { readonly type: 'cancel' };

export interface WidgetInputResult<TOutput = unknown> {
  readonly status: 'handled' | 'ignored' | 'invalid';
  readonly output?: TOutput;
  readonly message?: string;
}

export type WidgetFactory<
  TConstructionInput = undefined,
  TWidget extends WidgetContract = WidgetContract,
> = (id: string, input: TConstructionInput) => TWidget;

export interface WidgetDefinition<
  TConstructionInput = undefined,
  TWidget extends WidgetContract = WidgetContract,
> {
  readonly kind: string;
  readonly order: number;
  readonly create: WidgetFactory<TConstructionInput, TWidget>;
}

export interface WidgetContract<
  TOutput = unknown,
  TInstructions extends WidgetAgentInstructions = WidgetAgentInstructions,
> {
  readonly id: string;
  readonly kind: string;
  readonly lifecycle: WidgetLifecycle;
  readonly capabilities: WidgetCapabilities;
  readonly accessibility: WidgetAccessibilityMetadata;
  /** Literal agent-facing usage contract exposed by every widget class. */
  readonly instructions: TInstructions;
  mount(): void;
  activate(): void;
  disable(): void;
  focus(): void;
  blur(): void;
  render(adapter?: WidgetRenderAdapter): WidgetRenderState;
  handleInput(input: WidgetInput): WidgetInputResult<TOutput>;
  destroy(adapter?: WidgetRenderAdapter): void;
}

export class WidgetContractError extends Error {
  constructor(
    readonly code: 'validation' | 'lifecycle' | 'duplicate' | 'capacity' | 'not-found' | 'mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'WidgetContractError';
  }
}
import type { NativeDesignTone } from '../../../presentation/design/semantics.js';
