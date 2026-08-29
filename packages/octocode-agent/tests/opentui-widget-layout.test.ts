import { describe, expect, it } from 'vitest';

import {
  fitTerminalText,
  terminalDisplayWidth,
} from '../src/terminal/opentui/widgets/layout.js';

describe('terminal widget layout', () => {
  it('measures combining marks, wide glyphs, and emoji by terminal columns', () => {
    expect(terminalDisplayWidth('e\u0301')).toBe(1);
    expect(terminalDisplayWidth('界')).toBe(2);
    expect(terminalDisplayWidth('👩‍💻')).toBe(2);
  });

  it('fits only at grapheme boundaries and reserves the ellipsis column', () => {
    expect(fitTerminalText('ab界cd', 5)).toBe('ab界…');
    expect(fitTerminalText('👩‍💻 work', 4)).toBe('👩‍💻 …');
    expect(fitTerminalText('anything', 1)).toBe('…');
    expect(fitTerminalText('anything', 0)).toBe('');
  });

  it('rejects invalid viewport widths', () => {
    expect(() => fitTerminalText('text', -1)).toThrow('non-negative integer');
    expect(() => fitTerminalText('text', 1.5)).toThrow('non-negative integer');
  });
});
