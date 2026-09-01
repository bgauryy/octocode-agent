import { createStore, type StoreApi } from 'zustand/vanilla';

import { NATIVE_DESIGN_LAYOUT } from '../../../presentation/design/tokens.js';
import type { OpenTuiInteractionKind, OpenTuiKeyContext } from '../keymap.js';
import {
  createInitialPresentationState,
  reducePresentation,
  type PresentationEvent,
  type PresentationState,
} from '../presentation.js';

export type OpenTuiRailPane = 'activity' | 'context';

export interface OpenTuiViewSnapshot {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly railPane: OpenTuiRailPane;
  readonly focusedSemanticId?: string;
  readonly compactRailFocusOverride: boolean;
  readonly composerDraft: string;
  readonly shortcutOverlayOpen: boolean;
}

export interface OpenTuiStoreActions {
  readonly accept: (event: PresentationEvent) => void;
  readonly resize: (width: number, height: number) => void;
  readonly selectRailPane: (pane: OpenTuiRailPane) => void;
  readonly focusSemantic: (id: string | undefined) => void;
  readonly setCompactRailFocusOverride: (active: boolean) => void;
  readonly setComposerDraft: (draft: string) => void;
  readonly setShortcutOverlayOpen: (open: boolean) => void;
}

export interface OpenTuiStoreState {
  readonly presentation: PresentationState;
  readonly view: OpenTuiViewSnapshot;
  readonly actions: OpenTuiStoreActions;
}

export type OpenTuiStore = StoreApi<OpenTuiStoreState>;

export interface OpenTuiStoreOptions {
  readonly initialPresentation?: PresentationState;
  readonly viewport?: OpenTuiViewSnapshot['viewport'];
}

export interface OpenTuiLayoutContext {
  readonly width: number;
  readonly height: number;
  readonly narrow: boolean;
  readonly short: boolean;
  readonly railVisible: boolean;
}

const DEFAULT_VIEWPORT = Object.freeze({ width: 80, height: 24 });

function immutableViewport(
  viewport: OpenTuiViewSnapshot['viewport'],
): OpenTuiViewSnapshot['viewport'] {
  return Object.freeze({ width: viewport.width, height: viewport.height });
}

function initialView(
  viewport: OpenTuiViewSnapshot['viewport'],
): OpenTuiViewSnapshot {
  return Object.freeze({
    viewport: immutableViewport(viewport),
    railPane: 'context',
    compactRailFocusOverride: false,
    composerDraft: '',
    shortcutOverlayOpen: false,
  });
}

function replaceView(
  state: OpenTuiStoreState,
  update: Partial<OpenTuiViewSnapshot>,
): Pick<OpenTuiStoreState, 'view'> {
  return { view: Object.freeze({ ...state.view, ...update }) };
}

export function createOpenTuiStore(
  options: OpenTuiStoreOptions = {},
): OpenTuiStore {
  return createStore<OpenTuiStoreState>()((set) => {
    const actions: OpenTuiStoreActions = Object.freeze({
      accept: (event: PresentationEvent) => set((state) => {
        const presentation = reducePresentation(state.presentation, event);
        return presentation === state.presentation ? state : { presentation };
      }),
      resize: (width: number, height: number) => set((state) => (
        state.view.viewport.width === width && state.view.viewport.height === height
          ? state
          : replaceView(state, { viewport: immutableViewport({ width, height }) })
      )),
      selectRailPane: (railPane: OpenTuiRailPane) => set((state) => (
        state.view.railPane === railPane ? state : replaceView(state, { railPane })
      )),
      focusSemantic: (focusedSemanticId: string | undefined) => set((state) => (
        state.view.focusedSemanticId === focusedSemanticId
          ? state
          : replaceView(state, { focusedSemanticId })
      )),
      setCompactRailFocusOverride: (compactRailFocusOverride: boolean) => set((state) => (
        state.view.compactRailFocusOverride === compactRailFocusOverride
          ? state
          : replaceView(state, { compactRailFocusOverride })
      )),
      setComposerDraft: (composerDraft: string) => set((state) => (
        state.view.composerDraft === composerDraft
          ? state
          : replaceView(state, { composerDraft })
      )),
      setShortcutOverlayOpen: (shortcutOverlayOpen: boolean) => set((state) => (
        state.view.shortcutOverlayOpen === shortcutOverlayOpen
          ? state
          : replaceView(state, { shortcutOverlayOpen })
      )),
    });
    return {
      presentation: options.initialPresentation ?? createInitialPresentationState(),
      view: initialView(options.viewport ?? DEFAULT_VIEWPORT),
      actions,
    };
  });
}

export function selectSerializableOpenTuiView(
  state: OpenTuiStoreState,
): OpenTuiViewSnapshot {
  return {
    viewport: state.view.viewport,
    railPane: state.view.railPane,
    ...(state.view.focusedSemanticId === undefined
      ? {}
      : { focusedSemanticId: state.view.focusedSemanticId }),
    compactRailFocusOverride: state.view.compactRailFocusOverride,
    composerDraft: state.view.composerDraft,
    shortcutOverlayOpen: state.view.shortcutOverlayOpen,
  };
}

export function selectActiveTurn(state: OpenTuiStoreState): boolean {
  return state.presentation.working === 'active';
}

function selectActiveInteraction(state: OpenTuiStoreState) {
  const interaction = state.presentation.interaction;
  return interaction !== undefined
    && (interaction.status === 'pending' || interaction.status === 'validation')
    ? interaction
    : undefined;
}

export function selectInteractionGeneration(
  state: OpenTuiStoreState,
): number | undefined {
  return selectActiveInteraction(state)?.generation;
}

export function selectInteractionType(
  state: OpenTuiStoreState,
): OpenTuiInteractionKind | undefined {
  return selectActiveInteraction(state)?.request.type;
}

export function selectDiscussAvailable(state: OpenTuiStoreState): boolean {
  return selectActiveInteraction(state)?.request.workflow?.allowDiscuss === true;
}

export function selectOpenTuiLayoutContext(
  state: OpenTuiStoreState,
): OpenTuiLayoutContext {
  const { width, height } = state.view.viewport;
  const narrow = width < NATIVE_DESIGN_LAYOUT.wideColumns;
  const short = height < NATIVE_DESIGN_LAYOUT.shortRows;
  return {
    width,
    height,
    narrow,
    short,
    railVisible: !narrow || !short || state.view.compactRailFocusOverride,
  };
}

export function selectOpenTuiKeyContext(
  state: OpenTuiStoreState,
  assistOpen = false,
): OpenTuiKeyContext {
  const interaction = selectInteractionType(state);
  return {
    assistOpen: assistOpen && interaction === undefined,
    ...(interaction === undefined ? {} : { interaction }),
    discussAvailable: selectDiscussAvailable(state),
    semanticSurfaceFocused: state.view.focusedSemanticId !== undefined,
    activeTurn: selectActiveTurn(state),
  };
}
