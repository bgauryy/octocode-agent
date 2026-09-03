import {
  BoxRenderable,
  CliRenderEvents,
  createCliRenderer,
  decodePasteBytes,
  ScrollBoxRenderable,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
  TextareaRenderable,
  type KeyEvent,
} from '@opentui/core';

import {
  ComposerPasteStore,
  WorkspaceFileCatalog,
  applyComposerSuggestion,
  commandSuggestions,
  parseComposerTrigger,
  type ComposerTrigger,
  type NativeComposerSuggestion,
} from '../../native-composer.js';
import {
  NativeComposerImageStore,
  parseNativeDraggedImagePath,
  type NativeImageInputResolver,
} from '../../native-user-input.js';

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
import { NATIVE_DESIGN_CONTENT, NATIVE_DESIGN_LAYOUT, nativeColorEnabledFromEnvironment } from '../../presentation/design/tokens.js';
import {
  createOpenTuiStore,
  selectActiveTurn,
  selectDiscussAvailable,
  selectInteractionGeneration,
  selectInteractionType,
  selectOpenTuiLayoutContext,
  type OpenTuiStore,
} from './state/view-store.js';
import type { NativeWorkerOperationIntent } from '../../native-worker-operations.js';
import { resolveOpenTuiRailWidth } from './layout-policy.js';

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
  /** Capability-rooted resolver for binary paste and terminal-dropped image paths. */
  readonly imageInput?: NativeImageInputResolver;
  readonly workerOperation?: (intent: NativeWorkerOperationIntent) => void | Promise<void>;
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
  injectedStore?: OpenTuiStore,
): OpenTuiRendererFacade {
  const theme = OPEN_TUI_THEMES[renderer.themeMode === 'light' ? 'light' : 'dark'];
  const colorEnabled = nativeColorEnabledFromEnvironment(process.env);
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
    minWidth: 0,
    flexDirection: 'column',
  });
  const rail = new ScrollBoxRenderable(renderer, {
    id: 'octocode-agent-rail',
    width: '42%',
    height: '100%',
    flexShrink: 0,
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
      { name: NATIVE_DESIGN_CONTENT.activityTab, description: 'Tool and run activity', value: 'activity' },
      { name: NATIVE_DESIGN_CONTENT.contextTab, description: 'Runtime context and status', value: 'context' },
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
    height: NATIVE_DESIGN_LAYOUT.composerRows,
    minHeight: NATIVE_DESIGN_LAYOUT.composerRows,
    maxHeight: 6,
    wrapMode: 'word',
    placeholder: NATIVE_DESIGN_CONTENT.composerPlaceholder,
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
    content: NATIVE_DESIGN_CONTENT.composerHelp,
    fg: color('muted'),
  });
  const shortcutHelp = new TextRenderable(renderer, {
    id: 'octocode-agent-shortcuts',
    width: '100%',
    height: 0,
    visible: false,
    content: NATIVE_DESIGN_CONTENT.shortcutHelp.join('\n'),
    fg: color('text'),
    bg: color('surfaceRaised'),
  });
  editor.add(shortcutHelp);
  editor.add(composerHelp);
  editor.add(composer);
  const width = Math.max(1, renderer.width);
  const height = Math.max(1, renderer.height);
  const store = injectedStore ?? createOpenTuiStore({
    viewport: { width, height },
    initialPresentation: options.initialState,
  });
  store.getState().actions.resize(width, height);
  const pasteStore = new ComposerPasteStore();
  const imageStore = new NativeComposerImageStore();
  const imageLoads = new AbortController();
  let pendingImageLoads = 0;
  let pendingImageSequence = 0;
  const inputValidation = (message: string): void => {
    options.events?.inputValidation?.(message);
  };
  const replaceComposerToken = (token: string, replacement: string): void => {
    const current = composer.plainText;
    const index = current.indexOf(token);
    if (index < 0) return;
    const next = `${current.slice(0, index)}${replacement}${current.slice(index + token.length)}`;
    composer.replaceText(next);
    composer.cursorOffset = index + replacement.length;
  };
  composer.onPaste = (event) => {
    // Paste payloads are intercepted before TextareaRenderable mutates its
    // buffer. Large content stays in the renderer-independent store and only a
    // compact marker enters visual/Zustand draft state.
    event.preventDefault();
    event.stopPropagation();
    if (event.metadata?.kind === 'binary' || event.metadata?.mimeType?.startsWith('image/')) {
      try {
        if (options.imageInput === undefined) throw new Error('Image input is unavailable');
        const image = options.imageInput.fromBinary(
          event.bytes,
          event.metadata?.mimeType,
        );
        composer.insertText(imageStore.add(image).marker);
      } catch (error) {
        composer.insertText('[image rejected]');
        inputValidation(`Image attachment rejected · ${error instanceof Error ? error.message : 'invalid image'}`);
      }
      return;
    }
    const decoded = decodePasteBytes(event.bytes);
    const imagePath = parseNativeDraggedImagePath(decoded);
    if (imagePath !== undefined && options.imageInput !== undefined) {
      const pending = `[image loading #${++pendingImageSequence}]`;
      pendingImageLoads += 1;
      composer.insertText(pending);
      void options.imageInput.fromWorkspacePath(imagePath, imageLoads.signal)
        .then((image) => replaceComposerToken(pending, imageStore.add(image).marker))
        .catch((error: unknown) => {
          const prepared = pasteStore.prepare(decoded);
          replaceComposerToken(pending, prepared.displayText);
          inputValidation(`Image attachment rejected · ${error instanceof Error ? error.message : 'invalid image'}`);
        })
        .finally(() => { pendingImageLoads -= 1; });
      return;
    }
    const prepared = pasteStore.prepare(decoded);
    composer.insertText(prepared.displayText);
  };
  composer.onSubmit = () => {
    // The toolkit textarea is the synchronous keystroke authority; its content
    // callback can trail a native submit by one input tick. Zustand retains the
    // serializable draft snapshot, but must not make submission drop fresh text.
    const draft = composer.plainText;
    if (draft.trim().length === 0 && imageStore.size === 0) return;
    if (pendingImageLoads > 0) {
      inputValidation('Wait for image attachment loading to finish');
      return;
    }
    let submitted: ReturnType<NativeComposerImageStore['compose']>;
    try {
      submitted = imageStore.compose(pasteStore.expand(draft));
    } catch (error) {
      inputValidation(`Input was not submitted · ${error instanceof Error ? error.message : 'invalid input'}`);
      return;
    }
    pasteStore.clear();
    imageStore.clear();
    composer.clear();
    store.getState().actions.setComposerDraft('');
    options.events?.submitInput(submitted);
  };
  const syncRailPane = (): void => {
    const contextSelected = railTabs.getSelectedIndex() === 1;
    store.getState().actions.selectRailPane(contextSelected ? 'context' : 'activity');
    tools.visible = !contextSelected;
    sidebar.visible = contextSelected;
  };
  const railSelectionChanged = (): void => syncRailPane();
  railTabs.on(TabSelectRenderableEvents.SELECTION_CHANGED, railSelectionChanged);
  railTabs.on(TabSelectRenderableEvents.ITEM_SELECTED, railSelectionChanged);
  railTabs.setSelectedIndex(0);
  syncRailPane();

  const applyResponsiveLayout = (nextWidth: number, nextHeight: number): void => {
    store.getState().actions.resize(nextWidth, nextHeight);
    const layout = selectOpenTuiLayoutContext(store.getState());
    body.flexDirection = layout.narrow ? 'column' : 'row';
    rail.width = layout.narrow ? '100%' : resolveOpenTuiRailWidth(nextWidth);
    const compactRailHeight = layout.short
      ? NATIVE_DESIGN_LAYOUT.minimumActivityRows
      : Math.max(NATIVE_DESIGN_LAYOUT.minimumActivityRows, Math.floor(nextHeight / 3));
    rail.visible = layout.railVisible;
    rail.height = layout.narrow ? compactRailHeight : '100%';
    rail.maxHeight = layout.narrow ? compactRailHeight : '100%';
  };
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
    workerOperation: options.workerOperation,
  });
  let activeGeneration: number | undefined;
  let activeInteractionType: 'confirm' | 'select' | 'input' | 'editor' | undefined;
  let activeDiscussAvailable = false;
  let activeTurn = false;
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
    const actionHeight = Math.min(NATIVE_DESIGN_LAYOUT.maximumActionRows, Math.max(1, nextHeight));
    composer.visible = activeGeneration === undefined;
    composer.height = activeGeneration === undefined ? NATIVE_DESIGN_LAYOUT.composerRows : 0;
    composerHelp.visible = activeGeneration === undefined;
    composerHelp.height = activeGeneration === undefined ? NATIVE_DESIGN_LAYOUT.composerHelpRows : 0;
    editor.height = activeGeneration === undefined ? 'auto' : actionHeight;
    body.maxHeight = activeGeneration === undefined
      ? '100%'
      : Math.max(0, nextHeight - actionHeight - NATIVE_DESIGN_LAYOUT.fixedChromeRows);
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
    store.getState().actions.focusSemantic(undefined);
    composer?.focus();
    store.getState().actions.setCompactRailFocusOverride(false);
    applyResponsiveLayout(Math.max(1, renderer.width), Math.max(1, renderer.height));
  };
  const syncLayout = (): void => {
    const nextWidth = Math.max(1, renderer.width);
    const nextHeight = Math.max(1, renderer.height);
    const previous = store.getState().view.viewport;
    if (nextWidth === previous.width && nextHeight === previous.height) return;
    store.getState().actions.resize(nextWidth, nextHeight);
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
      railTabs.id,
      ...(controller?.getFocusableWidgetIds() ?? []),
    ];
    if (ids.length === 0) {
      focusComposer();
      return;
    }
    const focusedSemanticId = store.getState().view.focusedSemanticId;
    if (focusedSemanticId === undefined) {
      const target = reverse ? ids.at(-1) : ids[0];
      if (target === railTabs.id) {
        controller?.focusWidget(undefined);
        store.getState().actions.setCompactRailFocusOverride(true);
        applyResponsiveLayout(Math.max(1, renderer.width), Math.max(1, renderer.height));
        railTabs.focus();
        store.getState().actions.focusSemantic(target);
      } else if (target !== undefined && controller?.focusWidget(target)) store.getState().actions.focusSemantic(target);
      return;
    }
    const current = ids.indexOf(focusedSemanticId);
    const next = current + (reverse ? -1 : 1);
    if (current < 0 || next < 0 || next >= ids.length) {
      focusComposer();
      return;
    }
    const target = ids[next];
    if (target === railTabs.id) {
      controller?.focusWidget(undefined);
      store.getState().actions.setCompactRailFocusOverride(true);
      applyResponsiveLayout(Math.max(1, renderer.width), Math.max(1, renderer.height));
      railTabs.focus();
      store.getState().actions.focusSemantic(target);
    } else if (target !== undefined && controller?.focusWidget(target)) store.getState().actions.focusSemantic(target);
  };
  const keyHandler = (key: KeyEvent): void => {
    const name = key.name.toLowerCase();
    const shortcutKey = name === '?' || key.sequence === '?';
    const escapeKey = name === 'escape' || name === 'esc' || key.sequence === '\u001b';
    if (shortcutKey && activeGeneration === undefined && composer.plainText.length === 0) {
      key.preventDefault();
      const open = !store.getState().view.shortcutOverlayOpen;
      store.getState().actions.setShortcutOverlayOpen(open);
      shortcutHelp.visible = open;
      shortcutHelp.height = open ? NATIVE_DESIGN_CONTENT.shortcutHelp.length : 0;
      return;
    }
    if (store.getState().view.shortcutOverlayOpen && escapeKey) {
      key.preventDefault();
      store.getState().actions.setShortcutOverlayOpen(false);
      shortcutHelp.visible = false;
      shortcutHelp.height = 0;
      composer.focus();
      return;
    }
    const action = resolveOpenTuiKeyAction(key, {
      assistOpen: assist !== undefined && activeGeneration === undefined,
      interaction: activeGeneration === undefined ? undefined : activeInteractionType,
      discussAvailable: activeGeneration !== undefined && activeDiscussAvailable,
      semanticSurfaceFocused: store.getState().view.focusedSemanticId !== undefined,
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
      case 'interaction-discuss':
        key.preventDefault();
        if (activeGeneration !== undefined) {
          controller?.handleNativeInteraction(activeGeneration, { type: 'discuss' });
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
        if (store.getState().view.focusedSemanticId === railTabs.id) return;
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
  const composerChanged = (): void => {
    store.getState().actions.setComposerDraft(composer.plainText);
    refreshAssist(composer.plainText);
  };
  composer.onContentChange = composerChanged;

  const facade: OpenTuiRendererFacade = {
    render(state) {
      const projectedStoreState = { ...store.getState(), presentation: state };
      activeTurn = selectActiveTurn(projectedStoreState);
      activeGeneration = selectInteractionGeneration(projectedStoreState);
      activeInteractionType = selectInteractionType(projectedStoreState);
      activeDiscussAvailable = selectDiscussAvailable(projectedStoreState);
      applyActionPlaneLayout(Math.max(1, renderer.height));
      if (activeGeneration !== undefined) clearAssist();
      const actionableStatus = state.runtimeWidgets?.statusNotifications?.some(
        ({ action }) => action !== undefined,
      ) === true;
      if (actionableStatus && railTabs.getSelectedIndex() !== 1) {
        railTabs.setSelectedIndex(1);
        syncRailPane();
      }
      adapter.setInteractionGeneration(activeGeneration);
      if (activeGeneration !== undefined && store.getState().view.focusedSemanticId !== undefined) {
        controller?.focusWidget(undefined);
        store.getState().actions.focusSemantic(undefined);
      }
      syncLayout();
      controller?.render(state);
      collectAnnouncements();
      const focusedSemanticId = store.getState().view.focusedSemanticId;
      if (focusedSemanticId !== undefined
        && focusedSemanticId !== railTabs.id
        && !controller?.getFocusableWidgetIds().includes(focusedSemanticId)) {
        focusComposer();
      }
      if (activeGeneration === undefined && store.getState().view.focusedSemanticId === undefined) composer?.focus();
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
        () => {
          composer.onContentChange = undefined;
          composer.onPaste = undefined;
          composer.onSubmit = undefined;
          pasteStore.clear();
          imageStore.clear();
          imageLoads.abort('terminal stopped');
        },
        () => railTabs.off(TabSelectRenderableEvents.SELECTION_CHANGED, railSelectionChanged),
        () => railTabs.off(TabSelectRenderableEvents.ITEM_SELECTED, railSelectionChanged),
        clearAssist,
        () => controller?.destroy(),
        () => adapter.destroyAll(),
        () => root.destroy(),
      ]);
    },
  };
  facade.render(injectedStore?.getState().presentation ?? options.initialState ?? createInitialPresentationState());
  return facade;
}

/** Production OpenTUI renderer factory. All toolkit types remain in this directory. */
export function createDefaultOpenTuiTerminal(options: {
  readonly cwd?: string;
  readonly alternateOutput?: boolean;
  readonly reducedMotion?: boolean;
  readonly imageInput?: NativeImageInputResolver;
  readonly workerOperation?: (intent: NativeWorkerOperationIntent) => void | Promise<void>;
} = {}): OpenTuiTerminal {
  return createOpenTuiTerminal({
    inputOwnership: 'renderer',
    async createRenderer(events, store) {
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
          imageInput: options.imageInput,
          workerOperation: options.workerOperation,
        }, store);
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
