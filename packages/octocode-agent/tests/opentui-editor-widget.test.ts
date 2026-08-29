import { describe, expect, it } from 'vitest';

import { WidgetContractError } from '../src/terminal/opentui/widgets/contracts.js';
import {
  EditorWidget,
  type EditorWidgetResult,
} from '../src/terminal/opentui/widgets/editor.js';

function activeWidget(options: ConstructorParameters<typeof EditorWidget>[0]): EditorWidget {
  const widget = new EditorWidget(options);
  widget.mount();
  widget.activate();
  return widget;
}

describe('EditorWidget', () => {
  it('renders a labeled multiline textbox with complete agent instructions', () => {
    const widget = activeWidget({
      id: 'editor-notes',
      label: 'Edit release notes',
      help: 'Summarize user-visible changes.',
      initialValue: 'First line',
    });

    const state = widget.render();
    expect(state.focused).toBe(true);
    expect(state.accessibility).toMatchObject({
      role: 'textbox',
      label: 'Edit release notes',
      liveRegion: 'polite',
    });
    expect(state.regions).toContainEqual({ id: 'label', role: 'prompt', text: 'Edit release notes' });
    expect(state.regions).toContainEqual({ id: 'value', role: 'content', text: 'First line' });
    expect(widget.instructions.keys.join(' ')).toMatch(/Enter.*newline/i);
    expect(widget.instructions.keys.join(' ')).toMatch(/(?:Ctrl|Meta).+Enter.*submit/i);
    expect(widget.instructions.accessibility.join(' ')).toMatch(/plain-text/i);
  });

  it('edits by grapheme, supports selection, and keeps newline distinct from submit', () => {
    const widget = activeWidget({ id: 'editor-graphemes', label: 'Edit message' });

    widget.handleInput({ type: 'text', text: 'A👨‍👩‍👧‍👦C' });
    widget.handleInput({ type: 'key', key: 'ArrowLeft' });
    widget.handleInput({ type: 'key', key: 'Backspace' });
    expect(widget.value).toBe('AC');
    expect(widget.cursor).toBe(1);

    widget.handleInput({ type: 'key', key: 'Enter' });
    widget.handleInput({ type: 'paste', text: 'β\r\nγ\u0000' });
    expect(widget.value).toBe('A\nβ\nγC');
    expect(widget.handleInput({ type: 'key', key: 'Shift+ArrowUp' })).toMatchObject({ status: 'handled' });
    expect(widget.selection).not.toBeUndefined();
    widget.handleInput({ type: 'text', text: 'X' });
    expect(widget.selection).toBeUndefined();

    expect(widget.handleInput({ type: 'key', key: 'Meta+Enter' })).toEqual<EditorWidgetResult>({
      status: 'handled',
      output: { type: 'submit', value: widget.value, sensitive: false },
    });
  });

  it('supports line, page, undo, redo, and select-all commands', () => {
    const widget = activeWidget({
      id: 'editor-navigation',
      label: 'Edit plan',
      initialValue: 'one\ntwo\nthree\nfour\nfive',
      viewportHeight: 2,
    });

    widget.handleInput({ type: 'key', key: 'Home' });
    expect(widget.cursorPosition).toEqual({ line: 4, column: 0 });
    widget.handleInput({ type: 'key', key: 'PageUp' });
    expect(widget.cursorPosition.line).toBe(2);
    widget.handleInput({ type: 'key', key: 'ArrowUp' });
    widget.handleInput({ type: 'key', key: 'End' });
    expect(widget.cursorPosition).toEqual({ line: 1, column: 3 });

    widget.handleInput({ type: 'key', key: 'Ctrl+A' });
    expect(widget.selection).toEqual({ start: 0, end: 23 });
    widget.handleInput({ type: 'text', text: 'replacement' });
    expect(widget.value).toBe('replacement');
    widget.handleInput({ type: 'key', key: 'Ctrl+Z' });
    expect(widget.value).toBe('one\ntwo\nthree\nfour\nfive');
    widget.handleInput({ type: 'key', key: 'Ctrl+Shift+Z' });
    expect(widget.value).toBe('replacement');
  });

  it('preserves buffer, cursor, selection, undo history, and scroll across resize', () => {
    const widget = activeWidget({
      id: 'editor-resize',
      label: 'Edit document',
      initialValue: 'a\nb\nc\nd',
      viewportHeight: 2,
    });
    widget.handleInput({ type: 'key', key: 'PageUp' });
    widget.handleInput({ type: 'key', key: 'Shift+Home' });
    const before = {
      value: widget.value,
      cursor: widget.cursor,
      selection: widget.selection,
      scroll: widget.scrollLine,
    };

    widget.resize(24, 3);
    expect({
      value: widget.value,
      cursor: widget.cursor,
      selection: widget.selection,
      scroll: widget.scrollLine,
    }).toEqual(before);
    widget.handleInput({ type: 'text', text: 'x' });
    widget.handleInput({ type: 'key', key: 'Ctrl+Z' });
    expect(widget.value).toBe(before.value);
  });

  it('validates bounds, reports cancel intent, and describes shortcuts in alternate output', () => {
    const widget = activeWidget({
      id: 'editor-validation',
      label: 'Edit summary',
      required: true,
      minLength: 3,
      maxLength: 6,
    });

    expect(widget.handleInput({ type: 'submit' })).toEqual({
      status: 'invalid',
      message: 'A value is required.',
    });
    widget.handleInput({ type: 'text', text: 'abcdef' });
    expect(widget.handleInput({ type: 'text', text: 'g' })).toMatchObject({ status: 'invalid' });
    expect(widget.alternateOutput()).toMatch(/Ctrl\+Enter or Meta\+Enter: submit/i);
    expect(widget.alternateOutput()).toMatch(/Escape or Ctrl-C: cancel/i);
    expect(widget.handleInput({ type: 'key', key: 'Escape' })).toEqual<EditorWidgetResult>({
      status: 'handled',
      output: { type: 'cancel', reason: 'escape' },
    });
  });

  it('redacts sensitive values everywhere except the typed submit intent', () => {
    const widget = activeWidget({
      id: 'editor-secret',
      label: 'Edit private key (content is hidden)',
      sensitive: true,
      initialValue: 'very-secret\nmaterial',
      redactionLabel: 'hidden\u001b[31m key\u001b[0m\u202e',
    });

    expect(JSON.stringify(widget.render())).not.toContain('very-secret');
    expect(widget.alternateOutput()).not.toContain('very-secret');
    expect(widget.alternateOutput()).toContain('hidden key');
    expect(widget.handleInput({ type: 'key', key: 'Ctrl+Enter' })).toEqual<EditorWidgetResult>({
      status: 'handled',
      output: { type: 'submit', value: 'very-secret\nmaterial', sensitive: true },
    });
  });

  it('sanitizes terminal, C1, and bidi controls from metadata and multiline content', () => {
    const widget = activeWidget({
      id: 'editor-adversarial',
      label: 'Edit\u001b[31m notes\u001b[0m\u202e',
      help: 'Help\u009b31m text\u2066',
      initialValue: 'safe\u001b[31mred\u001b[0m\nline\u202E-two\u009b31m',
    });
    const placeholderWidget = activeWidget({
      id: 'editor-adversarial-placeholder',
      label: 'Edit draft',
      placeholder: 'Draft\u001b]8;;https://invalid.example\u0007 link',
    });

    expect(widget.value).toBe('safered\nline-two');
    expect(widget.render().accessibility.label).toBe('Edit notes');
    const rendered = JSON.stringify(widget.render());
    const alternate = widget.alternateOutput();
    expect(`${rendered}${alternate}`).not.toMatch(/[\u001b\u009b\u202e\u2066]/u);
    expect(rendered).toContain('Help text');
    expect(JSON.stringify(placeholderWidget.render())).toContain('Draft link');
  });

  it('caps undo history deterministically for repeated large snapshots', () => {
    const initialValue = `${'a'.repeat(7_990)}00`;
    const widget = activeWidget({
      id: 'editor-history-cap',
      label: 'Edit bounded document',
      initialValue,
      maxLength: 8_192,
    });

    for (let index = 1; index <= 40; index += 1) {
      widget.handleInput({ type: 'key', key: 'Ctrl+A' });
      widget.handleInput({
        type: 'text',
        text: `${'a'.repeat(7_990)}${String(index).padStart(2, '0')}`,
      });
    }
    for (let index = 0; index < 100; index += 1) {
      widget.handleInput({ type: 'key', key: 'Ctrl+Z' });
    }

    expect(widget.value).not.toBe(initialValue);
    expect(widget.value).toHaveLength(7_992);
  });

  it('synchronizes a full native textarea value with a grapheme cursor and clears selection', () => {
    const widget = activeWidget({
      id: 'editor-native-sync',
      label: 'Edit native buffer',
      initialValue: 'old value',
    });
    widget.handleInput({ type: 'key', key: 'Ctrl+A' });

    expect(widget.replaceValue('A👨‍👩‍👧‍👦\r\nB\u001b[31m', 2)).toEqual({ status: 'handled' });
    expect(widget.value).toBe('A👨‍👩‍👧‍👦\nB');
    expect(widget.cursor).toBe(2);
    expect(widget.cursorPosition).toEqual({ line: 0, column: 2 });
    expect(widget.selection).toBeUndefined();

    widget.handleInput({ type: 'key', key: 'Ctrl+Z' });
    expect(widget.value).toBe('old value');
  });

  it('rejects oversize or invalid-cursor native replacements without changing the draft', () => {
    const widget = activeWidget({
      id: 'editor-native-bounds',
      label: 'Edit bounded native buffer',
      initialValue: 'safe',
      maxLength: 5,
    });

    expect(widget.replaceValue('123456')).toEqual({
      status: 'invalid',
      message: 'Enter no more than 5 characters.',
    });
    expect(widget.value).toBe('safe');
    expect(widget.replaceValue('okay', 5)).toMatchObject({ status: 'invalid' });
    expect(widget.value).toBe('safe');
    expect(widget.replaceValue('ok\u001b[31m', 2)).toEqual({ status: 'handled' });
    expect(widget.value).toBe('ok');
  });

  it('does not create undo entries for redundant native synchronization', () => {
    const widget = activeWidget({
      id: 'editor-native-redundant',
      label: 'Edit synchronized buffer',
      initialValue: 'one',
    });

    for (let index = 0; index < 100; index += 1) {
      expect(widget.replaceValue('one', 3)).toEqual({ status: 'handled' });
    }
    widget.replaceValue('two', 3);
    widget.handleInput({ type: 'key', key: 'Ctrl+Z' });
    expect(widget.value).toBe('one');
    widget.handleInput({ type: 'key', key: 'Ctrl+Z' });
    expect(widget.value).toBe('one');
  });

  it('bounds native replacement history and preserves the synchronized value through resize', () => {
    const initialValue = `${'a'.repeat(7_990)}00`;
    const widget = activeWidget({
      id: 'editor-native-history',
      label: 'Edit synchronized document',
      initialValue,
      maxLength: 8_192,
    });

    for (let index = 1; index <= 40; index += 1) {
      widget.replaceValue(`${'a'.repeat(7_990)}${String(index).padStart(2, '0')}`);
    }
    const synchronized = widget.value;
    const cursor = widget.cursor;
    widget.resize(30, 4);
    expect(widget.value).toBe(synchronized);
    expect(widget.cursor).toBe(cursor);

    for (let index = 0; index < 100; index += 1) {
      widget.handleInput({ type: 'key', key: 'Ctrl+Z' });
    }
    expect(widget.value).not.toBe(initialValue);
  });

  it('rejects missing labels, implicit secret capture, destructive confirmation, and invalid bounds', () => {
    expect(() => new EditorWidget({ id: 'editor-no-label', label: '' })).toThrow(WidgetContractError);
    expect(() => new EditorWidget({ id: 'editor-implicit-secret', label: 'Paste your password' }))
      .toThrow(/sensitive/i);
    expect(() => new EditorWidget({
      id: 'editor-destructive',
      label: 'Type DELETE to confirm deleting the repository',
    })).toThrow(/confirm widget/i);
    expect(() => new EditorWidget({
      id: 'editor-bounds',
      label: 'Edit text',
      minLength: 10,
      maxLength: 2,
    })).toThrow(/minLength/i);
  });
});
