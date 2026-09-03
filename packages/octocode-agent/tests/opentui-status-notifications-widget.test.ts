import { describe, expect, it } from 'vitest';

import {
  StatusNotificationsWidget,
  type StatusNotificationInput,
} from '../src/terminal/opentui/widgets/status-notifications.js';

function notice(overrides: Partial<StatusNotificationInput> = {}): StatusNotificationInput {
  return {
    authority: 'runtime',
    slot: 'agent',
    id: 'research',
    message: 'Researching widget behavior',
    lifecycle: 'active',
    ...overrides,
  };
}

describe('StatusNotificationsWidget', () => {
  it('renders stable named items with explicit, color-independent severity', () => {
    const widget = new StatusNotificationsWidget('status-center');
    widget.upsert(notice(), 1_000);
    widget.upsert(notice({ slot: 'permission', id: 'write', message: 'Write approval needed', lifecycle: 'warning' }), 2_000);
    widget.mount();
    widget.activate();

    const state = widget.render();
    expect(state.regions.map((region) => region.id)).toEqual(['summary', 'item-1', 'item-2', 'help']);
    const text = state.regions.map((region) => region.text).join('\n');
    expect(text).toContain('ℹ Info · Researching widget behavior');
    expect(text).toContain('! Warning · Write approval needed');
    expect(text).not.toContain('agent/research');
    expect(text).not.toContain('permission/write');
    expect(text).toContain('Enter action · Esc back');
    expect(text).not.toContain('Ctrl-C cancel/exit');
  });

  it('derives polite or assertive urgency from lifecycle and deduplicates updates', () => {
    const widget = new StatusNotificationsWidget('status-live');
    widget.upsert(notice(), 1_000);
    widget.upsert(notice(), 2_000);
    widget.upsert(notice({ lifecycle: 'success', message: 'Research complete' }), 3_000);
    widget.upsert(notice({ slot: 'system', id: 'network', lifecycle: 'error', message: 'Network unavailable' }), 4_000);

    expect(widget.takeAnnouncements()).toEqual([
      expect.objectContaining({ severity: 'info', role: 'status', liveRegion: 'polite' }),
      expect.objectContaining({ severity: 'success', role: 'status', liveRegion: 'polite' }),
      expect.objectContaining({ severity: 'error', role: 'alert', liveRegion: 'assertive' }),
    ]);
    expect(widget.takeAnnouncements()).toEqual([]);
    expect(widget.history).toHaveLength(3);
  });

  it('replaces and clears deterministically by slot and id lifecycle key', () => {
    const widget = new StatusNotificationsWidget('status-lifecycle');
    widget.upsert(notice(), 1_000);
    widget.upsert(notice({ lifecycle: 'success', message: 'Done' }), 2_000);
    expect(widget.items).toHaveLength(1);
    expect(widget.toPlainText()).toContain('[SUCCESS] agent/research: Done');

    widget.upsert(notice({ lifecycle: 'cleared', message: '' }), 3_000);
    expect(widget.items).toEqual([]);
    expect(widget.render().regions.map((region) => region.id)).toEqual(['summary', 'empty', 'help']);
  });

  it('bounds history, active items, and pending announcements without storms', () => {
    const widget = new StatusNotificationsWidget('status-bounded', { historyLimit: 4, itemLimit: 3, announcementLimit: 2 });
    for (let index = 0; index < 10; index += 1) {
      widget.upsert(notice({ id: `job-${index}`, message: `Job ${index}` }), index);
    }

    expect(widget.items.map((item) => item.id)).toEqual(['job-7', 'job-8', 'job-9']);
    expect(widget.history).toHaveLength(4);
    expect(widget.takeAnnouncements()).toHaveLength(2);
  });

  it('provides keyboard-reachable navigation and returns actions without executing them', () => {
    const widget = new StatusNotificationsWidget('status-navigation');
    widget.upsert(notice({ id: 'first', action: { id: 'inspect', label: 'Inspect' } }), 1_000);
    widget.upsert(notice({ id: 'second', action: { id: 'retry', label: 'Retry' } }), 2_000);
    widget.mount();
    widget.activate();
    widget.focus();

    expect(widget.handleInput({ type: 'key', key: 'ArrowDown' })).toMatchObject({ status: 'handled' });
    expect(widget.render().regions.find((region) => region.id === 'item-2')?.text).toContain('>');
    expect(widget.handleInput({ type: 'submit' })).toEqual({
      status: 'handled',
      output: {
        type: 'action',
        key: 'agent:second',
        action: { id: 'retry', label: 'Retry' },
      },
    });
    expect(widget.handleInput({ type: 'key', key: 'Home' })).toMatchObject({ status: 'handled' });
    expect(widget.handleInput({ type: 'key', key: 'End' })).toMatchObject({ status: 'handled' });
  });

  it.each([
    { type: 'cancel' as const },
    { type: 'key' as const, key: 'Escape' },
    { type: 'key' as const, key: 'escape' },
    { type: 'key' as const, key: 'ESC' },
    { type: 'key' as const, key: 'Ctrl+C' },
    { type: 'key' as const, key: 'ctrl+c' },
    { type: 'key' as const, key: 'ctrl-c' },
    { type: 'key' as const, key: 'c-c' },
    { type: 'key' as const, key: '\u0003' },
  ])('cancels deterministically for semantic, Escape/Esc, and Ctrl-C variant $type $key', (input) => {
    const widget = new StatusNotificationsWidget('status-cancel');
    widget.mount();
    widget.activate();
    widget.focus();

    expect(widget.handleInput(input)).toEqual({
      status: 'handled',
      output: { type: 'cancel' },
    });
  });

  it('sanitizes ANSI, OSC, and controls and emits linear timestamped alternate output once per item', () => {
    const widget = new StatusNotificationsWidget('status-safe');
    widget.upsert(notice({
      message: '\u001b[31mred\u001b[0m \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 ok\u0000bad',
      action: { id: 'open', label: '\u001b[2JOpen\nnow' },
    }), Date.parse('2026-08-27T12:34:56.000Z'));

    const text = widget.toPlainText();
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toBe('2026-08-27T12:34:56.000Z 1 ℹ [INFO] agent/research: red link okbad — action: Open now');
    expect(text.match(/\[INFO\]/gu)).toHaveLength(1);
    expect(text).not.toContain('evil.example');
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
  });

  it('uses static presentation and exposes complete literal agent instructions', () => {
    const widget = new StatusNotificationsWidget('status-instructions');
    widget.upsert(notice({ lifecycle: 'active' }));
    const text = widget.toPlainText();
    expect(text).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
    expect(widget.instructions).toMatchObject({
      inputs: expect.arrayContaining([expect.stringMatching(/runtime.*slot.*id.*message.*lifecycle.*action/i)]),
      stateAndOutput: expect.arrayContaining([expect.stringMatching(/runtime.*severity/i)]),
      accessibility: expect.arrayContaining([
        expect.stringMatching(/assertive/i),
        expect.stringMatching(/reduced motion/i),
      ]),
      recovery: expect.arrayContaining([expect.stringMatching(/storm|duplicate/i)]),
    });
  });

  it('requires canonical runtime authority before lifecycle can control urgency', () => {
    const widget = new StatusNotificationsWidget('status-authority');
    expect(() => widget.upsert(notice({
      authority: 'agent' as StatusNotificationInput['authority'],
      lifecycle: 'error',
    }))).toThrow(/authority.*runtime/i);
    expect(widget.items).toEqual([]);
    expect(widget.takeAnnouncements()).toEqual([]);
  });

  it('rejects invalid or overlong stable IDs instead of truncating them into collisions', () => {
    const widget = new StatusNotificationsWidget('status-stable-ids');
    const sharedPrefix = 'a'.repeat(80);

    expect(() => widget.upsert(notice({ id: `${sharedPrefix}x` }))).toThrow(/at most 80/i);
    expect(() => widget.upsert(notice({ id: `${sharedPrefix}y` }))).toThrow(/at most 80/i);
    expect(() => widget.upsert(notice({ id: 'unsafe id' }))).toThrow(/stable id/i);
    expect(() => widget.upsert(notice({ action: { id: 'unsafe action', label: 'Retry' } })))
      .toThrow(/stable id/i);
    expect(widget.items).toEqual([]);
  });

  it('rejects timestamps outside the JavaScript Date ISO range before alternate output', () => {
    const widget = new StatusNotificationsWidget('status-date-range');
    expect(() => widget.upsert(notice(), Number.POSITIVE_INFINITY)).toThrow(/date iso range/i);
    expect(() => widget.upsert(notice(), 8_640_000_000_000_001)).toThrow(/date iso range/i);
    expect(() => widget.upsert(notice(), -1)).toThrow(/date iso range/i);
    expect(widget.toPlainText()).toBe('');

    widget.upsert(notice(), 8_640_000_000_000_000);
    expect(() => widget.toPlainText()).not.toThrow();
  });

  it('declares listbox semantics while keeping urgency on runtime-owned announcement records', () => {
    const widget = new StatusNotificationsWidget('status-semantics');
    widget.upsert(notice({ lifecycle: 'warning', message: 'Review needed' }));

    expect(widget.accessibility).toMatchObject({ role: 'listbox', liveRegion: 'polite' });
    expect(widget.render().regions.find((region) => region.id === 'item-1')).toMatchObject({ role: 'option' });
    expect(widget.takeAnnouncements()).toEqual([
      expect.objectContaining({ role: 'alert', liveRegion: 'assertive', severity: 'warning' }),
    ]);
  });
});
