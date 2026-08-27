import { describe, expect, it, vi } from 'vitest';

import {
  createInitialPresentationState,
  createOpenTuiTerminal,
  createOpenTuiUiPort,
  reducePresentation,
} from '../src/terminal/opentui/index.js';

describe('OpenTUI presentation projection', () => {
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
      working: 'active',
      transcript: 'hello',
      statuses: {},
      notifications: [{ severity: 'warning', message: 'careful' }],
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

    await terminal.start();
    expect(() => terminal.accept({ type: 'runtime-ready' })).toThrow('frame failed');
    await expect(terminal.stop()).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();
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
    await ui.present({ type: 'title', value: 'Octocode' });
    await ui.present({ type: 'working', value: 'cancelling' });

    expect(terminal.snapshot()).toMatchObject({
      title: 'Octocode',
      working: 'cancelling',
      statuses: { model: 'ready' },
    });
    expect(frames).toHaveLength(4);
    await expect(ui.interact({ type: 'confirm', message: 'continue?' }, new AbortController().signal))
      .resolves.toEqual({ status: 'unsupported' });
  });
});
