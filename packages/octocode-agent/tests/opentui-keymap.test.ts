import { describe, expect, it } from 'vitest';

import {
  composerKeyBindings,
  resolveOpenTuiKeyAction,
} from '../src/terminal/opentui/keymap.js';

describe('OpenTUI keymap precedence', () => {
  it('keeps multiline composer editing local and submits only with Ctrl/Meta-Enter', () => {
    expect(composerKeyBindings()).toEqual(expect.arrayContaining([
      { name: 'return', action: 'newline' },
      { name: 'return', ctrl: true, action: 'submit' },
      { name: 'return', meta: true, action: 'submit' },
    ]));
  });

  it('gives completion and modal controls precedence over global focus navigation', () => {
    expect(resolveOpenTuiKeyAction({ name: 'tab' }, { assistOpen: true })).toBe('assist-accept');
    expect(resolveOpenTuiKeyAction({ name: 'escape' }, { assistOpen: true })).toBe('assist-dismiss');
    expect(resolveOpenTuiKeyAction({ name: 'tab' }, { interaction: 'confirm' })).toBe('interaction-navigate');
    expect(resolveOpenTuiKeyAction({ name: 'escape' }, { interaction: 'select' })).toBe('interaction-cancel');
    expect(resolveOpenTuiKeyAction(
      { name: 'd', ctrl: true },
      { interaction: 'input', discussAvailable: true },
    )).toBe('interaction-discuss');
  });

  it('normalizes aliases while preserving interrupt and focus semantics', () => {
    expect(resolveOpenTuiKeyAction({ name: 'c', ctrl: true }, {})).toBe('interrupt');
    expect(resolveOpenTuiKeyAction({ name: 'tab', shift: true }, {})).toBe('focus-previous');
    expect(resolveOpenTuiKeyAction({ name: 'tab' }, {})).toBe('focus-next');
    expect(resolveOpenTuiKeyAction({ name: 'arrowup' }, { semanticSurfaceFocused: true })).toBe('surface-navigate');
    expect(resolveOpenTuiKeyAction({ name: 'k' }, { semanticSurfaceFocused: true })).toBe('surface-navigate');
  });
});
