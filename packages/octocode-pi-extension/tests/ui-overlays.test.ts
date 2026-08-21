import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PiTheme } from '../src/types.js';
import { octocodeSelectListTheme, applyFilterKey, selectItemMatchesFilter } from '../src/tools/ui-overlays.js';

const theme = {
  fg: (color: string, t: string) => `<${color}>${t}</${color}>`,
  bold: (t: string) => `*${t}*`,
} as unknown as PiTheme;

test('octocodeSelectListTheme returns all five SelectList theme functions', () => {
  const t = octocodeSelectListTheme(theme);
  for (const key of ['selectedPrefix', 'selectedText', 'description', 'scrollInfo', 'noMatch'] as const) {
    assert.equal(typeof t[key], 'function', `${key} must be a function`);
  }
});

test('octocodeSelectListTheme maps to accent/muted/dim/warning colors', () => {
  const t = octocodeSelectListTheme(theme);
  assert.match(t.selectedPrefix('x'), /<accent>/);
  assert.match(t.selectedText('x'), /<accent>/);
  assert.match(t.description('x'), /<muted>/);
  assert.match(t.scrollInfo('x'), /<dim>/);
  assert.match(t.noMatch('x'), /<warning>/);
});

test('octocodeSelectListTheme is identity-safe without a theme', () => {
  const t = octocodeSelectListTheme(undefined);
  assert.equal(t.selectedText('plain'), 'plain');
  assert.equal(t.description('d'), 'd');
});

test('applyFilterKey appends printable characters', () => {
  assert.deepEqual(applyFilterKey('oct', 'o'), { buffer: 'octo', changed: true });
  assert.deepEqual(applyFilterKey('', 'a'), { buffer: 'a', changed: true });
  assert.deepEqual(applyFilterKey('ab', ' '), { buffer: 'ab ', changed: true });
});

test('applyFilterKey removes the last char on backspace (\\x7f and \\b)', () => {
  assert.deepEqual(applyFilterKey('octo', '\x7f'), { buffer: 'oct', changed: true });
  assert.deepEqual(applyFilterKey('oct', '\b'), { buffer: 'oc', changed: true });
  assert.deepEqual(applyFilterKey('', '\x7f'), { buffer: '', changed: false });
});

test('applyFilterKey ignores navigation/control keys (arrows, enter, esc)', () => {
  for (const key of ['\r', '\n', '\x1b', '\x1b[A', '\x1b[B', '\x03', '\t']) {
    assert.deepEqual(applyFilterKey('oct', key), { buffer: 'oct', changed: false }, `key ${JSON.stringify(key)} must not change buffer`);
  }
});

test('selectItemMatchesFilter matches the visible label/description, not just internal values', () => {
  const item = { value: 'cmd:/octocode-status', label: '/octocode-status', description: 'Show the Octocode dashboard' };
  // What the user SEES must match…
  assert.ok(selectItemMatchesFilter(item, 'status'));
  assert.ok(selectItemMatchesFilter(item, 'DASHBOARD'));
  // …value still matches for power users, and empty filter passes everything.
  assert.ok(selectItemMatchesFilter(item, 'cmd:'));
  assert.ok(selectItemMatchesFilter(item, '  '));
  assert.ok(!selectItemMatchesFilter(item, 'zzz'));
  // SHA-valued checkpoint items match by their visible date label.
  const checkpoint = { value: 'a1b2c3d', label: '2026-08-21 14:02 — fix banner' };
  assert.ok(selectItemMatchesFilter(checkpoint, 'fix banner'));
});
