import { describe, expect, it } from 'vitest';

import {
  TerminalTextValidationError,
  assertStableTerminalId,
  redactCommonCredentials,
  sanitizeMultilineText,
  sanitizeSingleLineText,
  truncateGraphemes,
} from '../src/terminal/opentui/widgets/sanitize.js';

describe('OpenTUI widget text sanitization', () => {
  it('strips terminal escape families, controls, newlines, and bidi spoofing from one line', () => {
    const unsafe = [
      '\u001b[31mred\u001b[0m',
      '\u001b]0;stolen title\u0007safe',
      '\u001bPprivate payload\u001b\\after-dcs',
      '\u001b_apc payload\u001b\\after-apc',
      '\u001b^pm payload\u001b\\after-pm',
      '\u001bXsos payload\u001b\\after-sos',
      '\u001b7after-esc',
      'line\r\nnext\tvalue\u0000',
      'trusted\u202eexe.txt\u2066isolated\u2069',
    ].join('|');

    expect(sanitizeSingleLineText(unsafe, { tabWidth: 1 })).toBe(
      'red|safe|after-dcs|after-apc|after-pm|after-sos|after-esc|linenext value|trustedexe.txtisolated',
    );
  });

  it('normalizes multiline newlines and configured tabs while stripping every other control', () => {
    expect(sanitizeMultilineText('one\r\ntwo\rthree\tfour\u0085five', { tabWidth: 3 })).toBe(
      'one\ntwo\nthree   fourfive',
    );
    expect(sanitizeMultilineText('a\tb', { tabWidth: 0 })).toBe('ab');
  });

  it('strips C1 forms and unterminated terminal string sequences through end of input', () => {
    expect(sanitizeSingleLineText('before\u009b31mred\u009b0mafter')).toBe('beforeredafter');
    expect(sanitizeSingleLineText('visible\u009dmalicious title')).toBe('visible');
    expect(sanitizeSingleLineText('visible\u001bPmalicious device command')).toBe('visible');
  });

  it('truncates by grapheme cluster and reserves room for the explicit ellipsis', () => {
    expect(truncateGraphemes('A👨‍👩‍👧‍👦e\u0301Z', 3)).toBe('A👨‍👩‍👧‍👦…');
    expect(truncateGraphemes('abcdef', 4, '[…]')).toBe('a[…]');
    expect(truncateGraphemes('abcdef', 0)).toBe('');
    expect(truncateGraphemes('ok', 4)).toBe('ok');
  });

  it('bounds sanitized single- and multiline values by grapheme count', () => {
    expect(sanitizeSingleLineText('A👩🏽‍💻BC', { maxGraphemes: 3 })).toBe('A👩🏽‍💻…');
    expect(sanitizeMultilineText('a\nb\nc', { maxGraphemes: 4 })).toBe('a\nb…');
  });

  it('optionally redacts common credentials without changing ordinary text', () => {
    expect(
      redactCommonCredentials(
        'Bearer abc.def api_key=secret password: hunter2 github_pat_abcdefghijklmnopqrstuvwxyz npm_abcdefghijklmnop',
      ),
    ).toBe('Bearer [REDACTED] api_key=[REDACTED] password: [REDACTED] [REDACTED] [REDACTED]');
    expect(sanitizeSingleLineText('token=private note=public', { redactCredentials: true })).toBe(
      'token=[REDACTED] note=public',
    );
    expect(sanitizeSingleLineText('ordinary terminal status')).toBe('ordinary terminal status');
  });

  it('validates stable IDs and rejects unsafe or overlong IDs instead of truncating', () => {
    expect(assertStableTerminalId('prompt-input:primary')).toBe('prompt-input:primary');
    expect(() => assertStableTerminalId(' bad ')).toThrow(TerminalTextValidationError);
    expect(() => assertStableTerminalId('safe\u001b[31m')).toThrow(/terminal control/i);
    expect(() => assertStableTerminalId('a'.repeat(65))).toThrow(/64/);
    expect(() => assertStableTerminalId('two words')).toThrow(/stable ID/i);
  });

  it('rejects invalid bounds and tab widths', () => {
    expect(() => sanitizeSingleLineText('value', { maxGraphemes: -1 })).toThrow(/maxGraphemes/);
    expect(() => sanitizeSingleLineText('value', { tabWidth: 17 })).toThrow(/tabWidth/);
    expect(() => sanitizeSingleLineText('long value', { maxGraphemes: 3, ellipsis: '\u001b[31m…' })).toThrow(
      /ellipsis/i,
    );
    expect(() => truncateGraphemes('value', 1.5)).toThrow(/maxGraphemes/);
  });
});
