/** Compaction ownership and lifecycle regression tests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { Type } from 'typebox';
import type { CompactOptions, PiInstance, ToolDefinition } from '../src/types.js';
import { registerContextTools } from '../src/tools/context-tools.js';
import { registerCompactionHooks, resetCompactionCheckpointDedupe } from '../src/tools/compaction-hooks.js';
import { isCompactionInFlight, markCompactionInFlight, resetCompactionArbiterForTests } from '../src/tools/compaction-state.js';
import { activePlanScope, clearPlan, setPlan } from '../src/tools/active-plan.js';

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface Harness {
  tools: Map<string, ToolDefinition>;
  notes: Array<{ msg: string; level?: string }>;
  sentUserMessages: Array<{ content: unknown; opts?: Record<string, unknown> }>;
  sentMessages: Array<{ customType?: string; content?: unknown; details?: unknown }>;
  handlerCount(event: string): number;
  fire(event: string, evt: unknown, ctx: unknown): Promise<unknown[]>;
}

function makeHarness(): Harness {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const notes: Array<{ msg: string; level?: string }> = [];
  const sentUserMessages: Array<{ content: unknown; opts?: Record<string, unknown> }> = [];
  const sentMessages: Array<{ customType?: string; content?: unknown; details?: unknown }> = [];
  const pi = {
    registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
    registerCommand: () => undefined,
    sendUserMessage: (content: unknown, opts?: Record<string, unknown>) => sentUserMessages.push({ content, opts }),
    sendMessage: (message: { customType?: string; content?: unknown; details?: unknown }) => sentMessages.push(message),
    on: (event: string, handler: Handler) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
  } as unknown as PiInstance;
  const notify = (_ctx: unknown, msg: string, level?: string) => notes.push({ msg, level });
  const registerFn = (
    target: { registerTool?(definition: ToolDefinition): void },
    names: Set<string>,
    definition: ToolDefinition,
  ) => {
    names.add(definition.name);
    target.registerTool?.(definition);
  };
  registerCompactionHooks(pi, notify as never);
  registerContextTools(pi, Type, new Set<string>(), registerFn as never, notify as never);
  return {
    tools,
    notes,
    sentUserMessages,
    sentMessages,
    handlerCount: (event) => handlers.get(event)?.length ?? 0,
    fire: (event, evt, ctx) => Promise.all((handlers.get(event) ?? []).map((handler) => handler(evt, ctx))),
  };
}

function makeCtx(options: { tokens?: number | null; contextWindow?: number; branch?: unknown[] } = {}) {
  const compactCalls: CompactOptions[] = [];
  const ctx = {
    hasUI: false,
    compact: (compactOptions: CompactOptions) => compactCalls.push(compactOptions),
    getContextUsage: () => ({
      tokens: options.tokens === undefined ? 90 : options.tokens,
      contextWindow: options.contextWindow ?? 100,
    }),
    sessionManager: {
      getBranch: () => options.branch ?? [],
      getSessionId: () => 'test-session',
    },
  };
  return { ctx, compactCalls };
}

let previousHome: string | undefined;
let testHome: string;

beforeEach(() => {
  previousHome = process.env['OCTOCODE_HOME'];
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-compaction-races-home-'));
  process.env['OCTOCODE_HOME'] = testHome;
  resetCompactionArbiterForTests();
  resetCompactionCheckpointDedupe();
  clearPlan(activePlanScope());
  clearPlan(activePlanScope(makeCtx().ctx));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['OCTOCODE_HOME'];
  else process.env['OCTOCODE_HOME'] = previousHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('arbiter mark expires when Pi never emits a completion event', () => {
  assert.equal(isCompactionInFlight(1_000), false);
  markCompactionInFlight(1_000);
  assert.equal(isCompactionInFlight(120_000), true);
  assert.equal(isCompactionInFlight(122_000), false);
});

test('Octocode does not register a duplicate turn_end compactor or abort-message rewriter', () => {
  const harness = makeHarness();
  assert.equal(harness.handlerCount('turn_end'), 0);
  assert.equal(harness.handlerCount('message_end'), 0);
  assert.equal(harness.tools.has('manage_context'), false);
});

test('completed high-context turns never call ctx.compact even when plan state is still active', async () => {
  const harness = makeHarness();
  const { ctx, compactCalls } = makeCtx({ tokens: 99, contextWindow: 100 });
  setPlan(activePlanScope(ctx), ['stale or unfinished plan step']);
  await harness.fire('turn_end', { message: { stopReason: 'stop' } }, ctx);
  assert.deepEqual(compactCalls, [], 'Pi alone owns its post-run threshold compaction check');
});

test('Pi compaction events mark, preserve on retry, and clear the shared arbiter', async () => {
  const harness = makeHarness();
  const { ctx } = makeCtx();
  await harness.fire('session_before_compact', { preparation: {}, reason: 'threshold', willRetry: false }, ctx);
  assert.equal(isCompactionInFlight(), true);
  await harness.fire('session_compact', { reason: 'threshold', willRetry: true }, ctx);
  assert.equal(isCompactionInFlight(), true);
  await harness.fire('session_compact', { compactionEntry: {}, reason: 'threshold', willRetry: false }, ctx);
  assert.equal(isCompactionInFlight(), false);
});

test('manual compaction without instructions is cancelled after an explicit terminal answer', async () => {
  const harness = makeHarness();
  const { ctx } = makeCtx();
  const [result] = await harness.fire('session_before_compact', {
    preparation: {}, reason: 'manual', willRetry: false,
    branchEntries: [{
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The prior work was already complete, verified, and closed.' }] },
    }],
  }, ctx) as Array<{ cancel?: boolean } | undefined>;
  assert.equal(result?.cancel, true);
  assert.ok(harness.notes.some((note) => /already completed/i.test(note.msg)));
});

test('explicit manual compaction instructions are respected after a terminal answer', async () => {
  const harness = makeHarness();
  const { ctx } = makeCtx();
  const [result] = await harness.fire('session_before_compact', {
    preparation: {}, reason: 'manual', willRetry: false,
    customInstructions: 'Preserve the query audit details.',
    branchEntries: [{
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The prior work was already complete, verified, and closed.' }] },
    }],
  }, ctx);
  assert.equal(result, undefined);
});

test('Pi and user compactions never schedule an Octocode follow-up turn', async () => {
  const harness = makeHarness();
  const { ctx } = makeCtx();
  await harness.fire('session_compact', {
    compactionEntry: {}, fromExtension: false, reason: 'threshold', willRetry: false,
  }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.sentUserMessages, []);
});

test('checkpoint-card dedupe resets stable-id and object-identity paths', async () => {
  const harness = makeHarness();
  const { ctx } = makeCtx();
  const count = () => harness.sentMessages.filter((message) => message.customType === 'octocode-compaction-checkpoint').length;

  await harness.fire('session_compact', { compactionEntry: { id: 'cmp-abc' }, reason: 'threshold', willRetry: false }, ctx);
  await harness.fire('session_compact', { compactionEntry: { id: 'cmp-abc' }, reason: 'threshold', willRetry: false }, ctx);
  assert.equal(count(), 1);
  resetCompactionCheckpointDedupe();
  await harness.fire('session_compact', { compactionEntry: { id: 'cmp-abc' }, reason: 'threshold', willRetry: false }, ctx);
  assert.equal(count(), 2);

  const entry = { reason: 'threshold' };
  await harness.fire('session_compact', { compactionEntry: entry, reason: 'threshold', willRetry: false }, ctx);
  await harness.fire('session_compact', { compactionEntry: entry, reason: 'threshold', willRetry: false }, ctx);
  assert.equal(count(), 3);
  resetCompactionCheckpointDedupe();
  await harness.fire('session_compact', { compactionEntry: entry, reason: 'threshold', willRetry: false }, ctx);
  assert.equal(count(), 4);
});
