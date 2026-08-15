import assert from 'node:assert/strict';
import { test } from 'vitest';
import { collapseSection, modelPanelLines } from '../src/tools/status-panel.js';
import type { PiContext } from '../src/types.js';

test('collapseSection keeps short sections unchanged', () => {
  const s = ['Header', 'a', 'b', 'c'];
  assert.deepEqual(collapseSection(s, 12, 'steps'), s);
});

test('collapseSection trims to header + maxRows + a "… N more" line', () => {
  const rows = Array.from({ length: 15 }, (_, i) => `row ${i + 1}`);
  const out = collapseSection(['Plan', ...rows], 12, 'steps');
  assert.equal(out.length, 14, 'header + 12 rows + 1 more-line');
  assert.equal(out[0], 'Plan');
  assert.equal(out[12], 'row 12', 'last shown row');
  assert.equal(out.at(-1), '… 3 more steps');
});

test('modelPanelLines shows provider/id and thinking for the main agent model', () => {
  const ctx = { model: { id: 'claude-haiku-4-5-20251001', provider: 'guy-provider-anthropic', reasoning: true } } as PiContext;
  const lines = modelPanelLines(ctx);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /model: guy-provider-anthropic\/claude-haiku-4-5-20251001/);
  assert.match(lines[0]!, /thinking/);
});

test('modelPanelLines omits provider prefix and thinking when absent', () => {
  const lines = modelPanelLines({ model: { id: 'grok-4.6' } } as PiContext);
  assert.deepEqual(lines, ['model: grok-4.6']);
});

test('modelPanelLines is empty when the model is unknown', () => {
  assert.deepEqual(modelPanelLines(undefined), []);
  assert.deepEqual(modelPanelLines({} as PiContext), []);
});

test('collapseSection boundary: exactly maxRows rows is not collapsed', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `r${i}`);
  const out = collapseSection(['H', ...rows], 12, 'steps');
  assert.equal(out.length, 13);
  assert.doesNotMatch(out.at(-1)!, /more/);
});
