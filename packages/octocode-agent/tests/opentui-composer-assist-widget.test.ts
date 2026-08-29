import { describe, expect, it } from 'vitest';

import {
  ComposerAssistWidget,
  type ComposerAssistSnapshot,
  type ComposerAssistWidgetResult,
} from '../src/terminal/opentui/widgets/composer-assist.js';

const READY: ComposerAssistSnapshot = {
  authority: 'runtime',
  revision: 3,
  mode: 'command',
  state: 'ready',
  query: '/p',
  suggestions: [
    { id: 'command.plan', kind: 'command', label: '/plan', description: 'Open plan mode.' },
    { id: 'command.profile', kind: 'command', label: '/profile', detail: 'Switch model profile.' },
    { id: 'command.publish', kind: 'command', label: '/publish', disabledReason: 'No remote is configured.' },
  ],
  selectedId: 'command.plan',
};

function activeWidget(snapshot: ComposerAssistSnapshot = READY): ComposerAssistWidget {
  const widget = new ComposerAssistWidget('composer-assist', snapshot, { viewportRows: 2, widthColumns: 120 });
  widget.mount();
  widget.activate();
  widget.focus();
  return widget;
}

describe('ComposerAssistWidget', () => {
  it('renders literal instructions and runtime-authoritative command suggestions', () => {
    const widget = activeWidget();
    const state = widget.render();

    expect(state.kind).toBe('composer.assist');
    expect(state.accessibility).toMatchObject({ role: 'listbox', label: 'Command suggestions', liveRegion: 'polite' });
    expect(state.regions.map(({ text }) => text)).toEqual([
      'Commands · READY · filter: /p',
      '> [selected] /plan — Open plan mode.',
      '  [available] /profile — Switch model profile.',
      '↑/↓ move · PgUp/PgDn page · Home/End bounds · Enter choose · Esc close · typing filters',
    ]);
    expect(widget.instructions.stateAndOutput.join(' ')).toMatch(/no filesystem|no dispatch/i);
  });

  it('navigates by stable ID, skips disabled suggestions, and emits activation without dispatching', () => {
    const widget = activeWidget();

    widget.handleInput({ type: 'key', key: 'ArrowDown' });
    expect(widget.highlightedId).toBe('command.profile');
    widget.handleInput({ type: 'key', key: 'ArrowDown' });
    expect(widget.highlightedId).toBe('command.plan');
    widget.handleInput({ type: 'key', key: 'End' });
    expect(widget.highlightedId).toBe('command.profile');

    expect(widget.handleInput({ type: 'key', key: 'Enter' })).toEqual<ComposerAssistWidgetResult>({
      status: 'handled',
      output: { type: 'activate', suggestionId: 'command.profile', kind: 'command' },
    });
    expect(widget.selectedId).toBe('command.plan');
    expect(widget.activateById('command.publish')).toEqual({
      status: 'invalid',
      message: 'Suggestion command.publish is disabled: No remote is configured.',
    });
  });

  it('emits bounded filter and cancellation intents without mutating authoritative suggestions', () => {
    const widget = activeWidget();

    expect(widget.handleInput({ type: 'text', text: 'lan' })).toEqual<ComposerAssistWidgetResult>({
      status: 'handled',
      output: { type: 'filter', mode: 'command', query: '/plan' },
    });
    expect(widget.filterQuery).toBe('/plan');
    expect(widget.suggestions).toHaveLength(3);
    expect(widget.handleInput({ type: 'key', key: 'Backspace' })).toMatchObject({
      status: 'handled',
      output: { type: 'filter', mode: 'command', query: '/pla' },
    });
    expect(widget.handleInput({ type: 'key', key: 'Escape' })).toEqual<ComposerAssistWidgetResult>({
      status: 'handled',
      output: { type: 'cancel', reason: 'escape' },
    });
  });

  it('supports file mode and sanitizes hostile terminal text in every output', () => {
    const widget = activeWidget({
      authority: 'runtime', revision: 1, mode: 'file', state: 'ready', query: '@src', selectedId: 'file.src',
      suggestions: [{
        id: 'file.src', kind: 'file', label: 'src/\u001b[31mindex.ts',
        description: 'Bearer very-secret-token-value', detail: '\u202eTypeScript',
      }],
    });

    expect(widget.render().accessibility.label).toBe('File suggestions');
    expect(JSON.stringify(widget.render())).not.toMatch(/[\u001b\u202e]/u);
    expect(widget.alternateOutput()).toContain('src/index.ts');
    expect(widget.alternateOutput()).toContain('Bearer [REDACTED]');
  });

  it.each([
    { state: 'idle' as const, text: 'Type / for commands.' },
    { state: 'loading' as const, text: 'Loading command suggestions…' },
    { state: 'empty' as const, text: 'No command suggestions.' },
    { state: 'error' as const, text: 'Command suggestions failed: Index unavailable.' },
  ])('renders and announces the $state state', ({ state, text }) => {
    const widget = activeWidget({
      authority: 'runtime', revision: 1, mode: 'command', state, query: '/', suggestions: [],
      ...(state === 'error' ? { errorMessage: 'Index unavailable.' } : {}),
    });

    expect(widget.render().regions.some((region) => region.text === text)).toBe(true);
    expect(widget.takeAnnouncements()).toContain(text);
  });

  it('validates authority, state invariants, stable IDs, kinds, and immutable copies', () => {
    expect(() => activeWidget({ ...READY, authority: 'runtime' as const, suggestions: [] })).toThrow(/ready.*suggestion/i);
    expect(() => activeWidget({ ...READY, suggestions: [{ id: 'bad id', kind: 'command', label: '/bad' }] })).toThrow(/stable/i);
    expect(() => activeWidget({ ...READY, suggestions: [{ id: 'file.x', kind: 'file', label: 'x' }] })).toThrow(/mode/i);
    expect(() => activeWidget({ ...READY, selectedId: 'missing' })).toThrow(/selectedId/i);

    const widget = activeWidget();
    expect(Object.isFrozen(widget.snapshot)).toBe(true);
    expect(Object.isFrozen(widget.suggestions)).toBe(true);
    expect(Object.isFrozen(widget.suggestions[0])).toBe(true);
  });

  it('updates monotonically, preserves highlight when possible, and bounds viewport navigation', () => {
    const widget = activeWidget();
    widget.highlightById('command.profile');
    widget.update({ ...READY, revision: 4, query: '/pr', selectedId: 'command.profile' });
    expect(widget.highlightedId).toBe('command.profile');
    expect(widget.selectedId).toBe('command.profile');
    expect(() => widget.update({ ...READY, revision: 3 })).toThrow(/revision/i);

    widget.resize(20, 1);
    expect(widget.render().regions.filter(({ role }) => role === 'option')).toHaveLength(1);
    expect(widget.scrollOffset).toBeGreaterThanOrEqual(0);
  });
});
