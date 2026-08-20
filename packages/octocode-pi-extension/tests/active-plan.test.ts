import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { Type } from 'typebox';
import type { ToolDefinition } from '../src/types.js';
import {
  setPlan, addStep, startStep, completeStep, clearPlan, getPlan, renderActivePlanAddendum,
  bumpPlanTurn, STALE_PLAN_TURNS, readPersistedPlanForTests, depsMet, displayStatus,
  activePlanScope, adoptPlanFromBranch, setPlanEntryAppender, PLAN_ENTRY_TYPE,
} from '../src/tools/active-plan.js';
import { registerPlanTool, refreshPlanUi, handleOctocodePlanCommand } from '../src/tools/plan-tool.js';
import type { PiContext } from '../src/types.js';

// Minimal UI spy for widget/status/notify assertions.
function uiCtx(cwd: string) {
  const calls = { widget: [] as unknown[], status: [] as unknown[], notify: [] as string[] };
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      setWidget: (name: string, content: unknown, opts?: unknown) =>
        calls.widget.push({ name, cleared: content === undefined, isFn: typeof content === 'function', opts, content }),
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

test('setPlan accepts {text, activeForm} objects and bare strings interchangeably', () => {
  const steps = setPlan(CWD, [{ text: 'Edit file', activeForm: 'Editing file' }, 'Run tests']);
  assert.equal(steps[0]!.text, 'Edit file');
  assert.equal(steps[0]!.activeForm, 'Editing file');
  assert.equal(steps[1]!.activeForm, undefined);
  // The current-step hint prefers the activeForm label.
  assert.match(renderActivePlanAddendum(CWD), /next: Editing file/);
});

test('addStep can carry an activeForm label', () => {
  setPlan(CWD, ['a']);
  const steps = addStep(CWD, 'Deploy', 'Deploying');
  assert.equal(steps[1]!.activeForm, 'Deploying');
});

test('a step with unmet dependencies shows as blocked, then unblocks when the dep is done', () => {
  const cwd = '/tmp/plan-deps-ws';
  setPlan(cwd, ['First', { text: 'Second', dependsOn: [1] }]);
  let list = getPlan(cwd);
  assert.equal(displayStatus(list[1]!, list), 'blocked');
  assert.equal(depsMet(list[1]!, list), false);
  completeStep(cwd, 1); // step 1 done → step 2 unblocks and auto-advances to doing
  list = getPlan(cwd);
  assert.equal(list[1]!.status, 'doing');
  assert.equal(displayStatus(list[1]!, list), 'doing');
  assert.match(renderActivePlanAddendum(cwd), /\[x\] 1\. First/);
  clearPlan(cwd);
});

test('auto-advance skips a blocked step and picks the next satisfiable todo', () => {
  const cwd = '/tmp/plan-deps2-ws';
  // Step 2 depends on 3; completing 1 should advance to 3 (satisfiable), not 2 (blocked).
  setPlan(cwd, ['A', { text: 'B', dependsOn: [3] }, 'C']);
  completeStep(cwd, 1);
  const list = getPlan(cwd);
  assert.equal(list[1]!.status, 'todo', 'blocked step stays todo');
  assert.equal(displayStatus(list[1]!, list), 'blocked');
  assert.equal(list[2]!.status, 'doing', 'next satisfiable todo becomes doing');
  clearPlan(cwd);
});

test('dependsOn round-trips through disk persistence', () => {
  const cwd = '/tmp/plan-deps-persist-ws';
  setPlan(cwd, ['One', { text: 'Two', dependsOn: [1] }]);
  const onDisk = readPersistedPlanForTests(cwd);
  assert.deepEqual(onDisk[1]!.dependsOn, [1]);
  clearPlan(cwd);
});

test('plan persists to disk (survives restart) and clear removes it', () => {
  const cwd = '/tmp/plan-persist-ws';
  setPlan(cwd, [{ text: 'Edit', activeForm: 'Editing' }, 'Test']);
  completeStep(cwd, 1); // step 2 doing
  // A fresh process would read exactly this from disk before touching memory.
  const onDisk = readPersistedPlanForTests(cwd);
  assert.equal(onDisk.length, 2, 'plan written to disk');
  assert.equal(onDisk[0]!.status, 'done');
  assert.equal(onDisk[1]!.status, 'doing');
  assert.equal(onDisk[0]!.activeForm, 'Editing');
  clearPlan(cwd);
  assert.equal(readPersistedPlanForTests(cwd).length, 0, 'clear deletes the persisted plan');
});


test('stale-plan nudge fires after N idle turns and clears on mutation', () => {
  const cwd = '/tmp/plan-stale-ws';
  setPlan(cwd, ['a', 'b']);
  assert.doesNotMatch(renderActivePlanAddendum(cwd), /not been updated/);
  for (let i = 0; i < STALE_PLAN_TURNS; i++) bumpPlanTurn(cwd);
  assert.match(renderActivePlanAddendum(cwd), /not been updated in 10\+ turns/);
  // Any mutation resets the staleness counter.
  completeStep(cwd, 1);
  assert.doesNotMatch(renderActivePlanAddendum(cwd), /not been updated/);
  clearPlan(cwd);
});

test('bumpPlanTurn is a no-op when there is no plan', () => {
  const cwd = '/tmp/plan-noplan-ws';
  assert.equal(bumpPlanTurn(cwd), 0);
  assert.equal(renderActivePlanAddendum(cwd), '');
});

test('normal flow always keeps one step in progress (no invariant nudge)', () => {
  const cwd = '/tmp/plan-invariant-ws';
  setPlan(cwd, ['a', 'b', 'c']);
  assert.doesNotMatch(renderActivePlanAddendum(cwd), /no step is in progress/);
  completeStep(cwd, 1);
  assert.equal(getPlan(cwd).filter((s) => s.status === 'doing').length, 1, 'exactly one doing after complete');
  assert.doesNotMatch(renderActivePlanAddendum(cwd), /no step is in progress/);
  clearPlan(cwd);
});

test('plan panel renders a progress bar, glyphs, and the running step activeForm', () => {
  const cwd = '/tmp/plan-widget-ws';
  const { ctx, calls } = uiCtx(cwd);
  setPlan(cwd, [{ text: 'Edit file', activeForm: 'Editing file' }, 'Run tests']);
  completeStep(cwd, 1); // step 2 becomes doing
  refreshPlanUi(ctx);
  const w = calls.widget.find(
    (x) => (x as { name: string }).name === 'octocode-status-panel' && !(x as { cleared: boolean }).cleared,
  ) as { content: (tui: unknown, theme: unknown) => { render?: unknown } } | undefined;
  assert.ok(w, 'a below-editor widget renderer was set');
  // Invoke the renderer with a no-op theme and read the lines it produces.
  const theme = { fg: (_c: string, t: string) => t } as unknown;
  const comp = w!.content(null, theme) as { render: (w: number) => string[] };
  const lines = comp.render(80);
  const joined = lines.join('\n');
  assert.match(joined, /Plan\s+[\u2588\u2591]{8}\s+1\/2 · now: Run tests/, 'header has progress and the current running step');
  assert.match(joined, /\u2713 1\. Edit file/, 'done step uses the check glyph');
  assert.match(joined, /\u25b8 2\. Run tests/, 'doing step uses the pointer glyph');
  clearPlan(cwd);
});

test('complete advances the next todo to doing and counts done', () => {
  setPlan(CWD, ['a', 'b', 'c']);
  completeStep(CWD, 1);
  const s = getPlan(CWD);
  assert.equal(s[0]!.status, 'done');
  assert.equal(s[1]!.status, 'doing'); // auto-advanced
  assert.match(renderActivePlanAddendum(CWD), /1\/3 done/);
});

test('addStep appends a todo; start can open a parallel active lane', () => {
  setPlan(CWD, ['a']);
  addStep(CWD, 'b');
  startStep(CWD, 2);
  assert.deepEqual(getPlan(CWD).map((s) => s.status), ['doing', 'doing']);
  assert.equal(getPlan(CWD).filter((s) => s.status === 'doing').length, 2);
});

test('addendum shows runnable parallel lanes and all active work', () => {
  const cwd = '/tmp/plan-parallel-addendum-ws';
  setPlan(cwd, [{ text: 'Edit', activeForm: 'Editing' }, { text: 'Review', activeForm: 'Reviewing' }, { text: 'Verify', dependsOn: [1, 2] }]);
  let out = renderActivePlanAddendum(cwd);
  assert.match(out, /parallel-ready: 2\. Review/);
  startStep(cwd, 2);
  out = renderActivePlanAddendum(cwd);
  assert.match(out, /now: Editing \| Reviewing/);
  assert.doesNotMatch(out, /parallel-ready: 3\. Verify/, 'blocked dependent work is not advertised as parallel-ready');
  clearPlan(cwd);
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

test('refreshPlanUi renders a live below-editor checklist without compact footer duplication', () => {
  const { ctx, calls } = uiCtx('/tmp/plan-ui-ws');
  setPlan('/tmp/plan-ui-ws', ['a', 'b']);
  refreshPlanUi(ctx);
  const rendered = calls.widget.find((w) => (w as { name: string }).name === 'octocode-status-panel') as
    | { cleared: boolean; isFn: boolean; opts?: { placement?: string } }
    | undefined;
  assert.ok(rendered && !rendered.cleared, 'below-editor plan widget is rendered while a plan is active');
  assert.equal(rendered!.isFn, true, 'widget content is a renderer fn (not a static string[])');
  assert.equal(rendered!.opts?.placement, 'belowEditor', 'plan checklist sits below the input field');
  assert.equal(calls.status.length, 0, 'plan UI does not write a duplicate compact status line');
  clearPlan('/tmp/plan-ui-ws');
  refreshPlanUi(ctx);
  assert.ok(calls.widget.some((w) => (w as { cleared: boolean }).cleared === true), 'widget cleared when the plan is empty');
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

test('/octocode-plan command text marks blocked steps and their dependencies', async () => {
  const cwd = '/tmp/plan-cmd-blocked-ws';
  setPlan(cwd, ['A', { text: 'B', dependsOn: [3] }, 'C']);
  completeStep(cwd, 1);
  const { ctx, calls } = uiCtx(cwd);
  await handleOctocodePlanCommand('show', ctx, (_c, m) => calls.notify.push(m));
  assert.ok(calls.notify.some((m) => /\[!\] 2\. B \(needs 3\)/.test(m)), 'blocked dependency is visible in text output');
  clearPlan(cwd);
});

test('plan tool start/complete with a bad index reports an error and does not mutate', async () => {
  const tool = loadTool();
  const ctx = { cwd: '/tmp/plan-badidx-ws' } as unknown as import('../src/types.js').PiContext;
  await tool.execute('id', { action: 'set', steps: ['one', 'two'] }, undefined, undefined, ctx);

  const oob = (await tool.execute('id', { action: 'complete', index: 9 }, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>; isError?: boolean; details: { error?: string; steps: Array<{ status: string }> };
  };
  assert.equal(oob.isError, true);
  assert.equal(oob.details.error, 'invalid-index');
  assert.match(oob.content[0]!.text, /no such step 9/);
  assert.equal(oob.details.steps.filter((s) => s.status === 'done').length, 0, 'nothing marked done');

  clearPlan('/tmp/plan-badidx-ws');
});

test('plan tool complete without index completes the current doing step (common loop, no bookkeeping)', async () => {
  const tool = loadTool();
  const ctx = { cwd: '/tmp/plan-defidx-ws' } as unknown as import('../src/types.js').PiContext;
  await tool.execute('id', { action: 'set', steps: ['one', 'two', 'three'] }, undefined, undefined, ctx);
  const res = (await tool.execute('id', { action: 'complete' }, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>; isError?: boolean; details: { steps: Array<{ status: string }> };
  };
  assert.notEqual(res.isError, true);
  assert.deepEqual(res.details.steps.map((s) => s.status), ['done', 'doing', 'todo'], 'doing step completed, next auto-advanced');
  clearPlan('/tmp/plan-defidx-ws');
});

test('plan tool start without index starts the next runnable todo as a parallel lane', async () => {
  const tool = loadTool();
  const ctx = { cwd: '/tmp/plan-defstart-ws' } as unknown as import('../src/types.js').PiContext;
  await tool.execute('id', { action: 'set', steps: ['one', 'two'] }, undefined, undefined, ctx);
  const res = (await tool.execute('id', { action: 'start' }, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>; isError?: boolean; details: { steps: Array<{ status: string }> };
  };
  assert.notEqual(res.isError, true);
  assert.deepEqual(res.details.steps.map((s) => s.status), ['doing', 'doing'], 'next todo becomes an additional active lane');
  clearPlan('/tmp/plan-defstart-ws');
});

test('plan tool complete without index errors clearly when no step is in progress', async () => {
  const tool = loadTool();
  const cwd = '/tmp/plan-nodoing-ws';
  const ctx = { cwd } as unknown as import('../src/types.js').PiContext;
  await tool.execute('id', { action: 'set', steps: ['one'] }, undefined, undefined, ctx);
  await tool.execute('id', { action: 'complete', index: 1 }, undefined, undefined, ctx); // all done
  const res = (await tool.execute('id', { action: 'complete' }, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>; isError?: boolean;
  };
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /no step is in progress/i);
  clearPlan(cwd);
});

test('plan tool remove deletes a step, remaps dependsOn indices, and keeps active work', async () => {
  const tool = loadTool();
  const cwd = '/tmp/plan-remove-ws';
  const ctx = { cwd } as unknown as import('../src/types.js').PiContext;
  await tool.execute(
    'id',
    { action: 'set', steps: ['A', 'B', { text: 'C', dependsOn: [1, 2] }] },
    undefined,
    undefined,
    ctx,
  );
  const res = (await tool.execute('id', { action: 'remove', index: 2 }, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>; isError?: boolean;
    details: { steps: Array<{ text: string; status: string; dependsOn?: number[] }> };
  };
  assert.notEqual(res.isError, true);
  assert.deepEqual(res.details.steps.map((s) => s.text), ['A', 'C']);
  assert.deepEqual(res.details.steps[1]!.dependsOn, [1], 'dep on removed step dropped, later dep renumbered');
  assert.equal(res.details.steps.filter((s) => s.status === 'doing').length, 1, 'still has active work');
  clearPlan(cwd);
});

test('plan tool add supports dependsOn ordering', async () => {
  const tool = loadTool();
  const cwd = '/tmp/plan-adddeps-ws';
  const ctx = { cwd } as unknown as import('../src/types.js').PiContext;
  await tool.execute('id', { action: 'set', steps: ['A'] }, undefined, undefined, ctx);
  const res = (await tool.execute(
    'id',
    { action: 'add', text: 'B', dependsOn: [1] },
    undefined,
    undefined,
    ctx,
  )) as { details: { steps: Array<{ dependsOn?: number[] }> } };
  assert.deepEqual(res.details.steps[1]!.dependsOn, [1]);
  clearPlan(cwd);
});

test('plan tool teaches the default-index flow, task sync, and parallel lanes in its contract', () => {
  const tool = loadTool();
  assert.match(tool.description, /remove/);
  assert.match(tool.description, /multiple independent steps may be doing in parallel/);
  const guidelines = tool.promptGuidelines?.join('\n') ?? '';
  assert.match(guidelines, /plan\(complete\)/);
  assert.match(guidelines, /single current step/i);
  assert.match(guidelines, /Awareness task\/work state/);
  assert.match(guidelines, /plan\(start:N\)/);
});

test('plan tool requires explicit complete index when multiple lanes are doing', async () => {
  const tool = loadTool();
  const cwd = '/tmp/plan-parallel-complete-ws';
  const ctx = { cwd } as unknown as import('../src/types.js').PiContext;
  await tool.execute('id', { action: 'set', steps: ['A', 'B'] }, undefined, undefined, ctx);
  await tool.execute('id', { action: 'start', index: 2 }, undefined, undefined, ctx);
  const res = (await tool.execute('id', { action: 'complete' }, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>; isError?: boolean;
    details: { error: string };
  };
  assert.equal(res.isError, true);
  assert.equal(res.details.error, 'ambiguous-target');
  assert.match(res.content[0]!.text, /2 steps are in progress/);
  clearPlan(cwd);
});

test('plan tool refuses to start blocked dependency lanes', async () => {
  const tool = loadTool();
  const cwd = '/tmp/plan-blocked-start-ws';
  const ctx = { cwd } as unknown as import('../src/types.js').PiContext;
  await tool.execute('id', { action: 'set', steps: ['A', { text: 'B', dependsOn: [3] }, 'C'] }, undefined, undefined, ctx);
  const res = (await tool.execute('id', { action: 'start', index: 2 }, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>; isError?: boolean;
    details: { error: string };
  };
  assert.equal(res.isError, true);
  assert.equal(res.details.error, 'blocked-step');
  assert.match(res.content[0]!.text, /blocked by dependencies/);
  clearPlan(cwd);
});

test('plan tool start/complete on an empty plan reports no active plan', async () => {
  const tool = loadTool();
  const ctx = { cwd: '/tmp/plan-empty-ws' } as unknown as import('../src/types.js').PiContext;
  const res = (await tool.execute('id', { action: 'complete', index: 1 }, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>; isError?: boolean;
  };
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /no active plan/);
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

test('plan tool state is scoped by Pi session file, not only workspace cwd', async () => {
  const tool = loadTool();
  const cwd = '/tmp/plan-session-tool-ws';
  const ctx1 = {
    cwd,
    sessionManager: { getSessionFile: () => '/tmp/pi-sessions/session-one.jsonl' },
  } as unknown as PiContext;
  const ctx2 = {
    cwd,
    sessionManager: { getSessionFile: () => '/tmp/pi-sessions/session-two.jsonl' },
  } as unknown as PiContext;

  await tool.execute('id', { action: 'set', steps: ['old session work'] }, undefined, undefined, ctx1);
  const fresh = (await tool.execute('id', { action: 'show' }, undefined, undefined, ctx2)) as {
    content: Array<{ text: string }>;
    details: { steps: Array<{ text: string }>; addendum: string };
  };

  assert.deepEqual(fresh.details.steps, [], 'fresh session has no active plan');
  assert.match(fresh.content[0]!.text, /\(no active plan\)/);
  assert.equal(fresh.details.addendum, '', 'fresh session gets no stale active_plan addendum');

  clearPlan(activePlanScope(ctx1));
  clearPlan(activePlanScope(ctx2));
});

// ─── Branch/fork-correct plan state (pi appendEntry pattern) ──────────────────
//
// Pi docs: extension state belongs in session entries so /fork and /tree roll
// it back with the conversation. Every plan mutation appends an
// `octocode-plan` CustomEntry; on session_start / session_tree the plan is
// re-adopted from the branch, so a fork from before the plan existed starts
// clean and a fork mid-plan restores exactly that snapshot.

const BRANCH_CWD = '/tmp/plan-branch-test-ws';

function planEntry(steps: Array<Record<string, unknown>>): Record<string, unknown> {
  return { type: 'custom', customType: PLAN_ENTRY_TYPE, data: { version: 1, steps } };
}

test('plan mutations notify the entry appender with the current steps; clear appends empty', () => {
  const appended: Array<{ steps: Array<{ text: string; status: string }> }> = [];
  setPlanEntryAppender((steps) => appended.push({ steps: steps.map((s) => ({ text: s.text, status: s.status })) }));
  try {
    setPlan(BRANCH_CWD, ['one', 'two']);
    completeStep(BRANCH_CWD, 1);
    clearPlan(BRANCH_CWD);
  } finally {
    setPlanEntryAppender(null);
  }
  assert.equal(appended.length, 3, 'set + complete + clear each append a snapshot entry');
  assert.deepEqual(appended[0]!.steps.map((s) => s.status), ['doing', 'todo']);
  assert.equal(appended[1]!.steps[0]!.status, 'done');
  assert.deepEqual(appended[2]!.steps, [], 'clear appends an empty snapshot so forks after clear start clean');
});

test('adoptPlanFromBranch restores the LAST plan snapshot in the branch and does not re-append', () => {
  const appended: unknown[] = [];
  setPlanEntryAppender(() => appended.push(1));
  try {
    setPlan(BRANCH_CWD, ['stale disk step']);
    appended.length = 0;
    const adopted = adoptPlanFromBranch(BRANCH_CWD, [
      { type: 'message' },
      planEntry([{ text: 'old', status: 'done' }]),
      { type: 'compaction' },
      planEntry([{ text: 'fork point step', status: 'doing' }, { text: 'later', status: 'todo' }]),
      { type: 'message' },
    ]);
    assert.equal(adopted, true);
    assert.deepEqual(getPlan(BRANCH_CWD).map((s) => s.text), ['fork point step', 'later']);
    assert.equal(appended.length, 0, 'adoption is reconciliation, not a new mutation');
  } finally {
    setPlanEntryAppender(null);
    clearPlan(BRANCH_CWD);
  }
});

test('adoptPlanFromBranch with an empty snapshot clears the scope; without any snapshot leaves state alone', () => {
  try {
    setPlan(BRANCH_CWD, ['pre-existing']);
    assert.equal(
      adoptPlanFromBranch(BRANCH_CWD, [{ type: 'message' }, { type: 'compaction' }]),
      false,
      'branches predating the feature leave disk state untouched (back-compat)'
    );
    assert.deepEqual(getPlan(BRANCH_CWD).map((s) => s.text), ['pre-existing']);

    assert.equal(adoptPlanFromBranch(BRANCH_CWD, [planEntry([])]), true);
    assert.deepEqual(getPlan(BRANCH_CWD), [], 'empty snapshot in branch clears the plan');
  } finally {
    clearPlan(BRANCH_CWD);
  }
});
