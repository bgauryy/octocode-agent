import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  TabSelectRenderable,
  TextAttributes,
  TextRenderable,
  TextareaRenderable,
} from '@opentui/core';
import {
  createTestRenderer,
  KeyCodes,
  ManualClock,
  setRendererCapabilities,
} from '@opentui/core/testing';
import { describe, expect, it } from 'vitest';

import {
  createInitialPresentationState,
  reducePresentation,
  type OpenTuiInputEvent,
  type OpenTuiRendererEvents,
} from '../src/terminal/opentui/presentation.js';
import { createOpenTuiTerminal } from '../src/terminal/opentui/create-terminal.js';
import { createOpenTuiRendererFacade } from '../src/terminal/opentui/renderer.js';
import { EditorWidget } from '../src/terminal/opentui/widgets/editor.js';
import { PromptInputWidget } from '../src/terminal/opentui/widgets/prompt-input.js';
import { SelectWidget } from '../src/terminal/opentui/widgets/select.js';

const hasNativeFfi = process.execArgv.includes('--experimental-ffi')
  || process.env.NODE_OPTIONS?.split(/\s+/u).includes('--experimental-ffi') === true;

const describeNativeFfi = hasNativeFfi ? describe : describe.skip;

describeNativeFfi('production OpenTUI widget renderer (requires NODE_OPTIONS=--experimental-ffi)', () => {
  it('streams bounded sanitized semantic announcements only in alternate-output mode', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const state = reducePresentation(createInitialPresentationState(), {
      type: 'runtime-widgets-changed',
      snapshots: { statusNotifications: [{
        authority: 'runtime', slot: 'system', id: 'clear',
        message: 'Context cleared. New session started. api_key=secret-value-long',
        lifecycle: 'success',
      }] },
    });
    const streamed: string[] = [];
    const facade = createOpenTuiRendererFacade(setup.renderer, {
      initialState: state,
      alternateOutput: true,
      alternateOutputSink: (text) => streamed.push(text),
    });
    facade.render(state);
    await setup.flush();

    expect(streamed).toEqual([
      'SUCCESS: Context cleared. New session started. api_key=[REDACTED]',
    ]);
    expect(facade.drainAnnouncements?.()).toHaveLength(1);
    await facade.destroy();
    setup.renderer.destroy();

    const ordinarySetup = await createTestRenderer({ width: 80, height: 24 });
    const ordinaryStreamed: string[] = [];
    const ordinary = createOpenTuiRendererFacade(ordinarySetup.renderer, {
      initialState: state,
      alternateOutputSink: (text) => ordinaryStreamed.push(text),
    });
    await ordinarySetup.flush();
    expect(ordinaryStreamed).toEqual([]);
    await ordinary.destroy();
    ordinarySetup.renderer.destroy();
  });

  it('applies the narrow layout on initial render and omits unavailable status actions from the projection', async () => {
    const setup = await createTestRenderer({ width: 64, height: 18 });
    const state = reducePresentation(createInitialPresentationState(), {
      type: 'runtime-widgets-changed',
      snapshots: { statusNotifications: [{
        authority: 'runtime', slot: 'system', id: 'retry', message: 'Provider failed', lifecycle: 'error',
        action: { id: 'retry-provider', label: 'Retry provider' },
      }] },
    });
    const facade = createOpenTuiRendererFacade(setup.renderer, { initialState: state });
    await setup.flush();

    const rail = setup.renderer.root.findDescendantById('octocode-agent-rail') as BoxRenderable;
    expect(rail.visible).toBe(false);
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain('Retry provider');
    expect(frame).not.toContain('Enter action');
    expect(facade.alternateOutput?.()).not.toContain('Retry provider');

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('bounds and scrolls activity on a short narrow terminal without hiding the composer', async () => {
    const setup = await createTestRenderer({ width: 40, height: 12 });
    const facade = createOpenTuiRendererFacade(setup.renderer);
    let state = createInitialPresentationState();
    for (let index = 0; index < 20; index += 1) {
      state = reducePresentation(state, {
        type: 'tool-started', callId: `call-${index}`, name: `tool-${index}`,
      });
    }
    facade.render(state);
    await setup.flush();

    const rail = setup.renderer.root.findDescendantById('octocode-agent-rail') as ScrollBoxRenderable;
    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer') as InputRenderable;
    expect(rail).toBeInstanceOf(ScrollBoxRenderable);
    expect(rail.visible).toBe(false);
    expect(composer.height).toBeGreaterThan(0);
    expect(composer.y + composer.height).toBeLessThanOrEqual(12);

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('keeps the composer visible when wide-terminal activity fills the rail', async () => {
    const setup = await createTestRenderer({
      width: 80, height: 24, kittyKeyboard: true, otherModifiersMode: true,
    });
    const facade = createOpenTuiRendererFacade(setup.renderer);
    let state = createInitialPresentationState();
    state = reducePresentation(state, {
      type: 'presentation-changed', property: 'widget',
      value: {
        id: 'help', kind: 'list', title: 'Native commands',
        items: Array.from({ length: 30 }, (_, index) => `Command ${index + 1}`),
      },
    });
    facade.render(state);
    await setup.flush();

    const rail = setup.renderer.root.findDescendantById('octocode-agent-rail') as ScrollBoxRenderable;
    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer') as TextareaRenderable;
    expect(rail.visible).toBe(true);
    expect(composer.height).toBeGreaterThan(0);
    expect(composer.y + composer.height).toBeLessThanOrEqual(24);

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('uses a multiline composer with explicit Ctrl/Meta-Enter submission', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const submitted: string[] = [];
    const facade = createOpenTuiRendererFacade(setup.renderer, {
      events: {
        submitLine: (line) => submitted.push(line),
        interrupt: () => undefined,
        resolveInteraction: () => undefined,
      },
    });
    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer') as TextareaRenderable;
    expect(composer).toBeInstanceOf(TextareaRenderable);

    setup.mockInput.typeText('first');
    setup.mockInput.pressKey(KeyCodes.RETURN);
    setup.mockInput.typeText('second');
    await setup.flush();
    expect(composer.plainText).toBe('first\nsecond');
    expect(submitted).toEqual([]);

    composer.handleKeyPress({ name: 'return', ctrl: true } as Parameters<typeof composer.handleKeyPress>[0]);
    await setup.flush();
    expect(submitted).toEqual(['first\nsecond']);
    expect(composer.plainText).toBe('');

    setup.mockInput.typeText('meta');
    setup.mockInput.pressKey(KeyCodes.RETURN, { meta: true });
    await setup.flush();
    expect(submitted).toEqual(['first\nsecond', 'meta']);
    await facade.destroy();
    setup.renderer.destroy();
  });

  it('switches the wide rail between Activity and Context without stealing completion Tab', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const facade = createOpenTuiRendererFacade(setup.renderer);
    const tabs = setup.renderer.root.findDescendantById('octocode-agent-rail-tabs') as TabSelectRenderable;
    const tools = setup.renderer.root.findDescendantById('octocode-agent-tools') as BoxRenderable;
    const sidebar = setup.renderer.root.findDescendantById('octocode-agent-sidebar') as BoxRenderable;
    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer') as TextareaRenderable;
    expect(tabs).toBeInstanceOf(TabSelectRenderable);
    expect(tools.visible).toBe(false);
    expect(sidebar.visible).toBe(true);

    tabs.setSelectedIndex(0);
    tabs.selectCurrent();
    await setup.flush();
    expect(tools.visible).toBe(true);
    expect(sidebar.visible).toBe(false);

    await setup.mockInput.typeText('/pl');
    await setup.flush();
    setup.mockInput.pressKey(KeyCodes.TAB);
    await setup.flush();
    expect(composer.plainText).toBe('/plan ');
    expect(tabs.getSelectedIndex()).toBe(0);
    await facade.destroy();
    setup.renderer.destroy();
  });

  it('routes Enter on a focused status action through the typed asynchronous host sink', async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const actions: unknown[] = [];
    const facade = createOpenTuiRendererFacade(setup.renderer, {
      statusAction: (invocation) => { actions.push(invocation); },
    });
    const state = reducePresentation(createInitialPresentationState(), {
      type: 'runtime-widgets-changed',
      snapshots: { statusNotifications: [{
        authority: 'runtime', slot: 'system', id: 'retry', message: 'Provider failed', lifecycle: 'error',
        action: { id: 'retry-provider', label: 'Retry provider' },
      }] },
    });
    facade.render(state);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('Retry provider');

    setup.mockInput.pressKey(KeyCodes.TAB);
    setup.mockInput.pressKey(KeyCodes.TAB);
    setup.mockInput.pressKey(KeyCodes.TAB);
    await setup.flush();
    expect((setup.renderer.root.findDescendantById('status-notifications-scroll') as ScrollBoxRenderable).focused).toBe(true);
    setup.mockInput.pressKey(KeyCodes.RETURN);
    expect(actions).toEqual([]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(actions).toEqual([{
      key: 'system:retry',
      action: { id: 'retry-provider', label: 'Retry provider' },
    }]);

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('routes raw Escape and Ctrl-C by active-turn state while preserving local modal handling and text input', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const interrupts: string[] = [];
    const resolutions: unknown[] = [];
    const facade = createOpenTuiRendererFacade(setup.renderer, {
      events: {
        submitLine: () => undefined,
        interrupt: () => interrupts.push('interrupt'),
        resolveInteraction: (generation, result) => resolutions.push({ generation, result }),
      },
    });
    const idle = reducePresentation(createInitialPresentationState(), { type: 'runtime-ready' });
    facade.render(idle);
    await setup.flush();

    await setup.mockInput.typeText('c');
    await setup.flush();
    expect((setup.renderer.root.findDescendantById('octocode-agent-composer') as TextareaRenderable).plainText).toBe('c');
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await setup.flush();
    expect(interrupts).toEqual([]);

    const active = reducePresentation(idle, { type: 'presentation-changed', property: 'working', value: 'active' });
    facade.render(active);
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await setup.flush();
    expect(interrupts).toEqual(['interrupt']);

    facade.render(reducePresentation(active, {
      type: 'interaction-requested', request: { type: 'confirm', message: 'Proceed?' },
    }));
    await setup.flush();
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(resolutions).toEqual([{ generation: 1, result: { status: 'cancelled' } }]);
    expect(interrupts).toEqual(['interrupt']);

    await facade.destroy();
    setup.renderer.destroy();

    const activeCtrlSetup = await createTestRenderer({ width: 80, height: 24 });
    const activeCtrlInterrupts: string[] = [];
    const activeCtrlFacade = createOpenTuiRendererFacade(activeCtrlSetup.renderer, {
      events: {
        submitLine: () => undefined,
        interrupt: () => activeCtrlInterrupts.push('interrupt'),
        resolveInteraction: () => undefined,
      },
    });
    activeCtrlFacade.render(active);
    activeCtrlSetup.mockInput.pressKey('c', { ctrl: true });
    await activeCtrlSetup.flush();
    expect(activeCtrlInterrupts).toEqual(['interrupt']);
    await activeCtrlFacade.destroy();
    activeCtrlSetup.renderer.destroy();

    const idleCtrlSetup = await createTestRenderer({ width: 80, height: 24 });
    const idleCtrlInterrupts: string[] = [];
    const idleCtrlFacade = createOpenTuiRendererFacade(idleCtrlSetup.renderer, {
      events: {
        submitLine: () => undefined,
        interrupt: () => idleCtrlInterrupts.push('interrupt'),
        resolveInteraction: () => undefined,
      },
    });
    idleCtrlFacade.render(idle);
    idleCtrlSetup.mockInput.pressKey('c', { ctrl: true });
    await idleCtrlSetup.flush();
    expect(idleCtrlInterrupts).toEqual(['interrupt']);
    await idleCtrlFacade.destroy();
    idleCtrlSetup.renderer.destroy();
  });

  it('routes mouse activation for confirm choices and notification actions', async () => {
    const confirmSetup = await createTestRenderer({ width: 80, height: 30, footerHeight: 0, useMouse: true, enableMouseMovement: true });
    const resolutions: unknown[] = [];
    const confirmFacade = createOpenTuiRendererFacade(confirmSetup.renderer, {
      events: {
        submitLine: () => undefined,
        interrupt: () => undefined,
        resolveInteraction: (generation, result) => resolutions.push({ generation, result }),
      },
    });
    confirmFacade.render(reducePresentation(createInitialPresentationState(), {
      type: 'interaction-requested', request: { type: 'confirm', message: 'Proceed?' },
    }));
    await confirmSetup.flush();
    const confirm = confirmSetup.renderer.root.findDescendantById('interaction-1-confirm') as SelectRenderable;
    expect(confirm.y + confirm.height).toBeLessThanOrEqual(30);
    await confirmSetup.mockMouse.click(confirm.x + 2, confirm.y);
    await confirmSetup.flush();
    await confirmSetup.waitFor(() => resolutions.length > 0);
    expect(resolutions).toEqual([{ generation: 1, result: { status: 'accepted', value: true } }]);
    await confirmFacade.destroy();
    confirmSetup.renderer.destroy();

    const statusSetup = await createTestRenderer({ width: 80, height: 20, footerHeight: 0, useMouse: true, enableMouseMovement: true });
    const actions: unknown[] = [];
    const statusFacade = createOpenTuiRendererFacade(statusSetup.renderer, {
      statusAction: (invocation) => { actions.push(invocation); },
    });
    statusFacade.render(reducePresentation(createInitialPresentationState(), {
      type: 'runtime-widgets-changed',
      snapshots: { statusNotifications: [{
        authority: 'runtime', slot: 'system', id: 'retry', message: 'Provider failed', lifecycle: 'error',
        action: { id: 'retry-provider', label: 'Retry provider' },
      }] },
    }));
    await statusSetup.flush();
    const statusText = statusSetup.renderer.root.findDescendantById('status-notifications-semantics') as TextRenderable;
    await statusSetup.mockMouse.click(statusText.x + 2, statusText.y + 1);
    await statusSetup.flush();
    await statusSetup.waitFor(() => actions.length > 0);
    expect(actions).toEqual([{
      key: 'system:retry',
      action: { id: 'retry-provider', label: 'Retry provider' },
    }]);
    await statusFacade.destroy();
    statusSetup.renderer.destroy();
  });

  it('preserves a normalized semantic frame across clock and terminal capability variants', async () => {
    const clock = new ManualClock();
    clock.setTime(1_000);
    const setup = await createTestRenderer({
      width: 80, height: 24, footerHeight: 0, kittyKeyboard: true, otherModifiersMode: true,
    });
    const facade = createOpenTuiRendererFacade(setup.renderer, { nowMs: () => clock.now() });
    const state = reducePresentation(createInitialPresentationState(), {
      type: 'message-started', messageId: 'message-capability', role: 'assistant',
    });
    facade.render(reducePresentation(state, {
      type: 'message-delta', messageId: 'message-capability', text: 'Capability-safe output',
    }));
    setRendererCapabilities(setup.renderer, {
      rgb: false, ansi256: false, unicode: 'wcwidth', kitty_keyboard: false, hyperlinks: false,
      terminal: { name: 'minimal', version: '1', from_xtversion: false },
    });
    await setup.flush();
    const normalized = (frame: string) => frame.split('\n').map((line) => line.trimEnd()).filter(Boolean);
    const minimal = normalized(setup.captureCharFrame());

    clock.advance(5_000);
    setRendererCapabilities(setup.renderer, {
      rgb: true, ansi256: true, unicode: 'unicode', kitty_keyboard: true, hyperlinks: true,
      terminal: { name: 'rich', version: '2', from_xtversion: true },
    });
    facade.render(reducePresentation(state, {
      type: 'message-delta', messageId: 'message-capability', text: 'Capability-safe output',
    }));
    await setup.flush();
    expect(normalized(setup.captureCharFrame())).toEqual(minimal);
    expect(clock.now()).toBe(6_000);
    expect((setup.renderer.root.findDescendantById('octocode-agent-composer') as TextareaRenderable).focused).toBe(true);
    await facade.destroy();
    setup.renderer.destroy();
  });

  it.each([
    { width: 20, height: 6 },
    { width: 71, height: 18 },
    { width: 72, height: 18 },
    { width: 71, height: 23 },
    { width: 72, height: 24 },
  ])('keeps the current action reachable at the $width x $height layout boundary', async ({ width, height }) => {
    const setup = await createTestRenderer({ width, height, footerHeight: 0 });
    const facade = createOpenTuiRendererFacade(setup.renderer);
    facade.render(reducePresentation(createInitialPresentationState(), {
      type: 'interaction-requested', request: { type: 'confirm', message: 'Proceed?' },
    }));
    await setup.flush();
    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer') as InputRenderable;
    const confirm = setup.renderer.root.findDescendantById('interaction-1-confirm') as SelectRenderable;
    const rail = setup.renderer.root.findDescendantById('octocode-agent-rail') as ScrollBoxRenderable;
    expect(composer).toBeInstanceOf(TextareaRenderable);
    expect(confirm).toBeInstanceOf(SelectRenderable);
    expect(confirm.y).toBeGreaterThanOrEqual(0);
    expect(confirm.y + confirm.height).toBeLessThanOrEqual(height);
    expect(rail.visible).toBe(width >= 72 || height >= 24);
    await facade.destroy();
    setup.renderer.destroy();
  });

  it('materializes typed surfaces, merged statuses, and explicit output drains', async () => {
    const setup = await createTestRenderer({ width: 64, height: 22 });
    const facade = createOpenTuiRendererFacade(setup.renderer);
    let state = createInitialPresentationState();
    state = reducePresentation(state, {
      type: 'presentation-changed', property: 'widget',
      value: { id: 'audit', kind: 'list', title: 'Audit', items: Array.from({ length: 18 }, (_, index) => `Check ${index + 1}`) },
    });
    state = reducePresentation(state, { type: 'status-changed', name: 'model', text: 'ready' });
    state = reducePresentation(state, { type: 'notification', severity: 'warning', message: 'Context nearly full' });
    state = reducePresentation(state, {
      type: 'runtime-widgets-changed',
      snapshots: { statusNotifications: [{
        authority: 'runtime', slot: 'agent', id: 'run', message: 'Agent complete', lifecycle: 'success',
      }] },
    });
    facade.render(state);
    await setup.flush();

    expect(setup.renderer.root.findDescendantById('presentation-1-scroll')).toBeInstanceOf(ScrollBoxRenderable);
    expect(setup.renderer.root.findDescendantById('status-notifications-scroll')).toBeInstanceOf(ScrollBoxRenderable);
    expect(setup.renderer.root.findDescendantById('header-box')).toBeUndefined();
    const alternate = facade.alternateOutput?.() ?? '';
    expect(alternate).toContain('Audit');
    expect(alternate).toContain('model: ready');
    expect(alternate).toContain('Context nearly full');
    expect(alternate).toContain('Agent complete');
    expect(facade.drainAnnouncements?.()).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'WARNING: Context nearly full', politeness: 'assertive' }),
      expect.objectContaining({ text: 'SUCCESS: Agent complete', politeness: 'polite' }),
    ]));
    expect(facade.drainAnnouncements?.()).toEqual([]);

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('cycles focus through semantic ScrollBoxes, routes navigation, restores composer, and uses actual resize width', async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const facade = createOpenTuiRendererFacade(setup.renderer);
    let state = createInitialPresentationState();
    state = reducePresentation(state, {
      type: 'presentation-changed', property: 'widget',
      value: { id: 'long', kind: 'list', items: Array.from({ length: 30 }, (_, index) => `Row ${index + 1}`) },
    });
    state = reducePresentation(state, { type: 'status-changed', name: 'runtime', text: 'active' });
    state = reducePresentation(state, {
      type: 'chrome-changed',
      chrome: {
        authority: 'runtime', title: 'Octocode Agent With A Long Title', trust: 'trusted',
        sessionId: 'session-that-must-not-survive-narrow-layout', modelId: 'model-with-long-name',
      },
    });
    state = reducePresentation(state, { type: 'runtime-ready' });
    state = reducePresentation(state, { type: 'presentation-changed', property: 'working', value: 'active' });
    facade.render(state);
    await setup.flush();
    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer') as InputRenderable;
    expect(composer.focused).toBe(true);

    setup.mockInput.pressKey(KeyCodes.TAB, { shift: true });
    await setup.flush();
    const surface = setup.renderer.root.findDescendantById('presentation-1-scroll') as ScrollBoxRenderable;
    expect(surface.focused).toBe(true);
    expect(facade.alternateOutput?.()).toContain('Row 1');
    setup.mockInput.pressKey(KeyCodes.END);
    await setup.flush();
    expect(surface.scrollTop).toBeGreaterThan(0);
    state = reducePresentation(state, { type: 'presentation-changed', property: 'working', value: 'idle' });
    facade.render(state);
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await setup.flush();
    expect(composer.focused).toBe(true);

    setup.resize(32, 18);
    facade.render(state);
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain('session-that-must-not-survive-narrow-layout');
    expect(frame).not.toContain('Cancel turn');
    expect(facade.alternateOutput?.()).toContain('session-that-must-not-survive-narrow-layout');

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('renders a semantic frame, native input focus/key flow, and a narrow resize', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const facade = createOpenTuiRendererFacade(setup.renderer);
    let state = reducePresentation(createInitialPresentationState(), {
      type: 'message-started', messageId: 'message-1', role: 'assistant',
    });
    state = reducePresentation(state, { type: 'message-delta', messageId: 'message-1', text: 'Accessible hello' });
    state = reducePresentation(state, {
      type: 'interaction-requested',
      request: { type: 'input', message: 'Name', initial: 'A' },
    });
    facade.render(state);
    await setup.flush();

    const semanticTranscript = setup.renderer.root.findDescendantById('transcript-semantics') as TextRenderable;
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Accessible hello');
    expect(frame).toContain('Name');
    expect(frame).not.toMatch(/\[(banner|log|region|status)\]/u);
    expect(frame).not.toContain('CONTENT:');
    expect(semanticTranscript.chunks.some(({ attributes }) => (
      (attributes ?? 0) & TextAttributes.BOLD
    ) !== 0)).toBe(true);
    const input = setup.renderer.root.findDescendantById('interaction-1-input');
    expect(input).toBeInstanceOf(InputRenderable);
    (input as InputRenderable).focus();
    setup.mockInput.typeText('da');
    await setup.flush();
    expect((input as InputRenderable).value).toBe('Ada');

    setup.resize(48, 18);
    facade.render(state);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('Accessible hello');
    expect(setup.renderer.root.findDescendantById('interaction-1-input')).toBe(input);
    expect((input as InputRenderable).value).toBe('Ada');

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('keeps composer and modal controls interactive in accessible output mode', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const facade = createOpenTuiRendererFacade(setup.renderer, { alternateOutput: true });
    const state = reducePresentation(createInitialPresentationState(), {
      type: 'interaction-requested',
      request: { type: 'input', message: 'Accessible name', initial: 'Ada' },
    });
    facade.render(state);
    await setup.flush();

    expect(setup.renderer.root.findDescendantById('octocode-agent-composer')).toBeInstanceOf(TextareaRenderable);
    expect(setup.renderer.root.findDescendantById('interaction-1-input')).toBeInstanceOf(InputRenderable);
    expect(setup.captureCharFrame()).toContain('Accessible name');

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('restores composer focus when a focused semantic surface is removed', async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const facade = createOpenTuiRendererFacade(setup.renderer);
    let state = reducePresentation(createInitialPresentationState(), {
      type: 'presentation-changed', property: 'widget',
      value: { id: 'temporary', kind: 'list', items: ['one', 'two'] },
    });
    facade.render(state);
    await setup.flush();
    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer') as TextareaRenderable;
    setup.mockInput.pressKey(KeyCodes.TAB, { shift: true });
    await setup.flush();
    expect(composer.focused).toBe(false);

    state = reducePresentation(state, {
      type: 'presentation-changed', property: 'widget', value: { id: 'temporary', remove: true },
    });
    facade.render(state);
    await setup.flush();

    expect(composer.focused).toBe(true);
    await facade.destroy();
    setup.renderer.destroy();
  });

  it('updates the narrow layout from the native resize event without another presentation render', async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const facade = createOpenTuiRendererFacade(setup.renderer);
    await setup.flush();

    const rail = setup.renderer.root.findDescendantById('octocode-agent-rail') as BoxRenderable;
    const transcript = setup.renderer.root.findDescendantById('octocode-agent-transcript') as BoxRenderable;
    expect(rail.y).toBe(transcript.y);

    setup.resize(40, 18);
    await setup.flush();

    expect(rail.visible).toBe(false);

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('converts native UTF-16 editor offsets to grapheme indexes', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    let semanticEditor: EditorWidget | undefined;
    const facade = createOpenTuiRendererFacade(setup.renderer, {
      interactionWidgetFactory: (interaction) => {
        semanticEditor = new EditorWidget({
          id: `interaction-${interaction.generation}`,
          label: 'Unicode editor',
          initialValue: 'A😀éB',
        });
        return semanticEditor;
      },
    });
    const state = reducePresentation(createInitialPresentationState(), {
      type: 'interaction-requested', request: { type: 'editor', message: 'Unicode editor', initial: 'A😀éB' },
    });
    facade.render(state);
    await setup.flush();

    const editor = setup.renderer.root.findDescendantById('interaction-1-textarea') as TextareaRenderable;
    editor.cursorOffset = 4;
    await setup.mockInput.typeText('x');
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(editor.plainText).toBe('A😀éxB');
    expect(editor.cursorOffset).toBe(5);
    expect(semanticEditor?.value).toBe('A😀éxB');
    expect(semanticEditor?.cursor).toBe(4);

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('converts native input cursor units to JavaScript string boundaries', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    let semanticInput: PromptInputWidget | undefined;
    const facade = createOpenTuiRendererFacade(setup.renderer, {
      interactionWidgetFactory: (interaction) => {
        semanticInput = new PromptInputWidget({
          id: `interaction-${interaction.generation}`,
          question: 'Unicode input',
          initialValue: 'éx',
        });
        return semanticInput;
      },
    });
    facade.render(reducePresentation(createInitialPresentationState(), {
      type: 'interaction-requested', request: { type: 'input', message: 'Unicode input', initial: 'éx' },
    }));
    await setup.flush();
    const input = setup.renderer.root.findDescendantById('interaction-1-input') as InputRenderable;
    input.cursorOffset = 2;
    input.emit(InputRenderableEvents.INPUT, input.value);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(semanticInput?.cursor).toBe(3);
    await facade.destroy();
    setup.renderer.destroy();
  });

  it('synchronizes sanitized bracketed multiline paste into the semantic editor', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    let semanticEditor: EditorWidget | undefined;
    const facade = createOpenTuiRendererFacade(setup.renderer, {
      interactionWidgetFactory: (interaction) => {
        semanticEditor = new EditorWidget({
          id: `interaction-${interaction.generation}`,
          label: 'Paste editor',
          initialValue: 'seed',
        });
        return semanticEditor;
      },
    });
    const state = reducePresentation(createInitialPresentationState(), {
      type: 'interaction-requested', request: { type: 'editor', message: 'Paste editor', initial: 'seed' },
    });
    facade.render(state);
    await setup.flush();

    const editor = setup.renderer.root.findDescendantById('interaction-1-textarea') as TextareaRenderable;
    editor.cursorOffset = editor.plainText.length;
    await setup.mockInput.pasteBracketedText(' pasted\n\u001B[31mline\u001B[0m');
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(editor.plainText).toBe('seed pasted\nline');
    expect(semanticEditor?.value).toBe('seed pasted\nline');
    expect(semanticEditor?.cursor).toBe(16);
    expect(editor.onContentChange).toBeTypeOf('function');

    await facade.destroy();
    expect(editor.onContentChange).toBeUndefined();
    setup.renderer.destroy();
  });

  it('never materializes sensitive prompt and editor values in native controls', async () => {
    for (const kind of ['input', 'editor'] as const) {
      const setup = await createTestRenderer({ width: 80, height: 24 });
      const secret = kind === 'input' ? 's3cr3t-value' : 'editor-secret-value';
      const facade = createOpenTuiRendererFacade(setup.renderer, {
        interactionWidgetFactory: (interaction) => kind === 'input'
          ? new PromptInputWidget({
              id: `interaction-${interaction.generation}`,
              question: 'Secret',
              sensitive: true,
              initialValue: secret,
            })
          : new EditorWidget({
              id: `interaction-${interaction.generation}`,
              label: 'Secret',
              sensitive: true,
              initialValue: secret,
            }),
      });
      facade.render(reducePresentation(createInitialPresentationState(), {
        type: 'interaction-requested',
        request: kind === 'input' ? { type: 'input', message: 'Secret' } : { type: 'editor', message: 'Secret', initial: secret },
      }));
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain(secret);
      expect(facade.alternateOutput?.()).not.toContain(secret);
      expect(setup.renderer.root.findDescendantById(`interaction-1-${kind === 'input' ? 'input' : 'textarea'}`)).toBeUndefined();
      await facade.destroy();
      setup.renderer.destroy();
    }
  });

  it('owns composer and modal input with focus restoration and stale-generation rejection', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    let rendererEvents: OpenTuiRendererEvents | undefined;
    let facade: ReturnType<typeof createOpenTuiRendererFacade> | undefined;
    const terminal = createOpenTuiTerminal({
      inputOwnership: 'renderer',
      async createRenderer(events) {
        rendererEvents = events;
        facade = createOpenTuiRendererFacade(setup.renderer, { events });
        return facade;
      },
    });
    const inputEvents: OpenTuiInputEvent[] = [];
    terminal.subscribeInput?.((event) => { inputEvents.push(event); });
    await terminal.start();
    await setup.flush();

    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer') as InputRenderable;
    expect(composer).toBeInstanceOf(TextareaRenderable);
    expect(composer.focused).toBe(true);
    setup.mockInput.typeText('hello');
    setup.mockInput.pressKey(KeyCodes.RETURN, { meta: true });
    await setup.flush();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(inputEvents).toContainEqual({ type: 'line', line: 'hello' });
    expect(composer.plainText).toBe('');

    const first = terminal.interact?.({ type: 'input', message: 'First' }, new AbortController().signal);
    await setup.flush();
    const staleInput = setup.renderer.root.findDescendantById('interaction-1-input') as InputRenderable;
    expect(staleInput.focused).toBe(true);
    const second = terminal.interact?.({ type: 'input', message: 'Second' }, new AbortController().signal);
    await expect(first).resolves.toEqual({ status: 'cancelled' });
    await setup.flush();
    staleInput.emit(InputRenderableEvents.ENTER, 'stale');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(terminal.snapshot().interaction?.status).toBe('pending');
    const currentInput = setup.renderer.root.findDescendantById('interaction-2-input') as InputRenderable;
    currentInput.value = 'current';
    setup.mockInput.pressKey(KeyCodes.RETURN);
    await expect(second).resolves.toEqual({ status: 'accepted', value: 'current' });
    await setup.flush();
    expect(composer.focused).toBe(true);

    const selectResult = terminal.interact?.({ type: 'select', message: 'Choose', options: ['Alpha', 'Beta'] }, new AbortController().signal);
    await setup.flush();
    const select = setup.renderer.root.findDescendantById('interaction-3-select') as SelectRenderable;
    expect(select).toBeInstanceOf(SelectRenderable);
    expect(select.focused).toBe(true);
    setup.mockInput.typeText('b');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    setup.mockInput.pressKey(KeyCodes.RETURN);
    await expect(selectResult).resolves.toEqual({ status: 'accepted', value: 'Beta' });

    const editorResult = terminal.interact?.({ type: 'editor', message: 'Edit response', initial: 'seed' }, new AbortController().signal);
    await setup.flush();
    const editor = setup.renderer.root.findDescendantById('interaction-4-textarea') as TextareaRenderable;
    expect(editor).toBeInstanceOf(TextareaRenderable);
    expect(editor.focused).toBe(true);
    setup.mockInput.pressKey(KeyCodes.END);
    setup.mockInput.typeText(' value');
    setup.resize(52, 20);
    facade?.render(terminal.snapshot());
    await setup.flush();
    expect(setup.renderer.root.findDescendantById('interaction-4-textarea')).toBe(editor);
    expect(editor.plainText).toBe('seed value');
    setup.mockInput.pressKey(KeyCodes.RETURN, { meta: true });
    await expect(editorResult).resolves.toEqual({ status: 'accepted', value: 'seed value' });

    const confirmResult = terminal.interact?.({ type: 'confirm', message: 'Proceed?' }, new AbortController().signal);
    await setup.flush();
    const confirm = setup.renderer.root.findDescendantById('interaction-5-confirm') as SelectRenderable;
    expect(confirm).toBeInstanceOf(SelectRenderable);
    expect(confirm.focused).toBe(true);
    setup.mockInput.pressKey(KeyCodes.RETURN);
    await expect(confirmResult).resolves.toEqual({ status: 'accepted', value: false });
    await setup.flush();
    expect(composer.focused).toBe(true);

    const confirmArrowResult = terminal.interact?.({ type: 'confirm', message: 'Proceed by arrow?' }, new AbortController().signal);
    await setup.flush();
    setup.mockInput.pressKey(KeyCodes.ARROW_RIGHT);
    setup.mockInput.pressKey(KeyCodes.RETURN);
    await expect(confirmArrowResult).resolves.toEqual({ status: 'accepted', value: true });

    const confirmKeyResult = terminal.interact?.({ type: 'confirm', message: 'Proceed by key?' }, new AbortController().signal);
    await setup.flush();
    setup.mockInput.typeText('y');
    await expect(confirmKeyResult).resolves.toEqual({ status: 'accepted', value: true });
    await setup.flush();
    expect(composer.focused).toBe(true);

    rendererEvents?.interrupt();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(inputEvents.at(-1)).toEqual({ type: 'interrupt' });
    await terminal.stop();
    setup.renderer.destroy();
  });

  it('keeps required, pattern, and oversize failures modal and renders their status', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const resolutions: unknown[] = [];
    const facade = createOpenTuiRendererFacade(setup.renderer, {
      events: {
        submitLine: () => undefined,
        interrupt: () => undefined,
        resolveInteraction: (generation, result) => resolutions.push({ generation, result }),
      },
      interactionWidgetFactory: (interaction) => new PromptInputWidget({
        id: `interaction-${interaction.generation}`,
        question: 'Lowercase name',
        required: true,
        maxLength: 5,
        pattern: /^[a-z]+$/u,
        patternDescription: 'Use lowercase letters only.',
      }),
    });
    const state = reducePresentation(createInitialPresentationState(), {
      type: 'interaction-requested', request: { type: 'input', message: 'Lowercase name' },
    });
    facade.render(state);
    await setup.flush();
    const input = setup.renderer.root.findDescendantById('interaction-1-input') as InputRenderable;

    input.emit(InputRenderableEvents.ENTER, '');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('A value is required.');
    expect(resolutions).toEqual([]);

    input.emit(InputRenderableEvents.ENTER, 'ABC');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('Use lowercase letters only.');
    expect(resolutions).toEqual([]);

    input.emit(InputRenderableEvents.ENTER, 'abcdef');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('Enter no more than 5 characters.');
    expect(resolutions).toEqual([]);

    input.emit(InputRenderableEvents.ENTER, 'ada');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(resolutions).toEqual([{ generation: 1, result: { status: 'accepted', value: 'ada' } }]);
    await facade.destroy();
    setup.renderer.destroy();
  });

  it('materializes every select option, rejects disabled option 10, and selects option 12 by stable ID', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const resolutions: unknown[] = [];
    const labels = Array.from({ length: 12 }, (_, index) => `Option ${index + 1}`);
    const facade = createOpenTuiRendererFacade(setup.renderer, {
      events: {
        submitLine: () => undefined,
        interrupt: () => undefined,
        resolveInteraction: (generation, result) => resolutions.push({ generation, result }),
      },
      interactionWidgetFactory: (interaction) => new SelectWidget({
        id: `interaction-${interaction.generation}`,
        label: 'Choose',
        consequential: true,
        options: labels.map((label, index) => ({
          id: `choice-${index + 1}`,
          label,
          ...(index === 9 ? { disabledReason: 'Unavailable' } : {}),
        })),
      }),
    });
    const state = reducePresentation(createInitialPresentationState(), {
      type: 'interaction-requested', request: { type: 'select', message: 'Choose', options: labels },
    });
    facade.render(state);
    await setup.flush();
    const select = setup.renderer.root.findDescendantById('interaction-1-select') as SelectRenderable;
    expect(select.options).toHaveLength(12);

    select.setSelectedIndex(9);
    select.selectCurrent();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(resolutions).toEqual([]);
    select.setSelectedIndex(11);
    select.selectCurrent();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(resolutions).toEqual([{ generation: 1, result: { status: 'accepted', value: 'Option 12' } }]);
    await facade.destroy();
    setup.renderer.destroy();
  });

  it('offers slash commands and @files without submitting completion text as a prompt', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const submitted: string[] = [];
    const facade = createOpenTuiRendererFacade(setup.renderer, {
      events: {
        submitLine: (line) => submitted.push(line),
        interrupt: () => undefined,
        resolveInteraction: () => undefined,
      },
      fileCatalog: {
        search: async () => [{
          id: 'file-agent', kind: 'file', label: 'src/agent file.ts', insertText: 'src/agent file.ts',
        }],
      },
    });
    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer') as TextareaRenderable;

    setup.mockInput.typeText('/pl');
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('/plan');
    setup.mockInput.pressKey(KeyCodes.TAB);
    await setup.flush();
    expect(composer.plainText).toBe('/plan ');
    expect(submitted).toEqual([]);

    composer.setText('review @src');
    composer.cursorOffset = composer.plainText.length;
    composer.onContentChange?.({});
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('src/agent file.ts');
    setup.mockInput.pressKey(KeyCodes.RETURN);
    await setup.flush();
    expect(composer.plainText).toBe('review @"src/agent file.ts"');
    expect(submitted).toEqual([]);

    composer.setText('é @sr');
    composer.cursorOffset = 5;
    composer.onContentChange?.({});
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await setup.flush();
    setup.mockInput.pressKey(KeyCodes.RETURN);
    await setup.flush();
    expect(composer.plainText).toBe('é @"src/agent file.ts"');
    expect(submitted).toEqual([]);

    await facade.destroy();
    setup.renderer.destroy();
  });

  it('keeps the selected completion visible on a narrow terminal', async () => {
    const setup = await createTestRenderer({ width: 40, height: 18 });
    const facade = createOpenTuiRendererFacade(setup.renderer);
    const composer = setup.renderer.root.findDescendantById('octocode-agent-composer') as TextareaRenderable;
    await setup.mockInput.typeText('/pl');
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('/plan');
    setup.mockInput.pressKey(KeyCodes.TAB);
    await setup.flush();
    expect(composer.plainText).toBe('/plan ');
    await facade.destroy();
    setup.renderer.destroy();
  });
});
