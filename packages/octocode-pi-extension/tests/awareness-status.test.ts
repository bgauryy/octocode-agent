import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  parseAwarenessStatus,
  hasAwarenessSignal,
  formatAwarenessPanel,
  refreshAwarenessPanel,
  setAwarenessStatusRunnerForTests,
  resetAwarenessStatusStateForTests,
  forceAwarenessStatusRefreshForTests,
  type AwarenessStatus,
} from '../src/tools/awareness-status.js';
import type { PiContext } from '../src/types.js';

afterEach(() => resetAwarenessStatusStateForTests());

const FULL = JSON.stringify({
  plans: 3,
  activePlans: 1,
  tasks: 7,
  readyTasks: 2,
  inProgressTasks: 1,
  locks: 2,
  work: 1,
  pendingChecks: 4,
  verifyTasks: 4,
  agents: 2,
  messages: 5,
});

test('parseAwarenessStatus maps the Lite status JSON fields', () => {
  const s = parseAwarenessStatus(FULL)!;
  assert.equal(s.activePlans, 1);
  assert.equal(s.readyTasks, 2);
  assert.equal(s.inProgressTasks, 1);
  assert.equal(s.verifyTasks, 4);
  assert.equal(s.lockCount, 2);
  assert.equal(s.workCount, 1);
  assert.equal(s.agentCount, 2);
  assert.equal(s.messageCount, 5);
});

test('parseAwarenessStatus falls back to legacy Lite status totals', () => {
  const s = parseAwarenessStatus(JSON.stringify({ plans: 1, tasks: 3, pendingChecks: 2 }))!;
  assert.equal(s.activePlans, 1);
  assert.equal(s.readyTasks, 3);
  assert.equal(s.inProgressTasks, 0);
  assert.equal(s.verifyTasks, 2);
});

test('parseAwarenessStatus returns null on bad JSON', () => {
  assert.equal(parseAwarenessStatus('not json'), null);
});

test('hasAwarenessSignal is false only when everything is zero', () => {
  const zero: AwarenessStatus = {
    activePlans: 0, readyTasks: 0, inProgressTasks: 0, verifyTasks: 0,
    lockCount: 0, workCount: 0, agentCount: 0, messageCount: 0,
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
  assert.match(lines[0]!, /ready 2/);
  assert.match(lines[0]!, /doing 1/);
  assert.doesNotMatch(lines[0]!, /tasks 7/); // total task count is not mislabeled as actionable ready work
  assert.match(lines[0]!, /locks 2/);
  assert.match(lines[0]!, /work 1/);
  assert.doesNotMatch(lines[0]!, /agents 2/); // shown in the lower toolbar, not the below-editor panel
  assert.match(lines[0]!, /peer-msgs 5/);
  assert.match(lines[0]!, /verify-debt 4/);
});

test('formatAwarenessPanel is empty when there is no signal', () => {
  const zero = parseAwarenessStatus(JSON.stringify({}))!;
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
  delete process.env.OCTOCODE_AWARENESS_CLI;
  let calls = 0;
  setAwarenessStatusRunnerForTests(async () => { calls++; return FULL; });
  const { ctx, widget } = uiCtx();
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, 'runner invoked once');
  assert.ok(widget.some((w) => w.isFn && !w.cleared), 'a below-editor widget was rendered');
});

test('refreshAwarenessPanel throttles repeated calls within the window', async () => {
  delete process.env.OCTOCODE_AWARENESS_CLI;
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

test('refreshAwarenessPanel clears stale cached status when the async runner fails', async () => {
  delete process.env.OCTOCODE_AWARENESS_CLI;
  let calls = 0;
  setAwarenessStatusRunnerForTests(async () => (calls++ === 0 ? FULL : null));
  const { ctx, widget } = uiCtx();
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(widget.some((w) => w.isFn && !w.cleared), 'first successful refresh renders a widget');

  forceAwarenessStatusRefreshForTests(ctx.cwd!);
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(widget.some((w) => w.cleared), 'failed refresh clears the unified widget instead of keeping stale Awareness status');
});

test('refreshAwarenessPanel still runs without the CLI env var', async () => {
  delete process.env.OCTOCODE_AWARENESS_CLI;
  let calls = 0;
  setAwarenessStatusRunnerForTests(async () => { calls++; return FULL; });
  const { ctx } = uiCtx();
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, 'local package runner is invoked without OCTOCODE_AWARENESS_CLI');
});
