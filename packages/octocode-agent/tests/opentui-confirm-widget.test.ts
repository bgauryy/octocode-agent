import { describe, expect, it } from 'vitest';

import { WidgetContractError } from '../src/terminal/opentui/widgets/contracts.js';
import {
  ConfirmWidget,
  type ConfirmResult,
} from '../src/terminal/opentui/widgets/confirm.js';

function activeWidget(
  options: Partial<ConstructorParameters<typeof ConfirmWidget>[0]> = {},
): ConfirmWidget {
  const widget = new ConfirmWidget({
    id: 'confirm-release',
    authority: 'runtime',
    question: 'Publish version 2.0 now?',
    consequence: 'This publishes immutable packages to the public registry.',
    risk: 'consequential',
    ...options,
  });
  widget.mount();
  widget.activate();
  return widget;
}

describe('ConfirmWidget', () => {
  it('renders the full decision as an assertive alert with explicit, color-independent choices', () => {
    const widget = activeWidget();

    const state = widget.render();
    expect(state.focused).toBe(true);
    expect(state.accessibility).toMatchObject({
      role: 'alertdialog',
      label: 'Publish version 2.0 now?',
      liveRegion: 'assertive',
    });
    expect(state.regions).toEqual([
      { id: 'question', role: 'prompt', text: 'Publish version 2.0 now?' },
      {
        id: 'consequence',
        role: 'status',
        text: 'Consequence: This publishes immutable packages to the public registry.',
      },
      { id: 'option-yes', role: 'option', text: '  [ ] Yes — authorize exactly this action' },
      { id: 'option-no', role: 'option', text: '> [ ] No — do not authorize this action' },
      {
        id: 'announcement',
        role: 'status',
        text: 'Focused option: No. No answer has been submitted.',
      },
      {
        id: 'help',
        role: 'help',
        text: 'Left/Right or Tab moves; Y/N chooses; Enter submits the focused option; Escape or Ctrl-C cancels.',
      },
    ]);
  });

  it('never treats bare Enter as affirmative and requires an explicit Yes choice', () => {
    const untouched = activeWidget({ id: 'confirm-untouched' });
    expect(untouched.handleInput({ type: 'key', key: 'Enter' })).toEqual<ConfirmResult>({
      status: 'handled',
      output: { type: 'decision', confirmed: false, choice: 'no', reason: 'focused-submit' },
    });

    const moved = activeWidget({ id: 'confirm-moved' });
    expect(moved.handleInput({ type: 'key', key: 'ArrowRight' })).toEqual({ status: 'handled' });
    expect(moved.handleInput({ type: 'key', key: 'Enter' })).toEqual<ConfirmResult>({
      status: 'handled',
      output: { type: 'decision', confirmed: true, choice: 'yes', reason: 'focused-submit' },
    });
  });

  it('supports Left/Right, Tab, Shift-Tab, and direct Y/N without an implicit default', () => {
    const widget = activeWidget({ id: 'confirm-keys' });
    expect(widget.selectedOption).toBe('no');
    widget.handleInput({ type: 'key', key: 'Tab' });
    expect(widget.selectedOption).toBe('yes');
    widget.handleInput({ type: 'key', key: 'Shift+Tab' });
    expect(widget.selectedOption).toBe('no');
    widget.handleInput({ type: 'key', key: 'ArrowLeft' });
    expect(widget.selectedOption).toBe('yes');
    widget.handleInput({ type: 'key', key: 'ArrowRight' });
    expect(widget.selectedOption).toBe('no');

    expect(widget.handleInput({ type: 'key', key: 'y' })).toEqual<ConfirmResult>({
      status: 'handled',
      output: { type: 'decision', confirmed: true, choice: 'yes', reason: 'direct-key' },
    });

    const noWidget = activeWidget({ id: 'confirm-no-key' });
    expect(noWidget.handleInput({ type: 'key', key: 'N' })).toMatchObject({
      output: { type: 'decision', confirmed: false, choice: 'no', reason: 'direct-key' },
    });
  });

  it('returns distinct typed cancellation outcomes and announces them', () => {
    const cases = [
      [{ type: 'key', key: 'Escape' } as const, 'escape'],
      [{ type: 'key', key: 'Ctrl+C' } as const, 'interrupt'],
      [{ type: 'cancel' } as const, 'semantic'],
    ] as const;

    for (const [input, reason] of cases) {
      const widget = activeWidget({ id: `confirm-cancel-${reason}` });
      expect(widget.handleInput(input)).toEqual<ConfirmResult>({
        status: 'handled',
        output: { type: 'cancel', reason },
      });
      expect(widget.render().regions).toContainEqual({
        id: 'announcement',
        role: 'status',
        text: reason === 'interrupt'
          ? 'Cancelled by interrupt. No action was authorized.'
          : 'Cancelled. No action was authorized.',
      });
    }
  });

  it('returns and announces a typed timeout without choosing Yes or No', () => {
    const widget = activeWidget({ id: 'confirm-timeout', timeoutMs: 5_000 });

    expect(widget.expireTimeout()).toEqual<ConfirmResult>({
      status: 'handled',
      output: { type: 'timeout', timeoutMs: 5_000 },
    });
    expect(widget.render().regions).toContainEqual({
      id: 'announcement',
      role: 'status',
      text: 'Timed out after 5000 ms. No action was authorized.',
    });
    expect(widget.handleInput({ type: 'key', key: 'y' })).toEqual({
      status: 'ignored',
      message: 'confirmation is already resolved',
    });
  });

  it('preserves safe focus and unresolved state across resize', () => {
    const widget = activeWidget({ id: 'confirm-resize' });
    widget.handleInput({ type: 'key', key: 'ArrowRight' });
    widget.resize(24);

    expect(widget.viewportWidth).toBe(24);
    expect(widget.selectedOption).toBe('yes');
    expect(widget.render().regions.at(-2)?.text).toMatch(/Focused option: Yes/);
  });

  it('provides linear alternate output that states no default is inferred', () => {
    const widget = activeWidget({ id: 'confirm-alternate' });
    const output = widget.alternateOutput();

    expect(output).toContain('Question: Publish version 2.0 now?');
    expect(output).toContain('Consequence: This publishes immutable packages to the public registry.');
    expect(output).toContain('Choices: Yes / No');
    expect(output).toContain('No default is inferred');
  });

  it('rejects missing consequences, leading negatives, double negatives, and invalid timeouts', () => {
    expect(() => new ConfirmWidget({
      id: 'confirm-no-consequence',
      authority: 'runtime',
      question: 'Delete the branch?',
      consequence: '',
    })).toThrow(WidgetContractError);
    expect(() => new ConfirmWidget({
      id: 'confirm-leading-negative',
      authority: 'runtime',
      question: "Don't keep the branch?",
      consequence: 'The branch selection will change.',
    })).toThrow(/negative/i);
    expect(() => new ConfirmWidget({
      id: 'confirm-double-negative',
      authority: 'runtime',
      question: 'Do you not want to not publish?',
      consequence: 'The public registry will change.',
    })).toThrow(/negative/i);
    expect(() => new ConfirmWidget({
      id: 'confirm-timeout-invalid',
      authority: 'runtime',
      question: 'Publish now?',
      consequence: 'The public registry will change.',
      timeoutMs: 0,
    })).toThrow(/timeoutMs/i);
  });

  it('makes approval-laundering constraints explicit to agents', () => {
    const widget = activeWidget({ id: 'confirm-instructions', risk: 'destructive' });
    const instructions = JSON.stringify(widget.instructions);

    expect(instructions).toMatch(/visible user choice/i);
    expect(instructions).toMatch(/agent-generated|inferred/i);
    expect(instructions).toMatch(/exact question and consequence/i);
    expect(instructions).toMatch(/timeout.*cancel.*No.*not authorize/i);
    expect(instructions).toMatch(/destructive/i);
  });

  it('rejects absent or agent-authored authority before establishing approval scope', () => {
    const withoutAuthority = {
      id: 'confirm-missing-authority',
      question: 'Publish now?',
      consequence: 'The public registry will change.',
    } as ConstructorParameters<typeof ConfirmWidget>[0];
    expect(() => new ConfirmWidget(withoutAuthority)).toThrow(/runtime authority/i);
    expect(() => new ConfirmWidget({
      ...withoutAuthority,
      id: 'confirm-agent-authority',
      authority: 'agent' as never,
    })).toThrow(/runtime authority/i);
  });

  it('sanitizes CSI, OSC, C1, and bidi controls from every approval surface', () => {
    const widget = activeWidget({
      id: 'confirm-controls',
      question: 'Pub\u001b[31mlish\u001b[0m \u202e2.0 now?',
      consequence: 'Write \u001b]8;;https://evil.invalid\u0007\u009b31mpublic\u009b0m packages.',
    });

    const rendered = JSON.stringify(widget.render());
    const alternate = widget.alternateOutput();
    expect(widget.render().accessibility.label).toBe('Publish 2.0 now?');
    expect(rendered).toContain('Write public packages.');
    expect(`${rendered}${alternate}`).not.toMatch(/[\u001b\u009b\u009d\u202a-\u202e\u2066-\u2069]/);
    expect(`${rendered}${alternate}`).not.toContain('evil.invalid');
  });
});
