import { describe, expect, it } from 'vitest';

import { WidgetContractError } from '../src/terminal/opentui/widgets/contracts.js';
import {
  SelectWidget,
  type SelectWidgetResult,
} from '../src/terminal/opentui/widgets/select.js';

const OPTIONS = [
  { id: 'safe', label: 'Safe mode', description: 'Read-only checks.', recommended: true },
  { id: 'fast', label: 'Fast mode', description: 'Skip optional checks.' },
  { id: 'legacy', label: 'Legacy mode', disabledReason: 'Unavailable for this project.' },
  { id: 'custom', label: 'Custom mode', description: 'Choose settings manually.' },
] as const;

function activeWidget(overrides: Partial<ConstructorParameters<typeof SelectWidget>[0]> = {}): SelectWidget {
  const widget = new SelectWidget({
    id: 'mode-select',
    label: 'Choose an execution mode',
    options: OPTIONS,
    ...overrides,
  });
  widget.mount();
  widget.activate();
  return widget;
}

describe('SelectWidget', () => {
  it('renders a labeled listbox with textual state markers and complete instructions', () => {
    const widget = activeWidget();
    const state = widget.render();

    expect(state.focused).toBe(true);
    expect(state.accessibility).toMatchObject({
      role: 'listbox',
      label: 'Choose an execution mode',
      liveRegion: 'polite',
    });
    expect(state.regions.map((region) => region.text)).toEqual([
      'Choose an execution mode',
      '> [ ] Safe mode [recommended] — Read-only checks.',
      '  [ ] Fast mode — Skip optional checks.',
      '  [disabled] Legacy mode — Unavailable for this project.',
      '  [ ] Custom mode — Choose settings manually.',
      'Arrows move; Home/End and PageUp/PageDown jump; type searches; Enter chooses; Esc/Ctrl-C cancels.',
    ]);
    expect(widget.instructions.stateAndOutput.join(' ')).toMatch(/stable option ID/i);
    expect(widget.instructions.accessibility.join(' ')).toMatch(/color/i);
  });

  it('implements a concrete render method that forwards semantic state to the adapter', () => {
    const widget = activeWidget();
    let observed: ReturnType<SelectWidget['render']> | undefined;
    const state = widget.render({
      render(next) {
        observed = next;
      },
      destroy() {},
    });

    expect(observed).toBe(state);
    expect(state.kind).toBe('prompt.select');
  });

  it('navigates only enabled options by arrows, boundaries, and pages', () => {
    const widget = activeWidget();
    expect(widget.highlightedId).toBe('safe');

    widget.handleInput({ type: 'key', key: 'ArrowDown' });
    expect(widget.highlightedId).toBe('fast');
    widget.handleInput({ type: 'key', key: 'ArrowDown' });
    expect(widget.highlightedId).toBe('custom');
    widget.handleInput({ type: 'key', key: 'ArrowDown' });
    expect(widget.highlightedId).toBe('safe');
    widget.handleInput({ type: 'key', key: 'End' });
    expect(widget.highlightedId).toBe('custom');
    widget.handleInput({ type: 'key', key: 'Home' });
    expect(widget.highlightedId).toBe('safe');

    widget.resize(40, 2);
    widget.handleInput({ type: 'key', key: 'PageDown' });
    expect(widget.highlightedId).toBe('custom');
    widget.handleInput({ type: 'key', key: 'PageUp' });
    expect(widget.highlightedId).toBe('safe');
  });

  it('searches by label without selecting and supports semantic index highlighting', () => {
    const widget = activeWidget();
    expect(widget.handleInput({ type: 'text', text: 'cu' })).toMatchObject({ status: 'handled' });
    expect(widget.highlightedId).toBe('custom');
    expect(widget.selectedId).toBeUndefined();
    expect(widget.searchQuery).toBe('cu');

    expect(widget.handleInput({ type: 'key', key: 'Backspace' })).toMatchObject({ status: 'handled' });
    expect(widget.searchQuery).toBe('c');
    expect(widget.handleInput({ type: 'select', index: 1 })).toMatchObject({ status: 'handled' });
    expect(widget.highlightedId).toBe('fast');
    expect(widget.handleInput({ type: 'select', index: 2 })).toMatchObject({ status: 'invalid' });
    expect(widget.highlightedId).toBe('fast');
  });

  it('sanitizes terminal and bidi controls from search without exposing them in render state', () => {
    const widget = activeWidget();
    expect(widget.handleInput({ type: 'paste', text: 'sa\u202e\u009b31m' })).toEqual({
      status: 'handled',
    });

    expect(widget.searchQuery).toBe('sa');
    expect(widget.highlightedId).toBe('safe');
    expect(JSON.stringify(widget.render())).not.toMatch(/[\u009b\u202e]/u);
  });

  it('truncates and removes search text on grapheme boundaries', () => {
    const family = '👨‍👩‍👧‍👦';
    const familyWidget = activeWidget({
      options: [{ id: 'family', label: `${family} Family` }],
    });
    familyWidget.handleInput({ type: 'text', text: family });
    expect(familyWidget.searchQuery).toBe(family);
    familyWidget.handleInput({ type: 'key', key: 'Backspace' });
    expect(familyWidget.searchQuery).toBe('');

    const combining = 'e\u0301';
    const combiningWidget = activeWidget({
      options: [{ id: 'eclair', label: `${combining}clair` }],
    });
    combiningWidget.handleInput({ type: 'text', text: combining });
    combiningWidget.handleInput({ type: 'key', key: 'Backspace' });
    expect(combiningWidget.searchQuery).toBe('');

    const boundedWidget = activeWidget({
      options: [{ id: 'bounded', label: 'x'.repeat(128) }],
    });
    boundedWidget.handleInput({ type: 'paste', text: 'x'.repeat(129) });
    expect(boundedWidget.searchQuery).toBe('x'.repeat(128));
    boundedWidget.handleInput({ type: 'key', key: 'Backspace' });
    expect(boundedWidget.searchQuery).toBe('x'.repeat(127));
  });

  it('commits and emits only stable IDs while disabled options can never be selected', () => {
    const widget = activeWidget();
    widget.handleInput({ type: 'key', key: 'End' });

    expect(widget.handleInput({ type: 'key', key: 'Enter' })).toEqual<SelectWidgetResult>({
      status: 'handled',
      output: { type: 'select', optionId: 'custom' },
    });
    expect(widget.selectedId).toBe('custom');
    expect(widget.render().regions.find((region) => region.id === 'option-custom')?.text).toContain('[selected]');
    expect(widget.selectById('legacy')).toEqual({
      status: 'invalid',
      message: 'Option legacy is disabled: Unavailable for this project.',
    });
    expect(widget.selectedId).toBe('custom');
  });

  it('projects every native option beyond the viewport and synchronizes by stable ID', () => {
    const options = Array.from({ length: 10 }, (_, index) => ({
      id: `option-${index + 1}`,
      label: `Option ${index + 1}`,
      description: `Description ${index + 1}`,
      ...(index === 9 ? { disabledReason: 'Requires an unavailable capability.' } : {}),
    }));
    const widget = activeWidget({ options, consequential: true });

    expect(widget.render().regions.some((region) => region.id === 'option-option-9')).toBe(false);
    expect(widget.nativeOptions).toHaveLength(10);
    expect(widget.nativeOptions[8]).toEqual({
      id: 'option-9',
      label: 'Option 9',
      description: 'Description 9',
      disabled: false,
      recommended: false,
    });
    expect(widget.nativeOptions[9]).toEqual({
      id: 'option-10',
      label: 'Option 10',
      description: 'Description 10',
      disabled: true,
      disabledReason: 'Requires an unavailable capability.',
      recommended: false,
    });
    expect(Object.isFrozen(widget.nativeOptions)).toBe(true);
    expect(Object.isFrozen(widget.nativeOptions[8])).toBe(true);

    expect(widget.highlightById('option-9')).toEqual({ status: 'handled' });
    expect(widget.highlightedId).toBe('option-9');
    expect(widget.selectedId).toBeUndefined();
    expect(widget.scrollOffset).toBeGreaterThan(0);
    expect(widget.selectById('option-9')).toEqual<SelectWidgetResult>({
      status: 'handled',
      output: { type: 'select', optionId: 'option-9' },
    });
    expect(widget.selectedId).toBe('option-9');

    expect(widget.highlightById('option-10')).toEqual({
      status: 'invalid',
      message: 'Option option-10 is disabled: Requires an unavailable capability.',
    });
    expect(widget.selectById('option-10')).toEqual({
      status: 'invalid',
      message: 'Option option-10 is disabled: Requires an unavailable capability.',
    });
    expect(widget.selectedId).toBe('option-9');
  });

  it('does not coerce a consequential answer and rejects consequential preselection', () => {
    const widget = activeWidget({ consequential: true });
    expect(widget.highlightedId).toBe('safe');
    expect(widget.selectedId).toBeUndefined();
    expect(widget.alternateOutput()).toContain('Selection: none (explicit choice required)');

    expect(() => activeWidget({ consequential: true, selectedId: 'safe' })).toThrow(/preselect/i);
  });

  it('preserves committed selection, highlight, and visible scroll state through resize', () => {
    const widget = activeWidget({ selectedId: 'fast' });
    widget.resize(30, 2);
    widget.handleInput({ type: 'key', key: 'End' });
    const scrollBefore = widget.scrollOffset;

    widget.resize(12, 1);
    expect(widget.selectedId).toBe('fast');
    expect(widget.highlightedId).toBe('custom');
    expect(widget.scrollOffset).toBeGreaterThanOrEqual(scrollBefore);
    expect(widget.render().regions.some((region) => region.id === 'option-custom')).toBe(true);
  });

  it('provides bounded numbered linear alternate output without truncating ambiguous labels', () => {
    const widget = activeWidget({ selectedId: 'fast' });
    expect(widget.alternateOutput()).toBe([
      'Choose an execution mode',
      'Selection: fast',
      '1. [recommended] Safe mode — Read-only checks.',
      '2. [selected] Fast mode — Skip optional checks.',
      '3. [disabled: Unavailable for this project.] Legacy mode',
      '4. [available] Custom mode — Choose settings manually.',
    ].join('\n'));
  });

  it('emits typed cancellation for Escape, Ctrl-C, and semantic cancellation', () => {
    const cases = [
      [{ type: 'key', key: 'Escape' } as const, 'escape'],
      [{ type: 'key', key: 'Ctrl+C' } as const, 'interrupt'],
      [{ type: 'cancel' } as const, 'semantic'],
    ] as const;

    for (const [input, reason] of cases) {
      expect(activeWidget().handleInput(input)).toEqual<SelectWidgetResult>({
        status: 'handled',
        output: { type: 'cancel', reason },
      });
    }
  });

  it('rejects duplicate IDs, duplicate visible labels, ambiguous long text, and invalid selections', () => {
    expect(() => activeWidget({ options: [OPTIONS[0], OPTIONS[0]] })).toThrow(WidgetContractError);
    expect(() => activeWidget({
      options: [
        { id: 'one', label: 'Same label' },
        { id: 'two', label: ' same  label ' },
      ],
    })).toThrow(/label/i);
    expect(() => activeWidget({
      options: [{ id: 'long', label: 'x'.repeat(8_193) }],
    })).toThrow(/length bound/i);
    expect(() => activeWidget({
      options: [{ id: 'multiline', label: 'Ambiguous\nsecond line' }],
    })).toThrow(/controls/i);
    expect(() => activeWidget({ label: 'Choose\u202e mode' })).toThrow(/bidi/i);
    expect(() => activeWidget({
      options: [{ id: 'unsafe', label: 'Unsafe\u001b[31m label' }],
    })).toThrow(/terminal/i);
    expect(() => activeWidget({
      options: [{ id: 'unsafe', label: 'Unsafe', description: 'Injected\u009b31m red' }],
    })).toThrow(/terminal/i);
    expect(() => activeWidget({
      options: [{ id: 'safe\u202e', label: 'Unsafe ID' }],
    })).toThrow(/id.*terminal|bidi/i);
    expect(() => activeWidget({ selectedId: 'missing' })).toThrow(/selectedId/i);
    expect(() => activeWidget({ selectedId: 'legacy' })).toThrow(/disabled/i);

    expect(activeWidget().selectById('safe\u009b31m')).toEqual({
      status: 'invalid',
      message: 'Option ID is invalid or unsafe.',
    });
  });
});
