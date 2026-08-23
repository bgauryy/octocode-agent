import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { collapseSection, composeStatusPanelLines, modelPanelLines, resetStatusPanelStateForTests } from '../src/tools/status-panel.js';
import { clearPlan, setPlan } from '../src/tools/active-plan.js';
import { refreshPlanUi } from '../src/tools/plan-tool.js';
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

test('modelPanelLines shows only provider/id — pi already shows the bare id and thinking flag', () => {
  const ctx = { model: { id: 'claude-haiku-4-5-20251001', provider: 'guy-provider-anthropic', reasoning: true } } as PiContext;
  const lines = modelPanelLines(ctx);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /model: guy-provider-anthropic\/claude-haiku-4-5-20251001/);
  assert.doesNotMatch(lines[0]!, /thinking/, 'thinking lives in the octocode-thinking status, not here');
});

test('modelPanelLines is empty without a provider (pi already shows the bare id)', () => {
  assert.deepEqual(modelPanelLines({ model: { id: 'grok-4.6' } } as PiContext), []);
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

const THEME = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
const STATUS_CWD = '/tmp/status-panel-test-ws';

afterEach(() => {
  clearPlan(STATUS_CWD);
  resetStatusPanelStateForTests();
});

function uiCtx(cwd = STATUS_CWD): { ctx: PiContext; calls: Array<{ name: string; cleared: boolean; isFn: boolean; content: unknown }> } {
  const calls: Array<{ name: string; cleared: boolean; isFn: boolean; content: unknown }> = [];
  const ctx = {
    cwd,
    hasUI: true,
    model: { id: 'claude-test', provider: 'test-provider' },
    ui: {
      setWidget: (name: string, content: unknown) => calls.push({ name, cleared: content === undefined, isFn: typeof content === 'function', content }),
    },
  } as unknown as PiContext;
  return { ctx, calls };
}

test('status panel renderer shrinks with volatile sections instead of retaining blank rows', () => {
  const { ctx, calls } = uiCtx();
  setPlan(STATUS_CWD, Array.from({ length: 6 }, (_, i) => `step ${i + 1}`));
  refreshPlanUi(ctx);
  const registration = calls.find((call) => call.name === 'octocode-status-panel' && call.isFn)!;
  const factory = registration.content as (tui: unknown, theme: unknown) => { render(width: number): string[] };
  const renderer = factory({ requestRender: () => undefined }, THEME);

  const tall = renderer.render(100);
  assert.ok(tall.length > 2, 'active plan makes the panel taller than the model-only baseline');

  setPlan(STATUS_CWD, ['one remaining step']);
  const shorterVolatile = renderer.render(100);
  assert.ok(shorterVolatile.length < tall.length, 'volatile panel contracts to its current content height');
  assert.equal(shorterVolatile.some((line) => line === ''), false, 'the panel does not synthesize blank padding rows');

  clearPlan(STATUS_CWD);
  const modelOnly = renderer.render(100);
  assert.equal(modelOnly.length, 1, 'model-only baseline resets the remembered volatile height');
});

test('status panel composes the current branch plan at render time, not registration time', () => {
  const { ctx } = uiCtx();
  setPlan(STATUS_CWD, ['initial plan']);
  const initial = composeStatusPanelLines(ctx, THEME, 100).lines.join('\n');
  assert.match(initial, /initial plan/);

  setPlan(STATUS_CWD, ['compaction restored plan']);
  const afterMutation = composeStatusPanelLines(ctx, THEME, 100).lines.join('\n');
  assert.match(afterMutation, /compaction restored plan/);
  assert.doesNotMatch(afterMutation, /initial plan/);
});

test('status panel does not register a blank model widget when provider is unknown', () => {
  const { calls } = uiCtx();
  const ctx = { cwd: STATUS_CWD, hasUI: true, model: { id: 'claude-test' }, ui: { setWidget: (name: string, content: unknown) => calls.push({ name, cleared: content === undefined, isFn: typeof content === 'function', content }) } } as unknown as PiContext;
  refreshPlanUi(ctx);
  assert.ok(calls.some((call) => call.name === 'octocode-status-panel' && call.cleared), 'provider-less model clears instead of painting an empty widget');
  assert.equal(calls.some((call) => call.isFn), false, 'no blank renderer is registered');
});
