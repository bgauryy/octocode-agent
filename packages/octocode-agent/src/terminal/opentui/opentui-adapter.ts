import {
  BoxRenderable,
  bold,
  dim,
  InputRenderableEvents,
  InputRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  t,
  TextareaRenderable,
  TextRenderable,
} from '@opentui/core';

import type { WidgetContract, WidgetRenderAdapter, WidgetRenderState } from './widgets/contracts.js';
import { ConfirmWidget } from './widgets/confirm.js';
import { EditorWidget } from './widgets/editor.js';
import { PromptInputWidget } from './widgets/prompt-input.js';
import { SelectWidget } from './widgets/select.js';
import type { NativeInteractionEvent } from './widget-controller.js';

type RendererContext = ConstructorParameters<typeof BoxRenderable>[0];

export interface OpenTuiWidgetSlots {
  readonly header: BoxRenderable;
  readonly transcript: BoxRenderable;
  readonly tools: BoxRenderable;
  readonly sidebar: BoxRenderable;
  readonly editor: BoxRenderable;
  readonly footer: BoxRenderable;
}

export interface OpenTuiWidgetAdapterOptions {
  readonly alternateOutput?: boolean;
  readonly statusActionsEnabled?: boolean;
  readonly dispatchInteraction?: (generation: number, event: NativeInteractionEvent) => void;
}

interface MountedRenderable {
  revision: number;
  readonly kind: string;
  readonly root: BoxRenderable | ScrollBoxRenderable;
  readonly text: TextRenderable;
  readonly control?: InputRenderable | TextareaRenderable | SelectRenderable;
  syncing: boolean;
}

interface BoundInteraction {
  readonly generation: number;
  readonly widget: WidgetContract;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function interactiveKind(kind: string): boolean {
  return kind === 'prompt.input' || kind === 'prompt.editor' || kind === 'prompt.select' || kind === 'confirm';
}

function semanticText(state: WidgetRenderState, verboseSemantics: boolean): StyledText {
  const statusRegions = state.regions.filter((region) => region.role === 'status' && region.text.trim().length > 0);
  const otherRegions = state.regions.filter((region) => region.role !== 'status' && region.text.trim().length > 0);
  const lines = verboseSemantics
    ? [
        t`${state.focused ? bold('▶ FOCUSED · ') : ''}${bold(state.accessibility.label)} ${dim(`[${state.accessibility.role}]`)}`,
        ...statusRegions.map((region) => t`${bold(`${region.role.toUpperCase()}:`)} ${region.text}`),
        ...otherRegions.map((region) => t`${region.role.toUpperCase()}: ${region.text}`),
        ...(state.accessibility.description === undefined ? [] : [t`${dim(state.accessibility.description)}`]),
      ]
    : [
        ...((state.kind === 'header' || state.kind === 'footer')
          ? []
          : [t`${state.focused ? bold('▶ ') : ''}${bold(state.accessibility.label)}`]),
        ...statusRegions.map((region) => t`${bold(region.text)}`),
        ...otherRegions.map((region) => t`${region.text}`),
      ];
  const chunks = lines.flatMap((line, index) => index === 0
    ? line.chunks
    : [...t`\n`.chunks, ...line.chunks]);
  return new StyledText(chunks);
}

function nativeEditorCursor(control: TextareaRenderable): number {
  const prefix = control.getTextRange(0, control.cursorOffset);
  return [...GRAPHEME_SEGMENTER.segment(prefix)].length;
}

function nativeInputCursor(control: InputRenderable): number {
  return control.getTextRange(0, control.cursorOffset).length;
}

function region(state: WidgetRenderState, id: string): string | undefined {
  return state.regions.find((candidate) => candidate.id === id)?.text;
}

function slotFor(slots: OpenTuiWidgetSlots, kind: string): BoxRenderable {
  if (kind === 'header') return slots.header;
  if (kind === 'footer') return slots.footer;
  if (kind === 'transcript') return slots.transcript;
  if (kind === 'presentation-surface') return slots.transcript;
  if (kind === 'tool.progress') return slots.tools;
  if (kind === 'prompt.input' || kind === 'prompt.editor' || kind === 'composer.assist') return slots.editor;
  return slots.sidebar;
}

/** Toolkit-only materializer for semantic widget render states. */
export class OpenTuiSemanticAdapter implements WidgetRenderAdapter {
  private readonly renderer: RendererContext;
  private readonly slots: OpenTuiWidgetSlots;
  private readonly alternateOutput: boolean;
  private readonly statusActionsEnabled: boolean;
  private readonly dispatchInteraction?: (generation: number, event: NativeInteractionEvent) => void;
  private readonly mounted = new Map<string, MountedRenderable>();
  private readonly boundInteractions = new Map<string, BoundInteraction>();
  private interactionGeneration?: number;

  constructor(renderer: RendererContext, slots: OpenTuiWidgetSlots, options: OpenTuiWidgetAdapterOptions = {}) {
    this.renderer = renderer;
    this.slots = slots;
    this.alternateOutput = options.alternateOutput === true;
    this.statusActionsEnabled = options.statusActionsEnabled === true;
    this.dispatchInteraction = options.dispatchInteraction;
  }

  setInteractionGeneration(generation: number | undefined): void {
    this.interactionGeneration = generation;
  }

  bindInteraction(generation: number | undefined, widget: WidgetContract | undefined): void {
    this.boundInteractions.clear();
    if (generation !== undefined && widget) this.boundInteractions.set(widget.id, { generation, widget });
  }

  focusWidget(widgetId: string | undefined): void {
    if (widgetId === undefined) return;
    this.mounted.get(widgetId)?.root.focus();
  }

  navigateWidget(widgetId: string, key: string, absoluteOffset?: number): void {
    const root = this.mounted.get(widgetId)?.root;
    if (!(root instanceof ScrollBoxRenderable)) return;
    if (absoluteOffset !== undefined) {
      root.scrollTo(absoluteOffset);
      return;
    }
    const normalized = key.toLowerCase();
    if (normalized === 'home') root.scrollTo(0);
    else if (normalized === 'end') root.scrollTo(Math.max(0, root.scrollHeight - root.viewport.height));
    else if (normalized === 'pageup') root.scrollBy(-Math.max(1, root.viewport.height));
    else if (normalized === 'pagedown') root.scrollBy(Math.max(1, root.viewport.height));
    else if (normalized === 'arrowup' || normalized === 'up' || normalized === 'k') root.scrollBy(-1);
    else if (normalized === 'arrowdown' || normalized === 'down' || normalized === 'j') root.scrollBy(1);
  }

  render(state: WidgetRenderState): void {
    const projectedState = this.projectState(state);
    const text = semanticText(projectedState, this.alternateOutput);
    const existing = this.mounted.get(state.id);
    if (existing && existing.revision > state.revision) return;
    if (existing && existing.kind === state.kind) {
      existing.revision = state.revision;
      existing.text.content = text;
      this.syncNativeControl(existing, state);
      return;
    }
    if (existing) this.destroy(state.id);

    const mounted = this.create(state, text);
    slotFor(this.slots, state.kind).add(mounted.root);
    this.mounted.set(state.id, mounted);
    mounted.control?.focus();
  }

  private projectState(state: WidgetRenderState): WidgetRenderState {
    if (state.kind !== 'status.notifications' || this.statusActionsEnabled) return state;
    return {
      ...state,
      regions: state.regions.map((candidate) => candidate.id === 'help'
        ? { ...candidate, text: '↑/↓ navigate · Home/End jump · Esc/Ctrl-C cancel' }
        : candidate),
    };
  }

  destroy(widgetId: string): void {
    const mounted = this.mounted.get(widgetId);
    if (!mounted) return;
    this.mounted.delete(widgetId);
    if (mounted.control instanceof TextareaRenderable) mounted.control.onContentChange = undefined;
    mounted.root.destroy();
  }

  destroyAll(): void {
    for (const id of [...this.mounted.keys()]) this.destroy(id);
    this.boundInteractions.clear();
  }

  private create(state: WidgetRenderState, content: StyledText): MountedRenderable {
    const readOnlyScroll = state.kind === 'transcript'
      || state.kind === 'plan'
      || state.kind === 'status.notifications'
      || state.kind === 'presentation-surface';
    const root = readOnlyScroll
      ? new ScrollBoxRenderable(this.renderer, {
        id: `${state.id}-scroll`,
        width: '100%',
        flexGrow: 1,
        scrollY: true,
        stickyScroll: state.kind === 'transcript',
        stickyStart: state.kind === 'transcript' ? 'bottom' : 'top',
      })
      : new BoxRenderable(this.renderer, {
        id: `${state.id}-box`,
        width: '100%',
        flexDirection: 'column',
        focusable: state.capabilities.focusable,
      });
    const text = new TextRenderable(this.renderer, {
      id: `${state.id}-semantics`,
      content,
      width: '100%',
    });
    root.add(text);

    const control = this.alternateOutput ? undefined : this.addNativeControl(root, state);
    return { revision: state.revision, kind: state.kind, root, text, syncing: false, ...(control === undefined ? {} : { control }) };
  }

  private addNativeControl(
    root: BoxRenderable | ScrollBoxRenderable,
    state: WidgetRenderState,
  ): InputRenderable | TextareaRenderable | SelectRenderable | undefined {
    const binding = this.boundInteractions.get(state.id);
    const generation = interactiveKind(state.kind) ? binding?.generation : undefined;
    const widget = binding?.widget;
    if (state.kind === 'prompt.input') {
      const semantic = widget instanceof PromptInputWidget ? widget : undefined;
      if (semantic?.sensitive) return undefined;
      const input = new InputRenderable(this.renderer, {
        id: `${state.id}-input`,
        width: '100%',
        value: semantic?.value ?? region(state, 'value') ?? '',
        placeholder: region(state, 'placeholder') ?? '',
      });
      const changed = (value: string): void => {
        if (generation !== undefined && !this.mounted.get(state.id)?.syncing) {
          this.emit(generation, { type: 'input-change', value, cursor: nativeInputCursor(input) });
        }
      };
      input.on(InputRenderableEvents.INPUT, changed);
      input.on(InputRenderableEvents.CHANGE, changed);
      input.on(InputRenderableEvents.ENTER, (value: string) => {
        if (generation !== undefined) this.emit(generation, { type: 'input-submit', value, cursor: nativeInputCursor(input) });
      });
      root.add(input);
      return input;
    }
    if (state.kind === 'prompt.editor') {
      const semantic = widget instanceof EditorWidget ? widget : undefined;
      if (semantic?.sensitive) return undefined;
      const textarea = new TextareaRenderable(this.renderer, {
        id: `${state.id}-textarea`,
        width: '100%',
        minHeight: 3,
        maxHeight: 12,
        initialValue: semantic?.value ?? region(state, 'value') ?? '',
        placeholder: region(state, 'placeholder') ?? null,
        onSubmit: () => {
          if (generation !== undefined) this.emit(generation, {
            type: 'editor-submit',
            value: textarea.plainText,
            cursor: nativeEditorCursor(textarea),
          });
        },
      });
      textarea.onContentChange = () => {
        if (generation === undefined) return;
        queueMicrotask(() => {
          const mounted = this.mounted.get(state.id);
          if (generation !== this.interactionGeneration
            || mounted?.control !== textarea
            || mounted.syncing
            || !textarea.focused) return;
          this.emit(generation, {
            type: 'editor-change',
            value: textarea.plainText,
            cursor: nativeEditorCursor(textarea),
          });
        });
      };
      root.add(textarea);
      return textarea;
    }
    if (state.kind === 'prompt.select') {
      const semantic = widget instanceof SelectWidget ? widget : undefined;
      const options = semantic
        ? semantic.nativeOptions.map((option) => ({
          name: option.disabled ? `[disabled] ${option.label}` : option.label,
          description: option.disabledReason ?? option.description ?? '',
          value: option.id,
        }))
        : state.regions.filter((candidate) => candidate.role === 'option').map((candidate) => ({
          name: candidate.text,
          description: '',
          value: candidate.id.startsWith('option-') ? candidate.id.slice('option-'.length) : candidate.id,
        }));
      const selectedIndex = semantic
        ? Math.max(0, semantic.nativeOptions.findIndex(({ id }) => id === semantic.highlightedId))
        : 0;
      const select = new SelectRenderable(this.renderer, {
        id: `${state.id}-select`,
        width: '100%',
        options,
        selectedIndex,
        showDescription: false,
        showSelectionIndicator: true,
      });
      select.on(SelectRenderableEvents.SELECTION_CHANGED, (_index: number, option: { value: unknown }) => {
        if (generation !== undefined && typeof option.value === 'string' && !this.mounted.get(state.id)?.syncing) {
          this.emit(generation, { type: 'select-highlight', optionId: option.value });
        }
      });
      select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { value: unknown; name: string }) => {
        if (generation !== undefined && typeof option.value === 'string') {
          this.emit(generation, { type: 'select-submit', optionId: option.value });
        }
      });
      root.add(select);
      return select;
    }
    if (state.kind === 'confirm') {
      const semantic = widget instanceof ConfirmWidget ? widget : undefined;
      const confirm = new SelectRenderable(this.renderer, {
        id: `${state.id}-confirm`,
        width: '100%',
        options: [
          { name: 'Yes — authorize exactly this action', description: '', value: 'yes' },
          { name: 'No — do not authorize this action', description: '', value: 'no' },
        ],
        selectedIndex: semantic?.selectedOption === 'yes' ? 0 : 1,
        showDescription: false,
        showSelectionIndicator: true,
      });
      confirm.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
        if (generation !== undefined && !this.mounted.get(state.id)?.syncing) {
          this.emit(generation, { type: 'confirm-highlight', index });
        }
      });
      confirm.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
        if (generation !== undefined) this.emit(generation, { type: 'confirm-submit', index });
      });
      root.add(confirm);
      return confirm;
    }
    return undefined;
  }

  private emit(generation: number, event: NativeInteractionEvent): void {
    queueMicrotask(() => {
      if (generation === this.interactionGeneration) this.dispatchInteraction?.(generation, event);
    });
  }

  private syncNativeControl(mounted: MountedRenderable, state: WidgetRenderState): void {
    const binding = this.boundInteractions.get(state.id);
    const widget = binding?.widget;
    const control = mounted.control;
    if (!control || !widget) return;
    mounted.syncing = true;
    try {
      if (widget instanceof PromptInputWidget && control instanceof InputRenderable) {
        if (!control.focused && control.value !== widget.value) control.value = widget.value;
      } else if (widget instanceof EditorWidget && control instanceof TextareaRenderable) {
        if (!control.focused && control.plainText !== widget.value) control.setText(widget.value);
      } else if (widget instanceof SelectWidget && control instanceof SelectRenderable) {
        const index = widget.nativeOptions.findIndex(({ id }) => id === widget.highlightedId);
        if (index >= 0 && control.getSelectedIndex() !== index) control.setSelectedIndex(index);
      } else if (widget instanceof ConfirmWidget && control instanceof SelectRenderable) {
        const index = widget.selectedOption === 'yes' ? 0 : 1;
        if (control.getSelectedIndex() !== index) control.setSelectedIndex(index);
      }
    } finally {
      mounted.syncing = false;
    }
  }
}
