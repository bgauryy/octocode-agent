import { describe, expect, it } from 'vitest';

import { WidgetContractError } from '../src/terminal/opentui/widgets/contracts.js';
import {
  PromptInputWidget,
  type PromptInputResult,
} from '../src/terminal/opentui/widgets/prompt-input.js';

function activeWidget(options: ConstructorParameters<typeof PromptInputWidget>[0]): PromptInputWidget {
  const widget = new PromptInputWidget(options);
  widget.mount();
  widget.activate();
  return widget;
}

describe('PromptInputWidget', () => {
  it('renders an explicit labeled textbox and focuses it on activation', () => {
    const widget = activeWidget({
      id: 'prompt-name',
      question: 'What should this session be called?',
      placeholder: 'Release review',
      help: 'Use a short, recognizable name.',
    });

    const state = widget.render();
    expect(state.focused).toBe(true);
    expect(state.accessibility).toMatchObject({
      role: 'textbox',
      label: 'What should this session be called?',
      liveRegion: 'polite',
    });
    expect(state.regions).toEqual([
      { id: 'question', role: 'prompt', text: 'What should this session be called?' },
      { id: 'value', role: 'content', text: '' },
      { id: 'placeholder', role: 'help', text: 'Release review' },
      { id: 'help', role: 'help', text: 'Use a short, recognizable name.' },
    ]);
    expect(widget.focusOnActivation).toBe(true);
    expect(widget.instructions.accessibility.join(' ')).toMatch(/placeholder.*label/i);
  });

  it('edits at the cursor, sanitizes pasted newlines, and preserves state across resize', () => {
    const widget = activeWidget({ id: 'prompt-edit', question: 'What is the value?' });

    expect(widget.handleInput({ type: 'text', text: 'ac' })).toMatchObject({ status: 'handled' });
    expect(widget.handleInput({ type: 'key', key: 'ArrowLeft' })).toMatchObject({ status: 'handled' });
    expect(widget.handleInput({ type: 'paste', text: 'b\r\nnext\tline' })).toMatchObject({
      status: 'handled',
    });
    expect(widget.value).toBe('ab next linec');
    expect(widget.cursor).toBe('ab next line'.length);

    widget.resize(18);
    expect(widget.viewportWidth).toBe(18);
    expect(widget.value).toBe('ab next linec');
    expect(widget.cursor).toBe('ab next line'.length);

    widget.handleInput({ type: 'key', key: 'Backspace' });
    widget.handleInput({ type: 'key', key: 'Delete' });
    expect(widget.value).toBe('ab next lin');
    widget.handleInput({ type: 'key', key: 'Home' });
    widget.handleInput({ type: 'key', key: 'End' });
    expect(widget.cursor).toBe(widget.value.length);
  });

  it('moves and edits on grapheme boundaries without splitting emoji or combining sequences', () => {
    const widget = activeWidget({ id: 'prompt-unicode', question: 'What is the display name?' });
    widget.handleInput({ type: 'text', text: `A👨‍👩‍👧‍👦e\u0301B` });

    widget.handleInput({ type: 'key', key: 'ArrowLeft' });
    widget.handleInput({ type: 'key', key: 'Backspace' });
    expect(widget.value).toBe('A👨‍👩‍👧‍👦B');

    widget.handleInput({ type: 'key', key: 'ArrowLeft' });
    widget.handleInput({ type: 'key', key: 'Delete' });
    expect(widget.value).toBe('AB');
    expect(widget.cursor).toBe(1);
  });

  it('re-snaps the cursor when inserted joiners merge adjacent emoji', () => {
    const widget = activeWidget({ id: 'prompt-joiner', question: 'What symbol should be shown?' });
    widget.handleInput({ type: 'text', text: '👩👧' });
    widget.handleInput({ type: 'key', key: 'ArrowLeft' });
    widget.handleInput({ type: 'text', text: '\u200D' });

    expect(widget.value).toBe('👩‍👧');
    expect(widget.cursor).toBe(widget.value.length);
    widget.handleInput({ type: 'key', key: 'Backspace' });
    expect(widget.value).toBe('');
    expect(widget.cursor).toBe(0);
  });

  it('applies min and max character bounds by grapheme rather than UTF-16 code unit', () => {
    const widget = activeWidget({
      id: 'prompt-grapheme-bounds',
      question: 'Which symbol should be shown?',
      minLength: 1,
      maxLength: 1,
    });
    expect(widget.handleInput({ type: 'text', text: '👨‍👩‍👧‍👦' })).toMatchObject({ status: 'handled' });
    expect(widget.handleInput({ type: 'submit' })).toMatchObject({ status: 'handled' });
    expect(widget.handleInput({ type: 'text', text: 'x' })).toEqual({
      status: 'invalid',
      message: 'Enter no more than 1 characters.',
    });
  });

  it('synchronizes a complete native buffer with one invalidation and clears validation', () => {
    const widget = activeWidget({
      id: 'prompt-native-sync',
      question: 'What value should be used?',
      required: true,
    });
    widget.handleInput({ type: 'submit' });
    expect(widget.render().regions.at(-1)?.id).toBe('validation');
    const revision = widget.render().revision;

    expect(widget.replaceValue('native\r\nvalue', 6)).toEqual({ status: 'handled' });
    const state = widget.render();
    expect(widget.value).toBe('native value');
    expect(widget.cursor).toBe(6);
    expect(state.revision).toBe(revision + 1);
    expect(state.regions.some(({ id }) => id === 'validation')).toBe(false);
  });

  it('rejects an oversized native replacement without mutating the existing buffer', () => {
    const widget = activeWidget({
      id: 'prompt-native-oversize',
      question: 'What short code should be used?',
      initialValue: 'ok',
      maxLength: 2,
    });
    const cursor = widget.cursor;

    expect(widget.replaceValue('toolong')).toEqual({
      status: 'invalid',
      message: 'Enter no more than 2 characters.',
    });
    expect(widget.value).toBe('ok');
    expect(widget.cursor).toBe(cursor);
  });

  it('snaps native cursor synchronization to a grapheme boundary and survives resize', () => {
    const widget = activeWidget({ id: 'prompt-native-emoji', question: 'What symbol should be used?' });
    const family = '👨‍👩‍👧‍👦';

    expect(widget.replaceValue(`${family}x`, 2)).toEqual({ status: 'handled' });
    expect(widget.cursor).toBe(family.length);
    widget.resize(12);
    expect(widget.value).toBe(`${family}x`);
    expect(widget.cursor).toBe(family.length);
    expect(widget.viewportWidth).toBe(12);
  });

  it('sanitizes native replacement values without returning or rendering sensitive content', () => {
    const widget = activeWidget({
      id: 'prompt-native-sensitive',
      question: 'Enter the access token (input will be hidden).',
      sensitive: true,
    });

    const result = widget.replaceValue('secret\u001b[2J-value\u202E');
    expect(result).toEqual({ status: 'handled' });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(JSON.stringify(widget.render())).not.toContain('secret-value');
    expect(widget.alternateOutput()).not.toContain('secret-value');
  });

  it('validates required/min/max/pattern constraints and submits only valid values', () => {
    const widget = activeWidget({
      id: 'prompt-branch',
      question: 'Which branch should be used?',
      required: true,
      minLength: 3,
      maxLength: 8,
      pattern: /^[a-z]+$/,
      patternDescription: 'Use lowercase letters only.',
    });

    expect(widget.handleInput({ type: 'key', key: 'Enter' })).toEqual({
      status: 'invalid',
      message: 'A value is required.',
    });
    expect(widget.render().regions.at(-1)).toEqual({
      id: 'validation',
      role: 'status',
      text: 'A value is required.',
    });

    widget.handleInput({ type: 'text', text: 'A' });
    expect(widget.handleInput({ type: 'submit' })).toMatchObject({ status: 'invalid' });
    widget.handleInput({ type: 'key', key: 'Backspace' });
    widget.handleInput({ type: 'text', text: 'main' });
    expect(widget.handleInput({ type: 'key', key: 'Enter' })).toEqual<PromptInputResult>({
      status: 'handled',
      output: { type: 'submit', value: 'main', sensitive: false },
    });
  });

  it('reports cancel intent for Escape, Ctrl-C, and semantic cancellation', () => {
    for (const input of [
      { type: 'key', key: 'Escape' } as const,
      { type: 'key', key: 'Ctrl+C' } as const,
      { type: 'cancel' } as const,
    ]) {
      const widget = activeWidget({ id: `prompt-cancel-${input.type}-${input.type === 'key' ? input.key.replace('+', '') : 'semantic'}`, question: 'Continue typing?' });
      expect(widget.handleInput(input)).toMatchObject({
        status: 'handled',
        output: { type: 'cancel' },
      });
    }
  });

  it('redacts sensitive content from visual and alternate output', () => {
    const widget = activeWidget({
      id: 'prompt-token',
      question: 'Enter the access token (input will be hidden).',
      sensitive: true,
      redactionLabel: 'hidden token',
    });
    widget.handleInput({ type: 'paste', text: 'secret-value' });

    const rendered = JSON.stringify(widget.render());
    expect(rendered).not.toContain('secret-value');
    expect(rendered).toContain('hidden token');
    expect(widget.alternateOutput()).not.toContain('secret-value');
    expect(widget.alternateOutput()).toContain('hidden token');
    expect(widget.handleInput({ type: 'submit' })).toEqual<PromptInputResult>({
      status: 'handled',
      output: { type: 'submit', value: 'secret-value', sensitive: true },
    });
  });

  it('sanitizes terminal controls and bidi formatting from all configured display text', () => {
    const widget = activeWidget({
      id: 'prompt-hostile-metadata',
      question: '\u001b[31mWhat is the name?\u001b[0m\u202E',
      placeholder: '\u001b]52;c;Y2xpcGJvYXJk\u0007Visible placeholder',
      help: '\u009b2JVisible help\u2066',
      sensitive: true,
      redactionLabel: '\u001b[5mhidden\u001b[0m\u200F',
    });

    const rendered = widget.render();
    expect(rendered.accessibility.label).toBe('What is the name?');
    expect(rendered.accessibility.description).toBe('Visible help');
    expect(rendered.regions).toEqual([
      { id: 'question', role: 'prompt', text: 'What is the name?' },
      { id: 'value', role: 'content', text: '' },
      { id: 'placeholder', role: 'help', text: 'Visible placeholder' },
      { id: 'help', role: 'help', text: 'Visible help' },
    ]);
    expect(JSON.stringify(rendered)).not.toMatch(/[\u001b\u009b\u202e\u2066\u200f]/u);
  });

  it('strips CSI, OSC, C1, and bidi controls from typed and pasted values before output', () => {
    const widget = activeWidget({ id: 'prompt-hostile-input', question: 'What text should be used?' });
    widget.handleInput({
      type: 'text',
      text: 'safe\u001b[2J\u202E\r\nnext\u009b31m!',
    });
    widget.handleInput({
      type: 'paste',
      text: '\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\u2069',
    });

    expect(widget.value).toBe('safe next!link');
    expect(JSON.stringify(widget.render())).not.toMatch(/[\u001b\u009b\u202e\u2069]/u);
    expect(widget.alternateOutput()).not.toMatch(/[\u001b\u009b\u202e\u2069]/u);
    expect(widget.handleInput({ type: 'submit' })).toEqual<PromptInputResult>({
      status: 'handled',
      output: { type: 'submit', value: 'safe next!link', sensitive: false },
    });
  });

  it('sanitizes before secret and destructive-prompt policy checks', () => {
    expect(() => new PromptInputWidget({
      id: 'obfuscated-secret',
      question: 'Enter the API \u001b[31mkey\u001b[0m.',
    })).toThrow(/sensitive/i);
    expect(() => new PromptInputWidget({
      id: 'obfuscated-delete',
      question: 'Type DELETE to \u009b31mconfirm deleting the repository.',
    })).toThrow(/confirm widget/i);
  });

  it('rejects absent labels, implicit secret solicitation, destructive approval, and invalid bounds', () => {
    expect(() => new PromptInputWidget({
      id: 'placeholder-label',
      question: '',
      placeholder: 'This must not become the label',
    })).toThrow(WidgetContractError);
    expect(() => new PromptInputWidget({
      id: 'implicit-secret',
      question: 'Enter your API key.',
    })).toThrow(/sensitive/i);
    expect(() => new PromptInputWidget({
      id: 'destructive-text',
      question: 'Type DELETE to confirm deleting the repository.',
    })).toThrow(/confirm widget/i);
    expect(() => new PromptInputWidget({
      id: 'invalid-bounds',
      question: 'What is the name?',
      minLength: 5,
      maxLength: 2,
    })).toThrow(/minLength/i);
  });
});
