import { describe, expect, it } from 'vitest';

import {
  MAX_TRANSCRIPT_SEGMENTS_PER_MESSAGE,
  MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH,
  TranscriptWidget,
  type TranscriptMessage,
} from '../src/terminal/opentui/widgets/transcript.js';

function activeWidget(messages: readonly TranscriptMessage[] = []): TranscriptWidget {
  const widget = new TranscriptWidget('conversation', messages);
  widget.mount();
  widget.activate();
  return widget;
}

describe('TranscriptWidget', () => {
  it('renders a semantic, role-prefixed conversation log with stable alternate output', () => {
    const widget = activeWidget([
      {
        id: 'user-1',
        turnId: 'turn-1',
        role: 'user',
        status: 'complete',
        segments: [{ kind: 'text', text: 'Run the checks' }],
      },
      {
        id: 'assistant-1',
        turnId: 'turn-1',
        role: 'assistant',
        status: 'streaming',
        segments: [
          { kind: 'thinking', text: 'private chain of thought' },
          { kind: 'text', text: 'Running them now.' },
        ],
      },
    ]);

    const state = widget.render();
    expect(state.accessibility).toMatchObject({
      role: 'log',
      label: 'Conversation',
      liveRegion: 'polite',
    });
    expect(state.capabilities).toEqual({ focusable: true, inputMode: 'keys' });
    expect(state.regions.find(({ id }) => id === 'messages')?.text).toBe(
      'user: Run the checks\nassistant: Running them now.',
    );
    expect(state.regions.find(({ id }) => id === 'activity')?.text).toBe(
      'assistant: Thinking…',
    );
    expect(widget.alternateOutput()).toBe(
      '[turn=turn-1 message=user-1 status=complete] user: Run the checks\n'
      + '[turn=turn-1 message=assistant-1 status=streaming] assistant: Running them now. [thinking]',
    );
    expect(widget.alternateOutput()).not.toContain('private chain of thought');
  });

  it('sanitizes controls and secrets and truncates only at grapheme boundaries', () => {
    const family = '👩‍👩‍👧‍👦';
    const widget = activeWidget(Array.from({ length: 7 }, (_, index) => ({
      id: `assistant-${index}`,
      role: 'assistant' as const,
      status: 'complete' as const,
      segments: [{
        kind: 'text' as const,
        text: `${index === 0
          ? 'safe\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 \u202EAPI_KEY=super-secret '
          : ''}${family.repeat(700)}`,
      }],
    })));

    const text = widget.render().regions.find(({ id }) => id === 'messages')?.text ?? '';
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u202E');
    expect(text).not.toContain('super-secret');
    expect(text).toContain('API_KEY=[REDACTED]');
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('\uFFFD');
  });

  it('rejects untrusted enum values and malformed or oversized segment data', () => {
    const valid = {
      id: 'assistant-1',
      role: 'assistant',
      status: 'complete',
      segments: [{ kind: 'text', text: 'done' }],
    };

    expect(() => activeWidget([{ ...valid, role: 'root' }] as unknown as TranscriptMessage[]))
      .toThrow(/role is invalid/i);
    expect(() => activeWidget([{ ...valid, status: 'aborted' }] as unknown as TranscriptMessage[]))
      .toThrow(/status is invalid/i);
    expect(() => activeWidget([{
      ...valid,
      segments: [{ kind: 'reasoning', text: 'hidden' }],
    }] as unknown as TranscriptMessage[])).toThrow(/segment kind is invalid/i);
    expect(() => activeWidget([{
      ...valid,
      segments: Array.from(
        { length: MAX_TRANSCRIPT_SEGMENTS_PER_MESSAGE + 1 },
        () => ({ kind: 'text', text: 'x' }),
      ),
    }] as unknown as TranscriptMessage[])).toThrow(/segments exceed/i);
    expect(() => activeWidget([{
      ...valid,
      segments: [{ kind: 'text', text: 'x'.repeat(MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH + 1) }],
    }] as unknown as TranscriptMessage[])).toThrow(/segment text exceeds/i);
  });

  it('deduplicates polite streaming announcements and immediately queues terminal outcomes', () => {
    const widget = activeWidget();
    const streaming: TranscriptMessage = {
      id: 'assistant-1',
      turnId: 'turn-1',
      role: 'assistant',
      status: 'streaming',
      segments: [{ kind: 'text', text: 'working' }],
    };

    widget.update([streaming]);
    widget.update([{ ...streaming, segments: [{ kind: 'text', text: 'working harder' }] }]);
    expect(widget.drainAnnouncements()).toEqual([{
      id: 'assistant-1:streaming',
      politeness: 'polite',
      text: 'Assistant response is updating.',
    }]);

    widget.update([{ ...streaming, status: 'error' }]);
    expect(widget.drainAnnouncements()).toEqual([{
      id: 'assistant-1:error',
      politeness: 'assertive',
      text: 'Assistant message failed.',
    }]);

    widget.update([{ ...streaming, status: 'cancelled' }]);
    expect(widget.drainAnnouncements()).toEqual([{
      id: 'assistant-1:cancelled',
      politeness: 'assertive',
      text: 'Assistant message was cancelled.',
    }]);

    widget.update([{ ...streaming, status: 'complete' }]);
    expect(widget.drainAnnouncements()).toEqual([{
      id: 'assistant-1:complete',
      politeness: 'polite',
      text: 'Assistant message completed.',
    }]);
  });

  it('owns a concrete render method and forwards its state through the adapter', () => {
    const widget = activeWidget();
    const rendered: unknown[] = [];
    const adapter = {
      render: (state: unknown) => rendered.push(state),
      destroy: () => undefined,
    };

    expect(Object.hasOwn(TranscriptWidget.prototype, 'render')).toBe(true);
    expect(widget.render(adapter)).toBe(rendered[0]);
  });

  it('exposes complete agent instructions and focusable scroll commands', () => {
    const widget = activeWidget();
    widget.focus();

    expect(widget.instructions.purpose).toMatch(/conversation/i);
    expect(widget.instructions.accessibility.join(' ')).toMatch(/alternate output/i);
    expect(widget.handleInput({ type: 'key', key: 'pageup' })).toEqual({
      status: 'handled',
      output: { type: 'scroll', direction: 'page-up' },
    });
    expect(widget.handleInput({ type: 'key', key: 'end' })).toEqual({
      status: 'handled',
      output: { type: 'scroll', direction: 'end' },
    });
    expect(widget.handleInput({ type: 'text', text: 'ignored' })).toEqual({ status: 'ignored' });
  });
});
