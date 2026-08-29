import { describe, expect, it } from 'vitest';

import { WidgetHost } from '../src/terminal/opentui/widget-host.js';
import type { WidgetRenderState } from '../src/terminal/opentui/widgets/contracts.js';
import { TranscriptWidget } from '../src/terminal/opentui/widgets/transcript.js';

class HostAdapter {
  readonly rendered: WidgetRenderState[] = [];
  readonly destroyed: string[] = [];
  focusedId?: string;

  render(state: WidgetRenderState): void {
    this.rendered.push(state);
  }

  destroy(widgetId: string): void {
    this.destroyed.push(widgetId);
  }

  focusWidget(widgetId: string | undefined): void {
    this.focusedId = widgetId;
  }
}

describe('WidgetHost', () => {
  it('owns activation, focus, and destruction for navigable widgets', () => {
    const adapter = new HostAdapter();
    const host = new WidgetHost(
      adapter,
      (widget): widget is TranscriptWidget => widget instanceof TranscriptWidget,
    );
    const widget = new TranscriptWidget('transcript');

    host.register(widget);
    expect(widget.lifecycle).toBe('active');
    expect(host.focus('transcript')).toBe(true);
    expect(host.focused()).toBe(widget);
    expect(adapter.focusedId).toBe('transcript');

    host.remove(widget);
    expect(widget.lifecycle).toBe('destroyed');
    expect(host.focused()).toBeUndefined();
    expect(adapter.focusedId).toBeUndefined();
    expect(adapter.destroyed).toEqual(['transcript']);
  });

  it('rejects ambiguous duplicate identities', () => {
    const adapter = new HostAdapter();
    const host = new WidgetHost(
      adapter,
      (widget): widget is TranscriptWidget => widget instanceof TranscriptWidget,
    );
    host.register(new TranscriptWidget('transcript'));

    expect(() => host.register(new TranscriptWidget('transcript')))
      .toThrow('widget id transcript is already registered');
  });
});
