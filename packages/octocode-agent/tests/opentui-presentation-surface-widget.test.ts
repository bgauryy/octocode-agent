import { describe, expect, it } from 'vitest';
import { OpenTuiWidget } from '../src/terminal/opentui/widgets/base.js';
import {
  PresentationSurfaceWidget,
  type PresentationSurfaceSnapshot,
} from '../src/terminal/opentui/widgets/presentation-surface.js';

function snapshot(
  payload: PresentationSurfaceSnapshot['payload'],
  revision = 1,
): PresentationSurfaceSnapshot {
  return { authority: 'runtime', id: 'surface-1', revision, payload };
}

function activeWidget(
  value: PresentationSurfaceSnapshot,
  options: { widthColumns?: number; viewportRows?: number } = {},
): PresentationSurfaceWidget {
  const widget = new PresentationSurfaceWidget('presentation-surface', value, options);
  widget.mount();
  widget.activate();
  widget.focus();
  return widget;
}

describe('PresentationSurfaceWidget', () => {
  it.each([
    {
      name: 'text',
      payload: { kind: 'text' as const, text: 'First line\nSecond line' },
      expected: ['TEXT', 'First line', 'Second line'],
    },
    {
      name: 'list',
      payload: { kind: 'list' as const, title: 'Checks', items: ['Build', 'Test'] },
      expected: ['LIST', 'Checks', '1. Build', '2. Test'],
    },
    {
      name: 'key-value',
      payload: {
        kind: 'key-value' as const,
        title: 'Environment',
        rows: [{ label: 'Mode', value: 'local' }, { label: 'State', value: 'ready' }],
      },
      expected: ['KEY VALUE', 'Environment', 'Mode: local', 'State: ready'],
    },
    {
      name: 'progress with a known total',
      payload: { kind: 'progress' as const, label: 'Indexed files', current: 4, total: 10 },
      expected: ['PROGRESS', 'Indexed files: 4 of 10', '40%'],
    },
  ])('renders $name through the class contract and complete alternate output', ({ payload, expected }) => {
    const widget = activeWidget(snapshot(payload), { widthColumns: 72, viewportRows: 6 });
    const observed: unknown[] = [];
    const state = widget.render({
      render: (value) => observed.push(value),
      destroy: () => undefined,
    });

    expect(widget).toBeInstanceOf(OpenTuiWidget);
    expect(observed).toEqual([state]);
    expect(state.accessibility).toMatchObject({ role: 'region', label: 'Runtime presentation' });
    expect(state.capabilities).toEqual({ focusable: true, inputMode: 'keys' });
    for (const text of expected) expect(widget.alternateOutput()).toContain(text);
    expect(state.regions.map(({ id }) => id)).toEqual(['summary', 'content', 'viewport', 'help']);
  });

  it('makes unknown progress explicit and never infers a completion claim', () => {
    const widget = activeWidget(snapshot({ kind: 'progress', label: 'Discovered files', current: 12 }));
    const output = widget.alternateOutput();

    expect(output).toContain('Discovered files: 12; total UNKNOWN');
    expect(output).not.toMatch(/complete|finished|success/i);
    expect(widget.instructions.stateAndOutput.join(' ')).toMatch(/never infer.*complet/i);
    expect(widget.instructions.avoidWhen.join(' ')).toMatch(/transcript/i);
    expect(widget.instructions.avoidWhen.join(' ')).toMatch(/tool/i);
    expect(widget.instructions.avoidWhen.join(' ')).toMatch(/plan/i);
    expect(widget.instructions.avoidWhen.join(' ')).toMatch(/approval/i);
  });

  it('rejects untruthful, ambiguous, or non-runtime progress snapshots', () => {
    const bad = (payload: unknown): PresentationSurfaceSnapshot => snapshot(payload as PresentationSurfaceSnapshot['payload']);

    expect(() => new PresentationSurfaceWidget('surface-a', bad({ kind: 'progress', label: 'Bad', current: Number.NaN }))).toThrow(/current/i);
    expect(() => new PresentationSurfaceWidget('surface-b', bad({ kind: 'progress', label: 'Bad', current: 1.5 }))).toThrow(/integer/i);
    expect(() => new PresentationSurfaceWidget('surface-c', bad({ kind: 'progress', label: 'Bad', current: 2, total: 0 }))).toThrow(/total/i);
    expect(() => new PresentationSurfaceWidget('surface-d', bad({ kind: 'progress', label: 'Bad', current: 3, total: 2 }))).toThrow(/exceed/i);
    expect(() => new PresentationSurfaceWidget('surface-e', {
      ...snapshot({ kind: 'text', text: 'Safe' }),
      authority: 'agent',
    } as unknown as PresentationSurfaceSnapshot)).toThrow(/runtime authority/i);
    expect(() => new PresentationSurfaceWidget('surface-f', bad({ kind: 'text', text: 'Safe', items: ['ambiguous'] }))).toThrow(/one payload|unexpected/i);
  });

  it('sanitizes and bounds all text while enforcing item and row limits', () => {
    const widget = activeWidget(snapshot({
      kind: 'key-value',
      title: '\u001b]8;;https://evil.invalid\u0007Details\u001b]8;;\u0007',
      rows: [{ label: 'Token\u202E', value: 'Bearer abcdefghijklmnop' }],
    }));
    const output = widget.alternateOutput();

    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u202E');
    expect(output).not.toContain('https://evil.invalid');
    expect(output).not.toContain('abcdefghijklmnop');
    expect(output).toContain('[REDACTED]');

    expect(() => new PresentationSurfaceWidget('too-many-items', snapshot({
      kind: 'list',
      items: Array.from({ length: 101 }, (_, index) => `item-${index}`),
    }))).toThrow(/item bound/i);
    expect(() => new PresentationSurfaceWidget('too-many-rows', snapshot({
      kind: 'key-value',
      rows: Array.from({ length: 101 }, (_, index) => ({ label: `key-${index}`, value: 'value' })),
    }))).toThrow(/row bound/i);
  });

  it('scrolls long content with keys, preserves bounds on resize, and exposes all rows alternatively', () => {
    const items = Array.from({ length: 12 }, (_, index) => `Item ${index + 1}`);
    const widget = activeWidget(snapshot({ kind: 'list', title: 'Long list', items }), {
      widthColumns: 40,
      viewportRows: 3,
    });

    expect(widget.scrollOffset).toBe(0);
    expect(widget.render().regions.find(({ id }) => id === 'content')?.text).toContain('1. Item 1');
    expect(widget.handleInput({ type: 'key', key: 'End' })).toEqual({ status: 'handled' });
    expect(widget.scrollOffset).toBe(9);
    expect(widget.render().regions.find(({ id }) => id === 'content')?.text).toContain('12. Item 12');
    widget.resize(24, 5);
    expect(widget.scrollOffset).toBe(7);
    expect(widget.alternateOutput()).toContain('1. Item 1');
    expect(widget.alternateOutput()).toContain('12. Item 12');
    expect(widget.handleInput({ type: 'key', key: 'Home' })).toEqual({ status: 'handled' });
    expect(widget.scrollOffset).toBe(0);
  });

  it('accepts only monotonic same-identity runtime updates and never exposes mutation actions', () => {
    const widget = activeWidget(snapshot({ kind: 'text', text: 'One' }, 3));

    expect(() => widget.update({ ...snapshot({ kind: 'text', text: 'Old' }, 2) })).toThrow(/stale/i);
    expect(() => widget.update({ ...snapshot({ kind: 'text', text: 'Other' }, 4), id: 'other' })).toThrow(/identity/i);
    expect(() => widget.update(snapshot({ kind: 'text', text: 'Conflict' }, 3))).toThrow(/revision/i);
    expect(widget.handleInput({ type: 'submit' })).toEqual({ status: 'ignored' });
    expect(widget.handleInput({ type: 'select', index: 0 })).toEqual({ status: 'ignored' });
    expect(widget.handleInput({ type: 'text', text: 'mutate' })).toEqual({ status: 'ignored' });

    widget.update(snapshot({ kind: 'progress', label: 'Work', current: 2, total: 5 }, 4));
    expect(widget.alternateOutput()).toContain('Work: 2 of 5 (40%)');
  });
});
