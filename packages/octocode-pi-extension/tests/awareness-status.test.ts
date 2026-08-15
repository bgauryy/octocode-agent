import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  parseAwarenessStatus,
  hasAwarenessSignal,
  formatAwarenessPanel,
  refreshAwarenessPanel,
  setAwarenessStatusRunnerForTests,
  resetAwarenessStatusStateForTests,
  type AwarenessStatus,
} from '../src/tools/awareness-status.js';
import type { PiContext } from '../src/types.js';

afterEach(() => resetAwarenessStatusStateForTests());

const FULL = JSON.stringify({
  ok: true,
  active_plans: 1,
  ready_tasks: 3,
  in_progress_tasks: 0,
  verify_tasks: 2,
  pending_runs: 1,
  actionable_refinements: 2,
  all_open_refinements: 5,
  lock_count: 0,
});

test('parseAwarenessStatus maps the compact JSON fields', () => {
  const s = parseAwarenessStatus(FULL)!;
  assert.equal(s.activePlans, 1);
  assert.equal(s.readyTasks, 3);
  assert.equal(s.verifyTasks, 2);
  assert.equal(s.pendingRuns, 1);
  assert.equal(s.actionableRefinements, 2);
  assert.equal(s.openRefinements, 5);
});

test('parseAwarenessStatus returns null on bad JSON or ok:false', () => {
  assert.equal(parseAwarenessStatus('not json'), null);
  assert.equal(parseAwarenessStatus(JSON.stringify({ ok: false })), null);
});

test('hasAwarenessSignal is false only when everything is zero', () => {
  const zero: AwarenessStatus = {
    activePlans: 0, readyTasks: 0, inProgressTasks: 0, verifyTasks: 0,
    pendingRuns: 0, actionableRefinements: 0, openRefinements: 0, lockCount: 0,
  };
  assert.equal(hasAwarenessSignal(zero), false);
  assert.equal(hasAwarenessSignal({ ...zero, readyTasks: 1 }), true);
});

test('formatAwarenessPanel renders counts and surfaces verify-debt', () => {
  const s = parseAwarenessStatus(FULL)!;
  const lines = formatAwarenessPanel(s); // no theme → plain text
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Awareness/);
  assert.match(lines[0]!, /plans 1/);
  assert.match(lines[0]!, /ready 3/);
  assert.doesNotMatch(lines[0]!, /doing 0/); // zero-count segments are dropped
  assert.match(lines[0]!, /refine 2/);       // actionable refinements, not all-open (5)
  assert.match(lines[0]!, /verify-debt 3/);  // verify_tasks 2 + pending_runs 1
});

test('formatAwarenessPanel is empty when there is no signal', () => {
  const zero = parseAwarenessStatus(JSON.stringify({ ok: true }))!;
  assert.deepEqual(formatAwarenessPanel(zero), []);
});

function uiCtx() {
  const widget: Array<{ cleared: boolean; isFn: boolean }> = [];
  const ctx = {
    cwd: '/tmp/aware-ws',
    hasUI: true,
    ui: {
      setWidget: (_name: string, content: unknown) =>
        widget.push({ cleared: content === undefined, isFn: typeof content === 'function' }),
      setStatus: () => {},
    },
  } as unknown as PiContext;
  return { ctx, widget };
}

test('refreshAwarenessPanel renders a widget from the async runner result', async () => {
  process.env.OCTOCODE_AWARENESS_CLI = '/fake/cli.js';
  let calls = 0;
  setAwarenessStatusRunnerForTests(async () => { calls++; return FULL; });
  const { ctx, widget } = uiCtx();
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, 'runner invoked once');
  assert.ok(widget.some((w) => w.isFn && !w.cleared), 'a below-editor widget was rendered');
});

test('refreshAwarenessPanel throttles repeated calls within the window', async () => {
  process.env.OCTOCODE_AWARENESS_CLI = '/fake/cli.js';
  let calls = 0;
  setAwarenessStatusRunnerForTests(async () => { calls++; return FULL; });
  const { ctx } = uiCtx();
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  refreshAwarenessPanel(ctx); // within 8s window
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, 'subsequent calls within the window do not re-run the CLI');
});

test('refreshAwarenessPanel is a no-op without the CLI env var', () => {
  delete process.env.OCTOCODE_AWARENESS_CLI;
  const { ctx, widget } = uiCtx();
  refreshAwarenessPanel(ctx);
  assert.equal(widget.length, 0, 'no widget calls when CLI is unavailable');
});
