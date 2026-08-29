import { describe, expect, it, vi } from 'vitest';

import {
  createInitialPresentationState,
  createOpenTuiUiPort,
  createPresentationStore,
  formatPresentationFrame,
  formatPresentationSections,
  MAX_PRESENTATION_MESSAGES,
  MAX_PRESENTATION_TOOLS,
  reducePresentation,
  type OpenTuiRendererEvents,
} from '../src/terminal/opentui/presentation.js';
import { createOpenTuiTerminal } from '../src/terminal/opentui/create-terminal.js';

describe('OpenTUI presentation projection', () => {
  it('merges independently produced authoritative runtime widget snapshots', () => {
    const header = { authority: 'runtime' as const, title: 'Octocode', trust: 'trusted' as const, working: 'idle' as const, width: 80 };
    const footer = { authority: 'runtime' as const, activeMode: 'interactive', connection: 'connected' as const, widthColumns: 80, keyHints: [] };
    const plan = {
      authority: 'runtime' as const,
      planId: 'plan:stable',
      scope: { sessionId: 'session-1', workspace: '/workspace' },
      revision: 1,
      phase: 'active' as const,
      steps: [{ id: 'step-1', text: 'Build', status: 'doing' as const }],
    };
    const notifications = [{ authority: 'runtime' as const, slot: 'system' as const, id: 'sync', message: 'Synced', lifecycle: 'success' as const }];

    let state = reducePresentation(createInitialPresentationState(), { type: 'runtime-widgets-changed', snapshots: { header, footer } });
    state = reducePresentation(state, { type: 'runtime-widgets-changed', snapshots: { plan } });
    state = reducePresentation(state, { type: 'runtime-widgets-changed', snapshots: { statusNotifications: notifications } });

    expect(state.runtimeWidgets).toEqual({ header, footer, plan, statusNotifications: notifications });
  });

  it('reduces semantic events without toolkit values entering state', () => {
    const initial = createInitialPresentationState();
    const ready = reducePresentation(initial, { type: 'runtime-ready' });
    const streaming = reducePresentation(ready, {
      type: 'message-delta',
      text: 'hello',
    });
    const notified = reducePresentation(streaming, {
      type: 'notification',
      severity: 'warning',
      message: 'careful',
    });

    expect(notified).toEqual({
      ready: true,
      working: 'idle',
      activeTurnId: undefined,
      turns: [],
      messages: [{
        id: 'assistant:unscoped',
        role: 'assistant',
        status: 'streaming',
        segments: [{ kind: 'text', text: 'hello' }],
      }],
      tools: [],
      statuses: {},
      notifications: [{ severity: 'warning', message: 'careful' }],
      widgets: {},
      interactionHandler: 'required',
    });
    expect(JSON.stringify(notified)).not.toMatch(/renderer|renderable|opentui/i);
  });

  it('destroys the renderer exactly once after normal stop', async () => {
    const destroy = vi.fn(async () => undefined);
    const render = vi.fn();
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({ destroy, render }),
    });

    await terminal.start();
    terminal.accept({ type: 'runtime-ready' });
    await terminal.stop();
    await terminal.stop();

    expect(render).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('cleans up after a render failure and reports the failure', async () => {
    const destroy = vi.fn(async () => undefined);
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({
        destroy,
        render: () => {
          throw new Error('frame failed');
        },
      }),
    });
    const failure = new Promise<unknown>((resolve) => terminal.subscribeFailure?.(resolve));

    await terminal.start();
    terminal.accept({ type: 'runtime-ready' });
    await expect(failure).resolves.toEqual(expect.objectContaining({ message: 'frame failed' }));
    await expect(terminal.stop()).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('coalesces presentation-only bursts into one renderer frame', async () => {
    const render = vi.fn();
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({ destroy: () => undefined, render }),
    });
    await terminal.start();

    for (let index = 0; index < 100; index += 1) {
      terminal.accept({ type: 'message-delta', messageId: 'stream', text: String(index) });
    }
    expect(render).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(render).toHaveBeenCalledOnce();
    expect(terminal.snapshot().messages[0]?.segments[0]?.text).toContain('99');
    await terminal.stop();
  });

  it('reports rejected renderer-input callbacks instead of swallowing them', async () => {
    let nativeEvents: OpenTuiRendererEvents | undefined;
    const terminal = createOpenTuiTerminal({
      inputOwnership: 'renderer',
      createRenderer: async (events) => {
        nativeEvents = events;
        return { destroy: () => undefined, render: () => undefined };
      },
    });
    const failure = new Promise<unknown>((resolve) => terminal.subscribeFailure?.(resolve));
    terminal.subscribeInput?.(async () => { throw new Error('input callback failed'); });
    await terminal.start();

    nativeEvents!.submitLine('hello');

    await expect(failure).resolves.toEqual(expect.objectContaining({ message: 'input callback failed' }));
    await terminal.stop();
  });

  it('propagates renderer callback failures through the terminal error boundary', async () => {
    let nativeEvents: OpenTuiRendererEvents | undefined;
    const terminal = createOpenTuiTerminal({
      createRenderer: async (events) => {
        nativeEvents = events;
        return { destroy: () => undefined, render: () => undefined };
      },
    });
    const failure = new Promise<unknown>((resolve) => terminal.subscribeFailure?.(resolve));
    await terminal.start();

    nativeEvents!.failure(new Error('status callback failed'));

    await expect(failure).resolves.toEqual(expect.objectContaining({ message: 'status callback failed' }));
    await terminal.stop();
  });

  it('preserves fatal runtime state after the failed turn ends', () => {
    let state = reducePresentation(createInitialPresentationState(), { type: 'turn-started', turnId: 'turn-1' });
    state = reducePresentation(state, { type: 'runtime-failed' });
    state = reducePresentation(state, { type: 'turn-ended', turnId: 'turn-1', outcome: 'error' });

    expect(state.working).toBe('failed');
    expect(state.activeTurnId).toBeUndefined();
  });

  it('maps the canonical UiPort into semantic terminal events', async () => {
    const frames: unknown[] = [];
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({
        destroy: () => undefined,
        render: (state) => frames.push(state),
      }),
    });
    await terminal.start();
    const ui = createOpenTuiUiPort(terminal);

    await ui.notify('hello', 'info');
    await ui.setStatus('model', 'ready');
    await ui.present({ type: 'working', value: 'cancelling' });

    expect(terminal.snapshot()).toMatchObject({
      working: 'cancelling',
      statuses: { model: 'ready' },
      interactionHandler: 'ready',
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(4);
    const interaction = ui.interact({ type: 'confirm', message: 'continue?' }, new AbortController().signal);
    expect(terminal.acceptInput!('yes')).toBe(true);
    await expect(interaction).resolves.toEqual({ status: 'accepted', value: true });
  });

  it('owns presentation data in a Zustand store and publishes immutable widget snapshots', () => {
    const store = createPresentationStore();
    const observed: unknown[] = [];
    store.subscribe((state) => observed.push(state.presentation));
    const items = ['audit', 'implement'];

    store.getState().accept({
      type: 'presentation-changed',
      property: 'widget',
      value: { id: 'plan', kind: 'list', title: 'Plan', items },
    });
    items.push('mutated after dispatch');

    expect(store.getState().presentation.widgets).toEqual({
      plan: { id: 'plan', kind: 'list', title: 'Plan', items: ['audit', 'implement'] },
    });
    expect(observed).toHaveLength(1);

    store.getState().accept({
      type: 'presentation-changed',
      property: 'widget',
      value: { id: 'plan', remove: true },
    });
    expect(store.getState().presentation.widgets).toEqual({});
  });

  it('renders typed widgets without stringifying arbitrary objects', () => {
    let state = createInitialPresentationState();
    state = reducePresentation(state, {
      type: 'presentation-changed',
      property: 'widget',
      value: { id: 'usage', kind: 'key-value', title: 'Usage', rows: [{ label: 'tokens', value: '42' }] },
    });
    state = reducePresentation(state, {
      type: 'presentation-changed',
      property: 'widget',
      value: { id: 'unsafe', kind: 'text', text: { secret: true } },
    });

    expect(formatPresentationFrame(state)).toContain('Usage\ntokens: 42');
    expect(formatPresentationFrame(state)).not.toContain('[object Object]');
    expect(state.widgets).not.toHaveProperty('unsafe');
  });

  it('assembles bounded typed message records across explicit turn boundaries', () => {
    let state = createInitialPresentationState();
    state = reducePresentation(state, { type: 'input-received', messageId: 'user-1', text: 'show status' });
    state = reducePresentation(state, { type: 'turn-started', turnId: 'turn-1' });
    state = reducePresentation(state, {
      type: 'message-started',
      messageId: 'assistant-1',
      role: 'assistant',
      turnId: 'turn-1',
    });
    state = reducePresentation(state, {
      type: 'message-delta',
      messageId: 'assistant-1',
      turnId: 'turn-1',
      segment: 'thinking',
      text: 'checking',
    });
    state = reducePresentation(state, {
      type: 'message-delta',
      messageId: 'assistant-1',
      turnId: 'turn-1',
      text: 'all green',
    });
    state = reducePresentation(state, { type: 'message-ended', messageId: 'assistant-1' });
    state = reducePresentation(state, { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed' });

    expect(state.working).toBe('idle');
    expect(state.activeTurnId).toBeUndefined();
    expect(state.turns).toEqual([{ id: 'turn-1', status: 'completed' }]);
    expect(state.messages).toEqual([
      {
        id: 'user-1',
        role: 'user',
        turnId: 'turn-1',
        status: 'complete',
        segments: [{ kind: 'text', text: 'show status' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        turnId: 'turn-1',
        status: 'complete',
        segments: [
          { kind: 'thinking', text: 'checking' },
          { kind: 'text', text: 'all green' },
        ],
      },
    ]);
    expect(formatPresentationFrame(state)).toContain('You\nshow status');
    expect(formatPresentationFrame(state)).toContain('Assistant\n[thinking] checking\nall green');

    for (let index = 0; index < MAX_PRESENTATION_MESSAGES + 5; index += 1) {
      state = reducePresentation(state, {
        type: 'user-message',
        messageId: `bounded-${index}`,
        text: `message-${index}`,
      });
    }
    expect(state.messages).toHaveLength(MAX_PRESENTATION_MESSAGES);
    expect(state.messages[0]?.id).toBe('bounded-5');
  });

  it('projects the complete typed tool lifecycle and bounds retained rows', () => {
    let state = createInitialPresentationState();
    state = reducePresentation(state, { type: 'tool-prepared', callId: 'call-1', name: 'search', input: 'query: status' });
    expect(state.tools[0]).toMatchObject({ status: 'pending', input: 'query: status' });
    state = reducePresentation(state, { type: 'tool-started', callId: 'call-1', name: 'search' });
    state = reducePresentation(state, { type: 'tool-progress', callId: 'call-1', message: '2 files', current: 2, total: 4 });
    expect(state.tools[0]).toMatchObject({ status: 'running', progress: { message: '2 files', current: 2, total: 4 } });
    state = reducePresentation(state, { type: 'tool-result', callId: 'call-1', name: 'search', result: 'done' });
    expect(state.tools[0]).toMatchObject({ status: 'success', result: 'done' });

    state = reducePresentation(state, { type: 'tool-prepared', callId: 'call-2', name: 'write' });
    state = reducePresentation(state, { type: 'tool-blocked', callId: 'call-2', name: 'write', message: 'approval required' });
    state = reducePresentation(state, { type: 'tool-ended', callId: 'call-2', name: 'write', error: 'approval required' });
    state = reducePresentation(state, { type: 'tool-prepared', callId: 'call-3', name: 'exec' });
    state = reducePresentation(state, { type: 'tool-failed', callId: 'call-3', name: 'exec', message: 'exit 1', category: 'tool-execution' });
    state = reducePresentation(state, { type: 'tool-prepared', callId: 'call-4', name: 'fetch' });
    state = reducePresentation(state, { type: 'tool-cancelled', callId: 'call-4', name: 'fetch', message: 'turn cancelled' });
    expect(state.tools.map(({ status }) => status)).toEqual(['success', 'blocked', 'error', 'cancelled']);

    for (let index = 0; index < MAX_PRESENTATION_TOOLS + 5; index += 1) {
      state = reducePresentation(state, { type: 'tool-prepared', callId: `bounded-${index}`, name: 'noop' });
    }
    expect(state.tools).toHaveLength(MAX_PRESENTATION_TOOLS);
    expect(state.tools[0]?.callId).toBe('bounded-5');
  });

  it('formats bounded structured renderer sections and exposes interaction readiness', async () => {
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({ destroy: () => undefined, render: () => undefined }),
    });
    await terminal.start();
    const handler = vi.fn(async () => ({ status: 'accepted' as const, value: true }));
    const ui = createOpenTuiUiPort(terminal, handler);
    terminal.accept({ type: 'user-message', text: 'hello' });
    terminal.accept({ type: 'tool-prepared', callId: 'call-1', name: 'search' });

    const sections = formatPresentationSections(terminal.snapshot());
    expect(sections).toEqual(expect.objectContaining({
      header: expect.stringContaining('ready'),
      messages: expect.stringContaining('You\nhello'),
      tools: expect.stringContaining('search · pending'),
    }));
    expect(Object.values(sections).every((section) => section.length <= 32_000)).toBe(true);
    expect(terminal.snapshot().interactionHandler).toBe('ready');
    await expect(ui.interact({ type: 'confirm', message: 'continue?' }, new AbortController().signal))
      .resolves.toEqual({ status: 'accepted', value: true });
    await terminal.stop();
  });

  it('renders and answers select, text, confirm, validation, cancellation, and timeout through line input', async () => {
    const terminal = createOpenTuiTerminal({
      createRenderer: async () => ({ destroy: () => undefined, render: () => undefined }),
    });
    await terminal.start();

    const selected = terminal.interact!({ type: 'select', message: 'Pick one', options: ['alpha', 'beta'] }, new AbortController().signal);
    expect(formatPresentationSections(terminal.snapshot()).sidebar).toContain('Pick one\n1. alpha\n2. beta');
    expect(terminal.acceptInput!('3')).toBe(true);
    expect(terminal.snapshot().interaction).toMatchObject({ status: 'validation', validation: 'Choose 1-2 or enter an exact option.' });
    expect(terminal.acceptInput!('2')).toBe(true);
    await expect(selected).resolves.toEqual({ status: 'accepted', value: 'beta' });

    const text = terminal.interact!({ type: 'input', message: 'Name?' }, new AbortController().signal);
    expect(terminal.acceptInput!('octocode')).toBe(true);
    await expect(text).resolves.toEqual({ status: 'accepted', value: 'octocode' });

    const confirmed = terminal.interact!({ type: 'confirm', message: 'Continue?' }, new AbortController().signal);
    expect(terminal.acceptInput!('yes')).toBe(true);
    await expect(confirmed).resolves.toEqual({ status: 'accepted', value: true });

    const cancelled = terminal.interact!({ type: 'input', message: 'Cancel me' }, new AbortController().signal);
    expect(terminal.acceptInput!('/cancel')).toBe(true);
    await expect(cancelled).resolves.toEqual({ status: 'cancelled' });
    expect(terminal.snapshot().interaction).toMatchObject({ status: 'cancelled' });

    const timeoutController = new AbortController();
    const timedOut = terminal.interact!({ type: 'confirm', message: 'Too late' }, timeoutController.signal);
    timeoutController.abort('interaction timeout');
    await expect(timedOut).resolves.toEqual({ status: 'timeout' });
    expect(terminal.snapshot().interaction).toMatchObject({ status: 'timeout' });
    expect(terminal.acceptInput!('orphan')).toBe(false);
    await terminal.stop();
  });

  it('queues renderer input and cancels a modal before publishing Ctrl-C', async () => {
    let nativeEvents: OpenTuiRendererEvents | undefined;
    const terminal = createOpenTuiTerminal({
      inputOwnership: 'renderer',
      createRenderer: async (events) => {
        nativeEvents = events;
        return { destroy: () => undefined, render: () => undefined };
      },
    });
    const received: unknown[] = [];
    terminal.subscribeInput?.((event) => { received.push(event); });
    await terminal.start();

    nativeEvents!.submitLine('queued');
    expect(received).toEqual([]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(received).toEqual([{ type: 'line', line: 'queued' }]);

    const interaction = terminal.interact!({ type: 'confirm', message: 'Proceed?' }, new AbortController().signal);
    nativeEvents!.interrupt();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await expect(interaction).resolves.toEqual({ status: 'cancelled' });
    expect(received).toEqual([{ type: 'line', line: 'queued' }]);

    nativeEvents!.interrupt();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(received.at(-1)).toEqual({ type: 'interrupt' });
    await terminal.stop();
  });
});
