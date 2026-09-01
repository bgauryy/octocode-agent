import { describe, expect, it } from 'vitest';

import {
  createOpenTuiStore,
  selectActiveTurn,
  selectDiscussAvailable,
  selectInteractionGeneration,
  selectInteractionType,
  selectOpenTuiKeyContext,
  selectOpenTuiLayoutContext,
  selectSerializableOpenTuiView,
} from '../src/terminal/opentui/state/view-store.js';

describe('OpenTUI store', () => {
  it('owns serializable presentation and view domains through stable named actions', () => {
    const store = createOpenTuiStore({ viewport: { width: 80, height: 24 } });
    const initial = store.getState();
    initial.actions.resize(40, 18);
    initial.actions.selectRailPane('activity');
    initial.actions.focusSemantic('octocode-agent-rail-tabs');
    initial.actions.setCompactRailFocusOverride(true);
    initial.actions.setComposerDraft('hello');
    initial.actions.setShortcutOverlayOpen(true);

    expect(selectSerializableOpenTuiView(store.getState())).toEqual({
      viewport: { width: 40, height: 18 },
      railPane: 'activity',
      focusedSemanticId: 'octocode-agent-rail-tabs',
      compactRailFocusOverride: true,
      composerDraft: 'hello',
      shortcutOverlayOpen: true,
    });
    expect(store.getState().actions).toBe(initial.actions);
    expect(store.getState().presentation).toBe(initial.presentation);
  });

  it('does not notify for no-op actions and preserves unrelated slice identities', () => {
    const store = createOpenTuiStore({ viewport: { width: 80, height: 24 } });
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    const initial = store.getState();

    initial.actions.resize(80, 24);
    initial.actions.selectRailPane('context');
    initial.actions.focusSemantic(undefined);
    initial.actions.setCompactRailFocusOverride(false);
    initial.actions.setComposerDraft('');
    initial.actions.setShortcutOverlayOpen(false);
    expect(notifications).toBe(0);

    initial.actions.resize(40, 18);
    expect(notifications).toBe(1);
    expect(store.getState().presentation).toBe(initial.presentation);
    expect(store.getState().actions).toBe(initial.actions);

    const resizedView = store.getState().view;
    initial.actions.accept({ type: 'runtime-ready' });
    expect(notifications).toBe(2);
    expect(store.getState().view).toBe(resizedView);
    expect(store.getState().actions).toBe(initial.actions);
  });

  it('derives active interaction, key, and layout context without mirrored state', () => {
    const store = createOpenTuiStore({ viewport: { width: 40, height: 18 } });
    const { actions } = store.getState();
    actions.accept({ type: 'turn-started', turnId: 'turn-1' });

    expect(selectActiveTurn(store.getState())).toBe(true);
    expect(selectInteractionGeneration(store.getState())).toBeUndefined();
    expect(selectOpenTuiKeyContext(store.getState(), true)).toMatchObject({
      assistOpen: true,
      semanticSurfaceFocused: false,
      activeTurn: true,
    });
    expect(selectOpenTuiLayoutContext(store.getState())).toEqual({
      width: 40,
      height: 18,
      narrow: true,
      short: true,
      railVisible: false,
    });

    actions.accept({
      type: 'interaction-requested',
      request: {
        type: 'confirm',
        message: 'Proceed?',
        workflow: {
          workflowId: 'ask-1',
          questionId: 'proceed',
          index: 0,
          total: 1,
          allowDiscuss: true,
        },
      },
    });
    expect(selectInteractionGeneration(store.getState())).toBe(1);
    expect(selectInteractionType(store.getState())).toBe('confirm');
    expect(selectDiscussAvailable(store.getState())).toBe(true);
    expect(selectOpenTuiKeyContext(store.getState(), true)).toMatchObject({
      assistOpen: false,
      interaction: 'confirm',
      discussAvailable: true,
      activeTurn: true,
    });

    actions.setCompactRailFocusOverride(true);
    expect(selectOpenTuiLayoutContext(store.getState()).railVisible).toBe(true);
  });
});
