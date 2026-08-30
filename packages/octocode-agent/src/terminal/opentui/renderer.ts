import {
  BoxRenderable,
  CliRenderEvents,
  createCliRenderer,
  ScrollBoxRenderable,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
  TextareaRenderable,
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
  type OpenTuiSemanticAnnouncement,
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
import { sanitizeSingleLineText } from './widgets/sanitize.js';
import { composerKeyBindings, resolveOpenTuiKeyAction } from './keymap.js';
import { OPEN_TUI_THEMES } from './theme.js';

type RendererContext = Awaited<ReturnType<typeof createCliRenderer>>;

export interface OpenTuiRendererOptions {
  readonly initialState?: PresentationState;
  readonly alternateOutput?: boolean;
  /** Plain, sanitized semantic announcements for accessible terminal hosts. */
  readonly alternateOutputSink?: (text: string) => void;
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
  const theme = OPEN_TUI_THEMES[renderer.themeMode === 'light' ? 'light' : 'dark'];
  const colorEnabled = process.env.NO_COLOR === undefined || process.env.FORCE_COLOR !== undefined;
  const color = (role: keyof typeof theme.colors): string | undefined => (
    colorEnabled ? theme.colors[role] : undefined
  );
  const root = new BoxRenderable(renderer, {
    id: 'octocode-agent-root',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
  });
  const header = new BoxRenderable(renderer, {
    id: 'octocode-agent-header', width: '100%', flexDirection: 'column', flexShrink: 0,
  });
  const body = new BoxRenderable(renderer, {
    id: 'octocode-agent-body', height: 0, flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: 'row',
  });
  const transcript = new BoxRenderable(renderer, {
    id: 'octocode-agent-transcript',
    flexGrow: 2,
    flexDirection: 'column',
  });
  const rail = new ScrollBoxRenderable(renderer, {
    id: 'octocode-agent-rail',
    width: '42%',
    height: '100%',
    flexDirection: 'column',
    scrollY: true,
    stickyStart: 'top',
    backgroundColor: color('surface'),
  });
  const railTabs = new TabSelectRenderable(renderer, {
    id: 'octocode-agent-rail-tabs',
    width: '100%',
    height: 2,
    options: [
      { name: 'Activity', description: 'Tool and run activity', value: 'activity' },
      { name: 'Context', description: 'Runtime context and status', value: 'context' },
    ],
    showDescription: false,
    showUnderline: true,
    wrapSelection: true,
    backgroundColor: color('surface'),
    textColor: color('muted'),
    focusedBackgroundColor: color('surfaceRaised'),
    focusedTextColor: color('focus'),
    selectedBackgroundColor: color('selectionBackground'),
    selectedTextColor: color('selectionText'),
    selectedDescriptionColor: color('muted'),
  });
  const tools = new BoxRenderable(renderer, { id: 'octocode-agent-tools', flexGrow: 1, flexDirection: 'column' });
  const sidebar = new BoxRenderable(renderer, { id: 'octocode-agent-sidebar', flexGrow: 1, flexDirection: 'column' });
  const editor = new BoxRenderable(renderer, {
    id: 'octocode-agent-editor', width: '100%', flexDirection: 'column', flexShrink: 0, zIndex: 10,
  });
  const footer = new BoxRenderable(renderer, {
    id: 'octocode-agent-footer', width: '100%', flexDirection: 'column', flexShrink: 0,
  });

  body.add(transcript);
  rail.add(railTabs);
  rail.add(tools);
  rail.add(sidebar);
  body.add(rail);
  root.add(header);
  root.add(body);
  root.add(editor);
  root.add(footer);
  renderer.root.add(root);

  const composer = new TextareaRenderable(renderer, {
    id: 'octocode-agent-composer',
    width: '100%',
    height: 3,
    minHeight: 3,
    maxHeight: 6,
    wrapMode: 'word',
    placeholder: 'Message Octocode Agent…',
    keyBindings: [...composerKeyBindings()].reverse(),
    backgroundColor: color('surface'),
    focusedBackgroundColor: color('surfaceRaised'),
    textColor: color('text'),
    focusedTextColor: color('text'),
    placeholderColor: color('muted'),
    cursorColor: color('focus'),
    selectionBg: color('selectionBackground'),
    selectionFg: color('selectionText'),
  });
  const composerHelp = new TextRenderable(renderer, {
    id: 'octocode-agent-composer-help',
    width: '100%',
    height: 1,
    content: 'Enter newline · Ctrl/⌘+Enter send · Tab move focus · Esc cancel',
    fg: color('muted'),
  });
  editor.add(composer);
  editor.add(composerHelp);
  composer.onSubmit = () => {
    const submitted = composer.plainText.trim();
    if (submitted.length === 0) return;
    composer.clear();
    options.events?.submitLine(submitted);
  };
  const syncRailPane = (): void => {
    const contextSelected = railTabs.getSelectedIndex() === 1;
    tools.visible = !contextSelected;
    sidebar.visible = contextSelected;
  };
  const railSelectionChanged = (): void => syncRailPane();
  railTabs.on(TabSelectRenderableEvents.SELECTION_CHANGED, railSelectionChanged);
  railTabs.on(TabSelectRenderableEvents.ITEM_SELECTED, railSelectionChanged);
  railTabs.setSelectedIndex(1);
  syncRailPane();

  const applyResponsiveLayout = (nextWidth: number, nextHeight: number): void => {
    const narrow = nextWidth < 72;
    body.flexDirection = narrow ? 'column' : 'row';
    rail.width = narrow ? '100%' : '42%';
    const compactRailHeight = nextHeight < 24 ? 0 : Math.max(4, Math.floor(nextHeight / 3));
    rail.visible = !narrow || compactRailHeight > 0;
    rail.height = narrow ? compactRailHeight : '100%';
    rail.maxHeight = narrow ? compactRailHeight : '100%';
  };
  const width = Math.max(1, renderer.width);
  const height = Math.max(1, renderer.height);
  applyResponsiveLayout(width, height);
  let controller: SemanticWidgetController | undefined;
  const adapter = new OpenTuiSemanticAdapter(renderer, { header, transcript, tools, sidebar, editor, footer }, {
    alternateOutput: options.alternateOutput,
    statusActionsEnabled: options.statusAction !== undefined,
    dispatchInteraction: (generation, event) => controller?.handleNativeInteraction(generation, event),
    dispatchStatusItem: (itemIndex) => controller?.activateStatusItem(itemIndex),
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
  let activeTurn = false;
  let semanticFocusedId: string | undefined;
  const fileCatalog = options.fileCatalog ?? new WorkspaceFileCatalog(options.cwd ?? process.cwd());
  let assist: ComposerAssistWidget | undefined;
  let assistTrigger: ComposerTrigger | undefined;
  let assistCandidates: readonly NativeComposerSuggestion[] = [];
  let assistRevision = 0;
  let assistRequest = 0;
  let assistAbort: AbortController | undefined;
  const pendingAnnouncements: OpenTuiSemanticAnnouncement[] = [];
  const emittedAnnouncementKeys: string[] = [];
  const emittedAnnouncementSet = new Set<string>();
  const collectAnnouncements = (): void => {
    const fresh = controller?.drainAnnouncements() ?? [];
    pendingAnnouncements.push(...fresh);
    if (pendingAnnouncements.length > 64) pendingAnnouncements.splice(0, pendingAnnouncements.length - 64);
    if (options.alternateOutput !== true || options.alternateOutputSink === undefined) return;
    for (const announcement of fresh) {
      const text = sanitizeSingleLineText(announcement.text, {
        maxGraphemes: 2_000,
        redactCredentials: true,
      });
      if (!text) continue;
      const key = `${announcement.source}\u0000${text}`;
      if (emittedAnnouncementSet.has(key)) continue;
      emittedAnnouncementSet.add(key);
      emittedAnnouncementKeys.push(key);
      if (emittedAnnouncementKeys.length > 256) {
        const oldest = emittedAnnouncementKeys.shift();
        if (oldest !== undefined) emittedAnnouncementSet.delete(oldest);
      }
      options.alternateOutputSink(text);
    }
  };
  const applyActionPlaneLayout = (nextHeight: number): void => {
    const actionHeight = Math.min(8, Math.max(1, nextHeight));
    composer.visible = activeGeneration === undefined;
    composer.height = activeGeneration === undefined ? 3 : 0;
    composerHelp.visible = activeGeneration === undefined;
    composerHelp.height = activeGeneration === undefined ? 1 : 0;
    editor.height = activeGeneration === undefined ? 'auto' : actionHeight;
    body.maxHeight = activeGeneration === undefined ? '100%' : Math.max(0, nextHeight - actionHeight - 4);
  };
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
    const completed = applyComposerSuggestion(composer.plainText, assistTrigger, candidate);
    clearAssist();
    composer.setText(completed.value);
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
    applyActionPlaneLayout(nextHeight);
    applyResponsiveLayout(nextWidth, nextHeight);
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
    const ids = [
      ...(rail.visible ? [railTabs.id] : []),
      ...(controller?.getFocusableWidgetIds() ?? []),
    ];
    if (ids.length === 0) {
      focusComposer();
      return;
    }
    if (semanticFocusedId === undefined) {
      const target = reverse ? ids.at(-1) : ids[0];
      if (target === railTabs.id) {
        controller?.focusWidget(undefined);
        railTabs.focus();
        semanticFocusedId = target;
      } else if (target !== undefined && controller?.focusWidget(target)) semanticFocusedId = target;
      return;
    }
    const current = ids.indexOf(semanticFocusedId);
    const next = current + (reverse ? -1 : 1);
    if (current < 0 || next < 0 || next >= ids.length) {
      focusComposer();
      return;
    }
    const target = ids[next];
    if (target === railTabs.id) {
      controller?.focusWidget(undefined);
      railTabs.focus();
      semanticFocusedId = target;
    } else if (target !== undefined && controller?.focusWidget(target)) semanticFocusedId = target;
  };
  const keyHandler = (key: KeyEvent): void => {
    const name = key.name.toLowerCase();
    const action = resolveOpenTuiKeyAction(key, {
      assistOpen: assist !== undefined && activeGeneration === undefined,
      interaction: activeGeneration === undefined ? undefined : activeInteractionType,
      semanticSurfaceFocused: semanticFocusedId !== undefined,
      activeTurn,
    });
    if (assist === undefined && activeGeneration === undefined
      && (name === 'enter' || name === 'return') && (key.ctrl === true || key.meta === true)) {
      key.preventDefault();
      composer.submit();
      return;
    }
    switch (action) {
      case 'assist-dismiss':
        key.preventDefault();
        clearAssist();
        composer?.focus();
        return;
      case 'assist-accept':
        key.preventDefault();
        activateAssist();
        return;
      case 'assist-navigate':
        key.preventDefault();
        assist?.handleInput({ type: 'key', key: name });
        assist?.render(adapter);
        composer?.focus();
        return;
      case 'interaction-cancel':
        key.preventDefault();
        if (activeGeneration !== undefined) {
          const generation = activeGeneration;
          queueMicrotask(() => controller?.handleNativeInteraction(generation, { type: 'key', key: name === 'c' ? 'ctrl+c' : 'escape' }));
        }
        return;
      case 'interrupt':
        key.preventDefault();
        options.events?.interrupt();
        return;
      case 'focus-composer':
        key.preventDefault();
        focusComposer();
        return;
      case 'focus-next':
      case 'focus-previous':
        key.preventDefault();
        cycleFocus(action === 'focus-previous');
        return;
      case 'surface-navigate':
        if (semanticFocusedId === railTabs.id) return;
        key.preventDefault();
        controller?.handleFocusedNavigation(name);
        return;
      case 'interaction-navigate': {
        key.preventDefault();
        const generation = activeGeneration;
        if (generation !== undefined) {
          const semanticKey = name === 'tab' && key.shift ? 'shift+tab' : key.name;
          controller?.handleNativeInteraction(generation, { type: 'key', key: semanticKey });
        }
        return;
      }
      case 'interaction-filter':
        key.preventDefault();
        if (activeGeneration !== undefined) {
          const generation = activeGeneration;
          queueMicrotask(() => controller?.handleNativeInteraction(generation, { type: 'key', key: name }));
        }
        return;
      default:
        return;
    }
  };
  renderer.keyInput.on('keypress', keyHandler);
  renderer.on(CliRenderEvents.RESIZE, syncLayout);
  const composerChanged = (): void => refreshAssist(composer.plainText);
  composer.onContentChange = composerChanged;

  const facade: OpenTuiRendererFacade = {
    render(state) {
      activeTurn = state.working === 'active';
      activeGeneration = state.interaction !== undefined
        && (state.interaction.status === 'pending' || state.interaction.status === 'validation')
        ? state.interaction.generation
        : undefined;
      activeInteractionType = activeGeneration === undefined ? undefined : state.interaction?.request.type;
      applyActionPlaneLayout(Math.max(1, renderer.height));
      if (activeGeneration !== undefined) clearAssist();
      adapter.setInteractionGeneration(activeGeneration);
      if (activeGeneration !== undefined && semanticFocusedId !== undefined) {
        controller?.focusWidget(undefined);
        semanticFocusedId = undefined;
      }
      syncLayout();
      controller?.render(state);
      collectAnnouncements();
      if (semanticFocusedId !== undefined
        && semanticFocusedId !== railTabs.id
        && !controller?.getFocusableWidgetIds().includes(semanticFocusedId)) {
        focusComposer();
      }
      if (activeGeneration === undefined && semanticFocusedId === undefined) composer?.focus();
    },
    alternateOutput() {
      return [controller?.alternateOutput() ?? '', assist?.alternateOutput() ?? ''].filter(Boolean).join('\n\n');
    },
    drainAnnouncements() {
      collectAnnouncements();
      const semantic = pendingAnnouncements.splice(0, pendingAnnouncements.length);
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
        () => { composer.onContentChange = undefined; composer.onSubmit = undefined; },
        () => railTabs.off(TabSelectRenderableEvents.SELECTION_CHANGED, railSelectionChanged),
        () => railTabs.off(TabSelectRenderableEvents.ITEM_SELECTED, railSelectionChanged),
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
  readonly reducedMotion?: boolean;
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
          ...(options.alternateOutput === true
            ? { alternateOutputSink: (text: string) => { process.stdout.write(`\r\n${text}\r\n`); } }
            : {}),
          reducedMotion: options.reducedMotion,
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
