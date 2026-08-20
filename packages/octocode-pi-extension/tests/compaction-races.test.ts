/**
 * Compaction race-hardening tests.
 *
 * Four independent triggers can start a compaction (pi's built-in threshold
 * auto-compaction, the extension's 80% turn_end watcher, the model-called
 * manage_context tool, and a user /compact). Pi's ctx.compact() has no
 * concurrency guard and session.compact() throws "Already compacted" when it
 * lands right after a finished compaction — users saw red error lines right
 * after a successful [compaction] entry. These tests pin the arbiter that
 * makes the triggers stand down for each other and the benign handling of
 * the losing calls.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { Type } from 'typebox';
import type { CompactOptions, PiInstance, ToolDefinition } from '../src/types.js';
import { registerContextTools, resetAutoCompactState } from '../src/tools/context-tools.js';
import { registerCompactionHooks } from '../src/tools/compaction-hooks.js';
import {
  markCompactionInFlight,
  isCompactionInFlight,
  resetCompactionArbiterForTests,
} from '../src/tools/compaction-state.js';
import { resetCompactionResumeStateForTests } from '../src/tools/compaction-resume.js';

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface Harness {
  tools: Map<string, ToolDefinition>;
  notes: Array<{ msg: string; level?: string }>;
  sentUserMessages: Array<{ content: unknown; opts?: Record<string, unknown> }>;
  fire(event: string, evt: unknown, ctx: unknown): Promise<unknown[]>;
}

function makeHarness(): Harness {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const notes: Array<{ msg: string; level?: string }> = [];
  const sentUserMessages: Array<{ content: unknown; opts?: Record<string, unknown> }> = [];
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
    registerCommand: () => undefined,
    sendUserMessage: (content: unknown, opts?: Record<string, unknown>) => {
      sentUserMessages.push({ content, opts });
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
  return { tools, notes, sentUserMessages, fire };
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
    ...(opts.branch ? { sessionManager: { getBranch: () => opts.branch } } : {}),
  };
  return { ctx, compactCalls };
}

const TURN_STOP = { message: { stopReason: 'stop' } };

beforeEach(() => {
  resetAutoCompactState();
  resetCompactionArbiterForTests();
  resetCompactionResumeStateForTests();
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

test('auto-compaction fires on a fresh threshold crossing (baseline)', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 1);
});

test('auto-compaction skips aborted turns — their usage is stale (often the very turn a compact() aborted)', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  await fire('turn_end', { message: { stopReason: 'aborted', usage: { output: 5 } } }, ctx);
  assert.equal(compactCalls.length, 0);
});

test('auto-compaction stands down while another compaction is in flight (session_before_compact fired)', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
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
  // Edge trigger: dip below the threshold, then cross it again.
  const low = makeCtx({ tokens: 10 });
  await fire('turn_end', TURN_STOP, { ...low.ctx, compact: low.ctx.compact });
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 1, 'compacts again once the previous compaction finished');
});

test('auto-compaction skips when the branch tip is already a compaction entry (pi would throw "Already compacted")', async () => {
  const { fire } = makeHarness();
  const { ctx, compactCalls } = makeCtx({
    tokens: 90,
    branch: [{ type: 'message' }, { type: 'compaction' }],
  });
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 0);
});

test('auto-compaction treats a losing "Already compacted" race as a benign info-level skip', async () => {
  const { fire, notes } = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  await fire('turn_end', TURN_STOP, ctx);
  assert.equal(compactCalls.length, 1);
  compactCalls[0]!.onError?.(new Error('Already compacted'));
  assert.ok(!notes.some((n) => n.level === 'error'), 'no red error line for a benign race loss');
  assert.ok(
    notes.some((n) => n.level === 'info' && /already compacted/i.test(n.msg)),
    'an info-level skip is surfaced instead',
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

// ─── manage_context tool ─────────────────────────────────────────────────────

async function executeManageContext(harness: Harness, ctx: unknown) {
  const tool = harness.tools.get('manage_context')!;
  return tool.execute('call-id', { type: 'compact' }, undefined, undefined, ctx as never);
}

test('manage_context treats "Already compacted" onError as a benign info-level skip', async () => {
  const harness = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  await executeManageContext(harness, ctx);
  assert.equal(compactCalls.length, 1);
  compactCalls[0]!.onError?.(new Error('Already compacted'));
  assert.ok(!harness.notes.some((n) => n.level === 'error'));
  assert.ok(
    harness.notes.some((n) => n.level === 'info' && /already compacted/i.test(n.msg)),
  );
});

test('manage_context auto-resumes even when Pi session_compact.fromExtension is false', async () => {
  const harness = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  await executeManageContext(harness, ctx);
  assert.equal(compactCalls.length, 1);
  compactCalls[0]!.onComplete?.();
  await harness.fire(
    'session_compact',
    { compactionEntry: {}, fromExtension: false, reason: 'manual', willRetry: false },
    ctx,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.sentUserMessages.length, 1);
  assert.match(String(harness.sentUserMessages[0]!.content), /Compaction is complete\. Re-orient/);
  assert.equal(harness.sentUserMessages[0]!.opts?.deliverAs, 'followUp');
});

test('manage_context pre-flight: skips when the branch tip is already a compaction entry', async () => {
  const harness = makeHarness();
  const { ctx, compactCalls } = makeCtx({
    tokens: 90,
    branch: [{ type: 'message' }, { type: 'compaction' }],
  });
  const result = await executeManageContext(harness, ctx);
  assert.equal(compactCalls.length, 0, 'must not call compact into a guaranteed throw');
  assert.notEqual(result.isError, true);
  assert.match(result.content[0]!.text, /just compacted|already compacted/i);
});

test('manage_context pre-flight: skips when context usage is unknown (right after a compaction)', async () => {
  const harness = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: null });
  const result = await executeManageContext(harness, ctx);
  assert.equal(compactCalls.length, 0);
  assert.notEqual(result.isError, true);
  assert.match(result.content[0]!.text, /just compacted|unknown/i);
});

test('manage_context reports an in-flight compaction instead of racing it', async () => {
  const harness = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  await harness.fire(
    'session_before_compact',
    { preparation: {}, reason: 'manual', willRetry: false },
    ctx,
  );
  const result = await executeManageContext(harness, ctx);
  assert.equal(compactCalls.length, 0);
  assert.notEqual(result.isError, true);
  assert.match(result.content[0]!.text, /already in progress/i);
});

test('manage_context marks the arbiter while its own compaction runs and clears it on completion', async () => {
  const harness = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 90 });
  await executeManageContext(harness, ctx);
  assert.equal(isCompactionInFlight(), true, 'own trigger marks in-flight');
  compactCalls[0]!.onComplete?.();
  assert.equal(isCompactionInFlight(), false, 'completion clears the mark');
});

test('manage_context description no longer tells the model to compact at 60% (races the automatics)', () => {
  const harness = makeHarness();
  const tool = harness.tools.get('manage_context')!;
  assert.doesNotMatch(tool.description ?? '', /60%/);
  assert.match(tool.description ?? '', /research→execution boundary/);
  assert.match(tool.description ?? '', /[Aa]utomatic compaction/);
});
