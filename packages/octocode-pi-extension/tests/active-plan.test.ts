import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { Type } from 'typebox';
import type { ToolDefinition } from '../src/types.js';
import {
  setPlan, addStep, startStep, completeStep, clearPlan, getPlan, renderActivePlanAddendum,
} from '../src/tools/active-plan.js';
import { registerPlanTool, refreshPlanUi, handleOctocodePlanCommand, buildPlanWidget, startPlanAnimation, stopPlanAnimation } from '../src/tools/plan-tool.js';
import type { PiContext } from '../src/types.js';

// Minimal UI spy for widget/status/notify assertions.
function uiCtx(cwd: string) {
  const calls = { widget: [] as unknown[], status: [] as unknown[], notify: [] as string[] };
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      setWidget: (name: string, content: unknown) => calls.widget.push({ name, cleared: content === undefined }),
      setStatus: (name: string, text: unknown) => calls.status.push({ name, text }),
      notify: (msg: string) => calls.notify.push(msg),
    },
  } as unknown as PiContext;
  return { ctx, calls };
}

const CWD = '/tmp/plan-test-ws';
afterEach(() => clearPlan(CWD));

test('empty plan renders no addendum (zero token cost)', () => {
  assert.equal(renderActivePlanAddendum(CWD), '');
});

test('setPlan marks the first step doing, rest todo', () => {
  const steps = setPlan(CWD, ['a', 'b', 'c']);
  assert.deepEqual(steps.map((s) => s.status), ['doing', 'todo', 'todo']);
});

test('complete advances the next todo to doing and counts done', () => {
  setPlan(CWD, ['a', 'b', 'c']);
  completeStep(CWD, 1);
  const s = getPlan(CWD);
  assert.equal(s[0]!.status, 'done');
  assert.equal(s[1]!.status, 'doing'); // auto-advanced
  assert.match(renderActivePlanAddendum(CWD), /1\/3 done/);
});

test('addStep appends a todo; start marks doing', () => {
  setPlan(CWD, ['a']);
  addStep(CWD, 'b');
  startStep(CWD, 2);
  assert.deepEqual(getPlan(CWD).map((s) => s.status), ['doing', 'doing']);
});

test('addendum shows markers and a next-step line', () => {
  setPlan(CWD, ['first', 'second']);
  const out = renderActivePlanAddendum(CWD);
  assert.match(out, /^<active_plan>/);
  assert.match(out, /\[~\] 1\. first/);
  assert.match(out, /\[ \] 2\. second/);
  assert.match(out, /next: first/);
  assert.match(out, /<\/active_plan>$/);
});

test('clear removes the plan', () => {
  setPlan(CWD, ['a']);
  clearPlan(CWD);
  assert.equal(getPlan(CWD).length, 0);
  assert.equal(renderActivePlanAddendum(CWD), '');
});

test('long step text is truncated and the list is capped', () => {
  const many = Array.from({ length: 60 }, (_v, i) => `step ${i}`);
  const steps = setPlan(CWD, [...many, 'x'.repeat(400)]);
  assert.ok(steps.length <= 40, 'capped');
});

// ─── tool wrapper ─────────────────────────────────────────────────────────────
function loadTool(): ToolDefinition {
  const tools = new Map<string, ToolDefinition>();
  const pi = { registerTool: (d: ToolDefinition) => tools.set(d.name, d) };
  registerPlanTool(pi, Type, new Set<string>(), (p, n, d) => { n.add(d.name); p.registerTool?.(d); });
  return tools.get('plan')!;
}

test('buildPlanWidget renders progress bar, glyphs, spinner, and a next line', () => {
  const steps = [
    { text: 'research', status: 'done' as const },
    { text: 'implement', status: 'doing' as const },
    { text: 'test', status: 'todo' as const },
  ];
  const out = buildPlanWidget(steps, { frame: 0 }).join('\n');
  assert.match(out, /Octocode plan/);
  assert.match(out, /[\u25b0]+[\u25b1]+\s+1\/3/); // progress bar ▰▱ + 1/3
  assert.match(out, /\u2713 1\. research/); // done glyph ✓
  assert.match(out, /1\. research/);
  assert.match(out, /2\. implement/); // doing row (spinner glyph precedes)
  assert.match(out, /\u25cb 3\. test/); // todo glyph ○
  assert.match(out, /\u21b3 next: implement/); // ↳ next
});

test('buildPlanWidget spinner frame advances the in-progress glyph', () => {
  const steps = [{ text: 'x', status: 'doing' as const }];
  const a = buildPlanWidget(steps, { frame: 0 })[1];
  const b = buildPlanWidget(steps, { frame: 1 })[1];
  assert.notEqual(a, b, 'spinner glyph changes with the frame');
});

test('buildPlanWidget is empty for no steps', () => {
  assert.deepEqual(buildPlanWidget([]), []);
});

test('idle-tick animation ticks while a step is doing and self-stops when work ends', () => {
  vi.useFakeTimers();
  const cwd = '/tmp/plan-anim-ws';
  try {
    let renders = 0;
    const tui = { requestRender: () => { renders += 1; } };
    setPlan(cwd, ['a', 'b']); // step 1 is doing
    startPlanAnimation(cwd, tui, 100);
    startPlanAnimation(cwd, tui, 100); // idempotent — no second timer
    vi.advanceTimersByTime(350);
    assert.ok(renders >= 3, `spinner ticks while doing, got ${renders}`);
    // Completing all steps → next tick self-stops (no doing step).
    completeStep(cwd, 1);
    completeStep(cwd, 2);
    const before = renders;
    vi.advanceTimersByTime(500);
    assert.equal(renders, before, 'animation self-stops once no step is doing');
  } finally {
    stopPlanAnimation();
    clearPlan(cwd);
    vi.useRealTimers();
  }
});

test('startPlanAnimation is a no-op without a doing step or requestRender', () => {
  vi.useFakeTimers();
  try {
    setPlan('/tmp/anim-none', ['x']);
    completeStep('/tmp/anim-none', 1); // no doing step
    let n = 0;
    startPlanAnimation('/tmp/anim-none', { requestRender: () => { n += 1; } }, 50);
    startPlanAnimation('/tmp/anim-none2', undefined, 50); // no tui
    vi.advanceTimersByTime(300);
    assert.equal(n, 0);
  } finally {
    stopPlanAnimation();
    clearPlan('/tmp/anim-none');
    vi.useRealTimers();
  }
});

test('refreshPlanUi sets a below-editor widget + footer when a plan exists, clears when empty', () => {
  const { ctx, calls } = uiCtx('/tmp/plan-ui-ws');
  setPlan('/tmp/plan-ui-ws', ['a', 'b']);
  refreshPlanUi(ctx);
  assert.ok(calls.widget.some((w) => (w as { cleared: boolean }).cleared === false), 'widget set');
  assert.ok(calls.status.some((s) => String((s as { text: unknown }).text).includes('plan 0/2')), 'footer set');
  clearPlan('/tmp/plan-ui-ws');
  refreshPlanUi(ctx);
  assert.ok(calls.widget.some((w) => (w as { cleared: boolean }).cleared === true), 'widget cleared when empty');
});

test('/octocode-plan command completes a step and clears the plan', async () => {
  const cwd = '/tmp/plan-cmd-ws';
  setPlan(cwd, ['x', 'y']);
  const { ctx, calls } = uiCtx(cwd);
  await handleOctocodePlanCommand('complete 1', ctx, (_c, m) => calls.notify.push(m));
  assert.equal(getPlan(cwd)[0]!.status, 'done');
  await handleOctocodePlanCommand('clear', ctx, (_c, m) => calls.notify.push(m));
  assert.equal(getPlan(cwd).length, 0);
  assert.ok(calls.notify.some((m) => /cleared/i.test(m)));
});

test('plan tool set→complete→show drives the checklist and returns the addendum', async () => {
  const tool = loadTool();
  const ctx = { cwd: '/tmp/plan-tool-ws' } as unknown as import('../src/types.js').PiContext;
  await tool.execute('id', { action: 'set', steps: ['one', 'two'] }, undefined, undefined, ctx);
  const res = (await tool.execute('id', { action: 'complete', index: 1 }, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>; details: { steps: Array<{ status: string }>; addendum: string };
  };
  assert.match(res.content[0]!.text, /1\/2 done/);
  assert.equal(res.details.steps[0]!.status, 'done');
  assert.match(res.details.addendum, /<active_plan>/);
  clearPlan('/tmp/plan-tool-ws');
});
