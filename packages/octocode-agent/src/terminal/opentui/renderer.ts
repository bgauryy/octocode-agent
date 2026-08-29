import {
  BoxRenderable,
  CliRenderEvents,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
} from '@opentui/core';

import {
  WorkspaceFileCatalog,
  applyComposerSuggestion,
  commandSuggestions,
  parseComposerTrigger,
  type ComposerTrigger,
  type NativeComposerSuggestion,
} from '../../native-composer.js';

import {
  createInitialPresentationState,
  type OpenTuiRendererFacade,
  type OpenTuiRendererEvents,
  type OpenTuiTerminal,
  type PresentationState,
} from './presentation.js';
import { createOpenTuiTerminal } from './create-terminal.js';
import { OpenTuiSemanticAdapter } from './opentui-adapter.js';
import {
  SemanticWidgetController,
  type StatusNotificationActionInvocation,
} from './widget-controller.js';
import { ComposerAssistWidget, type ComposerAssistSnapshot } from './widgets/composer-assist.js';
import type { WidgetContract } from './widgets/contracts.js';

type RendererContext = Awaited<ReturnType<typeof createCliRenderer>>;

export interface OpenTuiRendererOptions {
  readonly initialState?: PresentationState;
  readonly alternateOutput?: boolean;
  /** Defaults to true so production output is static unless a host explicitly opts into motion. */
  readonly reducedMotion?: boolean;
  readonly events?: OpenTuiRendererEvents;
  /** Runtime-owned status action sink. Actions are not rendered when this is absent. */
  readonly statusAction?: (invocation: StatusNotificationActionInvocation) => void | Promise<void>;
  /** Injectable clock for deterministic tool progress announcement throttling. */
  readonly nowMs?: () => number;
  /** Public test seam for renderer-level validation scenarios. */
  readonly interactionWidgetFactory?: (
    interaction: NonNullable<PresentationState['interaction']>,
  ) => WidgetContract;
  /** Workspace root used by the composer @file completion source. */
  readonly cwd?: string;
  /** Injectable completion source for deterministic tests and alternate hosts. */
  readonly fileCatalog?: Pick<WorkspaceFileCatalog, 'search'>;
}

async function bestEffortCleanup(
  actions: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try { await action(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'OpenTUI cleanup failed');
}

/** Public test seam: materialize the production semantic widget tree on any compatible renderer. */
export function createOpenTuiRendererFacade(
  renderer: RendererContext,
  options: OpenTuiRendererOptions = {},
): OpenTuiRendererFacade {
  const root = new BoxRenderable(renderer, {
    id: 'octocode-agent-root',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
  });
  const header = new BoxRenderable(renderer, { id: 'octocode-agent-header', width: '100%', flexDirection: 'column' });
  const body = new BoxRenderable(renderer, { id: 'octocode-agent-body', flexGrow: 1, flexDirection: 'row' });
  const transcript = new BoxRenderable(renderer, {
    id: 'octocode-agent-transcript',
    flexGrow: 2,
    flexDirection: 'column',
  });
  const rail = new BoxRenderable(renderer, {
    id: 'octocode-agent-rail',
    width: '34%',
    flexDirection: 'column',
  });
  const tools = new BoxRenderable(renderer, { id: 'octocode-agent-tools', flexGrow: 1, flexDirection: 'column' });
  const sidebar = new BoxRenderable(renderer, { id: 'octocode-agent-sidebar', flexGrow: 1, flexDirection: 'column' });
  const editor = new BoxRenderable(renderer, { id: 'octocode-agent-editor', width: '100%', flexDirection: 'column' });
  const footer = new BoxRenderable(renderer, { id: 'octocode-agent-footer', width: '100%', flexDirection: 'column' });

  body.add(transcript);
  rail.add(tools);
  rail.add(sidebar);
  body.add(rail);
  root.add(header);
  root.add(body);
  root.add(editor);
  root.add(footer);
  renderer.root.add(root);

  const composer = options.alternateOutput === true ? undefined : new InputRenderable(renderer, {
    id: 'octocode-agent-composer',
    width: '100%',
    placeholder: 'Message Octocode Agent',
  });
  if (composer) {
    editor.add(composer);
    composer.on(InputRenderableEvents.ENTER, (value: string) => {
      const submitted = value.trim();
      if (submitted.length === 0) return;
      composer.value = '';
      options.events?.submitLine(submitted);
    });
  }

  const width = Math.max(1, renderer.width);
  const height = Math.max(1, renderer.height);
  const initialNarrow = width < 72;
  body.flexDirection = initialNarrow ? 'column' : 'row';
  rail.width = initialNarrow ? '100%' : '34%';
  let controller: SemanticWidgetController | undefined;
  const adapter = new OpenTuiSemanticAdapter(renderer, { header, transcript, tools, sidebar, editor, footer }, {
    alternateOutput: options.alternateOutput,
    statusActionsEnabled: options.statusAction !== undefined,
    dispatchInteraction: (generation, event) => controller?.handleNativeInteraction(generation, event),
  });
  controller = new SemanticWidgetController(adapter, {
    widthColumns: width,
    heightRows: height,
    alternateOutput: options.alternateOutput,
    reducedMotion: options.reducedMotion ?? true,
  }, {
    resolveInteraction: options.events?.resolveInteraction,
    statusAction: options.statusAction,
    callbackFailure: options.events?.failure,
    nowMs: options.nowMs,
    interactionWidgetFactory: options.interactionWidgetFactory,
  });
  let previousWidth = width;
  let previousHeight = height;
  let activeGeneration: number | undefined;
  let activeInteractionType: 'confirm' | 'select' | 'input' | 'editor' | undefined;
  let semanticFocusedId: string | undefined;
  const fileCatalog = options.fileCatalog ?? new WorkspaceFileCatalog(options.cwd ?? process.cwd());
  let assist: ComposerAssistWidget | undefined;
  let assistTrigger: ComposerTrigger | undefined;
  let assistCandidates: readonly NativeComposerSuggestion[] = [];
  let assistRevision = 0;
  let assistRequest = 0;
  let assistAbort: AbortController | undefined;
  const clearAssist = (): void => {
    assistRequest += 1;
    assistAbort?.abort();
    assistAbort = undefined;
    assistTrigger = undefined;
    assistCandidates = [];
    if (assist) assist.destroy(adapter);
    assist = undefined;
  };
  const presentAssist = (
    trigger: ComposerTrigger,
    state: ComposerAssistSnapshot['state'],
    suggestions: readonly NativeComposerSuggestion[],
    errorMessage?: string,
  ): void => {
    assistRevision += 1;
    const snapshot: ComposerAssistSnapshot = {
      authority: 'runtime',
      revision: assistRevision,
      mode: trigger.mode,
      state,
      query: trigger.fragment,
      suggestions: suggestions.map(({ id, kind, label, description }) => ({
        id, kind, label, ...(description === undefined ? {} : { description }),
      })),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    };
    if (!assist) {
      assist = new ComposerAssistWidget('composer-assist', snapshot, {
        widthColumns: Math.max(20, Math.min(160, renderer.width)),
        viewportRows: Math.max(1, Math.min(8, renderer.height - 6)),
      });
      assist.mount();
      assist.activate();
      assist.focus();
    } else {
      assist.update(snapshot);
    }
    assistTrigger = trigger;
    assistCandidates = suggestions;
    assist.render(adapter);
    composer?.focus();
  };
  const refreshAssist = (value: string): void => {
    if (!composer || activeGeneration !== undefined) {
      clearAssist();
      return;
    }
    const trigger = parseComposerTrigger(value, composer.getTextRange(0, composer.cursorOffset).length);
    if (!trigger) {
      clearAssist();
      return;
    }
    const request = ++assistRequest;
    assistAbort?.abort();
    if (trigger.mode === 'command') {
      const suggestions = commandSuggestions(trigger.fragment);
      presentAssist(trigger, suggestions.length === 0 ? 'empty' : 'ready', suggestions);
      return;
    }
    const abort = new AbortController();
    assistAbort = abort;
    presentAssist(trigger, 'loading', []);
    void fileCatalog.search(trigger.fragment, abort.signal).then((suggestions) => {
      if (request !== assistRequest || abort.signal.aborted) return;
      presentAssist(trigger, suggestions.length === 0 ? 'empty' : 'ready', suggestions);
    }).catch((error: unknown) => {
      if (request !== assistRequest || abort.signal.aborted) return;
      presentAssist(trigger, 'error', [], error instanceof Error ? error.message : 'File completion failed');
    });
  };
  const activateAssist = (): boolean => {
    if (!assist || !assistTrigger || !composer || !assist.highlightedId) return false;
    const candidate = assistCandidates.find(({ id }) => id === assist!.highlightedId);
    if (!candidate) return false;
    const completed = applyComposerSuggestion(composer.value, assistTrigger, candidate);
    clearAssist();
    composer.value = completed.value;
    composer.cursorOffset = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      .segment(completed.value.slice(0, completed.cursor))].length;
    composer.focus();
    return true;
  };
  const focusComposer = (): void => {
    controller?.focusWidget(undefined);
    semanticFocusedId = undefined;
    composer?.focus();
  };
  const syncLayout = (): void => {
    const nextWidth = Math.max(1, renderer.width);
    const nextHeight = Math.max(1, renderer.height);
    if (nextWidth === previousWidth && nextHeight === previousHeight) return;
    previousWidth = nextWidth;
    previousHeight = nextHeight;
    const narrow = nextWidth < 72;
    body.flexDirection = narrow ? 'column' : 'row';
    rail.width = narrow ? '100%' : '34%';
    assist?.resize(
      Math.max(20, Math.min(160, nextWidth)),
      Math.max(1, Math.min(8, nextHeight - 6)),
    );
    assist?.render(adapter);
    controller?.resize({
      widthColumns: nextWidth,
      heightRows: nextHeight,
      alternateOutput: options.alternateOutput,
      reducedMotion: options.reducedMotion ?? true,
    });
  };
  const cycleFocus = (reverse: boolean): void => {
    if (!composer) return;
    const ids = controller?.getFocusableWidgetIds() ?? [];
    if (ids.length === 0) {
      focusComposer();
      return;
    }
    if (semanticFocusedId === undefined) {
      const target = reverse ? ids.at(-1) : ids[0];
      if (target !== undefined && controller?.focusWidget(target)) semanticFocusedId = target;
      return;
    }
    const current = ids.indexOf(semanticFocusedId);
    const next = current + (reverse ? -1 : 1);
    if (current < 0 || next < 0 || next >= ids.length) {
      focusComposer();
      return;
    }
    const target = ids[next];
    if (target !== undefined && controller?.focusWidget(target)) semanticFocusedId = target;
  };
  const keyHandler = (key: KeyEvent): void => {
    if (assist && activeGeneration === undefined) {
      const name = key.name.toLowerCase();
      if ((key.ctrl && name === 'c') || name === 'escape' || name === 'esc') {
        key.preventDefault();
        clearAssist();
        composer?.focus();
        return;
      }
      if (name === 'enter' || name === 'return' || name === 'tab') {
        key.preventDefault();
        activateAssist();
        return;
      }
      if (name === 'arrowup' || name === 'arrowdown' || name === 'up' || name === 'down'
        || name === 'pageup' || name === 'pagedown' || name === 'home' || name === 'end'
        || name === 'j' || name === 'k') {
        key.preventDefault();
        assist.handleInput({ type: 'key', key: name });
        assist.render(adapter);
        composer?.focus();
        return;
      }
    }
    if (key.ctrl && key.name === 'c') {
      key.preventDefault();
      if (activeGeneration !== undefined) {
        const generation = activeGeneration;
        queueMicrotask(() => controller?.handleNativeInteraction(generation, { type: 'key', key: 'ctrl+c' }));
      } else {
        options.events?.interrupt();
      }
      return;
    }
    if ((key.name === 'escape' || key.name === 'esc') && activeGeneration !== undefined) {
      key.preventDefault();
      const generation = activeGeneration;
      queueMicrotask(() => controller?.handleNativeInteraction(generation, { type: 'key', key: 'escape' }));
      return;
    }
    if (activeGeneration === undefined && semanticFocusedId !== undefined
      && (key.name === 'escape' || key.name === 'esc')) {
      key.preventDefault();
      focusComposer();
      return;
    }
    if (activeGeneration === undefined && key.name.toLowerCase() === 'tab') {
      key.preventDefault();
      cycleFocus(key.shift === true);
      return;
    }
    if (activeGeneration === undefined && semanticFocusedId !== undefined) {
      const name = key.name.toLowerCase();
      if (name === 'arrowup' || name === 'arrowdown' || name === 'up' || name === 'down'
        || name === 'pageup' || name === 'pagedown' || name === 'home' || name === 'end'
        || name === 'j' || name === 'k' || name === 'enter' || name === 'return') {
        key.preventDefault();
        controller?.handleFocusedNavigation(name);
        return;
      }
    }
    if (activeInteractionType === 'confirm' && activeGeneration !== undefined
      && ['y', 'n', 'left', 'right', 'arrowleft', 'arrowright', 'tab'].includes(key.name.toLowerCase())) {
      key.preventDefault();
      const generation = activeGeneration;
      const semanticKey = key.name.toLowerCase() === 'tab' && key.shift ? 'shift+tab' : key.name;
      controller?.handleNativeInteraction(generation, { type: 'key', key: semanticKey });
      return;
    }
    if (activeInteractionType === 'select' && activeGeneration !== undefined) {
      const name = key.name.toLowerCase();
      if ((!key.ctrl && !key.meta && name.length === 1) || name === 'backspace') {
        key.preventDefault();
        const generation = activeGeneration;
        queueMicrotask(() => controller?.handleNativeInteraction(generation, { type: 'key', key: name }));
      }
    }
  };
  renderer.keyInput.on('keypress', keyHandler);
  renderer.on(CliRenderEvents.RESIZE, syncLayout);
  const composerChanged = (value: string): void => refreshAssist(value);
  composer?.on(InputRenderableEvents.INPUT, composerChanged);

  const facade: OpenTuiRendererFacade = {
    render(state) {
      activeGeneration = state.interaction !== undefined
        && (state.interaction.status === 'pending' || state.interaction.status === 'validation')
        ? state.interaction.generation
        : undefined;
      activeInteractionType = activeGeneration === undefined ? undefined : state.interaction?.request.type;
      if (activeGeneration !== undefined) clearAssist();
      adapter.setInteractionGeneration(activeGeneration);
      if (activeGeneration !== undefined && semanticFocusedId !== undefined) {
        controller?.focusWidget(undefined);
        semanticFocusedId = undefined;
      }
      syncLayout();
      controller?.render(state);
      if (semanticFocusedId !== undefined
        && !controller?.getFocusableWidgetIds().includes(semanticFocusedId)) {
        focusComposer();
      }
      if (activeGeneration === undefined && semanticFocusedId === undefined) composer?.focus();
    },
    alternateOutput() {
      return [controller?.alternateOutput() ?? '', assist?.alternateOutput() ?? ''].filter(Boolean).join('\n\n');
    },
    drainAnnouncements() {
      const semantic = controller?.drainAnnouncements() ?? [];
      const composerAnnouncements = assist?.takeAnnouncements().map((text) => ({
        source: assist!.id,
        politeness: 'polite' as const,
        text,
      })) ?? [];
      return [...semantic, ...composerAnnouncements];
    },
    async destroy() {
      await bestEffortCleanup([
        () => renderer.keyInput.off('keypress', keyHandler),
        () => renderer.off(CliRenderEvents.RESIZE, syncLayout),
        () => composer?.off(InputRenderableEvents.INPUT, composerChanged),
        clearAssist,
        () => controller?.destroy(),
        () => adapter.destroyAll(),
        () => root.destroy(),
      ]);
    },
  };
  facade.render(options.initialState ?? createInitialPresentationState());
  return facade;
}

/** Production OpenTUI renderer factory. All toolkit types remain in this directory. */
export function createDefaultOpenTuiTerminal(options: {
  readonly cwd?: string;
  readonly alternateOutput?: boolean;
} = {}): OpenTuiTerminal {
  return createOpenTuiTerminal({
    inputOwnership: 'renderer',
    async createRenderer(events) {
      const renderer = await createCliRenderer({ exitOnCtrlC: false });
      let facade: OpenTuiRendererFacade;
      try {
        facade = createOpenTuiRendererFacade(renderer, {
          events,
          cwd: options.cwd,
          alternateOutput: options.alternateOutput,
        });
      } catch (error) {
        try { renderer.destroy(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'OpenTUI initialization and rollback failed'); }
        throw error;
      }
      return {
        render: (state) => facade.render(state),
        alternateOutput: () => facade.alternateOutput?.() ?? '',
        drainAnnouncements: () => facade.drainAnnouncements?.() ?? [],
        async destroy() {
          await bestEffortCleanup([
            () => facade.destroy(),
            () => renderer.destroy(),
          ]);
        },
      };
    },
  });
}
