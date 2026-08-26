import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CURSOR_MARKER } from '@earendil-works/pi-tui';
import { closeFrameLines, renderFrame, renderInlineRows, renderStack } from '../src/tui/components.js';
import { visibleWidth } from '../src/tools/render-helpers.js';

test('renderFrame closes and aligns every border at narrow and wide widths', () => {
  for (const width of [2, 3, 18, 32, 64, 100]) {
    const lines = renderFrame({
      title: '◆ Input needed · 2 of 3',
      body: ['Which renderer should own the footer?', '› Zustand-backed component'],
      footer: 'enter confirm · esc cancel',
    }, { width });
    assert.ok(lines[0]?.startsWith('╭'));
    assert.ok(lines[0]?.endsWith('╮'));
    assert.ok(lines.at(-1)?.startsWith('╰'));
    assert.ok(lines.at(-1)?.endsWith('╯'));
    for (const line of lines) assert.equal(visibleWidth(line), width, `${width}: ${line}`);
    for (const line of lines.slice(1, -1)) {
      assert.ok(line.startsWith('│'));
      assert.ok(line.endsWith('│'));
    }
  }
});

test('all frame edge permutations remain closed, including the one-cell fallback', () => {
  assert.deepEqual(renderFrame({ title: 'x', body: ['y'], footer: 'z' }, { width: 1 }), ['╭']);
  const closed = closeFrameLines({ lines: ['╭─ title ', '│ body', '╰─ footer '] }, { width: 24 });
  assert.equal(closed.length, 3);
  assert.ok(closed[0]!.endsWith('╮'));
  assert.ok(closed[1]!.endsWith('│'));
  assert.ok(closed[2]!.endsWith('╯'));
  for (const line of closed) assert.equal(visibleWidth(line), 24);
});

test('legacy interactive frames preserve the cursor marker and close the right rail', () => {
  const lines = closeFrameLines({
    lines: [`│ answer ${CURSOR_MARKER}draft`, '╰─ enter confirm '],
  }, { width: 28 });
  assert.ok(lines[0]!.includes(CURSOR_MARKER));
  assert.ok(lines[0]!.endsWith('╮'));
  assert.ok(lines[1]!.endsWith('╯'));
  for (const line of lines) assert.equal(visibleWidth(line.replace(CURSOR_MARKER, '')), 28);
});

test('renderFrame remains cell-perfect with ANSI, emoji, CJK, and tabs', () => {
  const lines = renderFrame({
    title: '\x1b[36m界面 ⭐\x1b[0m',
    body: ['agent\tworking 👨‍👩‍👧‍👦', '長い説明'],
    footer: 'ready ✓',
  }, { width: 30 });
  assert.equal(lines.length, 4);
  for (const line of lines) assert.equal(visibleWidth(line), 30);
});

test('renderInlineRows wraps complete segments instead of clipping the important tail', () => {
  const rows = renderInlineRows({
    segments: [
      { text: 'context ▓▓▓▓▓▓▓░ 92% · 184k/200k', attention: true },
      { text: 'agents 4 (2 live)' },
      { text: 'blocked 1', attention: true },
      { text: 'failed 1', attention: true },
    ],
  }, { width: 34 });
  assert.ok(rows.length > 1);
  assert.match(rows.join('\n'), /blocked 1/);
  assert.match(rows.join('\n'), /failed 1/);
  for (const line of rows) assert.ok(visibleWidth(line) <= 34);
});

test('renderStack composes component output without blank padding', () => {
  assert.deepEqual(renderStack({ sections: [['one'], [], ['two', 'three']] }, { width: 20 }), ['one', 'two', 'three']);
});

test('every primitive is width-safe across pathological terminal sizes', () => {
  for (const width of [1, 2, 8, 24, 80, 160]) {
    const lines = [
      ...renderInlineRows({ segments: [{ text: 'model gpt-5.6' }, { text: 'context 199k/200k', attention: true }] }, { width }),
      ...renderStack({ sections: [['Plan'], ['▶ running task'], ['Awareness · verify-debt 2']] }, { width }),
      ...renderFrame({ title: 'Tool result', body: ['✓ [0] success', '✗ [1] failed'], footer: 'parallel' }, { width }),
    ];
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
});
