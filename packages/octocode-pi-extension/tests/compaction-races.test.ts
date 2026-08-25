/**
 * Compaction race-hardening tests.
 *
 * Three independent triggers can start a compaction (pi's built-in threshold
 * auto-compaction, the extension's 80% turn_end watcher, and a user /compact).
 * Pi's ctx.compact() has no
 * concurrency guard and session.compact() throws "Already compacted" when it
 * lands right after a finished compaction — users saw red error lines right
 * after a successful [compaction] entry. These tests pin the arbiter that
 * makes the triggers stand down for each other and the benign handling of
 * the losing calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { Type } from 'typebox';
import type { CompactOptions, PiInstance, ToolDefinition } from '../src/types.js';
import { registerContextTools, resetAutoCompactState } from '../src/tools/context-tools.js';
import { registerCompactionHooks, resetCompactionCheckpointDedupe } from '../src/tools/compaction-hooks.js';
import {
  markCompactionInFlight,
  isCompactionInFlight,
  resetCompactionArbiterForTests,
} from '../src/tools/compaction-state.js';
import { resetCompactionResumeStateForTests, setCompactionResumeRetryDelayForTests } from '../src/tools/compaction-resume.js';
import { markCompactionResumeRequested, markAutoCompactResumeRequested } from '../src/tools/compaction-state.js';
import { PLAN_ENTRY_TYPE, activePlanScope, adoptPlanFromBranch, clearPlan, setPlan } from '../src/tools/active-plan.js';

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface Harness {
  tools: Map<string, ToolDefinition>;
  notes: Array<{ msg: string; level?: string }>;
  sentUserMessages: Array<{ content: unknown; opts?: Record<string, unknown> }>;
  sentMessages: Array<{ customType?: string; content?: unknown; details?: unknown }>;
  fire(event: string, evt: unknown, ctx: unknown): Promise<unknown[]>;
}

function makeHarness(): Harness {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const notes: Array<{ msg: string; level?: string }> = [];
  const sentUserMessages: Array<{ content: unknown; opts?: Record<string, unknown> }> = [];
  const sentMessages: Array<{ customType?: string; content?: unknown; details?: unknown }> = [];
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
    registerCommand: () => undefined,
    sendUserMessage: (content: unknown, opts?: Record<string, unknown>) => {
      sentUserMessages.push({ content, opts });
    },
    sendMessage: (msg: { customType?: string; content?: unknown; details?: unknown }) => {
      sentMessages.push(msg);
    },
    on: (event: string, handler: Handler) => {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
    },
  } as unknown as PiInstance;
  const notify = (_ctx: unknown, msg: string, level?: string) => notes.push({ msg, level });
  const registerFn = (
    p: { registerTool?(def: ToolDefinition): void },
    names: Set<string>,
    def: ToolDefinition,
  ) => {
    names.add(def.name);
    p.registerTool?.(def);
  };
  registerCompactionHooks(pi, notify as never);
  registerContextTools(pi, Type, new Set<string>(), registerFn as never, notify as never);
  const fire = (event: string, evt: unknown, ctx: unknown) =>
    Promise.all((handlers.get(event) ?? []).map((h) => h(evt, ctx)));
  return { tools, notes, sentUserMessages, sentMessages, fire };
}

interface CtxOptions {
  tokens?: number | null;
  contextWindow?: number;
  branch?: Array<{ type: string }>;
}

function makeCtx(opts: CtxOptions = {}) {
  const compactCalls: CompactOptions[] = [];
  const ctx = {
    hasUI: false,
    compact: (options: CompactOptions) => {
      compactCalls.push(options);
    },
    getContextUsage: () => ({
      tokens: opts.tokens === undefined ? 90 : opts.tokens,
      contextWindow: opts.contextWindow ?? 100,
    }),
    sessionManager: {
      getBranch: () => opts.branch ?? [],
      getSessionId: () => 'test-session',
    },
  };
  return { ctx, compactCalls };
}

const TURN_STOP = { message: { stopReason: 'stop' } };

let previousHome: string | undefined;
let testHome: string;

beforeEach(() => {
  previousHome = process.env['OCTOCODE_HOME'];
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-compaction-races-home-'));
  process.env['OCTOCODE_HOME'] = testHome;
  resetAutoCompactState();
  resetCompactionArbiterForTests();
  resetCompactionResumeStateForTests();
  resetCompactionCheckpointDedupe();
  clearPlan(activePlanScope());
  clearPlan(activePlanScope(makeCtx().ctx));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['OCTOCODE_HOME'];
  else process.env['OCTOCODE_HOME'] = previousHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

// ─── The in-flight arbiter primitive ─────────────────────────────────────────

test('arbiter: mark/clear/expiry semantics', () => {
  assert.equal(isCompactionInFlight(1000), false);
  markCompactionInFlight(1000);
  assert.equal(isCompactionInFlight(1000), true);
  assert.equal(isCompactionInFlight(1000 + 119_000), true, 'still in flight within the TTL');
  assert.equal(
    isCompactionInFlight(1000 + 121_000),
    false,
    'expires after the TTL — pi emits no event when its internal auto-compaction fails, so a mark must not wedge forever',
  );
});

// ─── turn_end auto-compaction watcher ────────────────────────────────────────

test('auto-compaction skips a threshold crossing when no unfinished plan work remains', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 0, 'ended sessions do not compact just because they crossed 80%');
});

test('auto-compaction skips terminal completion answers even if stale plan work remains', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({
    tokens: 90,
    branch: [
      { type: 'message' },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'TL;DR: Prior work was already complete, verified, and closed.' }],
        },
      } as never,
    ],
  });
  setPlan(activePlanScope(ctx), ['stale unfinished step']);
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 0, 'terminal completion answers should not show a surprise compaction spinner');

  const later = makeCtx({ tokens: 90, branch: [{ type: 'message' }] });
  await fire('turn_end', TURN_STOP, later.ctx);
  assert.equal(later.compactCalls.length, 1, 'skipping terminal completion must not consume the threshold edge for later real work');
});

test('auto-compaction skips stale unfinished plan state with no active doing step', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90, branch: [{ type: 'message' }] });
  const scope = activePlanScope(ctx);
  adoptPlanFromBranch(scope, [{
    type: 'custom',
    customType: PLAN_ENTRY_TYPE,
    data: { steps: [{ text: 'stale todo from an old plan', status: 'todo' }] },
  }]);

  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 0, 'stale unfinished plan state is not active work');

  setPlan(scope, ['continue after compaction']);
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 1, 'skipping stale state must not consume the threshold edge for later active work');
});

test('auto-compaction fires on a fresh threshold crossing with active plan work', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  setPlan(activePlanScope(ctx), ['continue after compaction']);
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 1);
});

test('auto-compaction skips aborted turns — their usage is stale (often the very turn a compact() aborted)', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  setPlan(activePlanScope(ctx), ['continue after compaction']);
  await fire('turn_end', { message: { stopReason: 'aborted', usage: { output: 5 } } }, ctx);
  assert.equal(compactCalls.length, 0);
});

test('auto-compaction skips error turns — API 4xx/5xx errors report stale context size and the session may be exiting', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  // Active plan work and above-threshold context: without the error guard these
  // conditions would trigger ctx.compact(), wasting budget and running post-session.
  setPlan(activePlanScope(ctx), ['continue after compaction']);
  await fire('turn_end', { message: { stopReason: 'error' } }, ctx);
  assert.equal(compactCalls.length, 0, 'must not compact after an API error turn');
});

test('auto-compaction stands down while another compaction is in flight (session_before_compact fired)', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  setPlan(activePlanScope(ctx), ['continue after compaction']);
  await fire(
    'session_before_compact',
    { preparation: {}, reason: 'threshold', willRetry: false },
    ctx,
  );
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 0, 'watcher must not race a compaction that pi already started');
});

test('session_compact clears the in-flight mark so a later crossing compacts again', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  await fire('session_before_compact', { preparation: {}, reason: 'threshold', willRetry: false }, ctx);
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 0);
  await fire(
    'session_compact',
    { compactionEntry: {}, fromExtension: false, reason: 'threshold', willRetry: false },
    ctx,
  );
  // Edge trigger: dip below the threshold, then cross it again with unfinished work.
  const low = makeCtx({ tokens: 10 });
  await fire('turn_end', TURN_STOP, { ...low.ctx, compact: low.ctx.compact });
  setPlan(activePlanScope(ctx), ['continue after compaction']);
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 1, 'compacts again once the previous compaction finished');
});

test('session_compact willRetry preserves in-flight arbiter and prevents duplicate compact triggers', async () => {
  // Regression: before the fix, clearCompactionInFlight() and clearAllReadStates()
  // fired unconditionally before the willRetry guard, enabling reentrant
  // auto-compaction to race the retry window.
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  setPlan(activePlanScope(ctx), ['step to finish after compaction']);

  // session_before_compact marks in-flight.
  await fire('session_before_compact', { preparation: {}, reason: 'threshold', willRetry: false }, ctx);
  assert.equal(isCompactionInFlight(), true, 'in-flight mark set after session_before_compact');

  // Pi retries the compaction (first pass failed). The in-flight mark must
  // survive the willRetry pass so turn_end cannot race with a second compact.
  await fire('session_compact', { compactionEntry: {}, reason: 'threshold', willRetry: true }, ctx);
  assert.equal(isCompactionInFlight(), true, 'in-flight mark preserved during willRetry pass');

  // turn_end fires in the retry window — must NOT trigger a second auto-compact.
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 0, 'no duplicate compact triggered while willRetry in-flight');

  // Successful retry clears the in-flight mark.
  await fire('session_compact', { compactionEntry: {}, reason: 'threshold', willRetry: false }, ctx);
  assert.equal(isCompactionInFlight(), false, 'in-flight mark cleared after successful compaction');

  // Edge trigger: dip below the threshold, then cross again with active plan work.
  const low = makeCtx({ tokens: 10 });
  await fire('turn_end', TURN_STOP, low.ctx);
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 1, 'compacts once the successful compaction cleared the arbiter');
});

test('auto-compaction skips when the branch tip is already a compaction entry (pi would throw "Already compacted")', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({
    tokens: 90,
    branch: [{ type: 'message' }, { type: 'compaction' }],
  });
  setPlan(activePlanScope(ctx), ['continue after compaction']);
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 0);
});

test('auto-compaction treats a losing "Already compacted" race as a benign info-level skip', async () => {
  const { fire, notes } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  setPlan(activePlanScope(ctx), ['continue after compaction']);
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 1);
  compactCalls[0]!.onError?.(new Error('Already compacted'));
  assert.ok(!notes.some((n) => n.level === 'error'), 'no red error line for a benign race loss');
  assert.ok(
    notes.some((n) => n.level === 'info' && /already compacted/i.test(n.msg)),
    'an info-level skip is surfaced instead',
  );
});

test('auto-compaction treats Pi undefined-signal crash after saved compaction as a benign skip', async () => {
  const { fire, notes } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  setPlan(activePlanScope(ctx), ['continue after compaction']);
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 1);
  Object.assign(ctx, { sessionManager: { getBranch: () => [{ type: 'message' }, { type: 'compaction' }] } });
  compactCalls[0]!.onError?.(new Error("Cannot read properties of undefined (reading 'signal')"));
  assert.ok(!notes.some((n) => n.level === 'error'), 'no repeated red error line after compaction already landed');
  assert.ok(
    notes.some((n) => n.level === 'info' && /already compacted/i.test(n.msg)),
    'post-success Pi crash is surfaced as an info-level skip',
  );
});

test('session_compact does not auto-resume user or Pi compactions without Octocode resume intent', async () => {
  const harness = makeHarness();
  const { ctx } = makeCtx({ tokens: 90 });
  await harness.fire(
    'session_compact',
    { compactionEntry: {}, fromExtension: false, reason: 'manual', willRetry: false },
    ctx,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.sentUserMessages, []);
});

// ─── public surface ──────────────────────────────────────────────────────────

test('context automation does not register a model-callable context tool', () => {
  const harness = makeHarness();
  assert.equal(harness.tools.has('manage_context'), false);
});

test('message_end leaves ordinary aborted assistant messages untouched', async () => {
  const harness = makeHarness();
  const { ctx } = makeCtx({ tokens: 90 });
  const [replacement] = await harness.fire(
    'message_end',
    { message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'Operation aborted', content: [] } },
    ctx,
  );
  assert.equal(replacement, undefined);
});

test('auto-compaction downgrades the abort message its own compact() causes (no raw "aborted" leak)', async () => {
  const harness = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  setPlan(activePlanScope(ctx), ['continue after compaction']);

  // turn_end crosses 80% with active work → watcher calls ctx.compact() and
  // must arm abort suppression for the single abort that compact() will cause.
  await harness.fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 1);

  // The abort message Pi emits for that aborted run is rewritten to a benign
  // checkpoint notice instead of surfacing "This operation was aborted".
  const [replacement] = await harness.fire(
    'message_end',
    { message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'This operation was aborted', content: [] } },
    ctx,
  ) as Array<{ message?: { stopReason?: string; content?: Array<{ text?: string }> } } | undefined>;
  assert.ok(replacement?.message, 'auto-compact abort should be downgraded');
  assert.equal(replacement?.message?.stopReason, 'stop');
  assert.match(replacement?.message?.content?.[0]?.text ?? '', /Compaction interrupted this turn/);

  // Single-shot: a second unrelated abort is left untouched.
  const [second] = await harness.fire(
    'message_end',
    { message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'Operation aborted', content: [] } },
    ctx,
  );
  assert.equal(second, undefined);
});


// ── Stale-resume guard (TDD) ──────────────────────────────────────────────────
// Auto-compact resumes are plan-verified: if work completed while compaction was
// in flight the follow-up must be suppressed. Explicit internal resume intent
// remains covered separately for compaction-hook recovery.

test('session_compact suppresses auto-compact resume when plan cleared before session_compact fires', async () => {
  const { fire, sentUserMessages } = makeHarness();
  // Simulate: turn_end fires, plan is active, auto-compact is triggered.
  const scope = activePlanScope();
  setPlan(scope, ['step not yet done']);
  markAutoCompactResumeRequested();

  // Simulate: work finishes and plan clears BEFORE session_compact arrives.
  clearPlan(scope);

  const { ctx } = makeCtx();
  await fire(
    'session_compact',
    { compactionEntry: {}, fromExtension: true, reason: 'auto', willRetry: false },
    ctx,
  );
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(
    sentUserMessages.length,
    0,
    'stale auto-compact resume must not fire when plan is empty at session_compact time',
  );
});

test('session_compact suppresses auto-compact resume when last assistant turn signals completion', async () => {
  const { fire, sentUserMessages } = makeHarness();
  const scope = activePlanScope();
  setPlan(scope, ['step not yet done']);
  markAutoCompactResumeRequested();

  // Branch has a final assistant turn that says work is done.
  const { ctx } = makeCtx({
    branch: [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Prior work was already complete, verified, and closed. Nothing to continue.' }],
        },
      } as never,
    ],
  });
  await fire(
    'session_compact',
    { compactionEntry: {}, fromExtension: true, reason: 'auto', willRetry: false },
    ctx,
  );
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(
    sentUserMessages.length,
    0,
    'stale auto-compact resume must not fire when last assistant turn clearly completed the session',
  );
  // Clean up so the plan check in later tests is not tainted.
  clearPlan(scope);
});

test('session_compact still honors explicit extension resume intent without active plan', async () => {
  const { fire, sentUserMessages } = makeHarness();
  setCompactionResumeRetryDelayForTests(0);
  // Internal recovery uses the explicit non-plan-verified resume flag.
  markCompactionResumeRequested();

  const { ctx } = makeCtx(); // no plan set — explicit resumes bypass the plan check
  await fire(
    'session_compact',
    { compactionEntry: {}, fromExtension: true, reason: 'auto', willRetry: false },
    ctx,
  );
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(
    sentUserMessages.length,
    1,
    'explicit (manage_context) resume must always fire regardless of plan state',
  );
});

test('session_compact resume survives a willRetry pass and fires exactly once on success', async () => {
  const { fire, sentUserMessages } = makeHarness();
  const { ctx } = makeCtx();
  setCompactionResumeRetryDelayForTests(0);
  // Octocode requested this compaction (ctx.compact aborts the in-flight run).
  markCompactionResumeRequested();
  // Pi retries the compaction first: the resume intent must NOT be consumed here.
  await fire('session_compact', { reason: 'auto', fromExtension: true, willRetry: true }, ctx);
  assert.equal(sentUserMessages.length, 0, 'no continuation on the retry pass');
  // The successful retry must still schedule the continuation.
  await fire('session_compact', { reason: 'auto', fromExtension: true, willRetry: false }, ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sentUserMessages.length, 1, 'continuation fires exactly once after the successful compaction');
});

// ─── Checkpoint-card dedupe (TDD) ───────────────────────────────────────────
// Regression: resetCompactionCheckpointDedupe previously cleared only the
// fallback string key, leaving the WeakSet permanently populated. After the
// fix the reset reassigns the WeakSet and clears the stable-id Set so that a
// new session can re-emit a checkpoint for a previously seen entry/id.

test('resetCompactionCheckpointDedupe resets string-id, object-identity, and fallback-string dedupe paths', async () => {
  const { fire, sentMessages } = makeHarness();
  const { ctx } = makeCtx();
  const checkpoints = () => sentMessages.filter((m) => m.customType === 'octocode-compaction-checkpoint').length;

  // ─ Stable string-id path ──────────────────────────────────────────
  await fire('session_compact', { compactionEntry: { id: 'cmp-abc' }, reason: 'threshold', fromExtension: false, willRetry: false }, ctx);
  assert.equal(checkpoints(), 1, 'first id-keyed emission goes through');

  // Same id on a different object: still deduped within the session.
  await fire('session_compact', { compactionEntry: { id: 'cmp-abc' }, reason: 'threshold', fromExtension: false, willRetry: false }, ctx);
  assert.equal(checkpoints(), 1, 'duplicate string id is deduped within a session');

  // After session boundary reset, the same id should re-emit.
  resetCompactionCheckpointDedupe();
  await fire('session_compact', { compactionEntry: { id: 'cmp-abc' }, reason: 'threshold', fromExtension: false, willRetry: false }, ctx);
  assert.equal(checkpoints(), 2, 'string-id Set is cleared by reset — same id re-emits in new session');

  // ─ Object-identity path (no string id) ─────────────────────────
  const entryObj = { reason: 'threshold' }; // no id — goes through WeakSet path
  await fire('session_compact', { compactionEntry: entryObj, reason: 'threshold', fromExtension: false, willRetry: false }, ctx);
  assert.equal(checkpoints(), 3, 'first object-identity emission goes through');

  // Same JS object reference: deduped by the WeakSet.
  await fire('session_compact', { compactionEntry: entryObj, reason: 'threshold', fromExtension: false, willRetry: false }, ctx);
  assert.equal(checkpoints(), 3, 'same object reference is WeakSet-deduped');

  // Reset reassigns the WeakSet — the same object reference is no longer tracked.
  resetCompactionCheckpointDedupe();
  await fire('session_compact', { compactionEntry: entryObj, reason: 'threshold', fromExtension: false, willRetry: false }, ctx);
  assert.equal(checkpoints(), 4, 'WeakSet reassignment on reset allows same object ref to re-emit in new session');
});
