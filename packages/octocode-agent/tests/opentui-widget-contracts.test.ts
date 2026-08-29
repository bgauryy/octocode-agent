import { describe, expect, it, vi } from 'vitest';

import { OpenTuiWidget } from '../src/terminal/opentui/widgets/base.js';
import {
  MAX_WIDGET_INSTRUCTION_ITEMS,
  WidgetContractError,
  type WidgetInput,
  type WidgetInputResult,
  type WidgetRenderRegion,
  type WidgetAccessibilityRole,
  type WidgetContract,
  type WidgetDefinition,
} from '../src/terminal/opentui/widgets/contracts.js';
import { WidgetRegistry } from '../src/terminal/opentui/widgets/registry.js';

const ACCESSIBILITY = {
  role: 'form' as const,
  label: 'Example widget',
  description: 'A deterministic test widget.',
  liveRegion: 'polite' as const,
  keyboardHelp: ['Enter submits', 'Escape cancels'],
};

const INSTRUCTIONS = {
  purpose: 'Collect one bounded value from the user.',
  useWhen: ['The agent needs an explicit user choice.'],
  avoidWhen: ['The answer is already known.'],
  inputs: ['A short text value.'],
  stateAndOutput: ['Active until submitted; outputs the submitted value.'],
  keys: ['Enter submits.', 'Escape cancels.'],
  accessibility: ['Announce validation errors through the polite live region.'],
  recovery: ['Retry with a shorter value after validation failure.'],
};

class FakeWidget extends OpenTuiWidget<string, typeof INSTRUCTIONS> {
  private value = '';

  constructor(id: string, kind = 'fake.input') {
    super({
      id,
      kind,
      capabilities: { focusable: true, inputMode: 'text' },
      accessibility: ACCESSIBILITY,
      instructions: INSTRUCTIONS,
    });
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    return [{ id: 'value', role: 'content', text: this.value || 'empty' }];
  }

  protected onInput(input: WidgetInput): WidgetInputResult<string> {
    if (input.type !== 'text') return { status: 'ignored' };
    this.value = input.text;
    this.invalidate();
    return { status: 'handled', output: this.value };
  }
}

describe('OpenTUI widget contracts', () => {
  it('provides class lifecycle, rendering, focus, input, instructions, and a narrow adapter', () => {
    const widget = new FakeWidget('prompt-1');
    const adapter = { render: vi.fn(), destroy: vi.fn() };

    expect(widget.lifecycle).toBe('created');
    expect(widget.instructions).toEqual(INSTRUCTIONS);
    widget.mount();
    widget.activate();
    widget.focus();
    expect(widget.handleInput({ type: 'text', text: 'Ada' })).toEqual({
      status: 'handled',
      output: 'Ada',
    });

    const state = widget.render(adapter);
    expect(state).toMatchObject({
      id: 'prompt-1',
      kind: 'fake.input',
      lifecycle: 'active',
      focused: true,
      regions: [{ id: 'value', role: 'content', text: 'Ada' }],
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(adapter.render).toHaveBeenCalledWith(state);

    widget.destroy(adapter);
    widget.destroy(adapter);
    expect(widget.lifecycle).toBe('destroyed');
    expect(adapter.destroy).toHaveBeenCalledTimes(1);
    expect(() => widget.render()).toThrow(WidgetContractError);
  });

  it('fails closed on invalid identity, metadata, instructions, and render bounds', () => {
    expect(() => new FakeWidget('../unsafe')).toThrow(WidgetContractError);
    expect(() => new FakeWidget('ok', 'Not Lowercase')).toThrow(WidgetContractError);

    class InvalidMetadataWidget extends OpenTuiWidget {
      constructor() {
        super({
          id: 'invalid-metadata',
          kind: 'invalid.metadata',
          capabilities: { focusable: false, inputMode: 'none' },
          accessibility: { ...ACCESSIBILITY, label: '' },
          instructions: INSTRUCTIONS,
        });
      }
      protected renderRegions(): readonly WidgetRenderRegion[] { return []; }
    }
    expect(() => new InvalidMetadataWidget()).toThrow(WidgetContractError);

    class InvalidInstructionsWidget extends OpenTuiWidget {
      constructor() {
        super({
          id: 'invalid-instructions',
          kind: 'invalid.instructions',
          capabilities: { focusable: false, inputMode: 'none' },
          accessibility: ACCESSIBILITY,
          instructions: {
            ...INSTRUCTIONS,
            keys: Array.from({ length: MAX_WIDGET_INSTRUCTION_ITEMS + 1 }, () => 'key'),
          },
        });
      }
      protected renderRegions(): readonly WidgetRenderRegion[] { return []; }
    }
    expect(() => new InvalidInstructionsWidget()).toThrow(WidgetContractError);

    class InvalidRenderWidget extends FakeWidget {
      protected renderRegions(): readonly WidgetRenderRegion[] {
        return [{ id: 'too-long', role: 'content', text: 'x'.repeat(8_193) }];
      }
    }
    const invalidRender = new InvalidRenderWidget('invalid-render');
    invalidRender.mount();
    expect(() => invalidRender.render()).toThrow(WidgetContractError);
    expect(invalidRender.lifecycle).toBe('failed');
  });

  it('registers factories in deterministic order and rejects duplicates, overflow, and mismatches', () => {
    expect(() => new WidgetRegistry().register({
      kind: 'Not Valid',
      order: 0,
      create: (id) => new FakeWidget(id),
    })).toThrow(/kind/i);

    const registry = new WidgetRegistry({ maxEntries: 2 });
    registry.register({ kind: 'zeta', order: 20, create: (id) => new FakeWidget(id, 'zeta') });
    registry.register({ kind: 'alpha', order: 10, create: (id) => new FakeWidget(id, 'alpha') });

    expect(registry.list().map(({ kind }) => kind)).toEqual(['alpha', 'zeta']);
    expect(registry.create('alpha', 'alpha-1')).toBeInstanceOf(FakeWidget);
    expect(() => registry.register({
      kind: 'alpha',
      order: 30,
      create: (id) => new FakeWidget(id, 'alpha'),
    })).toThrow(/duplicate/i);
    expect(() => registry.register({
      kind: 'third',
      order: 30,
      create: (id) => new FakeWidget(id, 'third'),
    })).toThrow(/capacity/i);

    const mismatched = new WidgetRegistry();
    mismatched.register({
      kind: 'expected',
      order: 0,
      create: (id) => new FakeWidget(id, 'unexpected'),
    });
    expect(() => mismatched.create('expected', 'widget-1')).toThrow(/mismatched/i);
  });

  it('passes typed construction input to factories and rejects reused factory or widget identities', () => {
    interface ConstructionInput {
      readonly seed: string;
    }

    const create = (id: string, input: ConstructionInput): FakeWidget => {
      const widget = new FakeWidget(id, 'constructed');
      widget.mount();
      widget.activate();
      widget.focus();
      widget.handleInput({ type: 'text', text: input.seed });
      return widget;
    };
    const definition: WidgetDefinition<ConstructionInput, FakeWidget> = {
      kind: 'constructed',
      order: 1,
      create,
    };
    const registry = new WidgetRegistry();
    registry.register(definition);

    const widget = registry.create<ConstructionInput, FakeWidget>(
      'constructed',
      'constructed-1',
      { seed: 'typed seed' },
    );
    expect(widget.render().regions[0]?.text).toBe('typed seed');
    expect(() => registry.register({ kind: 'reused-factory', order: 2, create })).toThrow(/factory/i);

    const singleton = new FakeWidget('singleton', 'singleton');
    const singletonRegistry = new WidgetRegistry();
    singletonRegistry.register({ kind: 'singleton', order: 0, create: () => singleton });
    expect(singletonRegistry.create('singleton', 'singleton')).toBe(singleton);
    expect(() => singletonRegistry.create('singleton', 'singleton')).toThrow(/instance/i);
  });

  it('defines the semantic roles needed by the complete widget surface', () => {
    const roles: readonly WidgetAccessibilityRole[] = [
      'banner',
      'contentinfo',
      'alertdialog',
      'list',
      'option',
    ];
    expect(roles).toHaveLength(5);

    const widget: WidgetContract<string, typeof INSTRUCTIONS> = new FakeWidget('typed-instructions');
    expect(widget.instructions.purpose).toBe(INSTRUCTIONS.purpose);
  });
});
